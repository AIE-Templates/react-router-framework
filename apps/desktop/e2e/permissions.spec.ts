import { expect, test } from "./desktop.ts";

test("notifications and media remain denied for the app document", async ({ desktop: { page } }) => {
  const checks = await page.evaluate(async () => ({
    notifications: (await navigator.permissions.query({ name: "notifications" })).state,
    microphone: (await navigator.permissions.query({ name: "microphone" })).state,
    camera: (await navigator.permissions.query({ name: "camera" })).state,
  }));
  expect(checks).toEqual({ notifications: "denied", microphone: "denied", camera: "denied" });
  // Only request after checking the deny policy. The launch also uses synthetic media devices.
  const requests = await page.evaluate(async () => {
    const notifications = await Notification.requestPermission();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      for (const track of stream.getTracks()) track.stop();
      return { notifications, media: "granted" };
    } catch (error) {
      return { notifications, media: error instanceof Error ? error.name : "unknown" };
    }
  });
  expect(requests).toEqual({ notifications: "denied", media: "NotAllowedError" });
});

test("a user gesture can write the clipboard from the app's main frame", async ({ desktop: { app, page } }) => {
  // Materialize every format before overwriting it; keep the snapshot inside the main process.
  const saved = await app.evaluateHandle(async ({ clipboard, ClipboardItem }) =>
    Promise.all(
      (await clipboard.read())
        .filter((item) => item.types.length > 0)
        .map(
          async (item) =>
            new ClipboardItem(
              Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)]))),
            ),
        ),
    ),
  );
  try {
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = "Copy permission test";
      button.style.cssText = "position: fixed; left: 16px; bottom: 16px; z-index: 99999; app-region: no-drag";
      button.addEventListener("click", () => {
        void navigator.clipboard.writeText("desktop-permission-e2e").then(
          () => {
            button.dataset.result = "copied";
            return undefined;
          },
          (error: unknown) => {
            button.dataset.result = error instanceof Error ? error.name : "unknown";
            return undefined;
          },
        );
      });
      document.body.append(button);
    });
    const copy = page.getByRole("button", { name: "Copy permission test", exact: true });
    await copy.click();
    await expect(copy).toHaveAttribute("data-result", "copied");
    expect(await app.evaluate(async ({ clipboard }) => (await clipboard.readText()) === "desktop-permission-e2e")).toBe(
      true,
    );
  } finally {
    await app.evaluate(async ({ clipboard }, items) => {
      // An empty clipboard (possibly with only macOS find text) has no payload to overwrite ours.
      if (!items.some((item) => item.types.some((type) => type !== "electron application/findtext"))) clipboard.clear();
      if (items.length > 0) await clipboard.write(items);
    }, saved);
    await saved.dispose();
  }
});
