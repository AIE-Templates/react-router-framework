import { useId } from "react";
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
  const menuId = useId();
  return (
    <div className={compact ? classes.railFooter : classes.sidebarFooter}>
      <button
        type="button"
        popoverTarget={menuId}
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
      <div popover="auto" id={menuId} className={classes.popover}>
        <Identity />
        <Link
          className={classes.settingsLink}
          to="/settings"
          target="_blank"
          rel="noopener"
          onClick={(event) => event.currentTarget.parentElement?.hidePopover()}
        >
          <DemoIcon name="settings" /> Appearance settings
        </Link>
      </div>
    </div>
  );
}
