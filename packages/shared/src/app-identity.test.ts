import { describe, expect, it } from "vitest";

import { cookieName, cookieSafe, storageKey } from "./app-identity.ts";

describe("application persistence identity", () => {
  it("preserves deployed visual storage and cookie names", () => {
    expect(storageKey("visual-preferences")).toBe("framework-app:visual-preferences");
    expect(cookieName("visual")).toBe("framework-app_visual");
  });

  it("normalizes app IDs without changing cookie-safe characters", () => {
    expect(cookieSafe("com.example/app:one")).toBe("com_example_app_one");
    expect(cookieSafe("App-1_name")).toBe("App-1_name");
  });
});
