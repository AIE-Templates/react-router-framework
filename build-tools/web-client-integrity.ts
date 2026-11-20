import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Saved outside the public client directory after React Router finishes the Web build. */
export const CLIENT_DIGEST_FILE = "client.sha256";

/** Hash names and bytes of every client resource, including public files and transitive imports. */
export function clientDigest(directory: string): string {
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"))
    // oxlint-disable-next-line unicorn/no-array-sort -- the Web project targets ES2022 and this array is fresh.
    .sort();
  const digest = createHash("sha256");
  for (const file of files) {
    const hash = createHash("sha256")
      .update(readFileSync(join(directory, file)))
      .digest();
    digest.update(file).update("\0").update(hash);
  }
  return digest.digest("hex");
}
