import type { Page } from "@playwright/test";

import { expect, quit, test, waitForApp } from "./desktop.ts";

const RECORD = { title: "Desktop storage", nested: { revision: 2 }, tags: ["app-origin", "persistent"] };

/** Real browser storage: wait for transaction completion, not just request success, then close. */
async function record(page: Page, operation: "read" | "write" | "delete"): Promise<unknown> {
  return page.evaluate(
    async ({ operation: action, value }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open("e2e-persistence", 1);
        open.addEventListener("upgradeneeded", () => open.result.createObjectStore("records"), { once: true });
        open.addEventListener("success", () => resolve(open.result), { once: true });
        open.addEventListener("error", () => reject(open.error), { once: true });
        open.addEventListener("blocked", () => reject(new Error("IndexedDB open was blocked")), { once: true });
      });
      try {
        return await new Promise<unknown>((resolve, reject) => {
          const transaction = db.transaction("records", action === "read" ? "readonly" : "readwrite");
          const store = transaction.objectStore("records");
          const request =
            action === "write"
              ? store.put(value, "probe")
              : action === "delete"
                ? store.delete("probe")
                : store.get("probe");
          transaction.addEventListener("complete", () => resolve(request.result), { once: true });
          transaction.addEventListener(
            "abort",
            () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")),
            { once: true },
          );
        });
      } finally {
        db.close();
      }
    },
    { operation, value: RECORD },
  );
}

test("IndexedDB survives a reload on the application origin", async ({ desktop: { page } }) => {
  expect(await record(page, "read")).toBeUndefined();
  await record(page, "write");
  await page.reload();
  await waitForApp(page);
  expect(await record(page, "read")).toEqual(RECORD);
});

test("IndexedDB survives closing and reopening a macOS window", async ({ desktop: { app, page } }) => {
  test.skip(process.platform !== "darwin", "Other platforms quit after their last window closes");
  await record(page, "write");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  const opened = app.waitForEvent("window");
  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit("activate");
  });
  const next = await opened;
  await waitForApp(next);
  expect(await record(next, "read")).toEqual(RECORD);
});

test("IndexedDB writes and deletions survive quitting immediately after the transaction commits", async ({
  launchApp,
}) => {
  const first = await launchApp();
  expect(await record(first.page, "read")).toBeUndefined();
  await record(first.page, "write");
  await quit(first);

  const second = await launchApp();
  expect(await record(second.page, "read")).toEqual(RECORD);
  await record(second.page, "delete");
  await quit(second);

  const third = await launchApp();
  expect(await record(third.page, "read")).toBeUndefined();
});
