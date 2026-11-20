import { describe, expect, it } from "vitest";

import { DEBUG_ENV, DEV_ENV } from "../src/debug-env.names.ts";
import { BENCH_PREFIX } from "../src/diagnostics/bench/routes.ts";
import { E2E_PREFIX } from "../src/diagnostics/e2e/routes.ts";
import { SMOKE_PREFIX } from "../src/diagnostics/smoke/routes.ts";
import { REMOTE_DEBUGGING_REFUSED_MESSAGE } from "../src/startup-signals.ts";
import type { Bundle } from "./build-profile.ts";
import { BUNDLE_MARKERS, checkBundleTexts, desktopNames, hasMarker, RELEASE_DESKTOP_ENV } from "./bundle-markers.ts";

// Bundle text shaped like minified output.
const release: Record<Bundle, string> = {
  "main.cjs":
    'let e=require("electron");var Ft=`remote debugging refused`;let r=process.env.DESKTOP_CHROME_MODE,' +
    "s={WEB_SHELL_DESKTOP_ENV:process.env.XDG_CURRENT_DESKTOP};X.info({buildProfile:`release`},`build profile`)",
  "preload.cjs": 'let e=require("electron");e.contextBridge.exposeInMainWorld(`desktop`,{})',
  "utility.mjs": "const t=process.env.CLIENT_DIR,n=e.WEB_SHELL_DESKTOP_ENV;process.parentPort.on(`message`,()=>{})",
};
const test: Record<Bundle, string> = {
  "main.cjs":
    "var q={bootProfile:`DESKTOP_BOOT_PROFILE`,portAckCoalesce:`DESKTOP_PORT_ACK_COALESCE`,smoke:`DESKTOP_SMOKE`," +
    "smokeLayout:`DESKTOP_SMOKE_LAYOUT`,smokeScreenshot:`DESKTOP_SMOKE_SCREENSHOT`,bench:`DESKTOP_BENCH`," +
    "benchCases:`DESKTOP_BENCH_CASES`,benchWarmupMs:`DESKTOP_BENCH_WARMUP_MS`,benchMeasureMs:`DESKTOP_BENCH_MEASURE_MS`," +
    "benchLabel:`DESKTOP_BENCH_LABEL`,e2e:`DESKTOP_E2E`};globalThis.desktopBuildProfile=`test`;" +
    "fetch(`/__smoke/sse?id=1`);fetch(`/__bench/proc`);process.stdout.write(`SMOKE_RESULT ${a}`);" +
    "process.stdout.write(`BENCH_RESULT ${b}`);let r=process.env.DESKTOP_CHROME_MODE",
  "preload.cjs": release["preload.cjs"],
  "utility.mjs": "var a=`/__smoke`,b=`/__bench/`,c=`/__e2e`;app.route(c,d());process.parentPort.on(`message`,()=>{})",
};
const withLine = (code: Record<Bundle, string>, bundle: Bundle, line: string) => ({
  ...code,
  [bundle]: `${code[bundle]};${line}`,
});
const without = (code: Record<Bundle, string>, text: string) => ({
  "main.cjs": code["main.cjs"].replaceAll(text, "x"),
  "preload.cjs": code["preload.cjs"].replaceAll(text, "x"),
  "utility.mjs": code["utility.mjs"].replaceAll(text, "x"),
});

