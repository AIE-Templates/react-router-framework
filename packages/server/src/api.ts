import { Hono } from "hono";

import { health } from "./routes/health.ts";

/** Where the API is mounted. Hosts use it to tell API requests from page requests. */
export const API_BASE_PATH = "/api";

// The API. Mount each route module with `.route()` in one chain so ApiType covers all of them.
export const api = new Hono().basePath(API_BASE_PATH).route("/health", health);

export type ApiType = typeof api;
