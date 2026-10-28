import { createRequire } from "node:module";

// Electron has no install script: it downloads and unpacks its binary the first time `electron` is
// required. Do that once, here, before the test files import it from parallel workers, which would
// otherwise unpack it concurrently and fail.
export default function setup() {
  createRequire(import.meta.url)("electron");
}
