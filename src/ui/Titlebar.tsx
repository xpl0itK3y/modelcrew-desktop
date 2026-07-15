import { useCallback, useEffect, useRef, useState } from "react";
import {
  BellIcon,
  GridIcon,
  PlusIcon,
  SidebarIcon,
  SlidersIcon,
} from "./Icons";
import { useI18n } from "../i18n";
import { useAnimatedPresence } from "./useAnimatedPresence";
import { UpdatePopover } from "../updater/UpdatePopover";
import {
  loadReadNotificationIds,
  markNotificationIdsRead,
} from "../updater/readNotifications";
import type {
  AppUpdaterController,
  UpdateNotification,
} from "../updater/types";

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
  // Поповер остаётся в DOM на время exit-анимации после закрытия.
  const popoverPresence = useAnimatedPresence(notificationsOpen || null, 150);
  const [readNotificationIds, setReadNotificationIds] = useState(() =>
    loadReadNotificationIds(),
  );
  const notificationsRef = useRef<HTMLDivElement | null>(null);
  const bellRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const toggleSidebarLabel = t("titlebar.toggleSidebar");
  const newTerminalLabel = t("titlebar.newTerminal");
  const settingsLabel = t("titlebar.settings");

  const attentionItems = props.updater.center.items.filter(
    (item): item is UpdateNotification =>
      item.kind === "update" &&
      (item.phase === "ready" || item.phase === "manual"),
  );
  const latestAttentionItem = attentionItems[attentionItems.length - 1];
  // Count unread attention-worthy notifications (announcements plus ready/manual
  // updates) for the badge on the bell; opening the center marks them read.
  const unreadCount = props.updater.center.items.filter(
    (item) =>
      !readNotificationIds.includes(item.id) &&
      (item.kind === "announcement" ||
        item.phase === "ready" ||
        item.phase === "manual"),
  ).length;
  const notificationLabel = latestAttentionItem
    ? t("titlebar.updateReady", { version: latestAttentionItem.version })
    : t("titlebar.notifications");
  const downloadingItem = props.updater.center.items.find(
    (item): item is UpdateNotification =>
      item.kind === "update" &&
      (item.phase === "downloading" || item.phase === "verifying"),
  );
  const downloadPercent =
    downloadingItem?.total && downloadingItem.total > 0
      ? Math.min(
          100,
          ((downloadingItem.downloaded ?? 0) / downloadingItem.total) * 100,
        )
      : null;
  const latestItem =
    props.updater.center.items[props.updater.center.items.length - 1];
  const updateAnnouncement = (() => {
    if (!latestItem) {
      if (
        props.updater.center.sync === "initial" ||
        props.updater.center.sync === "checking"
      ) {
        return t("update.refreshingNotifications");
      }
      return t("update.empty");
    }
    if (latestItem.kind === "announcement") {
      return latestItem.title;
    }
    switch (latestItem.phase) {
      case "downloading":
        return t("update.downloading", { version: latestItem.version });
      case "downloadRetry":
        return t("update.downloadRetry");
      case "verifying":
        return t("update.verifying");
      case "ready":
      case "manual":
        return t("titlebar.updateReady", { version: latestItem.version });
      case "authorizing":
        return t("update.authorizing");
      case "installing":
        return t("update.installing", { version: latestItem.version });
      case "restarting":
        return t("update.restarting", { version: latestItem.version });
      case "authorizationCancelled":
        return t("update.authorizationCancelledTitle");
      case "installFailed":
        return t("update.installFailedTitle");
      case "restartFailed":
        return t("update.restartFailedTitle");
    }
  })();

  const closeNotifications = useCallback((restoreFocus = true) => {
    setNotificationsOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => bellRef.current?.focus());
    }
  }, []);

  const toggleNotifications = useCallback(() => {
    if (notificationsOpen) {
      setNotificationsOpen(false);
      return;
    }
    setNotificationsOpen(true);
    void props.updater.ensureChecked();
  }, [notificationsOpen, props.updater]);

  useEffect(() => {
    if (!notificationsOpen) {
      return;
    }

    const visibleIds = props.updater.center.items.map((item) => item.id);
    if (visibleIds.length > 0) {
      setReadNotificationIds((currentIds) => {
        if (visibleIds.every((id) => currentIds.includes(id))) {
          return currentIds;
        }
        return markNotificationIdsRead(currentIds, visibleIds);
      });
    }
  }, [notificationsOpen, props.updater.center.items]);

  useEffect(() => {
    if (!notificationsOpen) {
      return;
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
  }, [closeNotifications, notificationsOpen]);

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
            }`}
            title={t("titlebar.notifications")}
            aria-label={notificationLabel}
            aria-haspopup="dialog"
            aria-controls="notification-center"
            aria-expanded={notificationsOpen}
            onClick={toggleNotifications}
          >
            <BellIcon />
            {unreadCount > 0 && (
              <span className="notification-badge" aria-hidden="true">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
            {downloadingItem && (
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
          {popoverPresence && (
            <UpdatePopover
              ref={popoverRef}
              center={props.updater.center}
              closing={popoverPresence.closing}
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
