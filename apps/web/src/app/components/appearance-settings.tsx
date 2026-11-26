import { visualRecordKernel } from "@repo/shared";

import { useVisualActions, useVisualState, useVisualStatus } from "~/managers/visual/hooks";

import classes from "./appearance-settings.module.css";
export function VisualSettings() {
  const preferences = visualRecordKernel.effective(useVisualState());
  const actions = useVisualActions();
  const status = useVisualStatus();
  const stores = Object.values(status.storage);
  const saveFailed = stores.includes("failed") || !stores.includes("ok");
  return (
    <fieldset className={classes.visualSettings} data-window-interactive="">
      <legend>Appearance</legend>
      <label>
        Color scheme
        <select
          data-native-control=""
          value={preferences.colorScheme}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "auto" || value === "light" || value === "dark") actions.setColorSchemePreference(value);
          }}
        >
          <option value="auto">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label>
        Direction
        <select
          data-native-control=""
          value={preferences.direction}
          onChange={(event) => actions.setDirection(event.target.value === "rtl" ? "rtl" : "ltr")}
        >
          <option value="ltr">LTR</option>
          <option value="rtl">RTL</option>
        </select>
      </label>
      <label>
        Motion
        <select
          data-native-control=""
          value={preferences.reducedMotion}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "auto" || value === "reduce" || value === "full") actions.setReducedMotionPreference(value);
          }}
        >
          <option value="auto">System</option>
          <option value="reduce">Reduced</option>
          <option value="full">Full</option>
        </select>
      </label>
      <button data-native-control="" type="button" onClick={actions.resetVisualPreferences}>
        Reset appearance
      </button>
      {status.initialized && saveFailed && (
        <>
          <output>Appearance settings could not be saved.</output>
          <button data-native-control="" type="button" onClick={actions.retry}>
            Retry
          </button>
        </>
      )}
    </fieldset>
  );
}
