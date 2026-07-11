import { useCallback, useRef, useState } from "react";
import {
  DockviewApi,
  DockviewGroupPanel,
  DockviewReact,
  DockviewReadyEvent,
  DockviewTheme,
  IDockviewHeaderActionsProps,
  IWatermarkPanelProps,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import { TerminalPanel } from "./panels/TerminalPanel";
import { TerminalTab } from "./panels/TerminalTab";
import { destroyTerminal } from "./terminal/registry";
import { Titlebar } from "./ui/Titlebar";
import { Sidebar } from "./ui/Sidebar";
import { MaximizeIcon, PlusIcon, SplitIcon } from "./ui/Icons";
import "./App.css";

// Минимальный размер панели по ТЗ: ~30 колонок × 7 строк терминала.
export const PANEL_MIN_WIDTH = 240;
export const PANEL_MIN_HEIGHT = 160;

const WORKSPACE_NAME = "modelcrew";

const components = { terminal: TerminalPanel };
const tabComponents = { terminal: TerminalTab };

const modelcrewTheme: DockviewTheme = {
  name: "modelcrew",
  className: "dockview-theme-modelcrew",
  colorScheme: "dark",
  gap: 8,
  dndOverlayMounting: "absolute",
  dndPanelOverlay: "group",
  tabGroupIndicator: "none",
};

let panelCounter = 0;

function addPanel(
  api: DockviewApi,
  options: {
    group?: DockviewGroupPanel;
    direction?: "left" | "right" | "above" | "below";
  } = {},
) {
  panelCounter += 1;
  api.addPanel({
    id: crypto.randomUUID(),
    component: "terminal",
    tabComponent: "terminal",
    title: `терминал ${panelCounter}`,
    minimumWidth: PANEL_MIN_WIDTH,
    minimumHeight: PANEL_MIN_HEIGHT,
    ...(options.group
      ? {
          position: {
            referenceGroup: options.group,
            ...(options.direction ? { direction: options.direction } : {}),
          },
        }
      : {}),
  });
}

function GroupActions(props: IDockviewHeaderActionsProps) {
  return (
    <div className="group-actions">
      <button
        type="button"
        className="icon-button"
        title="Новый терминал во вкладке"
        onClick={() => addPanel(props.containerApi, { group: props.group })}
      >
        <PlusIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        title="Сплит вправо"
        onClick={() =>
          addPanel(props.containerApi, { group: props.group, direction: "right" })
        }
      >
        <SplitIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        title="Развернуть/вернуть группу"
        onClick={() => {
          if (props.containerApi.hasMaximizedGroup()) {
            props.containerApi.exitMaximizedGroup();
          } else if (props.activePanel) {
            props.containerApi.maximizeGroup(props.activePanel);
          }
        }}
      >
        <MaximizeIcon />
      </button>
    </div>
  );
}

function Welcome(props: IWatermarkPanelProps) {
  return (
    <div className="welcome">
      <div className="welcome-badge">MODELCREW</div>
      <h1 className="welcome-title">Собери свою команду.</h1>
      <p className="welcome-subtitle">Терминалы для агентов — в одном окне.</p>
      <button
        type="button"
        className="welcome-button"
        onClick={() => addPanel(props.containerApi)}
      >
        <PlusIcon /> Новый терминал
      </button>
      <div className="welcome-hints">
        <span>
          <kbd>⌘T</kbd> новый терминал
        </span>
        <span>
          <kbd>⌘⇧T</kbd> новая группа
        </span>
        <span>
          <kbd>⌘↩</kbd> зум
        </span>
      </div>
    </div>
  );
}

export default function App() {
  const apiRef = useRef<DockviewApi | null>(null);
  const [terminalCount, setTerminalCount] = useState(0);
  const [sidebarVisible, setSidebarVisible] = useState(true);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    // Закрытие панели любым путём (крестик, группа, хоткей) должно
    // убивать процесс — единая точка уборки.
    event.api.onDidRemovePanel((panel) => {
      void destroyTerminal(panel.id);
      setTerminalCount(event.api.panels.length);
    });
    event.api.onDidAddPanel(() => {
      setTerminalCount(event.api.panels.length);
    });
    addPanel(event.api);
  }, []);

  return (
    <div className={`app-shell ${sidebarVisible ? "" : "sidebar-hidden"}`}>
      <Titlebar
        workspaceName={WORKSPACE_NAME}
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible((visible) => !visible)}
      />
      <div className="app-body">
        {sidebarVisible && (
          <Sidebar workspaceName={WORKSPACE_NAME} terminalCount={terminalCount} />
        )}
        <main className="dock-area">
          <DockviewReact
            components={components}
            tabComponents={tabComponents}
            watermarkComponent={Welcome}
            rightHeaderActionsComponent={GroupActions}
            onReady={onReady}
            theme={modelcrewTheme}
          />
        </main>
      </div>
    </div>
  );
}
