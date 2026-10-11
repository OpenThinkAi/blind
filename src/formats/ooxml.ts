// OOXML core: read a zip, stream each XML member through a text-node
// rewriter, write the zip back. No document object model: the rewriter
// tokenizes the XML and copies every byte it does not rewrite, so a no-op
// rewrite reproduces the input byte for byte.
//
// Only selected text nodes and allowlisted attribute values are offered to the
// callback (see RewriteRules). An unchanged value keeps its original bytes,
// entity spelling included; a changed value is re-encoded. Members that are not
// XML are copied raw. Member order, timestamps, flags, extra fields and the
// compression method are kept from the input, so the output depends only on
// the input bytes and the callback.
//
// Fail closed: an unreadable zip throws ZipError; a member that cannot be read
// or parsed is left untouched and reported with kind "error", never skipped.

import { deflateRawSync, inflateRawSync } from "node:zlib";

export class ZipError extends Error {
  override name = "ZipError";
}

export class XmlError extends Error {
  override name = "XmlError";
}

// ---------------------------------------------------------------- XML

export interface Frame {
  /** Qualified name as written, e.g. `w:t`. */
  name: string;
  /** Decoded attribute values by qualified name. */
  attrs: ReadonlyMap<string, string>;
}

export interface NodeContext {
  /** The element holding the text, or carrying the attribute. */
  element: Frame;
  /** Ancestors, outermost first. */
  parents: readonly Frame[];
  /** Set when the value is an attribute value. */
  attribute?: string;
}

export interface RewriteRules {
  /** Rewrite the text content of this element? */
  text(element: Frame, parents: readonly Frame[]): boolean;
  /** Rewrite this attribute's value? */
  attribute(element: Frame, attribute: string, parents: readonly Frame[]): boolean;
  /**
   * When a rewritten text value of this element starts or ends with whitespace and the element has
   * no xml:space attribute, add xml:space="preserve" so a consumer does not strip it (WordprocessingML
   * `w:t`). Unchanged values never gain the attribute.
   */
  preserveSpace?(element: Frame, parents: readonly Frame[]): boolean;
  /**
   * Called for every start tag, self-closing ones included, in document order and before the
   * element's attributes are offered: lets a handler see markup between text nodes (a tab, a break).
   */
  visit?(element: Frame, parents: readonly Frame[]): void;
  /**
   * Offer each run of character data directly inside this element (text between its child tags,
   * CDATA included) when the element's text is not selected as a whole. Whitespace-only runs are
   * not offered. Lets a handler scan mixed content it does not otherwise rewrite.
   */
  runs?(element: Frame, parents: readonly Frame[]): boolean;
}

export type XmlRewrite = (value: string, ctx: NodeContext) => string;

export function localName(qname: string): string {
  const i = qname.indexOf(":");
  return i < 0 ? qname : qname.slice(i + 1);
}

/** `<t>` in any namespace (shared strings, inline strings, `w:t`, `a:t`) and `<v>` on formula-string cells. No attributes. */
export const defaultRules: RewriteRules = {
  text(el, parents) {
    const name = localName(el.name);
    if (name === "t") return true;
    const parent = parents[parents.length - 1];
    return name === "v" && parent !== undefined && localName(parent.name) === "c" && parent.attrs.get("t") === "str";
  },
  attribute: () => false,
};

const NAME = /[A-Za-z_:À-￿][\w.:\-·À-￿]*/y;
const SPACE = /[ \t\r\n]*/y;
const ENTITY = /&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|(lt|gt|amp|quot|apos));|&/g;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
// Characters XML 1.0 cannot carry at all, even as a character reference.
const ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function decodeEntities(raw: string): string {
  return raw.replace(ENTITY, (m, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
    if (named !== undefined) return NAMED[named]!;
    if (hex === undefined && dec === undefined) throw new XmlError(`bare "&" or unknown entity near "${m}"`);
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10);
    if (!(cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff))) {
      throw new XmlError(`character reference to an invalid code point: ${m}`);
    }
    return String.fromCodePoint(cp);
  });
}

