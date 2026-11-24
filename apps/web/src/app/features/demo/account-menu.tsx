import { Menu } from "@mantine/core";
import { Link } from "react-router";

import { DemoIcon } from "./demo-icon";

import classes from "./account-menu.module.css";

const name = "Alex Morgan";
const email = "alex@example.com";

function Identity() {
  return (
    <span className={classes.identity}>
      <strong>{name}</strong>
      <small>{email}</small>
    </span>
  );
}

export function AccountMenu({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? classes.railFooter : classes.sidebarFooter}>
      <Menu position={compact ? "right-end" : "top-start"} width={216} offset={8} shadow="md" returnFocus>
        <Menu.Target>
          <button
            type="button"
            data-native-control=""
            className={classes.trigger}
            aria-label={`Account menu for ${name}`}
            title={compact ? name : undefined}
          >
            <span className={classes.avatar} aria-hidden="true">
              AM
            </span>
            {!compact && (
              <>
                <Identity />
                <DemoIcon name="chevrons" />
              </>
            )}
          </button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>
            <Identity />
          </Menu.Label>
          <Menu.Divider />
          <Menu.Item
            component={Link}
            to="/settings"
            target="_blank"
            rel="noopener"
            leftSection={<DemoIcon name="settings" />}
          >
            Appearance settings
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}
