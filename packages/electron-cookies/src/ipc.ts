import type { Cookie, Cookies, IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";

import type { ScriptCookies } from "./script-cookies.ts";
import { cookieIpcChannels, type CookiePush, type CookieReply } from "./shared.ts";
import { createCookieSnapshots } from "./snapshots.ts";
import { type CookieLogger, CookieStoreTimeoutError, STORE_TIMEOUT_MS, storeDeadline } from "./store.ts";

export const SYNC_STORE_TIMEOUT_MS = 1_000;
export const SYNC_STORE_PROBE_TIMEOUT_MS = 50;
const COOLDOWN_MS = 5_000;

export interface CookieIpcOptions {
  prefix: string;
  jar: { script: ScriptCookies };
  ipcMain: { on(...args: Parameters<IpcMain["on"]>): void; handle: IpcMain["handle"] };
  changes: { on(...args: Parameters<Cookies["on"]>): void };
  ownsSender(this: void, sender: WebContents): boolean;
  isAppUrl(this: void, url: string): boolean;
  log: CookieLogger;
}

export function installCookieIpc({
  prefix,
  jar: { script },
  ipcMain,
  changes,
  ownsSender,
  isAppUrl,
  log,
}: CookieIpcOptions): void {
  const channels = cookieIpcChannels(prefix);
  const registrations = new Map<WebFrameMain, { creationUrl: string; documentId: string; sender: WebContents }>();
  let cooldownUntil = 0;
  let cooldownGeneration = -1;
  const snapshots = createCookieSnapshots(script);

  function trusted(frame: WebFrameMain | null, sender: WebContents, url: unknown): url is string {
    // Electron supplies the effective origin. Node's URL.origin for a custom scheme is "null".
    // A detached frame can still submit its document's pagehide write.
    if (!frame || frame.isDestroyed() || typeof url !== "string") return false;
    const { origin } = frame;
    return origin !== "null" && origin === script.origin && ownsSender(sender) && isAppUrl(url);
  }

  function cooling(generation: number) {
    return generation === cooldownGeneration && performance.now() < cooldownUntil;
  }

  async function sync(event: IpcMainEvent, url: unknown, op: "get" | "set", text?: unknown) {
    const receivedAt = performance.now();
    let reply: string | null = op === "get" ? "" : null;
    let deadline: ReturnType<typeof storeDeadline> | undefined;
    let acceptedUrl: string | undefined;
    let probing = false;
    let generation = -1;
    try {
      const frame = event.senderFrame;
      generation = script.successfulStoreCalls;
      probing = cooling(generation);
      if (!trusted(frame, event.sender, url)) return;
      deadline = storeDeadline(probing ? SYNC_STORE_PROBE_TIMEOUT_MS : SYNC_STORE_TIMEOUT_MS, receivedAt);
      acceptedUrl = url;
      if (op === "get") {
        const value = await script.readText(url, deadline.signal);
        snapshots.record(url, value);
        reply = value;
      } else if (typeof text === "string") {
        const result = await script.writeText(url, text, deadline.signal);
        reply = result.status;
      }
    } catch {
      if (acceptedUrl !== undefined && op === "get") reply = snapshots.fallback(acceptedUrl);
    } finally {
      deadline?.clear();
      if (deadline?.signal.aborted) {
        // A late timeout from an earlier request cannot undo a success during its wait.
        if (!probing && generation === script.successfulStoreCalls && !cooling(generation)) {
          cooldownGeneration = generation;
          cooldownUntil = performance.now() + COOLDOWN_MS;
        }
      }
      event.returnValue = reply;
      if (deadline?.signal.aborted) log.debug({ operation: op }, "synchronous cookie store call timed out");
    }
  }

  ipcMain.on(channels.get, (event, url: unknown) => void sync(event, url, "get"));
  ipcMain.on(channels.set, (event, url: unknown, text: unknown) => void sync(event, url, "set", text));

  function trustedUrl(event: IpcMainInvokeEvent, url: unknown) {
    const frame = event.senderFrame;
    return trusted(frame, event.sender, url) ? url : undefined;
  }

  ipcMain.handle(channels.getAll, (event, url: unknown, name: unknown) =>
    invokeCookieStore(trustedUrl(event, url), (creationUrl, signal) => {
      if (name !== undefined && typeof name !== "string") throw new TypeError("Invalid cookie name");
      return script.readAll(creationUrl, name, signal);
    }),
  );
  ipcMain.handle(channels.storeSet, (event, url: unknown, input: unknown) =>
    invokeCookieStore(trustedUrl(event, url), (creationUrl, signal) =>
      script.writeStructured(creationUrl, input, signal),
    ),
  );
  ipcMain.on(channels.register, (event, url: unknown, documentId: unknown) => {
    const frame = event.senderFrame;
    if (frame && trusted(frame, event.sender, url) && typeof documentId === "string" && documentId) {
      registrations.set(frame, { creationUrl: url, documentId, sender: event.sender });
    }
  });
  changes.on("changed", (_event, cookie, cause) => {
    if (cookie.domain?.replace(/^\./, "") !== script.storageHost) return;
    snapshots.storageChanged();
    const items = publicChange(script, cookie, cause);
    if (!items) return;
    const row = items.changed[0] ?? items.deleted[0];
    for (const [frame, { creationUrl, documentId, sender }] of registrations) {
      try {
        if (!trusted(frame, sender, creationUrl) || frame.detached) {
          registrations.delete(frame);
          continue;
        }
        const path = new URL(creationUrl).pathname;
        if (path !== row.path && !path.startsWith(row.path.endsWith("/") ? row.path : row.path + "/")) continue;
        frame.send(channels.changed, {
          documentId,
          ...items,
        } satisfies CookiePush);
      } catch {
        // A frame may disappear between checking it and sending the push.
        registrations.delete(frame);
      }
    }
  });
}

export async function invokeCookieStore<T>(
  url: string | undefined,
  operation: (url: string, signal: AbortSignal) => Promise<T>,
): Promise<CookieReply<T>> {
  if (!url)
    return {
      ok: false,
      error: { name: "SecurityError", message: "Access to the CookieStore API is denied in this context." },
    };
  const deadline = storeDeadline(STORE_TIMEOUT_MS);
  try {
    const value = await operation(url, deadline.signal);
    return { ok: true, value };
  } catch (err) {
    if (err instanceof TypeError) return { ok: false, error: { name: "TypeError", message: err.message } };
    return {
      ok: false,
      error: {
        name: err instanceof CookieStoreTimeoutError ? "TimeoutError" : "InvalidStateError",
        message: err instanceof CookieStoreTimeoutError ? "Cookie store timed out" : "CookieStore backend went away",
      },
    };
  } finally {
    deadline.clear();
  }
}

export function publicChange(
  script: ScriptCookies,
  cookie: Cookie,
  cause: string,
): Omit<CookiePush, "documentId"> | undefined {
  if (cookie.domain?.replace(/^\./, "") !== script.storageHost) return undefined;
  if (cookie.httpOnly || cause === "overwrite" || cause === "inserted-no-change-overwrite") return undefined;
  const row = script.publicCookie(cookie);
  if (cause === "inserted" || cause === "inserted-no-value-change-overwrite") return { changed: [row], deleted: [] };
  const { value: _value, expires: _expires, sameSite, ...deleted } = row;
  // Deleted items expose the stored SameSite attribute; no effective default is supplied.
  return {
    changed: [],
    deleted: [cookie.sameSite && cookie.sameSite !== "unspecified" ? { ...deleted, sameSite } : deleted],
  };
}
