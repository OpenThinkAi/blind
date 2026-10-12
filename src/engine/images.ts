// Placeholder images for DOCX and XLSX members that are pictures. A picture can hold a scanned ID, a
// face, a signature or EXIF (GPS, device owner), none of which blind can read, so by default each
// raster image is replaced by a neutral 1x1 image of the same format under the same part name
// (content types and relationships stay valid). `[images] keep = true` copies them unchanged.
// Plain constants: no dependency and no model code.

const b64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "base64"));

/** A 1x1 24-bit grey BMP. */
function grayBmp(): Uint8Array {
  const out = new Uint8Array(58);
  const v = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  v.setUint32(2, 58, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, 1, true);
  v.setInt32(22, 1, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, 4, true);
  out.fill(0x80, 54, 57);
  return out;
}

// A 1x1 grey 8-bit greyscale PNG.
const PNG = b64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==");
const JPEG = b64("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=");
const GIF = b64("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
const BMP = grayBmp();
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');

const BY_EXTENSION: Record<string, Uint8Array> = { png: PNG, jpg: JPEG, jpeg: JPEG, gif: GIF, bmp: BMP, svg: SVG };

/**
 * The placeholder for an image part, by its extension (the content type follows it), or null when
 * blind has none for that format (TIFF, EMF, WMF, ICO, WebP): such a package is refused unless the
 * policy keeps images.
 */
export function placeholderFor(name: string): Uint8Array | null {
  const ext = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  return BY_EXTENSION[ext] ?? null;
}

/** True when `bytes` is exactly one of the placeholders: an image blind wrote, which holds nothing to check. */
export function isPlaceholderImage(bytes: Uint8Array): boolean {
  return Object.values(BY_EXTENSION).some((p) => p.length === bytes.length && p.every((x, i) => bytes[i] === x));
}

/** The part names that are pictures. */
export const IMAGE = /\.(png|jpe?g|gif|bmp|tiff?|emf|wmf|svg|ico|webp)$/i;

/**
 * What blind does with a package's pictures (`[images]` in blind.toml): `replace` writes a neutral
 * placeholder of the same format under the same part name; `keep` copies them unchanged.
 */
export type ImageMode = "replace" | "keep";

/** The report line for a package's pictures, or the reason a picture with no placeholder stops the package. */
export function imageWarning(names: readonly string[], mode: ImageMode): { line: string | null; refusal: string | null } {
  if (names.length === 0) return { line: null, refusal: null };
  const n = `${names.length} image${names.length === 1 ? "" : "s"}`;
  if (mode === "keep") return { line: `${n} copied unchanged (images are not blinded): ${names.join(", ")}`, refusal: null };
  const stuck = names.find((x) => placeholderFor(x) === null);
  if (stuck !== undefined) {
    return { line: null, refusal: `image ${stuck} cannot be replaced with a placeholder (blind has none for its format); remove it, or set [images] keep = true to copy images unchanged` };
  }
  return { line: `${n} replaced with placeholders (images are not blinded; set [images] keep = true to keep them)`, refusal: null };
}
