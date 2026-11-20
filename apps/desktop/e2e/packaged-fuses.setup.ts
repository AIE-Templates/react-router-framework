import { test } from "@playwright/test";

import { checkLaunchInputs, launchLocation } from "../scripts/launch.ts";

// Runs before any test of the packaged project (playwright.config.ts): a packaged test app that is
// missing or whose fuses are not the test profile's (scripts/fuses.ts, for example because its
// `afterPack` did not run) fails here, and none of the packaged tests start.
test("the packaged test app has the test profile's fuses", async () => {
  await checkLaunchInputs(launchLocation("packaged", "test"));
});
