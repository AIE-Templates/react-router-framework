// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { parse } from "@babel/parser";
import { expect, it } from "vitest";

const appDirectory = resolve(import.meta.dirname, "../../src/app");
const hostDirectory = resolve(appDirectory, "../host");
const inside = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);
const feature = (path: string) => /^features\/([^/]+)\//.exec(path)?.[1];
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
const testFile = (path: string) => /\.(test|spec)(?:\.[cm]?[jt]sx?)?$/.test(path) || path.startsWith("testing/");

/** Check module references, including re-exports, dynamic imports and require, without matching comments/strings. */
function violations(path: string, source: string): string[] {
  if (testFile(path)) return [];
  const errors: string[] = [];
  const inspect = (specifier: string) => {
    const target = specifier.startsWith("~/")
      ? resolve(appDirectory, specifier.slice(2))
      : specifier.startsWith(".")
        ? resolve(appDirectory, dirname(path), specifier)
        : undefined;
    if (!target) return;
    if (inside(hostDirectory, target)) errors.push(`${path}: app must not import host (${specifier})`);
    if (!inside(appDirectory, target)) return;
    const targetPath = relative(appDirectory, target).split(sep).join("/");
    const from = feature(path);
    const to = feature(targetPath);
    if (to && from !== to) errors.push(`${path}: feature ${to} is private (${specifier})`);
    if (testFile(targetPath)) errors.push(`${path}: production must not import test helpers (${specifier})`);
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!record(value)) return;
    const node = value;
    if (
      ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(
        String(node.type),
      )
    ) {
      const reference = node.source;
      if (record(reference) && typeof reference.value === "string") inspect(reference.value);
    }
    if (node.type === "CallExpression") {
      const callee = node.callee;
      if (record(callee) && (callee.type === "Import" || (callee.type === "Identifier" && callee.name === "require"))) {
        const argument: unknown = Array.isArray(node.arguments) ? node.arguments[0] : undefined;
        if (record(argument) && typeof argument.value === "string") inspect(argument.value);
      }
    }
    if (node.type === "TSImportType") {
      const argument = node.argument;
      if (record(argument) && typeof argument.value === "string") inspect(argument.value);
    }
    Object.values(node).forEach(visit);
  };
  visit(parse(source, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] }));
  return errors;
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.[cm]?[jt]sx?$/.test(path) ? [path] : [];
  });
}

it("keeps application, host, feature and testing boundaries", () => {
  const errors = sources(appDirectory).flatMap((file) =>
    violations(relative(appDirectory, file).split(sep).join("/"), readFileSync(file, "utf8")),
  );
  expect(errors).toEqual([]);
});

it.each([
  ["components/button.tsx", 'import x from "~/features/demo/welcome"'],
  ["features/orders/page.tsx", 'export { x } from "~/features/accounts/model"'],
  ["features/orders/page.tsx", 'import("../../../host/app")'],
  ["lib/client.ts", 'require("../../host/app")'],
  ["root.tsx", 'import type { X } from "~/../host/app"'],
  ["lib/client.ts", 'type X = import("~/../host/app").X'],
  ["components/button.tsx", 'import { x } from "~/testing/render"'],
  ["components/button.tsx", 'export * from "~/components/button.test"'],
])("rejects invalid dependency in %s: %s", (path, source) => {
  expect(violations(path, source).length).toBeGreaterThan(0);
});

it.each([
  ["features/orders/page.tsx", 'import x from "./model"'],
  ["features/orders/page.tsx", 'import x from "~/components/button"'],
  ["root.tsx", 'import x from "~/providers/app-root"'],
  ["features/demo/page.test.tsx", 'import x from "~/testing/render"'],
  ["testing/render.tsx", 'import x from "~/providers/app-root"'],
  ["lib/client.ts", '// import x from "~/features/demo/welcome"\nconst text = "~/../host/app";'],
])("allows valid dependency in %s: %s", (path, source) => {
  expect(violations(path, source)).toEqual([]);
});