/** Text content: line ends normalised (CRLF and CR become LF) before entities are decoded, as an XML parser does. */
function decodeText(raw: string): string {
  return decodeEntities(raw.replace(/\r\n?/g, "\n"));
}

/** Attribute value: line ends normalised, then literal whitespace becomes a space; character references survive. */
function decodeAttr(raw: string): string {
  if (raw.includes("<")) throw new XmlError(`"<" inside an attribute value`);
  return decodeEntities(raw.replace(/\r\n?/g, "\n").replace(/[\t\n]/g, " "));
}

function checkLegal(value: string): void {
  if (ILLEGAL.test(value)) throw new XmlError("rewritten value contains a character XML cannot represent");
}

function encodeText(value: string): string {
  checkLegal(value);
  return value.replace(/[&<>\r]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&#13;"));
}

function encodeAttr(value: string): string {
  checkLegal(value);
  return value.replace(/[&<>"'\t\n\r]/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&apos;";
      default: return `&#${c.charCodeAt(0)};`;
    }
  });
}

function lineOf(s: string, i: number): number {
  let n = 1;
  for (let k = s.indexOf("\n"); k >= 0 && k < i; k = s.indexOf("\n", k + 1)) n++;
  return n;
}

/**
 * Stream `xml` through the rewriter and return the result. Throws XmlError on
 * malformed or unsupported XML (unbalanced tags, unterminated markup, bad
 * entities, a DTD, markup inside a selected text element).
 */
