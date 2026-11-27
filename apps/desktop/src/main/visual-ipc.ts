import { DESKTOP_VISUAL_IPC } from "@repo/shared";
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";

import type { Logger } from "./log.ts";
import type { VisualMirror } from "./visual-mirror.ts";

export function installVisualIpc(
  ipc: Pick<IpcMain, "on" | "handle">,
  mirror: VisualMirror,
  trusted: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean,
  fixedAppearanceFor: (contentsId: number) => "light" | "dark" | undefined,
  log: Pick<Logger, "warn">,
) {
  ipc.on(DESKTOP_VISUAL_IPC.read, (event) => {
    if (!trusted(event)) {
      log.warn({}, "untrusted visual mirror read");
      event.returnValue = null;
      return;
    }
    const fixedAppearance = fixedAppearanceFor(event.sender.id);
    event.returnValue = { ...mirror.read(), ...(fixedAppearance && { fixedAppearance }) };
  });
  ipc.handle(DESKTOP_VISUAL_IPC.push, (event, raw: unknown) => {
    if (!trusted(event)) {
      log.warn({}, "untrusted visual mirror push");
      return "failed";
    }
    return mirror.push(raw);
  });
}
