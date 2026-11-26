import { globSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep, win32 } from "node:path";

import { parse, parseExpression } from "@babel/parser";
import { type Node, traverseFast } from "@babel/types";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

it("keeps paths in package TypeScript configs inside the package", () => {
  const violations: string[] = [];
  for (const file of globSync("**/tsconfig*.json", { cwd: root, exclude: ["node_modules/**", "dist/**"] })) {
    // TypeScript accepts comments and trailing commas in its configs.
    traverseFast(parseExpression(readFileSync(resolve(root, file), "utf8")), (node) => {
      if (node.type !== "StringLiteral") return;
      const path = node.value.replaceAll("\\", "/");
      const target = relative(root, resolve(root, dirname(file), path));
      if (win32.isAbsolute(path) || target === ".." || target.startsWith(".." + sep))
        violations.push(file + " references " + path);
    });
  }
  expect(violations).toEqual([]);
});

function moduleReference(node: Node): Node | undefined | null {
  switch (node.type) {
    case "ImportDeclaration":
    case "ExportNamedDeclaration":
    case "ExportAllDeclaration":
    case "ImportExpression":
      return node.source;
    case "TSImportType":
      return node.argument;
    case "TSExternalModuleReference":
      return node.expression;
    case "CallExpression":
      if (node.callee.type === "Identifier" && node.callee.name === "require") return node.arguments[0];
  }
  return undefined;
}

it("keeps literal imports, re-exports and requires inside the standalone package", () => {
  const violations: string[] = [];
  for (const file of globSync("**/*.{ts,tsx,js,mts,cts,mjs,cjs}", {
    cwd: root,
    exclude: ["node_modules/**", "dist/**"],
  })) {
    const source = readFileSync(resolve(root, file), "utf8");
    const tree = parse(source, {
      sourceType: "unambiguous",
      plugins: ["typescript", "jsx"],
      createImportExpressions: true,
    });
    traverseFast(tree, (node) => {
      const ref = moduleReference(node);
      const specifier =
        ref?.type === "StringLiteral"
          ? ref.value
          : ref?.type === "TemplateLiteral" && ref.expressions.length === 0
            ? ref.quasis[0].value.cooked
            : undefined;
      if (!specifier) return;
      const target = relative(root, resolve(root, dirname(file), specifier));
      if (
        specifier.startsWith("@repo/") ||
        (specifier.startsWith(".") && (target === ".." || target.startsWith(".." + sep)))
      ) {
        violations.push(file + " imports " + specifier);
      }
    });
  }
  expect(violations).toEqual([]);
});
