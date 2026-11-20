// Reads an `app.asar` archive the way Electron does, without a dependency: what scripts/verify-release.ts
// checks in the final package is the archive's own index and bytes, not the build directory it
// was made from.
//
// The format: a pickled uint32 (the size of the header pickle), then the header pickle (its payload
// size, the JSON string's length, the JSON itself, padded to 4 bytes), then the files' bytes. The
// JSON is a tree of `files` objects; a file has `size`, `offset` (a decimal string, from the end of
// the header), and may be `unpacked` (kept in `app.asar.unpacked` beside it), `executable` or a
// `link`; electron-builder records an `integrity` (SHA-256 of the whole file) for each one.
// Electron's embedded asar integrity validation (the fuse) hashes the header JSON string, which on
// macOS the app's Info.plist records as `ElectronAsarIntegrity`.
// Runs on Node directly (type stripping).
import { createHash } from "node:crypto";

export interface AsarEntry {
  /** The path inside the archive, with forward slashes. */
  path: string;
  kind: "file" | "link" | "directory";
  size: number;
  /** Where the file's bytes start, from the end of the header. */
  offset: number;
  unpacked: boolean;
  /** The SHA-256 the archive records for the whole file, if it records one. */
  integrity?: string;
}

export interface Asar {
  /** The header JSON exactly as stored, which Electron's integrity check hashes. */
  headerJson: string;
  /** Where the files' bytes start in the archive. */
  dataOffset: number;
  entries: AsarEntry[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses an archive's header; throws when `archive` is not an asar archive. */
export function readAsar(archive: Buffer): Asar {
  if (archive.length < 16) throw new Error("not an asar archive: too short");
  // The size pickle: payload size 4, then the header pickle's size.
  if (archive.readUInt32LE(0) !== 4) throw new Error("not an asar archive: bad size pickle");
  const headerSize = archive.readUInt32LE(4);
  const jsonLength = archive.readUInt32LE(12);
  if (8 + headerSize > archive.length || 16 + jsonLength > 8 + headerSize) {
    throw new Error("not an asar archive: header out of bounds");
  }
  const headerJson = archive.subarray(16, 16 + jsonLength).toString("utf8");
  const header: unknown = JSON.parse(headerJson);
  const entries: AsarEntry[] = [];
  const walk = (node: unknown, prefix: string) => {
    if (!isObject(node) || !isObject(node.files)) throw new Error(`asar header: ${prefix || "/"} is not a directory`);
    for (const [name, child] of Object.entries(node.files)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!isObject(child)) throw new Error(`asar header: ${path} is not an entry`);
      if (isObject(child.files)) {
        entries.push({ path, kind: "directory", size: 0, offset: 0, unpacked: child.unpacked === true });
        walk(child, path);
      } else if (typeof child.link === "string") {
        entries.push({ path, kind: "link", size: 0, offset: 0, unpacked: child.unpacked === true });
      } else {
        const size = child.size;
        // Packed offsets are decimal strings. Unpacked files have no offset in this archive.
        const offset =
          child.unpacked === true && child.offset === undefined
            ? 0
            : typeof child.offset === "string" && /^\d+$/.test(child.offset)
              ? Number(child.offset)
              : NaN;
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(offset)) {
          throw new Error(`asar header: ${path} has no valid size or offset`);
        }
        const integrity =
          isObject(child.integrity) && typeof child.integrity.hash === "string" ? child.integrity.hash : undefined;
        entries.push({ path, kind: "file", size, offset, unpacked: child.unpacked === true, integrity });
      }
    }
  };
  walk(header, "");
  return { headerJson, dataOffset: 8 + headerSize, entries };
}

/** A packed file's bytes; throws for an unpacked or missing file or one past the archive's end. */
export function asarFile(archive: Buffer, asar: Asar, path: string): Buffer {
  const entry = asar.entries.find((candidate) => candidate.path === path);
  if (entry === undefined || entry.kind !== "file") throw new Error(`${path} is not a file in the archive`);
  if (entry.unpacked) throw new Error(`${path} is unpacked, outside the archive`);
  const start = asar.dataOffset + entry.offset;
  if (!Number.isSafeInteger(start) || start < asar.dataOffset || entry.size < 0 || entry.size > archive.length - start)
    throw new Error(`${path} runs past the end of the archive`);
  return archive.subarray(start, start + entry.size);
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The digest Electron's embedded asar integrity validation compares: SHA-256 of the header JSON. */
export function asarHeaderHash(asar: Asar): string {
  return sha256(asar.headerJson);
}
