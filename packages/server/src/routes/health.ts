import { Hono } from "hono";

// Chain route definitions so hono/client can infer their types.
export const health = new Hono().get("/", (c) => c.json({ status: "ok" }));