export function rewriteXml(xml: string, rewrite: XmlRewrite, rules: RewriteRules = defaultRules): string {
  const out: string[] = [];
  const stack: Frame[] = [];
  const fail = (at: number, msg: string): never => {
    throw new XmlError(`line ${lineOf(xml, at)}: ${msg}`);
  };
  const find = (needle: string, from: number, what: string): number => {
    const k = xml.indexOf(needle, from);
    if (k < 0) fail(from, `unterminated ${what}`);
    return k;
  };
  const withLine = <T>(at: number, f: () => T): T => {
    try {
      return f();
    } catch (e) {
      if (e instanceof XmlError) fail(at, e.message);
      throw e;
    }
  };

  // A run of character data inside a non-selected element, offered when rules.runs selects the element.
  const offerRun = (raw: string, value: string, at: number): string => {
    const top = stack[stack.length - 1];
    if (top === undefined || rules.runs === undefined || !/[^ \t\r\n]/.test(value)) return raw;
    const parents = stack.slice(0, -1);
    if (!rules.runs(top, parents)) return raw;
    const after = rewrite(value, { element: top, parents });
    return after === value ? raw : withLine(at, () => encodeText(after));
  };

  // A selected text element collects its content (text and CDATA) until its end tag.
  let selected: { frame: Frame; parents: Frame[]; raw: string[]; value: string[]; at: number; tag: number } | null = null;
  let rootClosed = false;
  let sawRoot = false;
  let i = 0;
  if (xml.charCodeAt(0) === 0xfeff) {
    out.push("﻿");
    i = 1;
  }

  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const end = lt < 0 ? xml.length : lt;
    if (end > i) {
      const raw = xml.slice(i, end);
      if (selected) {
        selected.raw.push(raw);
        selected.value.push(withLine(i, () => decodeText(raw)));
      } else {
        const value = withLine(i, () => decodeText(raw));
        if ((stack.length === 0) && /[^ \t\r\n]/.test(raw)) fail(i, "text outside the root element");
        out.push(offerRun(raw, value, i));
      }
    }
    if (lt < 0) break;
    i = lt;

    if (xml.startsWith("<![CDATA[", i)) {
      const k = find("]]>", i + 9, "CDATA section");
      const raw = xml.slice(i, k + 3);
      if (stack.length === 0) fail(i, "CDATA outside the root element");
      if (selected) {
        selected.raw.push(raw);
        selected.value.push(xml.slice(i + 9, k).replace(/\r\n?/g, "\n"));
      } else out.push(offerRun(raw, xml.slice(i + 9, k).replace(/\r\n?/g, "\n"), i));
      i = k + 3;
      continue;
    }
    if (selected && !xml.startsWith("</", i)) fail(i, `markup inside <${selected.frame.name}>, whose text is rewritten`);
    if (xml.startsWith("<!--", i)) {
      const k = find("-->", i + 4, "comment");
      out.push(xml.slice(i, k + 3));
      i = k + 3;
      continue;
    }
    if (xml.startsWith("<?", i)) {
      const k = find("?>", i + 2, "processing instruction");
      const pi = xml.slice(i, k + 2);
      if (/^<\?xml[ \t\r\n]/.test(pi)) {
        if (i !== (out[0] === "﻿" ? 1 : 0)) fail(i, "XML declaration not at the start");
        const enc = /encoding[ \t\r\n]*=[ \t\r\n]*["']([^"']*)["']/.exec(pi)?.[1];
        if (enc !== undefined && !/^utf-?8$/i.test(enc)) fail(i, `unsupported encoding "${enc}"`);
      }
      out.push(pi);
      i = k + 2;
      continue;
    }
    if (xml.startsWith("<!", i)) fail(i, "DTD or declaration not allowed in OOXML");

    if (xml.startsWith("</", i)) {
      NAME.lastIndex = i + 2;
      const name = NAME.exec(xml)?.[0];
      if (name === undefined) fail(i, "bad end tag");
      SPACE.lastIndex = i + 2 + name!.length;
      SPACE.exec(xml);
      const close = SPACE.lastIndex;
      if (xml[close] !== ">") fail(i, `bad end tag </${name}`);
      const top = stack.pop();
      if (!top || top.name !== name) fail(i, `</${name}> does not match ${top ? `<${top.name}>` : "any open element"}`);
      if (selected) {
        const s = selected;
        selected = null;
        const before = s.value.join("");
        const after = before === "" ? before : rewrite(before, { element: s.frame, parents: s.parents });
        out.push(after === before ? s.raw.join("") : withLine(s.at, () => encodeText(after)));
        if (after !== before && /^\s|\s$/.test(after) && !s.frame.attrs.has("xml:space") && rules.preserveSpace?.(s.frame, s.parents)) {
          out[s.tag] = `${(out[s.tag] as string).slice(0, -1)} xml:space="preserve">`;
        }
      }
      out.push(xml.slice(i, close + 1));
      i = close + 1;
      if (stack.length === 0) rootClosed = true;
      continue;
    }

    // Start tag.
    NAME.lastIndex = i + 1;
    const name = NAME.exec(xml)?.[0];
    if (name === undefined) fail(i, `bad "<"`);
    if (rootClosed) fail(i, "second root element");
    sawRoot = true;
    let p = i + 1 + name!.length;
    // Attribute value spans in the source, kept so only rewritten values change.
    const spans: { name: string; start: number; end: number; quote: string; value: string }[] = [];
    const attrs = new Map<string, string>();
    let selfClosing = false;
    for (;;) {
      SPACE.lastIndex = p;
      SPACE.exec(xml);
      const gap = SPACE.lastIndex - p;
      p = SPACE.lastIndex;
      if (xml[p] === ">") break;
      if (xml.startsWith("/>", p)) {
        selfClosing = true;
        p++;
        break;
      }
      if (p >= xml.length) fail(i, `unterminated <${name}`);
      if (gap === 0) fail(p, `bad attribute in <${name}>`);
      NAME.lastIndex = p;
      const an = NAME.exec(xml)?.[0];
      if (an === undefined) fail(p, `bad attribute in <${name}>`);
      p += an!.length;
      SPACE.lastIndex = p;
      SPACE.exec(xml);
      p = SPACE.lastIndex;
      if (xml[p] !== "=") fail(p, `attribute ${an} has no value`);
      SPACE.lastIndex = p + 1;
      SPACE.exec(xml);
      p = SPACE.lastIndex;
      const quote = xml[p];
      if (quote !== '"' && quote !== "'") fail(p, `attribute ${an} is not quoted`);
      const close = find(quote!, p + 1, `attribute ${an}`);
      if (attrs.has(an!)) fail(p, `duplicate attribute ${an}`);
      const value = withLine(p, () => decodeAttr(xml.slice(p + 1, close)));
      attrs.set(an!, value);
      spans.push({ name: an!, start: p + 1, end: close, quote: quote!, value });
      p = close + 1;
    }
    const frame: Frame = { name: name!, attrs };
    const parents = stack.slice();
    rules.visit?.(frame, parents);

    let cursor = i;
    for (const s of spans) {
      if (s.value === "" || !rules.attribute(frame, s.name, parents)) continue;
      const after = rewrite(s.value, { element: frame, parents, attribute: s.name });
      if (after === s.value) continue;
      out.push(xml.slice(cursor, s.start), withLine(s.start, () => encodeAttr(after)));
      cursor = s.end;
    }
    out.push(xml.slice(cursor, p + 1));
    i = p + 1;
    if (selfClosing) {
      if (stack.length === 0) rootClosed = true;
      continue;
    }
    stack.push(frame);
    if (rules.text(frame, parents)) selected = { frame, parents, raw: [], value: [], at: i, tag: out.length - 1 };
  }

  if (stack.length > 0) fail(xml.length, `<${stack[stack.length - 1]!.name}> is never closed`);
  if (!sawRoot) fail(0, "no root element");
  return out.join("");
}

