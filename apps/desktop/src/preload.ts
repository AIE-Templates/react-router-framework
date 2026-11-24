import {
  applyPreference,
  DESKTOP_CHROME_IPC,
  DESKTOP_PREFS_IPC,
  type DesktopBridge,
  type DesktopWindowState,
  type OverlayAppearanceResult,
  desktopBootstrapFromArguments,
  isDesktopWindowState,
  parseOverlayAppearance,
  parseOverlayDeclaration,
  isVisualThemePreference,
  isVisualThemeSnapshot,
  type VisualThemeSnapshot,
  isVisualThemeResult,
  type PreferenceUpdateResult,
} from "@repo/shared";
import { contextBridge, ipcRenderer } from "electron";

// Sandboxed: bundled as one CommonJS file, with only Electron required at runtime.
const versionArg = process.argv.find((arg) => arg.startsWith("--desktop-app-version="));
const bootstrap = desktopBootstrapFromArguments(process.argv);
const listeners = new Set<(state: DesktopWindowState) => void>();
let token: string | undefined;
let generation = 0;
let current: DesktopWindowState | undefined;

const receive = (payload: unknown) => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("token" in payload) ||
    payload.token !== token ||
    !("state" in payload)
  )
    return;
  const next = payload.state;
  if (!isDesktopWindowState(next) || (current && next.revision <= current.revision)) return;
  current = Object.freeze({ ...next });
  for (const listener of listeners) listener(current);
};
const onState = (_event: Electron.IpcRendererEvent, payload: unknown) => receive(payload);
const stop = () => {
  ++generation;
  if (token) ipcRenderer.send(DESKTOP_CHROME_IPC.unsubscribe, token);
  token = undefined;
  current = undefined;
  ipcRenderer.off(DESKTOP_CHROME_IPC.state, onState);
};

/** Checks the shape here, so a bad call never crosses IPC; the main process checks again and owns the limits. */
async function updatePref(key: unknown, value: unknown): Promise<PreferenceUpdateResult> {
  const checked = applyPreference({}, key, value);
  if (!checked.ok) return { status: "rejected", reason: checked.reason };
  try {
    const response: unknown = await ipcRenderer.invoke(DESKTOP_PREFS_IPC.set, { key, value });
    if (typeof response === "object" && response !== null && "status" in response) {
      if (response.status === "applied") return { status: "applied" };
      if (
        response.status === "rejected" &&
        "reason" in response &&
        typeof response.reason === "string" &&
        response.reason.length <= 128
      )
        return { status: "rejected", reason: response.reason };
    }
    return { status: "rejected", reason: "invalid-response" };
  } catch {
    return { status: "rejected", reason: "bridge-unavailable" };
  }
}

async function invokeAppearance(request: () => Promise<unknown>): Promise<OverlayAppearanceResult> {
  try {
    const response = await request();
    if (typeof response === "object" && response !== null && "status" in response) {
      if (response.status === "applied" && "appearance" in response) {
        const accepted = parseOverlayAppearance(response.appearance);
        if (accepted) return { status: "applied", appearance: accepted };
      }
      if (
        (response.status === "unsupported" || response.status === "rejected") &&
        "reason" in response &&
        typeof response.reason === "string" &&
        response.reason.length <= 128
      )
        return { status: response.status, reason: response.reason };
    }
    return { status: "rejected", reason: "invalid-response" };
  } catch {
    return { status: "rejected", reason: "bridge-unavailable" };
  }
}

// The main process issues one token per committed document. Both appearance channels share its
// first async lookup. A temporary IPC failure can be retried by the next call.
let visualDocument: Promise<string> | undefined;
async function invokeForDocument(channel: string, input: object): Promise<unknown> {
  visualDocument ??= ipcRenderer
    .invoke(DESKTOP_CHROME_IPC.visualDocument)
    .then((issued: unknown) => {
      if (typeof issued !== "string" || !issued) throw new Error("Missing visual document token");
      return issued;
    })
    .catch((error: unknown) => {
      visualDocument = undefined;
      throw error;
    });
  return ipcRenderer.invoke(channel, { ...input, document: await visualDocument });
}

let visualRevision = 0;

