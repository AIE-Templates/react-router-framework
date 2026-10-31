import { Button, Group, Menu, Modal, Popover, Select, Text, Tooltip } from "@mantine/core";
import { useState } from "react";

import { getInteractiveProps } from "../../providers/environment";
import { visualCodec } from "./bootstrap";
import { useVisualActions, useVisualState, useVisualStatus } from "./hooks";

export function VisualSettings() {
  const { preferences } = useVisualState();
  const actions = useVisualActions();
  const status = useVisualStatus();
  const [opened, setOpened] = useState(false);
  const popup = getInteractiveProps();
  return (
    <fieldset className="visual-settings" {...popup}>
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
            <Button variant="subtle">Preview options</Button>
          </Menu.Target>
          <Menu.Dropdown {...popup}>
            <Menu.Item onClick={() => setOpened(true)}>Open dialog</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title="Appearance preview"
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
