# Host and integration tests

Keep Node/Hono hosting and tests that require real host contexts here. Application production code under src/app must not import src/host. Host code may consume application lib/config/platform/services and server-only modules; integration tests may import the actual root and other modules under test with ~/ aliases. Keep same-directory imports relative.

Do not replace real BFF/context integration coverage with mocks during refactors. Pure component and fake-client tests stay colocated with application code. Every test here explicitly declares its Vitest environment on the first line: node for host-only tests, jsdom when rendering DOM. Derive route argument types from the actual exported loader/action, rather than importing ~/+types paths (rootDirs applies to relative generated-type imports).
