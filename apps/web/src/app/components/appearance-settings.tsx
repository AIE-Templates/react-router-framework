import { Button, Group, Menu, Modal, Popover, Select, Text, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { visualRecordKernel } from "@repo/shared";
import { useRef, useState } from "react";

import { useVisualActions, useVisualState, useVisualStatus } from "~/managers/visual/hooks";
import { getInteractiveProps } from "~/platform/chrome-adapter/dom-props";

import classes from "./appearance-settings.module.css";

/** Imperative modal and notification APIs are served by AppUiProvider. */
function confirmReset(reset: () => void, trigger: HTMLElement | null) {
  modals.openConfirmModal({
    // The menu item that opened the dialog unmounts, so return focus to the persistent trigger.
    returnFocus: false,
    onExitTransitionEnd: () => trigger?.focus(),
    title: "Reset appearance?",
    children: <Text size="sm">Color scheme, direction and motion return to their defaults.</Text>,
    labels: { confirm: "Reset", cancel: "Cancel" },
    onConfirm: () => {
      reset();
      notifications.show({ title: "Appearance reset", message: "Defaults restored." });
    },
  });
}

export function VisualSettings() {
  const preferences = visualRecordKernel.effective(useVisualState());
  const actions = useVisualActions();
  const status = useVisualStatus();
  const stores = Object.values(status.storage);
  const saveFailed = stores.includes("failed") || !stores.includes("ok");
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
        onOptionSubmit={(value) => {
          if (value === "auto" || value === "light" || value === "dark") actions.setColorSchemePreference(value);
        }}
      />
      <Select
        label="Direction"
        allowDeselect={false}
        value={preferences.direction}
        data={["ltr", "rtl"].map((value) => ({ value, label: value.toUpperCase() }))}
        onOptionSubmit={(value) => actions.setDirection(value === "rtl" ? "rtl" : "ltr")}
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
        onOptionSubmit={(value) => {
          if (value === "auto" || value === "reduce" || value === "full") actions.setReducedMotionPreference(value);
        }}
      />
      <Group gap="xs">
        <Tooltip label="Restore defaults">
          <Button variant="default" onClick={actions.resetVisualPreferences}>
            Reset appearance
          </Button>
        </Tooltip>
        <Popover>
          <Popover.Target>
            <Button variant="light">About appearance</Button>
          </Popover.Target>
          <Popover.Dropdown {...popup}>
            <Text size="sm">Choose System to follow your device’s light or dark appearance.</Text>
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
      >
        <Text>Direction and motion follow your global settings.</Text>
        <Button mt="md" onClick={() => setOpened(false)}>
          Close preview
        </Button>
      </Modal>
      {status.initialized && saveFailed && (
        <>
          <output>Appearance settings could not be saved.</output>
          <Button variant="default" onClick={actions.retry}>
            Retry
          </Button>
        </>
      )}
    </fieldset>
  );
}
