import { join } from "node:path";

interface UserDataApp {
  getPath(name: "userData"): string;
  setPath(name: "userData", path: string): void;
}

/** Select the instance directory before deriving any storage or utility cache paths. */
export function configureUserData(app: UserDataApp, suffix: string | undefined) {
  if (suffix) app.setPath("userData", `${app.getPath("userData")}-${suffix}`);
  const userData = app.getPath("userData");
  return { userData, compileCacheDir: join(userData, "compile-cache") };
}
