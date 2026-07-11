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
import { listen } from "@tauri-apps/api/event";
import { TerminalPanel } from "./panels/TerminalPanel";
import { TerminalTab } from "./panels/TerminalTab";
import {
  destroyTerminal,
  getAutoTitle,
  isManualTitle,
  rememberAutoTitle,
} from "./terminal/registry";
import { Titlebar } from "./ui/Titlebar";
import { Sidebar } from "./ui/Sidebar";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Settings } from "./ui/Settings";
import { CloseIcon, MaximizeIcon, PlusIcon, SplitIcon } from "./ui/Icons";
import { appActions } from "./appActions";
import { useHotkeys } from "./hotkeys/useHotkeys";
import { useCmdDrag } from "./hotkeys/useCmdDrag";
import { applyAccent, loadAccent, saveAccent } from "./theme";
import {
  closeGroupAnimated,
  flipGroups,
  snapshotGroupRects,
} from "./animations";
import {
  loadWorkspacesState,
  saveWorkspacesState,
  type Workspace,
  type WorkspacesState,
} from "./persist";
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

function addPanel(
  api: DockviewApi,
  options: {
    group?: DockviewGroupPanel;
    direction?: "left" | "right" | "above" | "below";
  } = {},
) {
  api.addPanel({
    id: crypto.randomUUID(),
    component: "terminal",
    tabComponent: "terminal",
    // Placeholder до первого тика вотчера, который подпишет панель
    // именем процесса (zsh, codex, vim, …).
    title: "терминал",
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
// длинной стороны. Вкладок нет — один терминал = одна панель, поэтому
// при упоре в минимумы 240×160 новый терминал не создаём вовсе.
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
    onNoSpace?.();
    return;
  }
  // Соседи ужимаются мгновенно, а плавность дорисовывает FLIP поверх.
  const before = snapshotGroupRects(api);
  addPanel(api, { group: target, direction });
  flipGroups(api, before, 200);
}

function GroupActions(props: IDockviewHeaderActionsProps) {
  return (
    <div className="group-actions">
      <button
        type="button"
        className="icon-button"
        title="Сплит вправо"
        onClick={() => {
          const before = snapshotGroupRects(props.containerApi);
          addPanel(props.containerApi, {
            group: props.group,
            direction: "right",
          });
          flipGroups(props.containerApi, before, 200);
        }}
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
      <button
        type="button"
        className="icon-button"
        title="Закрыть группу (⌘⇧W)"
        onClick={() => appActions.requestCloseGroup(props.group)}
      >
        <CloseIcon />
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
  // Во время swap/переключения воркспейса layout пересоздаётся через
  // fromJSON: панели формально удаляются, но PTY должны остаться живыми.
  const suppressCleanupRef = useRef(false);
  const [closeGroupRequest, setCloseGroupRequest] =
    useState<DockviewGroupPanel | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accent, setAccent] = useState(loadAccent);
  const [workspaces, setWorkspaces] = useState<WorkspacesState>(() => {
    const saved = loadWorkspacesState();
    if (saved) {
      return saved;
    }
    const first: Workspace = {
      id: crypto.randomUUID(),
      name: WORKSPACE_NAME,
      layout: null,
      count: 0,
    };
    return { list: [first], activeId: first.id };
  });
  const [deleteWorkspaceRequest, setDeleteWorkspaceRequest] =
    useState<Workspace | null>(null);
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const persistTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    applyAccent(accent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Снимок всего состояния воркспейсов в localStorage; активный —
  // с живой раскладкой из dockview.
  const persistNow = useCallback(() => {
    const { list, activeId } = workspacesRef.current;
    const api = apiRef.current;
    const snapshot = list.map((workspace) =>
      workspace.id === activeId && api
        ? { ...workspace, layout: api.toJSON(), count: api.panels.length }
        : workspace,
    );
    saveWorkspacesState({ list: snapshot, activeId });
  }, []);

  const schedulePersist = useCallback(() => {
    if (persistTimer.current !== undefined) {
      window.clearTimeout(persistTimer.current);
    }
    persistTimer.current = window.setTimeout(persistNow, 500);
  }, [persistNow]);

  useEffect(() => {
    schedulePersist();
  }, [workspaces, schedulePersist]);

  useEffect(() => {
    window.addEventListener("beforeunload", persistNow);
    return () => window.removeEventListener("beforeunload", persistNow);
  }, [persistNow]);

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

  const badges = useHotkeys({
    getApi: () => apiRef.current,
    newTerminal,
    requestCloseGroup: setCloseGroupRequest,
    suppressCleanupRef,
  });

  // ⌘-драг: перетаскивание терминала за любое место мышью.
  useCmdDrag({
    getApi: () => apiRef.current,
    suppressCleanupRef,
  });

  useEffect(() => {
    appActions.requestCloseGroup = setCloseGroupRequest;
    return () => {
      appActions.requestCloseGroup = () => {};
    };
  }, []);

  // Панели скрытых воркспейсов не получают pty-title: доводим имена из кэша.
  const applyAutoTitles = useCallback((api: DockviewApi) => {
    for (const panel of api.panels) {
      const title = getAutoTitle(panel.id);
      if (title && !isManualTitle(panel.id)) {
        panel.api.setTitle(title);
      }
    }
  }, []);

  // Снимок активного воркспейса перед уходом с него.
  const snapshotActive = useCallback(
    (list: Workspace[], activeId: string): Workspace[] => {
      const api = apiRef.current;
      if (!api) {
        return list;
      }
      const layout = api.toJSON();
      const count = api.panels.length;
      return list.map((workspace) =>
        workspace.id === activeId ? { ...workspace, layout, count } : workspace,
      );
    },
    [],
  );

  const loadWorkspace = useCallback(
    (workspace: Workspace) => {
      const api = apiRef.current;
      if (!api) {
        return;
      }
      suppressCleanupRef.current = true;
      try {
        if (workspace.layout) {
          api.fromJSON(workspace.layout);
        } else {
          api.closeAllGroups();
        }
      } finally {
        suppressCleanupRef.current = false;
      }
      if (!workspace.layout) {
        addPanel(api);
      }
      applyAutoTitles(api);
      setTerminalCount(api.panels.length);
    },
    [applyAutoTitles],
  );

  const selectWorkspace = useCallback(
    (id: string) => {
      setWorkspaces((prev) => {
        if (id === prev.activeId) {
          return prev;
        }
        const target = prev.list.find((workspace) => workspace.id === id);
        if (!target) {
          return prev;
        }
        const list = snapshotActive(prev.list, prev.activeId);
        loadWorkspace(target);
        return { list, activeId: id };
      });
    },
    [loadWorkspace, snapshotActive],
  );

  const createWorkspace = useCallback(() => {
    setWorkspaces((prev) => {
      const fresh: Workspace = {
        id: crypto.randomUUID(),
        name: `workspace ${prev.list.length + 1}`,
        layout: null,
        count: 0,
      };
      const list = snapshotActive(prev.list, prev.activeId);
      loadWorkspace(fresh);
      return { list: [...list, fresh], activeId: fresh.id };
    });
  }, [loadWorkspace, snapshotActive]);

  const renameWorkspace = useCallback((id: string, name: string) => {
    setWorkspaces((prev) => ({
      ...prev,
      list: prev.list.map((workspace) =>
        workspace.id === id ? { ...workspace, name } : workspace,
      ),
    }));
  }, []);

  const workspacePanelCount = useCallback(
    (workspace: Workspace): number => {
      if (workspace.id === workspaces.activeId) {
        return apiRef.current?.panels.length ?? workspace.count;
      }
      return workspace.layout
        ? Object.keys(workspace.layout.panels).length
        : workspace.count;
    },
    [workspaces.activeId],
  );

  // Удаление воркспейса: все его терминалы убиваются.
  const deleteWorkspace = useCallback(
    (workspace: Workspace) => {
      setWorkspaces((prev) => {
        const remaining = prev.list.filter((item) => item.id !== workspace.id);
        if (remaining.length === 0) {
          return prev;
        }
        if (workspace.id === prev.activeId) {
          const api = apiRef.current;
          // Закрываем без подавления — PTY этих панелей должны умереть.
          api?.closeAllGroups();
          const next = remaining[0];
          loadWorkspace(next);
          return { list: remaining, activeId: next.id };
        }
        for (const panelId of Object.keys(workspace.layout?.panels ?? {})) {
          void destroyTerminal(panelId);
        }
        return { list: remaining, activeId: prev.activeId };
      });
    },
    [loadWorkspace],
  );

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
    // Вкладок нет: перетаскивание может целиться только в сплиты,
    // дроп в центр/таббар чужой группы запрещён.
    event.api.onWillShowOverlay((overlay) => {
      if (
        overlay.kind === "tab" ||
        overlay.kind === "header_space" ||
        (overlay.kind === "content" && overlay.position === "center")
      ) {
        overlay.preventDefault();
      }
    });
    // Панель подписывается именем процесса переднего плана из PTY,
    // пока пользователь не переименовал её руками.
    if ("__TAURI_INTERNALS__" in window) {
      void listen<{ id: string; title: string }>("pty-title", (titleEvent) => {
        rememberAutoTitle(titleEvent.payload.id, titleEvent.payload.title);
        const panel = event.api.getPanel(titleEvent.payload.id);
        if (panel && !isManualTitle(titleEvent.payload.id)) {
          panel.api.setTitle(titleEvent.payload.title);
        }
      }).catch(() => {});
    }
    // Восстановление раскладки прошлого запуска; шеллы поднимутся свежие.
    const { list, activeId } = workspacesRef.current;
    const active = list.find((workspace) => workspace.id === activeId);
    if (active?.layout) {
      try {
        event.api.fromJSON(active.layout);
      } catch {
        addPanel(event.api);
      }
      setTerminalCount(event.api.panels.length);
    } else {
      addPanel(event.api);
    }
    event.api.onDidLayoutChange(() => {
      schedulePersist();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeWorkspace = workspaces.list.find(
    (workspace) => workspace.id === workspaces.activeId,
  );

  return (
    <div className={`app-shell ${sidebarVisible ? "" : "sidebar-hidden"}`}>
      <Titlebar
        workspaceName={activeWorkspace?.name ?? WORKSPACE_NAME}
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible((visible) => !visible)}
        onNewTerminal={newTerminal}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="app-body">
        <div className="sidebar-rail" aria-hidden={!sidebarVisible}>
          <Sidebar
            workspaces={workspaces.list.map((workspace) => ({
              id: workspace.id,
              name: workspace.name,
              count:
                workspace.id === workspaces.activeId
                  ? terminalCount
                  : workspacePanelCount(workspace),
            }))}
            activeId={workspaces.activeId}
            onSelect={selectWorkspace}
            onCreate={createWorkspace}
            onRename={renameWorkspace}
            onDelete={(id) => {
              const workspace = workspaces.list.find(
                (item) => item.id === id,
              );
              if (workspace) {
                setDeleteWorkspaceRequest(workspace);
              }
            }}
          />
        </div>
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
          text="Закрытие терминала"
          confirmLabel="Закрыть"
          onConfirm={() => {
            closeGroupAnimated(closeGroupRequest);
            setCloseGroupRequest(null);
          }}
          onCancel={() => setCloseGroupRequest(null)}
        />
      )}
      {deleteWorkspaceRequest && (
        <ConfirmDialog
          text={`Удалить воркспейс «${deleteWorkspaceRequest.name}» и закрыть ${workspacePanelCount(
            deleteWorkspaceRequest,
          )} ${plural(
            workspacePanelCount(deleteWorkspaceRequest),
            "терминал",
            "терминала",
            "терминалов",
          )}?`}
          confirmLabel="Удалить"
          onConfirm={() => {
            deleteWorkspace(deleteWorkspaceRequest);
            setDeleteWorkspaceRequest(null);
          }}
          onCancel={() => setDeleteWorkspaceRequest(null)}
        />
      )}
      {settingsOpen && (
        <Settings
          accent={accent}
          onSelectAccent={(color) => {
            setAccent(color);
            saveAccent(color);
          }}
          onClose={() => setSettingsOpen(false)}
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
