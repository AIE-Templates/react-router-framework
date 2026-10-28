// SSR build entry. build/server/index.js must stay a React Router server build, which prerendering
// imports directly, so re-export it alongside the host app and what server.ts needs to run it.
export * from "virtual:react-router/server-build";
export { createHostApp, getHostApp, type HostAppOptions } from "./app";
export { createWebApp, type WebAppOptions } from "./web-app";
export { API_BASE_PATH, logger, logStreamFailure, rethrowNonErrors, startServer } from "@repo/server";