// Window creation arguments survive reloads. Read the current committed preference once per document instead.
let seed: unknown;
if (process.isMainFrame) {
  try {
    seed = ipcRenderer.sendSync(DESKTOP_CHROME_IPC.visualSeed);
  } catch {
    // The async subscription can still recover the current preference after preload.
  }
}
const bridge: DesktopBridge = {
  visualTheme: isVisualThemeSnapshot(seed) ? seed : null,
  subscribeVisualTheme(listener) {
    if (typeof listener !== "function") return () => {};
    let active = true;
    let revision = -1;
    const receiveTheme = (value: unknown) => {
      if (!active || !isVisualThemeSnapshot(value) || value.revision <= revision) return;
      revision = value.revision;
      listener(Object.freeze({ revision, preference: value.preference }));
    };
    const changed = (_event: Electron.IpcRendererEvent, value: VisualThemeSnapshot) => receiveTheme(value);
    ipcRenderer.on(DESKTOP_CHROME_IPC.visualChanged, changed);
    void ipcRenderer
      .invoke(DESKTOP_CHROME_IPC.visualSnapshot)
      .then(receiveTheme)
      .catch(() => {});
    return () => {
      active = false;
      ipcRenderer.off(DESKTOP_CHROME_IPC.visualChanged, changed);
    };
  },
  platform: process.platform,
  version: versionArg ? versionArg.slice("--desktop-app-version=".length) : "",
  bootstrap,
  subscribeWindowState(listener) {
    if (typeof listener !== "function") return () => {};
    // Each call owns its subscription, even when the same callback is registered twice.
    const owned = (state: DesktopWindowState) => listener(state);
    listeners.add(owned);
    if (!token) {
      const activeGeneration = ++generation;
      token = `${activeGeneration}-${Math.random().toString(36).slice(2)}`;
      // Listen before invoking: updates sent between registration and invoke resolution are retained.
      ipcRenderer.on(DESKTOP_CHROME_IPC.state, onState);
      void ipcRenderer
        .invoke(DESKTOP_CHROME_IPC.subscribe, token)
        .then((payload: unknown) => {
          if (activeGeneration === generation) receive(payload);
          return undefined;
        })
        .catch(() => {
          // Enhancement failure leaves the document's CSS safety boundary in place.
          if (activeGeneration === generation) stop();
        });
    } else if (current) {
      owned(current);
    }
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(owned);
      if (listeners.size === 0) stop();
    };
  },
  declareOverlayAppearance(input) {
    const declaration = parseOverlayDeclaration(input);
    if (!declaration) return Promise.resolve({ status: "rejected", reason: "invalid-appearance" });
    return invokeAppearance(() => invokeForDocument(DESKTOP_CHROME_IPC.declaration, { declaration }));
  },
  async syncVisualTheme(preference) {
    if (!isVisualThemePreference(preference)) return { status: "rejected", reason: "invalid-request" };
    try {
      const result = await invokeForDocument(DESKTOP_CHROME_IPC.visualTheme, {
        revision: ++visualRevision,
        preference,
      });
      return isVisualThemeResult(result) ? result : { status: "rejected", reason: "invalid-response" };
    } catch {
      return { status: "rejected", reason: "bridge-unavailable" };
    }
  },
  subscribePreferences(rendered, listener) {
    if (!rendered || typeof rendered !== "object" || Array.isArray(rendered) || typeof listener !== "function")
      return () => {};
    let active = true;
    const changed = () => {
      if (active) listener();
    };
    ipcRenderer.on(DESKTOP_PREFS_IPC.changed, changed);
    // A peer may have written after SSR took its snapshot but before hydration subscribed.
    void ipcRenderer
      .invoke(DESKTOP_PREFS_IPC.snapshot)
      .then((snapshot: unknown) => {
        if (
          snapshot &&
          typeof snapshot === "object" &&
          (Object.keys(snapshot).length !== Object.keys(rendered).length ||
            Object.entries(snapshot).some(([key, value]) => rendered[key] !== value))
        )
          changed();
        return undefined;
      })
      .catch(() => {});
    return () => {
      active = false;
      ipcRenderer.off(DESKTOP_PREFS_IPC.changed, changed);
    };
  },
  // `null` is how removal crosses IPC; through setPref it is an invalid value like `undefined`.
  setPref: async (key, value) =>
    value === null ? { status: "rejected", reason: "invalid-value" } : updatePref(key, value),
  removePref: (key) => updatePref(key, null),
};
// A future sub-frame preload configuration must not expose capabilities or signal a main-frame paint.
if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("desktop", bridge);
  window.addEventListener("unload", () => {
    listeners.clear();
    stop();
  });

  // The first frame remains independent of bootstrap and the optional state enhancement.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => ipcRenderer.send("desktop:first-paint"));
  });
}
