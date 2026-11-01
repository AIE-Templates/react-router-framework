// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { expect, it } from "vitest";

import { BREAKPOINTS } from "~/config/breakpoints";

const appDirectory = resolve(import.meta.dirname, "..");
const reservedFeatures = new Set([
  "app",
  "mantine",
  "color",
  "font",
  "text",
  "font-weight",
  "tracking",
  "leading",
  "breakpoint",
  "container",
  "spacing",
  "radius",
  "shadow",
  "inset-shadow",
  "drop-shadow",
  "blur",
  "perspective",
  "aspect",
  "ease",
  "animate",
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(css|scss|ts|tsx)$/.test(file) && !/\.test\.[^.]+$/.test(file) ? [file] : [];
  });
}

const blank = (text: string) => text.replace(/[^\n]/g, " ");

function withoutComments(source: string) {
  let result = source.replace(/\/\*[\s\S]*?\*\//g, blank);
  // Only whole-line or whitespace-delimited JS comments, preserving URL strings.
  result = result.replace(/(^|\s)\/\/[^\n]*/gm, blank);
  return result;
}

/** Preserve offsets/lines while ignoring comments and nested Tailwind theme declarations. */
function definitionsSource(source: string) {
  let result = withoutComments(source);
  for (const match of result.matchAll(/@theme\b[^{}]*\{/g)) {
    const start = match.index;
    let depth = 1;
    let end = start + match[0].length;
    while (end < result.length && depth > 0) {
      if (result[end] === "{") depth++;
      if (result[end] === "}") depth--;
      end++;
    }
    result = result.slice(0, start) + blank(result.slice(start, end)) + result.slice(end);
  }
  return result;
}

function location(source: string, index: number) {
  const line = source.slice(0, index).split("\n").length;
  const text = source.split("\n")[line - 1] ?? "";
  return { line, exempt: /(?:\/\*|\/\/).*naming-allow:\s*\S/.test(text) };
}

it("keeps application CSS definitions in their namespaces and avoids transformed color/dimension functions", () => {
  const violations: string[] = [];
  for (const file of sourceFiles(appDirectory)) {
    const path = relative(appDirectory, file).replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
    const cleaned = definitionsSource(source);
    const feature = /^features\/([^/]+)\//.exec(path)?.[1];
    if (feature && reservedFeatures.has(feature)) violations.push(`${path}: reserved feature name ${feature}`);
    const report = (index: number, message: string) => {
      const { line, exempt } = location(source, index);
      if (!exempt) violations.push(`${path}:${line}: ${message}`);
    };
    // CSS declarations, CSS inside TS templates, and quoted/unquoted object keys.
    const definitions = [...cleaned.matchAll(/(--[\w-]+)["']?\s*:/g)];
    // Literal setProperty calls are definitions too; reads via var/getPropertyValue are not.
    definitions.push(...cleaned.matchAll(/\.setProperty\s*\(\s*["'`]?(--[\w-]+)["'`]/g));
    for (const match of definitions) {
      const name = match[1];
      if (name.startsWith("--app-shell-")) {
        report(match.index, `${name} is reserved for Mantine AppShell`);
      } else if (
        !name.startsWith("--app-") &&
        !name.startsWith("--mantine-") &&
        !name.startsWith("--tw-") &&
        !(feature && name.startsWith(`--${feature}-`))
      ) {
        report(match.index, `unexpected CSS variable definition ${name}`);
      }
    }
    // Stylesheets and CSS template strings only: ordinary JS function names are not CSS.
    const functionsSource = withoutComments(source);
    const regions = /\.(css|scss)$/.test(file)
      ? [{ text: functionsSource, index: 0 }]
      : [...functionsSource.matchAll(/`(?:\\.|[^`])*`/g)]
          .filter((match) => /--[\w-]+\s*:|@(?:media|layer)|[{}]/.test(match[0]))
          .map((match) => ({ text: match[0], index: match.index }));
    for (const region of regions) {
      for (const match of region.text.matchAll(/(?<![\w.-])(light-dark|rem)\s*\(/g)) {
        report(region.index + match.index, `${match[1]}() is forbidden; use semantic colors or mantine.rem()`);
      }
    }
  }
  expect(violations, "CSS namespace/function violations (inline naming-allow: reason for reviewed exceptions)").toEqual(
    [],
  );
});

it("uses configured em breakpoints for literal viewport media-query widths", () => {
  const allowed = new Set<string>(Object.values(BREAKPOINTS));
  const violations: string[] = [];
  for (const file of sourceFiles(appDirectory)) {
    const path = relative(appDirectory, file).replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
    const cleaned = definitionsSource(source);
    // Deliberately excludes @container and normal element dimensions.
    for (const query of cleaned.matchAll(/@media\b[^{};]+/g)) {
      if (!/(?:min-|max-)?width\b/.test(query[0])) continue;
      const widths = [
        ...query[0].matchAll(/(?:min-|max-)?width\s*(?::|[<>]=?|=)\s*(\d*\.?\d+(?:px|rem|em))\b/g),
        ...query[0].matchAll(/\b(\d*\.?\d+(?:px|rem|em))\s*[<>]=?\s*width\b/g),
      ];
      for (const width of widths) {
        const { line, exempt } = location(source, query.index + width.index);
        if (!allowed.has(width[1]) && !exempt)
          violations.push(`${path}:${line}: viewport width ${width[1]} is not in BREAKPOINTS`);
      }
    }
  }
  expect(violations).toEqual([]);
});
