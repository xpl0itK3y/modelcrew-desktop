import {
  BellIcon,
  GearIcon,
  GridIcon,
  PlusIcon,
  SidebarIcon,
  SlidersIcon,
} from "./Icons";

const isMac = navigator.userAgent.includes("Mac");

type TitlebarProps = {
  workspaceName: string;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onNewTerminal: () => void;
  onOpenSettings: () => void;
};

export function Titlebar(props: TitlebarProps) {
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-side titlebar-left">
        {isMac && <span className="traffic-lights-spacer" />}
        <button
          type="button"
          className={`icon-button ${props.sidebarVisible ? "" : "is-off"}`}
          title="Показать/скрыть сайдбар"
          onClick={props.onToggleSidebar}
        >
          <SidebarIcon />
        </button>
      </div>
      <div className="titlebar-center" data-tauri-drag-region>
        <span className="titlebar-workspace">{props.workspaceName}</span>
      </div>
      <div className="titlebar-side titlebar-right">
        <button
          type="button"
          className="icon-button"
          title="Новый терминал в сетку"
          onClick={props.onNewTerminal}
        >
          <PlusIcon />
        </button>
        <button type="button" className="icon-button is-disabled" title="Раскладки — скоро">
          <GridIcon />
        </button>
        <button type="button" className="icon-button is-disabled" title="Уведомления — скоро">
          <BellIcon />
        </button>
        <button type="button" className="icon-button is-disabled" title="Активность — скоро">
          <SlidersIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Настройки"
          onClick={props.onOpenSettings}
        >
          <GearIcon />
        </button>
      </div>
    </header>
  );
}
