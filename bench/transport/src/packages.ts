/**
 * The package code a run measures must be the workspace source (`src/`), loaded through the
 * `@repo/source` export condition. Without the condition Node takes the packages' `default`
 * export, `dist/`, which is whatever was built last. Every process and thread of a run checks.
 */
export function sourcePackages(): { channel: string; portFetch: string } {
  const packages = {
    channel: import.meta.resolve("@repo/channel"),
    portFetch: import.meta.resolve("@repo/port-fetch"),
  };
  for (const url of Object.values(packages)) {
    if (!url.endsWith("/src/index.ts")) {
      throw new Error(`a package resolves to ${url}, not its src/; run with --conditions=@repo/source`);
    }
  }
  return packages;
}
