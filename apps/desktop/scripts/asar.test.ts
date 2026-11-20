import { describe, expect, it } from "vitest";

import { asarFile, asarHeaderHash, readAsar, sha256 } from "./asar.ts";

interface Directory {
  files: Record<string, Directory | Record<string, unknown>>;
}

function isDirectory(value: Directory | Record<string, unknown> | undefined): value is Directory {
  return value !== undefined && typeof value.files === "object" && value.files !== null;
}

/** An archive the way electron-builder writes one: size pickle, header pickle, then the files' bytes. */
function makeAsar(
  files: Record<string, string | { content: string; unpacked?: boolean; integrity?: string }>,
  extra: Record<string, unknown> = {},
): Buffer {
  const root: Directory = { files: {} };
  const data: Buffer[] = [];
  let offset = 0;
  for (const [path, spec] of Object.entries(files)) {
    const { content, unpacked, integrity } = typeof spec === "string" ? { content: spec } : spec;
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const next: Directory = { files: {} };
      const existing = node.files[part];
      if (isDirectory(existing)) node = existing;
      else node = node.files[part] = next;
    }
    const bytes = Buffer.from(content);
    node.files[parts.at(-1)!] = unpacked
      ? { size: bytes.length, unpacked: true }
      : {
          size: bytes.length,
          offset: String(offset),
          integrity: { algorithm: "SHA256", hash: integrity ?? sha256(bytes), blockSize: 4194304, blocks: [] },
        };
    if (!unpacked) {
      data.push(bytes);
      offset += bytes.length;
    }
  }
  Object.assign(root.files, extra);
  const json = Buffer.from(JSON.stringify(root));
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(8 + padded);
  header.writeUInt32LE(4 + padded, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  return Buffer.concat([size, header, ...data]);
}

describe("asar reader", () => {
  it("lists entries and reads packed files by their offset", () => {
    const archive = makeAsar({
      "package.json": '{"main":".vite/release/main.cjs"}',
      ".vite/release/main.cjs": "main();",
      "native.node": { content: "binary", unpacked: true },
    });
    const asar = readAsar(archive);
    expect(asar.entries.map(({ path, kind, unpacked }) => [path, kind, unpacked])).toEqual([
      ["package.json", "file", false],
      [".vite", "directory", false],
      [".vite/release", "directory", false],
      [".vite/release/main.cjs", "file", false],
      ["native.node", "file", true],
    ]);
    expect(asarFile(archive, asar, ".vite/release/main.cjs").toString()).toBe("main();");
    expect(asar.entries.find((entry) => entry.path === "package.json")?.integrity).toBe(
      sha256('{"main":".vite/release/main.cjs"}'),
    );
    expect(() => asarFile(archive, asar, "native.node")).toThrow("unpacked");
    expect(() => asarFile(archive, asar, ".vite")).toThrow("not a file");
    expect(asarHeaderHash(asar)).toBe(sha256(asar.headerJson));
  });

  it("reports links and refuses what is not an archive", () => {
    const asar = readAsar(makeAsar({ "a.js": "a" }, { "b.js": { link: "a.js" } }));
    expect(asar.entries.find((entry) => entry.path === "b.js")?.kind).toBe("link");
    expect(() => readAsar(Buffer.from("PK\u0003\u0004 a zip file, not an archive"))).toThrow("not an asar archive");
    const truncated = makeAsar({ "a.js": "aaaa" });
    expect(() => asarFile(truncated.subarray(0, -2), readAsar(truncated.subarray(0, -2)), "a.js")).toThrow(
      "past the end",
    );
  });
});
