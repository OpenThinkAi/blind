// Reading and writing map.json on disk. The format itself (parse, serialise) is
// src/engine/map.ts, which imports no node: module; this is the file side. The
// map is created mode 0600 (never chmod'ed afterwards).

import { closeSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { type BlindMap, parseMap, serializeMap } from "./engine/map.ts";

/**
 * Write `text` atomically and privately: a temp file is created exclusively with mode 0600 (so
 * there is no window where it is readable by others), then renamed over the target.
 */
export function writePrivateText(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, text);
  } catch (err) {
    closeSync(fd);
    unlinkSync(tmp);
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    unlinkSync(tmp);
    throw err;
  }
}

/** Write the map atomically, mode 0600 (writePrivateText). */
export function writeMap(path: string, map: BlindMap): void {
  writePrivateText(path, serializeMap(map));
}

export function readMap(path: string): BlindMap {
  return parseMap(readFileSync(path, "utf8"), path);
}