// ---------------------------------------------------------------- zip

interface Entry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  /** Offset of the local header in the input. */
  local: number;
  dataStart: number;
  dataEnd: number;
  /** Data descriptor after the data (flag bit 3): 0, 12, or 16 with its signature. */
  descriptor: number;
  /** Offset of this entry's central directory record in the input. */
  central: number;
  centralLen: number;
}

interface Zip {
  bytes: Uint8Array;
  view: DataView;
  /** Central directory order. */
  entries: Entry[];
  cdOffset: number;
  eocd: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_DESCRIPTOR = 0x08074b50;
const utf8 = new TextDecoder("utf-8");

function readZip(input: Uint8Array): Zip {
  // A plain view, never a Buffer: Buffer#slice shares memory, and the writer slices headers to patch them.
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let k = bytes.length - 22; k >= 0 && k >= bytes.length - 22 - 0xffff; k--) {
    if (view.getUint32(k, true) === SIG_EOCD && k + 22 + view.getUint16(k + 20, true) === bytes.length) {
      eocd = k;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip file (no end of central directory record)");
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR) throw new ZipError("zip64 archives are not supported");
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) throw new ZipError("multi-disk archives are not supported");
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (view.getUint16(eocd + 8, true) !== count) throw new ZipError("inconsistent entry counts in the end of central directory record");
  if (cdOffset + cdSize !== eocd) throw new ZipError("central directory does not end where the end record starts");

  const entries: Entry[] = [];
  let c = cdOffset;
  for (let n = 0; n < count; n++) {
    if (c + 46 > eocd || view.getUint32(c, true) !== SIG_CENTRAL) throw new ZipError(`bad central directory record ${n + 1}`);
    const nameLen = view.getUint16(c + 28, true);
    const centralLen = 46 + nameLen + view.getUint16(c + 30, true) + view.getUint16(c + 32, true);
    if (c + centralLen > eocd) throw new ZipError(`central directory record ${n + 1} overruns the directory`);
    const nameBytes = bytes.subarray(c + 46, c + 46 + nameLen);
    const name = utf8.decode(nameBytes);
    const flags = view.getUint16(c + 8, true);
    const csize = view.getUint32(c + 20, true);
    const usize = view.getUint32(c + 24, true);
    const local = view.getUint32(c + 42, true);
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new ZipError(`${name}: zip64 entries are not supported`);
    if (local + 30 > cdOffset || view.getUint32(local, true) !== SIG_LOCAL) throw new ZipError(`${name}: bad local header`);
    const lNameLen = view.getUint16(local + 26, true);
    const lName = bytes.subarray(local + 30, local + 30 + lNameLen);
    if (lNameLen !== nameLen || !lName.every((b, k) => b === nameBytes[k])) throw new ZipError(`${name}: local header name differs from the central directory`);
    const dataStart = local + 30 + lNameLen + view.getUint16(local + 28, true);
    const dataEnd = dataStart + csize;
    let descriptor = 0;
    if (flags & 8) descriptor = dataEnd + 4 <= cdOffset && view.getUint32(dataEnd, true) === SIG_DESCRIPTOR ? 16 : 12;
    if (dataEnd + descriptor > cdOffset) throw new ZipError(`${name}: data overruns the central directory`);
    entries.push({
      name, flags, method: view.getUint16(c + 10, true), crc: view.getUint32(c + 16, true), csize, usize,
      local, dataStart, dataEnd, descriptor, central: c, centralLen,
    });
    c += centralLen;
  }
  if (c !== eocd) throw new ZipError("unexpected bytes after the central directory");

