import { visualCodec } from "./bootstrap";
import { useVisualActions, useVisualState, useVisualStatus } from "./hooks";
export function VisualSettings() {
  const { preferences } = useVisualState();
  const actions = useVisualActions();
  const status = useVisualStatus();
  return (
    <fieldset className="visual-settings" data-window-interactive="">
      <legend>Appearance</legend>
      <label>
        Color scheme
        <select
          value={preferences.colorScheme}
          onChange={(event) =>
            actions.setColorSchemePreference(visualCodec.parse({ colorScheme: event.target.value }).colorScheme)
          }
        >
          <option value="auto">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label>
        Direction
        <select
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
          value={preferences.reducedMotion}
          onChange={(event) =>
            actions.setReducedMotionPreference(visualCodec.parse({ reducedMotion: event.target.value }).reducedMotion)
          }
        >
          <option value="auto">System</option>
          <option value="reduce">Reduced</option>
          <option value="full">Full</option>
        </select>
      </label>
      <button type="button" onClick={actions.resetVisualPreferences}>
        Reset appearance
      </button>
      {(status.persistence === "failed" ||
        status.persistence === "unavailable" ||
        status.persistence === "unsupported-version") &&
        status.initialized && <output>Appearance is available for this session; settings could not be saved.</output>}
    </fieldset>
  );
}
