// @vitest-environment node
import { pino } from "pino";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { handleError } from "./entry.server";
import { loggerContext } from "./lib/logger";

function setup(init?: RequestInit) {
  const lines: string[] = [];
  const context = new RouterContextProvider();
  context.set(loggerContext, pino({}, { write: (line: string) => lines.push(line) }));
  const request = new Request("http://localhost/page", init);
  return { lines, args: { request, context, params: {} } };
}

// The 404 React Router reports for an unmatched URL.
function routeErrorResponse(status: number) {
  return { status, statusText: "Not Found", internal: true, data: "No route matches URL" };
}

describe("handleError", () => {
  it("logs server errors", () => {
    const { lines, args } = setup();
    handleError(new Error("boom"), args);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("boom");
  });

  it("skips 4xx route error responses such as unmatched URLs", () => {
    const { lines, args } = setup();
    handleError(routeErrorResponse(404), args);
    expect(lines).toEqual([]);
  });

  it("logs actions React Router rejected for a foreign origin as a warning", () => {
    const { lines, args } = setup({ method: "POST", headers: { origin: "https://evil.example" } });
    handleError(new Error("Bad Request"), args);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"level":40');
    expect(lines[0]).toContain("cross-origin action rejected");
    expect(lines[0]).not.toContain("stack");
  });

  it("still logs errors from same-origin actions", () => {
    const { lines, args } = setup({ method: "POST", headers: { origin: "http://localhost" } });
    handleError(new Error("boom"), args);
    expect(lines[0]).toContain('"level":50');
  });

  it("skips aborted requests", () => {
    const controller = new AbortController();
    controller.abort();
    const { lines, args } = setup({ signal: controller.signal });
    handleError(new Error("client went away"), args);
    expect(lines).toEqual([]);
  });
});