  // Every byte before the central directory must belong to a member: nothing hidden in gaps.
  let at = 0;
  for (const e of [...entries].sort((a, b) => a.local - b.local)) {
    if (e.local !== at) throw new ZipError(`unexpected bytes at offset ${at}, outside any member`);
    at = e.dataEnd + e.descriptor;
  }
  if (at !== cdOffset) throw new ZipError(`unexpected bytes at offset ${at}, outside any member`);
  return { bytes, view, entries, cdOffset, eocd };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function memberData(zip: Zip, e: Entry): Uint8Array {
  if (e.flags & 1) throw new ZipError("encrypted");
  const raw = zip.bytes.subarray(e.dataStart, e.dataEnd);
  let data: Uint8Array;
  if (e.method === 0) data = raw;
  else if (e.method === 8) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(e.usize, 1) });
    } catch (err) {
      throw new ZipError(`cannot inflate: ${(err as Error).message}`);
    }
  } else throw new ZipError(`unsupported compression method ${e.method}`);
  if (data.length !== e.usize) throw new ZipError(`size ${data.length} differs from the recorded ${e.usize}`);
  if (crc32(data) !== e.crc) throw new ZipError("CRC mismatch");
  return data;
}

interface Replacement {
  data: Uint8Array;
  crc: number;
  usize: number;
}

function writeZip(zip: Zip, replaced: Map<Entry, Replacement>): Uint8Array {
  const { bytes } = zip;
  const parts: Uint8Array[] = [];
  const offsets = new Map<Entry, number>();
  const sizes = new Map<Entry, number>();
  let at = 0;
  const push = (b: Uint8Array) => {
    parts.push(b);
    at += b.length;
  };
  const u32 = (v: number, what: string): number => {
    if (v > 0xffffffff) throw new ZipError(`${what} exceeds 4 GiB; zip64 is not supported`);
    return v;
  };

  for (const e of [...zip.entries].sort((a, b) => a.local - b.local)) {
    offsets.set(e, u32(at, "archive"));
    const r = replaced.get(e);
    if (!r) {
      push(bytes.subarray(e.local, e.dataEnd + e.descriptor));
      continue;
    }
    sizes.set(e, u32(r.data.length, e.name));
    const header = bytes.slice(e.local, e.dataStart);
    const hv = new DataView(header.buffer);
    if (!(e.flags & 8)) {
      hv.setUint32(14, r.crc, true);
      hv.setUint32(18, r.data.length, true);
      hv.setUint32(22, u32(r.usize, e.name), true);
    }
    push(header);
    push(r.data);
    if (e.descriptor) {
      const d = new Uint8Array(e.descriptor);
      const dv = new DataView(d.buffer);
      const o = e.descriptor === 16 ? 4 : 0;
      if (o) dv.setUint32(0, SIG_DESCRIPTOR, true);
      dv.setUint32(o, r.crc, true);
      dv.setUint32(o + 4, r.data.length, true);
      dv.setUint32(o + 8, u32(r.usize, e.name), true);
      push(d);
    }
  }

  const cdOffset = u32(at, "archive");
  for (const e of zip.entries) {
    const rec = bytes.slice(e.central, e.central + e.centralLen);
    const rv = new DataView(rec.buffer);
    const r = replaced.get(e);
    if (r) {
      rv.setUint32(16, r.crc, true);
      rv.setUint32(20, sizes.get(e)!, true);
      rv.setUint32(24, r.usize, true);
    }
    rv.setUint32(42, offsets.get(e)!, true);
    push(rec);
  }
  const end = bytes.slice(zip.eocd);
  const ev = new DataView(end.buffer);
  ev.setUint32(12, u32(at - cdOffset, "central directory"), true);
  ev.setUint32(16, cdOffset, true);
  push(end);

  const result = new Uint8Array(at);
  let k = 0;
  for (const part of parts) {
    result.set(part, k);
    k += part.length;
  }
  return result;
}

