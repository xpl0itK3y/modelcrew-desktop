import { useCallback, useEffect, useRef, useState } from "react";
import {
  BellIcon,
  GridIcon,
  PlusIcon,
  SidebarIcon,
  SlidersIcon,
} from "./Icons";
import { useI18n } from "../i18n";
import { UpdatePopover } from "../updater/UpdatePopover";
import type { AppUpdaterController } from "../updater/types";

const isMac = navigator.userAgent.includes("Mac");

type TitlebarProps = {
  workspaceName: string;
  workspaceFolder: string | null;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onNewTerminal: () => void;
  onOpenSettings: () => void;
  updater: AppUpdaterController;
};

// /Users/denis/github/proj → ~/github/proj
function collapseHome(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

export function Titlebar(props: TitlebarProps) {
  const { t } = useI18n();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [readVersion, setReadVersion] = useState<string | null>(null);
  const notificationsRef = useRef<HTMLDivElement | null>(null);
  const bellRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const toggleSidebarLabel = t("titlebar.toggleSidebar");
  const newTerminalLabel = t("titlebar.newTerminal");
  const settingsLabel = t("titlebar.settings");
  const attentionVersion =
    props.updater.state.status === "ready" ||
    props.updater.state.status === "packageManaged"
      ? props.updater.state.version
      : null;
  const hasUnreadUpdate = Boolean(
    attentionVersion && attentionVersion !== readVersion,
  );
  const notificationLabel = attentionVersion
    ? t("titlebar.updateReady", { version: attentionVersion })
    : t("titlebar.notifications");
  const updateAnnouncement = (() => {
    switch (props.updater.state.status) {
      case "checking":
        return t("update.checking");
      case "upToDate":
        return t("update.upToDate");
      case "downloading":
        return t("update.downloading", {
          version: props.updater.state.version,
        });
      case "ready":
      case "packageManaged":
        return t("titlebar.updateReady", {
          version: props.updater.state.version,
        });
      case "installing":
        return t("update.installing", {
          version: props.updater.state.version,
        });
      case "error":
        return t("update.errorTitle");
      default:
        return "";
    }
  })();
  const downloadPercent =
    props.updater.state.status === "downloading" && props.updater.state.total
      ? Math.min(
          100,
          (props.updater.state.downloaded / props.updater.state.total) * 100,
        )
      : null;

  const closeNotifications = useCallback((restoreFocus = true) => {
    setNotificationsOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => bellRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!notificationsOpen) {
      return;
    }
    if (attentionVersion) {
      setReadVersion(attentionVersion);
    }
    const focusTimer = window.requestAnimationFrame(() => {
      popoverRef.current?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !notificationsRef.current?.contains(event.target)
      ) {
        setNotificationsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeNotifications();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusTimer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [attentionVersion, closeNotifications, notificationsOpen]);

  return (
    <header className="titlebar" data-tauri-drag-region="deep">
      <div className="titlebar-side titlebar-left">
        {isMac && <span className="traffic-lights-spacer" />}
        <button
          type="button"
          className={`icon-button ${props.sidebarVisible ? "" : "is-off"}`}
          title={toggleSidebarLabel}
          aria-label={toggleSidebarLabel}
          aria-pressed={props.sidebarVisible}
          onClick={props.onToggleSidebar}
        >
          <SidebarIcon />
        </button>
      </div>
      <div className="titlebar-center">
        <span className="titlebar-workspace">{props.workspaceName}</span>
        {props.workspaceFolder && (
          <span className="titlebar-path" title={props.workspaceFolder}>
            › {collapseHome(props.workspaceFolder)}
          </span>
        )}
      </div>
      <div className="titlebar-side titlebar-right">
        <button
          type="button"
          className="icon-button"
          title={newTerminalLabel}
          aria-label={newTerminalLabel}
          onClick={props.onNewTerminal}
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          className="icon-button is-disabled"
          title={t("titlebar.layoutsSoon")}
          aria-label={t("titlebar.layoutsSoon")}
          disabled
        >
          <GridIcon />
        </button>
        <div className="titlebar-notifications" ref={notificationsRef}>
          <button
            ref={bellRef}
            type="button"
            className={`icon-button notification-button ${
              notificationsOpen ? "is-active" : ""
            } ${props.updater.enabled ? "" : "is-disabled"}`}
            title={
              props.updater.enabled
                ? t("titlebar.notifications")
                : t("titlebar.updatesUnavailable")
            }
            aria-label={notificationLabel}
            aria-haspopup="dialog"
            aria-expanded={notificationsOpen}
            disabled={!props.updater.enabled}
            onClick={() => setNotificationsOpen((open) => !open)}
          >
            <BellIcon />
            {hasUnreadUpdate && (
              <span className="notification-dot" aria-hidden="true" />
            )}
            {props.updater.state.status === "downloading" && (
              <span
                className={`notification-download ${
                  downloadPercent === null ? "is-indeterminate" : ""
                }`}
                aria-hidden="true"
              >
                <span
                  style={
                    downloadPercent === null
                      ? undefined
                      : { width: `${downloadPercent}%` }
                  }
                />
              </span>
            )}
          </button>
          {notificationsOpen && (
            <UpdatePopover
              ref={popoverRef}
              state={props.updater.state}
              onCheck={() => void props.updater.checkForUpdates()}
              onInstall={() => void props.updater.installUpdate()}
              onOpenRelease={() => void props.updater.openRelease()}
              onClose={() => closeNotifications()}
            />
          )}
          <span
            className="update-live-region"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {updateAnnouncement}
          </span>
        </div>
        <button
          type="button"
          className="icon-button"
          title={settingsLabel}
          aria-label={settingsLabel}
          onClick={props.onOpenSettings}
        >
          <SlidersIcon />
        </button>
      </div>
    </header>
  );
}
