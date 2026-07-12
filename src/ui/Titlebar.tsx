import {
  BellIcon,
  GridIcon,
  PlusIcon,
  SidebarIcon,
  SlidersIcon,
} from "./Icons";
import { useI18n } from "../i18n";

const isMac = navigator.userAgent.includes("Mac");

type TitlebarProps = {
  workspaceName: string;
  workspaceFolder: string | null;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onNewTerminal: () => void;
  onOpenSettings: () => void;
};

// /Users/denis/github/proj → ~/github/proj
function collapseHome(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

export function Titlebar(props: TitlebarProps) {
  const { t } = useI18n();
  const toggleSidebarLabel = t("titlebar.toggleSidebar");
  const newTerminalLabel = t("titlebar.newTerminal");
  const settingsLabel = t("titlebar.settings");

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
        <button
          type="button"
          className="icon-button is-disabled"
          title={t("titlebar.notificationsSoon")}
          aria-label={t("titlebar.notificationsSoon")}
          disabled
        >
          <BellIcon />
        </button>
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
