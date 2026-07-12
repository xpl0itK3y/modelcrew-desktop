import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TerminalPanel } from "./panels/TerminalPanel";
import { TerminalTab } from "./panels/TerminalTab";
import {
  destroyTerminal,
  applyTerminalTheme,
  getAutoTitle,
  isManualTitle,
  rememberAutoTitle,
} from "./terminal/registry";
import { Titlebar } from "./ui/Titlebar";
import { Sidebar } from "./ui/Sidebar";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Settings } from "./ui/Settings";
import {
  CloseIcon,
  FolderIcon,
  MaximizeIcon,
  PlusIcon,
  SplitIcon,
} from "./ui/Icons";
import { appActions } from "./appActions";
import { useHotkeys } from "./hotkeys/useHotkeys";
import { useCmdDrag } from "./hotkeys/useCmdDrag";
import {
  getAppTheme,
  loadAccent,
  loadTheme,
  saveAccent,
  saveTheme,
} from "./theme";
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
const isTauri = "__TAURI_INTERNALS__" in window;

type WorkspaceRootResult =
  | { status: "cancelled" }
  | { status: "bound"; workspaceId: string; path: string }
  | { status: "alreadyOpen"; workspaceId: string; path: string };

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
  workspaceId: string,
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
    // В layout сохраняется только владелец панели. cwd разрешает Rust.
    params: { workspaceId },
    minimumWidth: PANEL_MIN_WIDTH,
    minimumHeight: PANEL_MIN_HEIGHT,
    ...(options.group
      ? {
          position: {
            referenceGroup: options.group,
            ...(options.direction ? { direction: options.direction } : {}),
          },
        }
      : options.direction
        ? // Absolute-позиция: панель встаёт у края всего грида
          // (полноширинная строка/колонка).
          { position: { direction: options.direction } }
        : {}),
  });
}

