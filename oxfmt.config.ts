import { defineConfig } from "oxfmt";

export default defineConfig({
  sortImports: true,
  sortTailwindcss: {
    stylesheet: "./apps/web/src/app/styles/index.css",
    functions: ["clsx", "cn", "cva"],
  },
  sortPackageJson: {
    sortScripts: true,
  },
});
