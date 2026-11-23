/** Template-layer boundaries. Kept separate so regression cases need no Git repository. */
export function ownedFileViolation(branch: string, path: string): string | undefined {
  const electron = branch.startsWith("platform/electron/");
  const fullstack = electron || branch.includes("fullstack");
  const core = electron || branch.startsWith("app/");
  const mantine = branch.endsWith("/mantine");
  if (/^docs\//.test(path) && !/^docs\/specs\//.test(path))
    return "Non-spec docs file";
  if (!electron && /^(apps\/desktop\/|packages\/(channel|port-fetch)\/|bench\/transport\/|packages\/shared\/src\/(desktop-|preferences|shell.test))/.test(path))
    return "Electron-owned file";
  if (!fullstack && (/^(packages\/server\/|apps\/web\/(src\/host\/|server\.ts$|src\/app\/(entry\.server\.tsx$|lib\/|managers\/[^/]+\/persistence\/|config\/visual-cookie\.ts$|providers\/document-nonce\.ts$)))/.test(path) || /\.server\.ts$/.test(path)))
    return "Fullstack-owned file";
  if (!core && /^(packages\/shared\/|apps\/web\/src\/app\/((providers|layouts|window-chrome|managers|config|testing)\/|components\/appearance-settings\.tsx$|styles\/(tokens|shell|ui|naming\.test)\.))/.test(path))
    return "Core-owned file";
  if (!mantine && (/^apps\/web\/(vite-plugins\/|postcss\.config\.js$|src\/app\/(managers\/[^/]+\/mantine\/|styles\/_mantine\.scss$))/.test(path) || /\.module\.scss$/.test(path)))
    return "Mantine-owned file";
  if (!electron && /^apps\/web\/src\/app\/platform\/electron\//.test(path))
    return "Electron-owned file";
  return undefined;
}

/** Retired web entry points forbidden on every template branch. */
export function retiredWebPath(path: string): boolean {
  return /^apps\/web\/(visual-fallback-plugin\.ts$|src\/app\/(app\.css$|(?:routes|welcome|window-chrome)\/|providers\/environment\.ts$|managers\/visual\/settings\.tsx$|lib\/(?:shell|preferences)\.ts$))/.test(path);
}