// Новый терминал встаёт в сетку: делим самую большую группу вдоль её
// длинной стороны. Вкладок нет — один терминал = одна панель, поэтому
// при упоре в минимумы 240×160 новый терминал не создаём вовсе.
function addTerminalAutoGrid(
  api: DockviewApi,
  workspaceId: string,
  onNoSpace?: () => void,
) {
  const groups = api.groups;
  if (groups.length === 0) {
    addPanel(api, workspaceId);
    return;
  }

  // Раскладка строится СТРОКАМИ: новая панель встаёт в самую короткую
  // строку, а когда строки заполнены — полноширинной строкой снизу.
  // У строчного дерева вертикальные разделители соседних строк
  // независимы: перетаскивание границы в одной строке не двигает другую.
  const sorted = [...groups].sort((a, b) => {
    const rectA = a.element.getBoundingClientRect();
    const rectB = b.element.getBoundingClientRect();
    if (Math.abs(rectA.top - rectB.top) > 30) {
      return rectA.top - rectB.top;
    }
    return rectA.left - rectB.left;
  });
  const rows: DockviewGroupPanel[][] = [];
  let currentTop = Number.NEGATIVE_INFINITY;
  for (const group of sorted) {
    const top = group.element.getBoundingClientRect().top;
    if (Math.abs(top - currentTop) > 30) {
      rows.push([]);
      currentTop = top;
    }
    rows[rows.length - 1].push(group);
  }

  let shortest = rows[0];
  for (const row of rows) {
    if (row.length < shortest.length) {
      shortest = row;
    }
  }
  const targetColumns = Math.ceil(Math.sqrt(groups.length + 1));
  const rowWidth = shortest.reduce((width, group) => width + group.width, 0);
  const widenFits = rowWidth / (shortest.length + 1) >= PANEL_MIN_WIDTH;
  const gridHeight = rows.reduce((height, row) => height + row[0].height, 0);
  const newRowFits = gridHeight / (rows.length + 1) >= PANEL_MIN_HEIGHT;

  // Соседи ужимаются мгновенно, а плавность дорисовывает FLIP поверх.
  const before = snapshotGroupRects(api);
  if (widenFits && (shortest.length < targetColumns || !newRowFits)) {
    addPanel(api, workspaceId, {
      group: shortest[shortest.length - 1],
      direction: "right",
    });
  } else if (newRowFits) {
    addPanel(api, workspaceId, { direction: "below" });
  } else {
    onNoSpace?.();
    return;
  }
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
          const workspaceId = appActions.getActiveWorkspaceId();
          if (!workspaceId) {
            return;
          }
          const before = snapshotGroupRects(props.containerApi);
          addPanel(props.containerApi, workspaceId, {
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
  // Первый запуск (воркспейса нет) — онбординг через выбор папки проекта.
  if (!appActions.hasActiveWorkspace()) {
    return (
      <div className="welcome">
        <div className="welcome-badge">MODELCREW</div>
        <h1 className="welcome-title">Собери свою команду.</h1>
        <p className="welcome-subtitle">
          Выбери папку проекта — в ней будут жить терминалы воркспейса.
        </p>
        <button
          type="button"
          className="welcome-button"
          onClick={() => appActions.requestCreateWorkspace()}
        >
          <FolderIcon /> Открыть папку проекта
        </button>
        <div className="welcome-hints">
          <span>
            <kbd>⌘T</kbd> тоже откроет выбор папки
          </span>
        </div>
      </div>
    );
  }
  // Воркспейс есть, но все терминалы закрыты.
  return (
    <div className="welcome">
      <div className="welcome-badge">MODELCREW</div>
      <h1 className="welcome-title">Собери свою команду.</h1>
      <p className="welcome-subtitle">Терминалы для агентов — в одном окне.</p>
      <button
        type="button"
        className="welcome-button"
        onClick={() => {
          const workspaceId = appActions.getActiveWorkspaceId();
          if (workspaceId) {
            addTerminalAutoGrid(props.containerApi, workspaceId);
          }
        }}
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
  // Панель развёрнута на всё окно (⌘↩ / кнопка) — показываем индикатор.
  const [zoomed, setZoomed] = useState(false);
  const [accent, setAccent] = useState(loadAccent);
  const [themeId, setThemeId] = useState(loadTheme);
  const dockviewTheme = useMemo<DockviewTheme>(
    () => ({ ...modelcrewTheme, colorScheme: getAppTheme(themeId).scheme }),
    [themeId],
  );
  const [workspaces, setWorkspaces] = useState<WorkspacesState>(() => {
    // Первый запуск — без воркспейсов: пользователь начинает с выбора
    // папки проекта на welcome-экране.
    return loadWorkspacesState() ?? { list: [], activeId: null };
  });
  // Dockview не монтируется, пока Rust не зарегистрировал корни: иначе
  // восстановленные панели успеют запросить PTY раньше workspace roots.
  const [rootRegistryReady, setRootRegistryReady] = useState(!isTauri);
  const [rootErrors, setRootErrors] = useState<Record<string, string>>({});
  const rootErrorsRef = useRef(rootErrors);
  rootErrorsRef.current = rootErrors;
  const [deleteWorkspaceRequest, setDeleteWorkspaceRequest] =
    useState<Workspace | null>(null);
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const persistTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    applyTerminalTheme(themeId);
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
    if (!isTauri) {
      return;
    }
    let cancelled = false;
    const initial = workspacesRef.current.list;
    void (async () => {
      try {
        await invoke("workspace_reconcile_roots", {
          workspaceIds: initial.map((workspace) => workspace.id),
        });
      } catch (error) {
        if (!cancelled) {
          showToast(`Не удалось синхронизировать папки: ${String(error)}`);
        }
      }

      const results = await Promise.all(
        initial.map(async (workspace) => {
          if (!workspace.folder) {
            return {
              id: workspace.id,
              error: "Выберите папку проекта заново",
            };
          }
          try {
            const result = await invoke<WorkspaceRootResult>(
              "workspace_register_root",
              { workspaceId: workspace.id, path: workspace.folder },
            );
            if (result.status === "bound") {
              return { id: workspace.id, path: result.path };
            }
            if (result.status === "alreadyOpen") {
              return {
                id: workspace.id,
                error: `Папка уже принадлежит воркспейсу ${result.workspaceId}`,
              };
            }
            return { id: workspace.id, error: "Папка проекта не выбрана" };
          } catch (error) {
            return { id: workspace.id, error: String(error) };
          }
        }),
      );
      if (cancelled) {
        return;
      }
      const canonicalPaths = new Map(
        results
          .filter(
            (result): result is { id: string; path: string } =>
              "path" in result,
          )
          .map((result) => [result.id, result.path]),
      );
      const errors = Object.fromEntries(
        results
          .filter(
            (result): result is { id: string; error: string } =>
              "error" in result,
          )
          .map((result) => [result.id, result.error]),
      );
      setWorkspaces((previous) => {
        const next = {
          ...previous,
          list: previous.list.map((workspace) => ({
            ...workspace,
            folder: canonicalPaths.get(workspace.id) ?? workspace.folder,
          })),
        };
        workspacesRef.current = next;
        return next;
      });
      rootErrorsRef.current = errors;
      setRootErrors(errors);
      setRootRegistryReady(true);
    })();
    return () => {
      cancelled = true;
    };
    // Регистрация нужна один раз до первого mount Dockview. Новые корни
    // добавляет атомарная backend-команда workspace_pick_root.
  }, [showToast]);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== undefined) {
        window.clearTimeout(toastTimer.current);
      }
    };
  }, []);

  const newTerminal = useCallback(() => {
    // Терминалы живут только в воркспейсе: без него сначала выбор папки.
    const { list, activeId } = workspacesRef.current;
    const active = list.find((workspace) => workspace.id === activeId);
    if (!active || !active.folder || rootErrorsRef.current[active.id]) {
      appActions.requestCreateWorkspace();
      return;
    }
    if (!rootRegistryReady) {
      showToast("Папка проекта ещё проверяется");
      return;
    }
    const addToGrid = () => {
      if (!apiRef.current) {
        return;
      }
      addTerminalAutoGrid(apiRef.current, active.id, () =>
        showToast("Нет места для сплита"),
      );
    };
    if (!isTauri) {
      addToGrid();
      return;
    }
    void invoke("workspace_validate_root", { workspaceId: active.id })
      .then(addToGrid)
      .catch((error) => {
        const nextErrors = {
          ...rootErrorsRef.current,
          [active.id]: String(error),
        };
        rootErrorsRef.current = nextErrors;
        setRootErrors(nextErrors);
        showToast(String(error));
        appActions.requestCreateWorkspace();
      });
  }, [rootRegistryReady, showToast]);

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
    (list: Workspace[], activeId: string | null): Workspace[] => {
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
        if (
          workspace.folder &&
          !rootErrorsRef.current[workspace.id] &&
          workspace.layout
        ) {
          api.fromJSON(workspace.layout);
        } else {
          api.closeAllGroups();
        }
      } finally {
        suppressCleanupRef.current = false;
      }
      if (
        workspace.folder &&
        !rootErrorsRef.current[workspace.id] &&
        !workspace.layout
      ) {
        addPanel(api, workspace.id);
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
        // Папка нового активного воркспейса должна быть видна addPanel
        // уже в момент восстановления его раскладки.
        workspacesRef.current = { list, activeId: id };
        loadWorkspace(target);
        return workspacesRef.current;
      });
    },
    [loadWorkspace, snapshotActive],
  );

  const createWorkspace = useCallback(async () => {
    if (!isTauri) {
      showToast("Выбор папки доступен в приложении ModelCrew");
      return;
    }
    const current = workspacesRef.current;
    try {
      await invoke("workspace_reconcile_roots", {
        workspaceIds: current.list.map((workspace) => workspace.id),
      });
    } catch (error) {
      showToast(`Не удалось подготовить папки: ${String(error)}`);
      return;
    }
    const active = current.list.find(
      (workspace) => workspace.id === current.activeId,
    );
    // Старый workspace без папки или с исчезнувшей папкой переиспользуем:
    // его id и layout сохраняются, меняется только backend-привязка.
    const relinking =
      active && (!active.folder || rootErrorsRef.current[active.id])
        ? active
        : null;
    const workspaceId = relinking?.id ?? crypto.randomUUID();

    let result: WorkspaceRootResult;
    try {
      result = await invoke<WorkspaceRootResult>("workspace_pick_root", {
        workspaceId,
      });
    } catch (error) {
      showToast(String(error));
      return;
    }
    if (result.status === "cancelled") {
      return;
    }
    if (result.status === "alreadyOpen") {
      const existing = workspacesRef.current.list.find(
        (workspace) => workspace.id === result.workspaceId,
      );
      if (existing) {
        showToast(`Папка уже открыта в «${existing.name}»`);
        selectWorkspace(existing.id);
      } else {
        showToast("Папка уже зарегистрирована другим воркспейсом");
      }
      return;
    }
    if (result.workspaceId !== workspaceId) {
      showToast("Backend вернул чужой идентификатор воркспейса");
      return;
    }

    const folder = result.path;
    const baseName =
      folder.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "workspace";
    const nextErrors = { ...rootErrorsRef.current };
    delete nextErrors[workspaceId];
    rootErrorsRef.current = nextErrors;
    setRootErrors(nextErrors);

    setWorkspaces((prev) => {
      const existing = prev.list.find((workspace) => workspace.id === workspaceId);
      const fresh: Workspace = existing
        ? { ...existing, folder }
        : {
            id: workspaceId,
            name: baseName,
            folder,
            layout: null,
            count: 0,
          };
      const list = existing
        ? prev.list.map((workspace) =>
            workspace.id === workspaceId ? fresh : workspace,
          )
        : [...snapshotActive(prev.list, prev.activeId), fresh];
      workspacesRef.current = { list, activeId: fresh.id };
      loadWorkspace(fresh);
      return workspacesRef.current;
    });
  }, [loadWorkspace, snapshotActive, selectWorkspace, showToast]);

  useEffect(() => {
    appActions.requestCloseGroup = setCloseGroupRequest;
    appActions.getActiveWorkspaceId = () => workspacesRef.current.activeId;
    appActions.hasActiveWorkspace = () => {
      const { list, activeId } = workspacesRef.current;
      const active = list.find((workspace) => workspace.id === activeId);
      return Boolean(
        active?.folder && activeId && !rootErrorsRef.current[activeId],
      );
    };
    appActions.requestCreateWorkspace = () => {
      void createWorkspace();
    };
    return () => {
      appActions.requestCloseGroup = () => {};
      appActions.getActiveWorkspaceId = () => null;
      appActions.hasActiveWorkspace = () => false;
      appActions.requestCreateWorkspace = () => {};
    };
  }, [createWorkspace]);

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
      if (isTauri) {
        void invoke("workspace_unregister_root", {
          workspaceId: workspace.id,
        }).catch((error) => showToast(String(error)));
      }
      const nextErrors = { ...rootErrorsRef.current };
      delete nextErrors[workspace.id];
      rootErrorsRef.current = nextErrors;
      setRootErrors(nextErrors);
      setWorkspaces((prev) => {
        const remaining = prev.list.filter((item) => item.id !== workspace.id);
        if (workspace.id === prev.activeId) {
          const api = apiRef.current;
          // Закрываем без подавления — PTY этих панелей должны умереть.
          api?.closeAllGroups();
          // Последний воркспейс удалён — возврат к онбордингу.
          if (remaining.length === 0) {
            workspacesRef.current = { list: [], activeId: null };
            setTerminalCount(0);
            return workspacesRef.current;
          }
          const next = remaining[0];
          workspacesRef.current = { list: remaining, activeId: next.id };
          loadWorkspace(next);
          return workspacesRef.current;
        }
        for (const panelId of Object.keys(workspace.layout?.panels ?? {})) {
          void destroyTerminal(panelId);
        }
        return { list: remaining, activeId: prev.activeId };
      });
    },
    [loadWorkspace, showToast],
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
    // Без воркспейса терминалы не создаём — welcome ведёт через выбор папки.
    const { list, activeId } = workspacesRef.current;
    const active = list.find((workspace) => workspace.id === activeId);
    if (active?.folder && !rootErrorsRef.current[active.id] && active.layout) {
      try {
        event.api.fromJSON(active.layout);
      } catch {
        addPanel(event.api, active.id);
      }
      setTerminalCount(event.api.panels.length);
    } else if (active?.folder && !rootErrorsRef.current[active.id]) {
      addPanel(event.api, active.id);
    }
    event.api.onDidLayoutChange(() => {
      schedulePersist();
    });
    event.api.onDidMaximizedGroupChange(() => {
      setZoomed(event.api.hasMaximizedGroup());
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
        workspaceFolder={activeWorkspace?.folder ?? null}
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
              folder: workspace.folder,
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
          {rootRegistryReady ? (
            <DockviewReact
              components={components}
              tabComponents={tabComponents}
              watermarkComponent={Welcome}
              rightHeaderActionsComponent={GroupActions}
              onReady={onReady}
              theme={dockviewTheme}
            />
          ) : (
            <div className="workspace-loading">Проверяем папки проектов…</div>
          )}
        </main>
      </div>
      {toast && <div className="toast">{toast}</div>}
      {zoomed && (
        <button
          type="button"
          className="zoom-indicator"
          title="Вернуть раскладку"
          onClick={() => apiRef.current?.exitMaximizedGroup()}
        >
          <MaximizeIcon /> Терминал развёрнут
          <span className="zoom-indicator-hint">
            <kbd>⌘↩</kbd> вернуть
          </span>
        </button>
      )}
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
          themeId={themeId}
          accent={accent}
          onSelectTheme={(nextThemeId) => {
            setThemeId(nextThemeId);
            saveTheme(nextThemeId);
            applyTerminalTheme(nextThemeId);
          }}
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
