import { visualScript } from "~/managers/visual/bootstrap";
import { desktopVisualPrepaint } from "~/platform/electron/visual-source";

export const web = visualScript();
export const desktop = visualScript(desktopVisualPrepaint);