describe("the markers", () => {
  it("name every variable the readers take from the shared list, and the diagnostics' own markers", () => {
    const texts = BUNDLE_MARKERS.map((marker) => marker.text);
    expect(texts).toEqual(expect.arrayContaining([...Object.values(DEBUG_ENV), ...Object.values(DEV_ENV)]));
    expect(texts).toEqual(expect.arrayContaining([SMOKE_PREFIX, BENCH_PREFIX, E2E_PREFIX]));
    expect(texts).toEqual(expect.arrayContaining(["SMOKE_RESULT", "BENCH_RESULT", "desktopBuildProfile"]));
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("belong to dev and test, or to dev alone; none belongs to release", () => {
    for (const marker of BUNDLE_MARKERS) expect(marker.profiles).not.toContain("release");
    expect(BUNDLE_MARKERS.filter((marker) => !marker.profiles.includes("test")).map((marker) => marker.text)).toEqual(
      Object.values(DEV_ENV),
    );
  });

  it("match names whole and paths anywhere", () => {
    const smoke = { text: "DESKTOP_SMOKE", name: true };
    expect(hasMarker("process.env.DESKTOP_SMOKE===`1`", smoke)).toBe(true);
    expect(hasMarker("e[`DESKTOP_SMOKE`]", smoke)).toBe(true);
    expect(hasMarker('{"DESKTOP_SMOKE":"1"}', smoke)).toBe(true);
    expect(hasMarker("process.env.DESKTOP_SMOKE_LAYOUT", smoke)).toBe(false);
    expect(hasMarker("process.env.MY_DESKTOP_SMOKE", smoke)).toBe(false);
    expect(hasMarker("fetch(`/__e2e/cookies`)", { text: "/__e2e", name: false })).toBe(true);
    expect(hasMarker("fetch(`/api/__e2e`)", { text: "/__e2e", name: false })).toBe(true);
    expect(hasMarker("fetch(`/e2e`)", { text: "/__e2e", name: false })).toBe(false);
  });

  it("list the DESKTOP_* names in code, not the tails of longer names", () => {
    expect(desktopNames(release["main.cjs"])).toEqual(["DESKTOP_CHROME_MODE"]);
    expect(desktopNames("a.DESKTOP_B_2;WEB_SHELL_DESKTOP_ENV;`DESKTOP_A`;x$DESKTOP_C;DESKTOP_A")).toEqual([
      "DESKTOP_A",
      "DESKTOP_B_2",
    ]);
  });
});

describe("checkBundleTexts", () => {
  it("accepts release and test bundles as they are built", () => {
    expect(checkBundleTexts("release", release)).toEqual({
      problems: [],
      findings: [
        "none of 18 markers in main.cjs, preload.cjs, utility.mjs (debug environment variable, " +
          "development environment variable, diagnostic route prefix, diagnostic result marker, build profile global)",
        'main.cjs refuses remote debugging ("remote debugging refused")',
      ],
    });
    const result = checkBundleTexts("test", test);
    expect(result.problems).toEqual([]);
    expect(result.findings).toHaveLength(3);
    expect(result.findings[1]).toMatch(/^all 17 markers of the test profile found: DESKTOP_BOOT_PROFILE, /);
  });

  it.each([
    ["main.cjs", "let v=process.env.DESKTOP_SMOKE", "the debug environment variable DESKTOP_SMOKE"],
    ["main.cjs", "let v=process.env[`DESKTOP_BENCH_LABEL`]", "the debug environment variable DESKTOP_BENCH_LABEL"],
    ["utility.mjs", "const {DESKTOP_E2E:v}=process.env", "the debug environment variable DESKTOP_E2E"],
    ["preload.cjs", "process.env.DESKTOP_BOOT_PROFILE", "the debug environment variable DESKTOP_BOOT_PROFILE"],
    [
      "main.cjs",
      "t.setPath(`userData`,process.env.DESKTOP_USER_DATA_SUFFIX)",
      "the development environment variable DESKTOP_USER_DATA_SUFFIX",
    ],
    ["utility.mjs", "e.route(`/__e2e`,n())", "the diagnostic route prefix /__e2e"],
    ["utility.mjs", "e.pathname.startsWith(`/__bench/`)", "the diagnostic route prefix /__bench/"],
    ["main.cjs", "fetch(`/__smoke/sse-status`)", "the diagnostic route prefix /__smoke"],
    ["main.cjs", "process.stdout.write(`SMOKE_RESULT ${e}`)", "the diagnostic result marker SMOKE_RESULT"],
    ["main.cjs", "process.stdout.write(`BENCH_RESULT ${e}`)", "the diagnostic result marker BENCH_RESULT"],
    ["main.cjs", "globalThis.desktopBuildProfile=`release`", "the build profile global desktopBuildProfile"],
  ] as const)("fails a release %s that contains %j", (bundle, line, what) => {
    expect(checkBundleTexts("release", withLine(release, bundle, line)).problems).toEqual([
      `.vite/release/${bundle} contains ${what}, which the release profile must not`,
    ]);
  });

  it("fails a release bundle that names a DESKTOP_* variable nobody listed", () => {
    expect(checkBundleTexts("release", withLine(release, "main.cjs", "process.env.DESKTOP_TRACE")).problems).toEqual([
      `.vite/release/main.cjs contains DESKTOP_TRACE: a release build reads no DESKTOP_* variable but ${RELEASE_DESKTOP_ENV.join(", ")}`,
    ]);
    // A longer name than a listed one is another variable, and not a listed one.
    expect(checkBundleTexts("release", withLine(release, "utility.mjs", "e.DESKTOP_SMOKE_RETRIES")).problems).toEqual([
      ".vite/release/utility.mjs contains DESKTOP_SMOKE_RETRIES: a release build reads no DESKTOP_* variable but DESKTOP_CHROME_MODE",
    ]);
  });

  it("fails a release main bundle that does not refuse remote debugging", () => {
    expect(checkBundleTexts("release", without(release, REMOTE_DEBUGGING_REFUSED_MESSAGE)).problems).toEqual([
      '.vite/release/main.cjs does not contain "remote debugging refused": it does not refuse remote debugging',
    ]);
  });

  it("fails the positive control when a test bundle no longer shows a marker", () => {
    for (const marker of BUNDLE_MARKERS.filter(({ profiles }) => profiles.includes("test"))) {
      // Each marker must be found by itself: DESKTOP_SMOKE_LAYOUT does not stand in for DESKTOP_SMOKE.
      const code = marker.name
        ? {
            "main.cjs": test["main.cjs"].replace(new RegExp(`${marker.text}(?![A-Z_])`, "g"), "x"),
            "preload.cjs": test["preload.cjs"],
            "utility.mjs": test["utility.mjs"],
          }
        : without(test, marker.text);
      expect(checkBundleTexts("test", code).problems).toEqual([
        `no test bundle contains the ${marker.kind} ${marker.text}: the check cannot see what it looks for`,
      ]);
    }
    // The release bundles, presented as test: nothing found, so nothing proven.
    expect(checkBundleTexts("test", without(release, REMOTE_DEBUGGING_REFUSED_MESSAGE)).problems).toHaveLength(17);
  });

  it("fails a test bundle that contains the dev build's variable or the release build's refusal", () => {
    expect(
      checkBundleTexts("test", withLine(test, "main.cjs", "process.env[`DESKTOP_USER_DATA_SUFFIX`]")).problems,
    ).toEqual([
      ".vite/test/main.cjs contains the development environment variable DESKTOP_USER_DATA_SUFFIX, which the test profile must not",
    ]);
    expect(checkBundleTexts("test", withLine(test, "main.cjs", "var Ft=`remote debugging refused`")).problems).toEqual([
      '.vite/test/main.cjs contains "remote debugging refused": only release builds refuse remote debugging, ' +
        "so finding the message would no longer show that a build does",
    ]);
  });
});
