# Fix build profiles at build time and verify release from outside

Status: Accepted

## Context

Diagnostics (smoke, benchmark, E2E endpoints), the development proxy and the debug environment variables were bundled into every build and gated at run time, so the shipped application carried test capabilities that one missed check could expose. Playwright's Electron driver needs the Node inspector, which a hardened package disables, so the shipped package cannot be driven like the test package.

## Decision

Three build profiles, `dev`, `test` and `release`, are compiled in (`DESKTOP_BUILD_PROFILE`) with separate bundle directories (`.vite/<profile>`) and package directories (`out/test`, `out/release`). The build configuration replaces excluded modules with empty implementations of the same contract (`PROFILE_ENTRIES`). Release carries no debug or test capability: no diagnostics, no development code, no debug variable reads, no DevTools, and it refuses Chromium remote debugging at startup with exit status 97. Both packages take fuses from one table; the test package keeps only the Node inspector on. Users can launch the packaged release app directly or via `pnpm start:desktop`. Automated release verification uses `verify:release` to check it from outside. Playwright drives the test profile.

## Consequences

Test and release JavaScript are not the same artifact, so a test result does not transfer to release automatically. The difference list in HOST-11 is the contract: `verify:build` checks bundle contents against it with test as positive control, and `verify:release` checks the shipped package's fuses, archive, debugging refusal and clean startup and quit. Application behavior is exercised only on the test profile. Adding a debug capability means adding it to a profile entry and to the `verify:build` markers; a release-only failure outside the difference list is observable only through `verify:release` or by hand.
