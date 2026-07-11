import { useCallback, useEffect, useRef, useState } from "react";
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
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { MaximizeIcon, PlusIcon, SplitIcon } from "./ui/Icons";
import { useHotkeys } from "./hotkeys/useHotkeys";
import { PANEL_MIN_HEIGHT, PANEL_MIN_WIDTH, WORKSPACE_NAME } from "./constants";
import "./App.css";

const components = { terminal: TerminalPanel };
const tabComponents = { terminal: TerminalTab };

const modelcrewTheme: DockviewTheme = {
  name: "modelcrew",
  className: "dockview-theme-modelcrew",
  colorScheme: "dark",
  gap: 3,
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

// Новый терминал встаёт в сетку: делим самую большую группу вдоль её
// длинной стороны. Когда минимумы 240×160 не позволяют сплит — вкладка
// в активной группе + тост (правило ТЗ).
function addTerminalAutoGrid(api: DockviewApi, onNoSpace?: () => void) {
  const groups = api.groups;
  if (groups.length === 0) {
    addPanel(api);
    return;
  }
  let target = groups[0];
  for (const group of groups) {
    if (group.width * group.height > target.width * target.height) {
      target = group;
    }
  }
  const canRight = target.width / 2 >= PANEL_MIN_WIDTH;
  const canBelow = target.height / 2 >= PANEL_MIN_HEIGHT;
  let direction: "right" | "below" | undefined;
  if (canRight && (target.width >= target.height || !canBelow)) {
    direction = "right";
  } else if (canBelow) {
    direction = "below";
  }
  if (!direction) {
    addPanel(api, { group: api.activeGroup ?? target });
    onNoSpace?.();
    return;
  }
  addPanel(api, { group: target, direction });
}

function GroupActions(props: IDockviewHeaderActionsProps) {
  return (
    <div className="group-actions">
      <button
        type="button"
        className="icon-button"
        title="Новый терминал во вкладке (⌘⇧T)"
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
        title="Развернуть/вернуть (⌘↩)"
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
        onClick={() => addTerminalAutoGrid(props.containerApi)}
      >
        <PlusIcon /> Новый терминал
      </button>
      <div className="welcome-hints">
        <span>
          <kbd>⌘T</kbd> новый терминал
        </span>
        <span>
          <kbd>⌘⇧T</kbd> вкладка в группе
        </span>
        <span>
          <kbd>⌘⌥</kbd> номера панелей
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
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  // Во время swap layout пересоздаётся через fromJSON: панели формально
  // удаляются, но PTY-сессии должны остаться живыми.
  const suppressCleanupRef = useRef(false);
  const [closeGroupRequest, setCloseGroupRequest] =
    useState<DockviewGroupPanel | null>(null);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current !== undefined) {
      window.clearTimeout(toastTimer.current);
    }
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== undefined) {
        window.clearTimeout(toastTimer.current);
      }
    };
  }, []);

  const newTerminal = useCallback(() => {
    if (apiRef.current) {
      addTerminalAutoGrid(apiRef.current, () =>
        showToast("Нет места для сплита — открыл вкладкой"),
      );
    }
  }, [showToast]);

  const newTab = useCallback(() => {
    const api = apiRef.current;
    if (api) {
      addPanel(api, { group: api.activeGroup ?? undefined });
    }
  }, []);

  const badges = useHotkeys({
    getApi: () => apiRef.current,
    newTerminal,
    newTab,
    requestCloseGroup: setCloseGroupRequest,
    suppressCleanupRef,
  });

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    // Закрытие панели любым путём (крестик, группа, хоткей) должно
    // убивать процесс — единая точка уборки.
    event.api.onDidRemovePanel((panel) => {
      if (!suppressCleanupRef.current) {
        void destroyTerminal(panel.id);
      }
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
        onNewTerminal={newTerminal}
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
      {toast && <div className="toast">{toast}</div>}
      {badges && (
        <div className="quick-badges">
          {badges.map((badge) => (
            <div
              key={badge.num}
              className={`quick-badge ${badge.active ? "is-active" : ""}`}
              style={{ left: badge.left, top: badge.top }}
            >
              {badge.num}
            </div>
          ))}
        </div>
      )}
      {closeGroupRequest && (
        <ConfirmDialog
          text={`Закрыть ${closeGroupRequest.panels.length} ${plural(
            closeGroupRequest.panels.length,
            "терминал",
            "терминала",
            "терминалов",
          )}?`}
          confirmLabel="Закрыть"
          onConfirm={() => {
            closeGroupRequest.api.close();
            setCloseGroupRequest(null);
          }}
          onCancel={() => setCloseGroupRequest(null)}
        />
      )}
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return one;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return few;
  }
  return many;
}