// ---------------------------------------------------------------- OOXML

export type MemberResult =
  | { name: string; kind: "xml"; changed: boolean }
  /** Not XML (images, binaries, directories): copied raw, never read. */
  | { name: string; kind: "other" }
  /** Could not be read or parsed: copied raw and untouched. The caller must not treat it as processed. */
  | { name: string; kind: "error"; error: string };

export interface OoxmlResult {
  bytes: Uint8Array;
  /** One per member, in central directory order. */
  members: MemberResult[];
}

export type OoxmlRewrite = (value: string, ctx: NodeContext & { member: string }) => string;

export function isXmlMember(name: string): boolean {
  return /\.(xml|rels)$/i.test(name);
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A member's XML text; throws ZipError or XmlError when it cannot be read as UTF-8 XML. */
function memberXml(zip: Zip, e: Entry): string {
  const data = memberData(zip, e);
  if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) throw new XmlError("UTF-16 XML is not supported");
  try {
    return strictUtf8.decode(data);
  } catch {
    throw new XmlError("not valid UTF-8");
  }
}

export type OoxmlMember =
  | { name: string; kind: "xml"; text: string }
  | { name: string; kind: "other" }
  | { name: string; kind: "error"; error: string };

/**
 * Every member in central directory order, XML members with their decoded
 * text, for a handler that must read the parts before it rewrites them. Kinds
 * are as in MemberResult. Throws ZipError when the archive itself cannot be read.
 */
export function readOoxml(bytes: Uint8Array): OoxmlMember[] {
  const zip = readZip(bytes);
  return zip.entries.map((e): OoxmlMember => {
    if (e.name.endsWith("/") || !isXmlMember(e.name)) return { name: e.name, kind: "other" };
    try {
      return { name: e.name, kind: "xml", text: memberXml(zip, e) };
    } catch (err) {
      if (!(err instanceof XmlError || err instanceof ZipError)) throw err;
      return { name: e.name, kind: "error", error: err.message };
    }
  });
}

/**
 * Rewrite the text nodes of every XML member of an OOXML zip. Members are
 * visited in central directory order and nodes in document order. `rules` may
 * be chosen per member by name. Throws ZipError when the archive itself cannot
 * be read.
 */
export function rewriteOoxml(
  bytes: Uint8Array,
  rewrite: OoxmlRewrite,
  rules: RewriteRules | ((member: string) => RewriteRules) = defaultRules,
): OoxmlResult {
  const zip = readZip(bytes);
  const replaced = new Map<Entry, Replacement>();
  const members: MemberResult[] = [];

  for (const e of zip.entries) {
    if (e.name.endsWith("/") || !isXmlMember(e.name)) {
      members.push({ name: e.name, kind: "other" });
      continue;
    }
    try {
      const text = memberXml(zip, e);
      const out = rewriteXml(text, (v, ctx) => rewrite(v, { ...ctx, member: e.name }), typeof rules === "function" ? rules(e.name) : rules);
      if (out === text) {
        members.push({ name: e.name, kind: "xml", changed: false });
        continue;
      }
      const plain = new TextEncoder().encode(out);
      const stored = e.method === 0 ? plain : deflateRawSync(plain, { level: 6 });
      replaced.set(e, { data: stored, crc: crc32(plain), usize: plain.length });
      members.push({ name: e.name, kind: "xml", changed: true });
    } catch (err) {
      if (!(err instanceof XmlError || err instanceof ZipError)) throw err;
      members.push({ name: e.name, kind: "error", error: err.message });
    }
  }
  return { bytes: writeZip(zip, replaced), members };
}
