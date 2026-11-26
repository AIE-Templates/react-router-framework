import { defineConfig } from "oxlint";

export default defineConfig({
  // Setting `plugins` replaces the defaults, so the default ones are listed too.
  plugins: ["eslint", "typescript", "unicorn", "oxc", "react", "jsx-a11y", "import", "promise", "vitest"],
  categories: {
    correctness: "error",
    suspicious: "warn",
  },
  options: {
    typeAware: true,
  },
  env: {
    browser: true,
    node: true,
  },
  settings: {
    react: {
      linkComponents: [
        { name: "Link", attributes: ["to"] },
        { name: "NavLink", attributes: ["to"] },
      ],
    },
  },
  overrides: [
    {
      files: ["apps/*/src/**"],
      rules: { "import/no-relative-parent-imports": "error" },
    },
    {
      files: ["apps/web/src/app/**"],
      excludeFiles: ["**/*.test.{ts,tsx}", "apps/web/src/app/testing/**"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            name: "@mantine/core",
            importNames: ["useMantineColorScheme"],
            message:
              "Use useVisualState and useVisualActions from ~/managers/visual/hooks for the application color scheme.",
          },
        ],
      },
    },
  ],
  rules: {
    "unicorn/filename-case": ["error", { case: "kebabCase" }],
    // Hook rules sit in the `pedantic` category, which is not enabled.
    "react/rules-of-hooks": "error",
    // Not needed with the automatic JSX runtime.
    "react/react-in-jsx-scope": "off",
    "react/only-export-components": [
      "warn",
      {
        allowExportNames: [
          "meta",
          "links",
          "headers",
          "loader",
          "clientLoader",
          "action",
          "clientAction",
          "middleware",
          "clientMiddleware",
          "shouldRevalidate",
          "handle",
          "ErrorBoundary",
          "HydrateFallback",
        ],
      },
    ],
    // Allow promise-returning JSX handlers such as onClick={() => navigate("/")}; other misuses still error.
    "typescript/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
    "import/no-cycle": "error",
    "import/no-unassigned-import": ["warn", { allow: ["**/*.css", "@testing-library/jest-dom/vitest"] }],
  },
});
