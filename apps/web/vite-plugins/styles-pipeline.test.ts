// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";
import { expect, it } from "vitest";

import { mantineCss } from "./styles.ts";
import { visualFallbackPlugin } from "./visual-fallback.ts";

it("compiles injected Sass modules through the project's PostCSS pipeline", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const fixture = await mkdtemp(join(root, ".styles-fixture-"));
  try {
    await writeFile(
      join(fixture, "entry.js"),
      'export { default } from "./probe.module.scss"; import "./postcss.css"; import "virtual:visual-fallback.css";',
    );
    await writeFile(
      join(fixture, "probe.module.scss"),
      `
@layer components {
  .probeCard {
    padding: mantine.rem(16px);
    margin: mantine.rem(-2px);
    border-width: mantine.rem(0);
    @include mantine.smaller-than(mantine.$mantine-breakpoint-sm) { display: grid; }
    @include mantine.larger-than(mantine.$mantine-breakpoint-lg) { display: flex; }
    @include mantine.hover { opacity: 0.8; }
    @include mantine.rtl { float: right; }
    @include mantine.ltr { float: left; }
  }
}`,
    );
    await writeFile(join(fixture, "postcss.css"), ".postcss-proof { @mixin hover { opacity: 0.7; } }");
    const result = await build({
      configFile: false,
      root,
      css: mantineCss,
      plugins: [visualFallbackPlugin()],
      logLevel: "silent",
      build: {
        write: false,
        minify: false,
        cssMinify: false,
        lib: { entry: join(fixture, "entry.js"), formats: ["es"], fileName: "probe" },
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) => {
      if (!("output" in output)) throw new Error("Expected a finite Vite build, not a watcher");
      return output.output;
    });
    const css = outputs
      .filter((output) => output.type === "asset")
      .filter((output) => output.fileName.endsWith(".css"))
      .map((output) => String(output.source))
      .join("\n");
    const js = outputs
      .filter((output) => output.type === "chunk")
      .map((output) => output.code)
      .join("\n");
    expect(js).toContain("probeCard");
    expect(css).toContain("@layer components");
    expect(css).toContain("calc(1rem * var(--mantine-scale))");
    expect(css).toContain("calc(-0.125rem * var(--mantine-scale))");
    expect(css).toContain("calc(0rem * var(--mantine-scale))");
    expect(css).toMatch(/max-width:\s*48em/);
    expect(css).toMatch(/min-width:\s*75em/);
    expect(css).toMatch(/\[dir=["']?rtl/);
    expect(css).toMatch(/\[dir=["']?ltr/);
    expect(css).toContain(".postcss-proof:hover");
    expect(css).toContain(".postcss-proof:active");
    expect(css).toMatch(/hover:\s*hover/);
    expect(css).toMatch(/hover:\s*none/);
    expect(css).not.toContain("@mixin");
    expect(css).toMatch(/--mantine-color-placeholder:\s*var\(--app-color-muted-foreground\)/);
    expect(css).toContain(":root:not([data-color-scheme]):not([data-mantine-color-scheme])");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 30_000);
