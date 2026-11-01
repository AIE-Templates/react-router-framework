import { fileURLToPath } from "node:url";

import { runnerImport, type Plugin } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const fallback = fileURLToPath(new URL("../src/app/managers/visual/mantine/fallback.ts", import.meta.url));

/** Resolve app aliases at module-load time, outside the native config bundler. */
export function visualFallbackPlugin(): Plugin {
  const id = "virtual:visual-fallback.css";
  return {
    name: "visual-fallback",
    enforce: "pre",
    resolveId(source) {
      return source === id ? "\0" + id : null;
    },
    load(source) {
      return source === "\0" + id ? "" : null;
    },
    // The module graph entry exists during transform, including direct CSS requests.
    async transform(_code, source) {
      if (source !== "\0" + id) return null;
      const { module, dependencies } = await runnerImport<{ createVisualFallbackCss: () => string }>(fallback, {
        configFile: false,
        root,
        resolve: { tsconfigPaths: true },
      });
      this.addWatchFile(fallback);
      for (const dependency of dependencies) this.addWatchFile(dependency);
      return module.createVisualFallbackCss();
    },
  };
}
