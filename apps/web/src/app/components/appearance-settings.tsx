import { Button, Group, Menu, Modal, Popover, Select, Text, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useRef, useState } from "react";

import { visualCodec } from "~/managers/visual/bootstrap";
import { useVisualActions, useVisualState, useVisualStatus } from "~/managers/visual/hooks";

import { getInteractiveProps } from "../../providers/environment";

import classes from "./appearance-settings.module.css";

/** Imperative modal and notification APIs are served by AppUiProvider. */
function confirmReset(reset: () => void, trigger: HTMLElement | null) {
  modals.openConfirmModal({
    // The menu item that opened the dialog unmounts, so return focus to the persistent trigger.
    returnFocus: false,
    onExitTransitionEnd: () => trigger?.focus(),
    title: "Reset appearance?",
    children: <Text size="sm">Color scheme, direction and motion return to system defaults.</Text>,
    labels: { confirm: "Reset", cancel: "Cancel" },
    onConfirm: () => {
      reset();
      notifications.show({ title: "Appearance reset", message: "System defaults restored." });
    },
  });
}

export function VisualSettings() {
  const { preferences } = useVisualState();
  const actions = useVisualActions();
  const status = useVisualStatus();
  const [opened, setOpened] = useState(false);
  const previewButton = useRef<HTMLButtonElement>(null);
  const popup = getInteractiveProps();
  return (
    <fieldset className={classes.visualSettings} {...popup}>
      <legend>Appearance</legend>
      <Select
        label="Color scheme"
        allowDeselect={false}
        value={preferences.colorScheme}
        data={[
          { value: "auto", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
        onChange={(value) => actions.setColorSchemePreference(visualCodec.parse({ colorScheme: value }).colorScheme)}
        styles={{ dropdown: { WebkitAppRegion: "no-drag" } }}
      />
      <Select
        label="Direction"
        allowDeselect={false}
        value={preferences.direction}
        data={["ltr", "rtl"].map((value) => ({ value, label: value.toUpperCase() }))}
        onChange={(value) => actions.setDirection(value === "rtl" ? "rtl" : "ltr")}
        styles={{ dropdown: { WebkitAppRegion: "no-drag" } }}
      />
      <Select
        label="Motion"
        allowDeselect={false}
        value={preferences.reducedMotion}
        data={[
          { value: "auto", label: "System" },
          { value: "reduce", label: "Reduced" },
          { value: "full", label: "Full" },
        ]}
        onChange={(value) =>
          actions.setReducedMotionPreference(visualCodec.parse({ reducedMotion: value }).reducedMotion)
        }
        styles={{ dropdown: { WebkitAppRegion: "no-drag" } }}
      />
      <Group gap="xs">
        <Tooltip label="Restore system defaults">
          <Button variant="default" onClick={actions.resetVisualPreferences}>
            Reset appearance
          </Button>
        </Tooltip>
        <Popover>
          <Popover.Target>
            <Button variant="light">About appearance</Button>
          </Popover.Target>
          <Popover.Dropdown {...popup}>
            <Text size="sm">One preference source across the entire application.</Text>
          </Popover.Dropdown>
        </Popover>
        <Menu>
          <Menu.Target>
            <Button ref={previewButton} variant="subtle">
              Preview options
            </Button>
          </Menu.Target>
          <Menu.Dropdown {...popup}>
            <Menu.Item onClick={() => setOpened(true)}>Open dialog</Menu.Item>
            <Menu.Item onClick={() => confirmReset(actions.resetVisualPreferences, previewButton.current)}>
              Reset with confirmation
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title="Appearance preview"
        returnFocus={false}
        onExitTransitionEnd={() => previewButton.current?.focus()}
        styles={{ content: { WebkitAppRegion: "no-drag" } }}
      >
        <Text>Direction and motion follow your global settings.</Text>
        <Button mt="md" onClick={() => setOpened(false)}>
          Close preview
        </Button>
      </Modal>
      {(status.persistence === "failed" ||
        status.persistence === "unavailable" ||
        status.persistence === "unsupported-version") &&
        status.initialized && <output>Appearance is available for this session; settings could not be saved.</output>}
    </fieldset>
  );
}
