import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DockviewApi,
  DockviewGroupPanel,
  DockviewReact,
  DockviewReadyEvent,
  DockviewTheme,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TerminalPanel } from "./panels/TerminalPanel";
import { TerminalTab } from "./panels/TerminalTab";
import { GroupActions } from "./panels/GroupActions";
import { Welcome } from "./panels/Welcome";
import {
  destroyTerminal,
  applyTerminalFontSize,
  applyTerminalTheme,
  getAutoTitle,
  getRunningTerminalCount,
  isManualTitle,
  rememberAutoTitle,
  restartRunningTerminals,
} from "./terminal/registry";
import { Titlebar } from "./ui/Titlebar";
import { Sidebar } from "./ui/Sidebar";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Settings } from "./ui/Settings";
import { MaximizeIcon } from "./ui/Icons";
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
import { closeGroupAnimated } from "./animations";
import {
  addPanel,
  addTerminalAutoGrid,
  defaultTerminalTitles,
  localizeDefaultPanelTitles,
  snapshotActiveSessionLayout,
} from "./layoutOps";
import {
  activeSession,
  createDefaultSession,
  createTerminalSession,
  folderBaseName,
  isActiveSession,
  loadWorkspacesState,
  nextSessionDefaultIndex,
  saveWorkspacesState,
  sessionDisplayName,
  type FolderRuntimeStatus,
  type TerminalSession,
  type Workspace,
  type WorkspacesState,
} from "./persist";
import {
  backendErrorReason,
  formatTerminalCount,
  localizeBackendError,
  translate,
  useI18n,
} from "./i18n";
import { isMac, MAX_TERMINALS, WORKSPACE_NAME } from "./constants";
import { loadShell, saveShell } from "./shell";
import {
  loadTerminalFontSize,
  saveTerminalFontSize,
} from "./terminal/preferences";
import { useAppUpdater } from "./updater/useAppUpdater";
import { useNotificationSounds } from "./updater/useNotificationSounds";
import "./styles/index.css";

function unavailable(error: unknown): FolderRuntimeStatus {
  return {
    kind: "unavailable",
    reason: backendErrorReason(error),
    message: localizeBackendError(error),
  };
}

const components = { terminal: TerminalPanel };
const tabComponents = { terminal: TerminalTab };
const isTauri = "__TAURI_INTERNALS__" in window;

type WorkspaceRootResult =
  | { status: "cancelled" }
  | { status: "bound"; workspaceId: string; path: string }
  | { status: "alreadyOpen"; workspaceId: string; path: string };

type SessionDeleteRequest = {
  workspaceId: string;
  sessionId: string;
};

const modelcrewTheme: DockviewTheme = {
  name: "modelcrew",
  className: "dockview-theme-modelcrew",
  colorScheme: "dark",
  gap: 3,
  dndOverlayMounting: "absolute",
  dndPanelOverlay: "group",
  tabGroupIndicator: "none",
};

export default function App() {
  const { locale, t } = useI18n();
  const apiRef = useRef<DockviewApi | null>(null);
  const [, setTerminalCount] = useState(0);
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
  const [terminalFontSize, setTerminalFontSize] = useState(
    loadTerminalFontSize,
  );
  const [shell, setShell] = useState<string | null>(loadShell);
  const [pendingShell, setPendingShell] = useState<{
    command: string | null;
    label: string;
    count: number;
  } | null>(null);
  const [shellBusy, setShellBusy] = useState(false);
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
  const [rootErrors, setRootErrors] = useState<
    Record<string, FolderRuntimeStatus>
  >({});
  const rootErrorsRef = useRef(rootErrors);
  rootErrorsRef.current = rootErrors;
  const [deleteWorkspaceRequest, setDeleteWorkspaceRequest] =
    useState<Workspace | null>(null);
  const [deleteSessionRequest, setDeleteSessionRequest] =
    useState<SessionDeleteRequest | null>(null);
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const persistTimer = useRef<number | undefined>(undefined);
  const dockviewDisposablesRef = useRef<Array<{ dispose(): void }>>([]);
  const ptyTitleUnlistenRef = useRef<(() => void) | null>(null);
  const dockviewDisposedRef = useRef(false);

  useEffect(() => {
    setToast(null);
    if (toastTimer.current !== undefined) {
      window.clearTimeout(toastTimer.current);
      toastTimer.current = undefined;
    }
    if (isTauri) {
      void invoke("app_set_locale", { locale }).catch((error) => {
        console.error("Could not update native locale", error);
      });
    }

    const localizedTitle = translate("terminal.defaultTitle");
    for (const panel of apiRef.current?.panels ?? []) {
      const titleKind = panel.api.getParameters<{ titleKind?: string }>()
        .titleKind;
      if (
        (titleKind === "default" ||
          (titleKind === undefined &&
            defaultTerminalTitles.has(panel.title ?? ""))) &&
        !isManualTitle(panel.id)
      ) {
        panel.api.setTitle(localizedTitle);
      }
    }
    setWorkspaces((previous) => {
      const next = {
        ...previous,
        list: previous.list.map((workspace) => ({
          ...workspace,
          sessions: workspace.sessions.map((session) => ({
            ...session,
            layout: localizeDefaultPanelTitles(session.layout),
          })),
        })),
      };
      workspacesRef.current = next;
      return next;
    });
  }, [locale]);

  useEffect(() => {
    applyTerminalTheme(themeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Снимок всего состояния воркспейсов в localStorage; активный —
  // с живой раскладкой из dockview.
  const persistNow = useCallback(() => {
    const { list, activeId } = workspacesRef.current;
    const snapshot = snapshotActiveSessionLayout(list, activeId, apiRef.current);
    saveWorkspacesState({ list: snapshot, activeId });
  }, []);

  const prepareForUpdate = useCallback(async () => {
    // Фиксируем Dockview/Workspace и явно гасим процессы перед заменой
    // self-update или перед перезапуском уже установленного Linux-пакета.
    // Native Linux install идёт раньше, чтобы отмена системной авторизации
    // не закрывала пользовательские терминалы.
    persistNow();
    if (isTauri) {
      try {
        await invoke("pty_kill_all");
      } catch (error) {
        throw new Error(localizeBackendError(error));
      }
    }
  }, [persistNow]);

  const updater = useAppUpdater({ locale, beforeInstall: prepareForUpdate });

  useNotificationSounds(updater.center.items);

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

  const requestShellChange = useCallback(
    (command: string | null, label: string) => {
      if (shellBusy || command === shell) {
        return;
      }
      const count = getRunningTerminalCount();
      if (count === 0) {
        saveShell(command);
        setShell(command);
        showToast(translate("settings.shellChanged"));
        return;
      }
      setPendingShell({ command, label, count });
    },
    [shell, shellBusy, showToast],
  );

  const confirmShellChange = useCallback(() => {
    const request = pendingShell;
    if (!request || shellBusy) {
      return;
    }

    setShellBusy(true);
    saveShell(request.command);
    setShell(request.command);
    void restartRunningTerminals(request.command)
      .then((result) => {
        if (result.failures.length > 0) {
          showToast(
            translate("settings.shellRestartFailed", {
              failed: result.failures.length,
              total: result.total,
            }),
          );
        } else if (result.restarted > 0) {
          showToast(
            translate("settings.shellRestarted", {
              terminals: formatTerminalCount(result.restarted),
            }),
          );
        } else {
          showToast(translate("settings.shellChanged"));
        }
      })
      .catch((error) => showToast(localizeBackendError(error)))
      .finally(() => {
        setShellBusy(false);
        setPendingShell(null);
      });
  }, [pendingShell, shellBusy, showToast]);

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
          showToast(
            translate("workspace.syncFailed", {
              error: localizeBackendError(error),
            }),
          );
        }
      }

      const results = await Promise.all(
        initial.map(async (workspace) => {
          if (!workspace.folder) {
            return {
              id: workspace.id,
              status: { kind: "unbound" } as FolderRuntimeStatus,
            };
          }
          try {
            const result = await invoke<WorkspaceRootResult>(
              "workspace_register_root",
              { workspaceId: workspace.id, path: workspace.folder.canonicalPath },
            );
            if (result.status === "bound") {
              return { id: workspace.id, path: result.path };
            }
            if (result.status === "alreadyOpen") {
              return {
                id: workspace.id,
                status: {
                  kind: "unavailable",
                  reason: "unknown",
                  message: translate("workspace.rootOwnedBy", {
                    workspaceId: result.workspaceId,
                  }),
                } as FolderRuntimeStatus,
              };
            }
            return {
              id: workspace.id,
              status: { kind: "unbound" } as FolderRuntimeStatus,
            };
          } catch (error) {
            return { id: workspace.id, status: unavailable(error) };
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
            (result): result is { id: string; status: FolderRuntimeStatus } =>
              "status" in result,
          )
          .map((result) => [result.id, result.status]),
      );
      setWorkspaces((previous) => {
        const next = {
          ...previous,
          list: previous.list.map((workspace) => {
            const canonicalPath = canonicalPaths.get(workspace.id);
            if (!canonicalPath || !workspace.folder) {
              return workspace;
            }
            return {
              ...workspace,
              folder: { ...workspace.folder, canonicalPath },
            };
          }),
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

  useEffect(() => {
    dockviewDisposedRef.current = false;
    return () => {
      dockviewDisposedRef.current = true;
      ptyTitleUnlistenRef.current?.();
      ptyTitleUnlistenRef.current = null;
      for (const disposable of dockviewDisposablesRef.current) {
        disposable.dispose();
      }
      dockviewDisposablesRef.current = [];
      apiRef.current = null;
    };
  }, []);

  // Панели скрытых воркспейсов не получают pty-title: доводим имена из кэша.
  const applyAutoTitles = useCallback((api: DockviewApi) => {
    for (const panel of api.panels) {
      const title = getAutoTitle(panel.id);
      const titleKind = panel.api.getParameters<{ titleKind?: string }>()
        .titleKind;
      if (title && titleKind !== "manual" && !isManualTitle(panel.id)) {
        panel.api.setTitle(title);
        panel.api.updateParameters({
          ...panel.api.getParameters(),
          titleKind: "process",
        });
      }
    }
  }, []);

  // Dockview содержит только активную сессию. Перед любым переключением
  // сохраняем её layout, не затрагивая скрытые сессии и их живые PTY.
  const snapshotActiveSession = useCallback(
    (list: Workspace[], activeId: string | null): Workspace[] => {
      return snapshotActiveSessionLayout(list, activeId, apiRef.current);
    },
    [],
  );

  const loadSession = useCallback(
    (workspace: Workspace, session: TerminalSession) => {
      const api = apiRef.current;
      if (!api) {
        return;
      }
      const rootAvailable = Boolean(
        workspace.folder && !rootErrorsRef.current[workspace.id],
      );
      const previousPanelIds = new Set(api.panels.map((panel) => panel.id));
      let restored = false;
      suppressCleanupRef.current = true;
      try {
        if (rootAvailable && session.layout) {
          try {
            api.fromJSON(localizeDefaultPanelTitles(session.layout)!);
            restored = true;
          } catch {
            // Повреждённая сохранённая раскладка не должна блокировать вход
            // в сессию. Частично созданные панели убираем, прежние PTY при
            // этом остаются в registry как у обычной скрытой сессии.
            const partialPanelIds = api.panels
              .map((panel) => panel.id)
              .filter((panelId) => !previousPanelIds.has(panelId));
            api.closeAllGroups();
            for (const panelId of partialPanelIds) {
              void destroyTerminal(panelId);
            }
          }
        } else {
          api.closeAllGroups();
        }
      } finally {
        suppressCleanupRef.current = false;
      }
      if (rootAvailable && !restored) {
        addPanel(api, workspace.id, session.id);
      }
      applyAutoTitles(api);
      setTerminalCount(api.panels.length);
    },
    [applyAutoTitles],
  );

  const selectWorkspace = useCallback(
    (id: string) => {
      const current = workspacesRef.current;
      if (id === current.activeId) {
        return;
      }
      if (!current.list.some((workspace) => workspace.id === id)) {
        return;
      }
      const list = snapshotActiveSession(current.list, current.activeId).map(
        (workspace) =>
          workspace.id === id
            ? { ...workspace, lastOpenedAt: Date.now() }
            : workspace,
      );
      const target = list.find((workspace) => workspace.id === id)!;
      const session = activeSession(target);
      if (!session) {
        return;
      }
      const next = { list, activeId: id };
      workspacesRef.current = next;
      setWorkspaces(next);
      loadSession(target, session);
    },
    [loadSession, snapshotActiveSession],
  );

  const selectSession = useCallback(
    (workspaceId: string, sessionId: string) => {
      const current = workspacesRef.current;
      const workspace = current.list.find((item) => item.id === workspaceId);
      if (
        !workspace ||
        !workspace.sessions.some((session) => session.id === sessionId) ||
        isActiveSession(current, workspaceId, sessionId)
      ) {
        return;
      }
      const now = Date.now();
      const list = snapshotActiveSession(current.list, current.activeId).map(
        (item) =>
          item.id !== workspaceId
            ? item
            : {
                ...item,
                activeSessionId: sessionId,
                lastOpenedAt: now,
                sessions: item.sessions.map((session) =>
                  session.id === sessionId
                    ? { ...session, lastOpenedAt: now }
                    : session,
                ),
              },
      );
      const target = list.find((item) => item.id === workspaceId)!;
      const session = target.sessions.find((item) => item.id === sessionId)!;
      const next = { list, activeId: workspaceId };
      workspacesRef.current = next;
      setWorkspaces(next);
      loadSession(target, session);
    },
    [loadSession, snapshotActiveSession],
  );

  const createSessionAfterValidation = useCallback(
    (workspaceId: string, expectedSessionId: string) => {
      const current = workspacesRef.current;
      if (!isActiveSession(current, workspaceId, expectedSessionId)) {
        return;
      }
      const list = snapshotActiveSession(current.list, current.activeId);
      const workspace = list.find((item) => item.id === workspaceId);
      if (!workspace) {
        return;
      }
      const now = Date.now();
      const session = createTerminalSession(
        workspace.id,
        crypto.randomUUID(),
        nextSessionDefaultIndex(workspace),
        null,
        now,
      );
      const target: Workspace = {
        ...workspace,
        sessions: [...workspace.sessions, session],
        activeSessionId: session.id,
        lastOpenedAt: now,
      };
      const next = {
        list: list.map((item) => (item.id === workspaceId ? target : item)),
        activeId: workspaceId,
      };
      workspacesRef.current = next;
      setWorkspaces(next);
      loadSession(target, session);
    },
    [loadSession, snapshotActiveSession],
  );

  const createSession = useCallback(
    (workspaceId: string) => {
      selectWorkspace(workspaceId);
      const current = workspacesRef.current;
      const workspace = current.list.find((item) => item.id === workspaceId);
      const session = workspace ? activeSession(workspace) : undefined;
      if (!workspace || !session) {
        return;
      }
      if (!workspace.folder || rootErrorsRef.current[workspaceId]) {
        appActions.requestCreateWorkspace();
        return;
      }
      if (!rootRegistryReady) {
        showToast(translate("workspace.folderChecking"));
        return;
      }
      const create = () =>
        createSessionAfterValidation(workspaceId, session.id);
      if (!isTauri) {
        create();
        return;
      }
      void invoke("workspace_validate_root", { workspaceId })
        .then(create)
        .catch((error) => {
          const nextErrors = {
            ...rootErrorsRef.current,
            [workspaceId]: unavailable(error),
          };
          rootErrorsRef.current = nextErrors;
          setRootErrors(nextErrors);
          showToast(localizeBackendError(error));
          if (workspacesRef.current.activeId === workspaceId) {
            appActions.requestCreateWorkspace();
          }
        });
    },
    [
      createSessionAfterValidation,
      rootRegistryReady,
      selectWorkspace,
      showToast,
    ],
  );

  const newTerminalForSession = useCallback(
    (workspaceId: string, sessionId: string) => {
      selectSession(workspaceId, sessionId);
      const current = workspacesRef.current;
      const workspace = current.list.find((item) => item.id === workspaceId);
      if (
        !workspace ||
        !workspace.folder ||
        rootErrorsRef.current[workspaceId] ||
        !isActiveSession(current, workspaceId, sessionId)
      ) {
        if (workspace && (!workspace.folder || rootErrorsRef.current[workspaceId])) {
          appActions.requestCreateWorkspace();
        }
        return;
      }
      if (!rootRegistryReady) {
        showToast(translate("workspace.folderChecking"));
        return;
      }
      const addToGrid = () => {
        if (!isActiveSession(workspacesRef.current, workspaceId, sessionId)) {
          return;
        }
        const api = apiRef.current;
        if (!api) {
          return;
        }
        addTerminalAutoGrid(api, workspaceId, sessionId, (reason) =>
          showToast(
            reason === "limit"
              ? translate("layout.terminalLimit", { max: MAX_TERMINALS })
              : translate("layout.noSplitSpace"),
          ),
        );
      };
      if (!isTauri) {
        addToGrid();
        return;
      }
      void invoke("workspace_validate_root", { workspaceId })
        .then(addToGrid)
        .catch((error) => {
          const nextErrors = {
            ...rootErrorsRef.current,
            [workspaceId]: unavailable(error),
          };
          rootErrorsRef.current = nextErrors;
          setRootErrors(nextErrors);
          showToast(localizeBackendError(error));
          if (isActiveSession(workspacesRef.current, workspaceId, sessionId)) {
            appActions.requestCreateWorkspace();
          }
        });
    },
    [rootRegistryReady, selectSession, showToast],
  );

  const newTerminal = useCallback(() => {
    const { list, activeId } = workspacesRef.current;
    const workspace = list.find((item) => item.id === activeId);
    const session = workspace ? activeSession(workspace) : undefined;
    if (!workspace || !session) {
      appActions.requestCreateWorkspace();
      return;
    }
    newTerminalForSession(workspace.id, session.id);
  }, [newTerminalForSession]);

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

  const createWorkspace = useCallback(async () => {
    if (!isTauri) {
      showToast(translate("workspace.folderPickerDesktopOnly"));
      return;
    }
    const current = workspacesRef.current;
    try {
      await invoke("workspace_reconcile_roots", {
        workspaceIds: current.list.map((workspace) => workspace.id),
      });
    } catch (error) {
      showToast(
        translate("workspace.prepareFailed", {
          error: localizeBackendError(error),
        }),
      );
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
        locale,
      });
    } catch (error) {
      showToast(localizeBackendError(error));
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
        showToast(
          translate("workspace.alreadyOpen", { name: existing.displayName }),
        );
        selectWorkspace(existing.id);
      } else {
        showToast(translate("workspace.alreadyRegistered"));
      }
      return;
    }
    if (result.workspaceId !== workspaceId) {
      showToast(translate("workspace.invalidBackendId"));
      return;
    }

    const folder = {
      // Бэкенд-диалог отдаёт уже канонический путь — он же «выбранный».
      selectedPath: result.path,
      canonicalPath: result.path,
      identityKey: null,
    };
    const baseName = folderBaseName(result.path);
    const nextErrors = { ...rootErrorsRef.current };
    delete nextErrors[workspaceId];
    rootErrorsRef.current = nextErrors;
    setRootErrors(nextErrors);

    const previous = workspacesRef.current;
    const snapshotted = snapshotActiveSession(
      previous.list,
      previous.activeId,
    );
    const existing = snapshotted.find(
      (workspace) => workspace.id === workspaceId,
    );
    const now = Date.now();
    let fresh: Workspace;
    if (existing) {
      fresh = {
        ...existing,
        folder,
        lastOpenedAt: now,
        // Автоимя следует за новой папкой; ручное имя не трогаем.
        displayName:
          existing.nameMode === "folder" ? baseName : existing.displayName,
      };
    } else {
      const session = createDefaultSession(workspaceId, null, now);
      fresh = {
        id: workspaceId,
        displayName: baseName,
        nameMode: "folder",
        folder,
        sessions: [session],
        activeSessionId: session.id,
        createdAt: now,
        lastOpenedAt: now,
      };
    }
    const list = existing
      ? snapshotted.map((workspace) =>
          workspace.id === workspaceId ? fresh : workspace,
        )
      : [...snapshotted, fresh];
    const next = { list, activeId: fresh.id };
    workspacesRef.current = next;
    setWorkspaces(next);
    const session = activeSession(fresh);
    if (session) {
      loadSession(fresh, session);
    }
  }, [loadSession, locale, snapshotActiveSession, selectWorkspace, showToast]);

  useEffect(() => {
    appActions.requestCloseGroup = setCloseGroupRequest;
    appActions.getActiveWorkspaceId = () => workspacesRef.current.activeId;
    appActions.getActiveSessionId = () => {
      const { list, activeId } = workspacesRef.current;
      return list.find((workspace) => workspace.id === activeId)
        ?.activeSessionId ?? null;
    };
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
    appActions.requestNewTerminal = newTerminal;
    appActions.notifyNoSpace = () => showToast(translate("layout.noSplitSpace"));
    appActions.notifyLimit = () =>
      showToast(translate("layout.terminalLimit", { max: MAX_TERMINALS }));
    return () => {
      appActions.requestCloseGroup = () => {};
      appActions.getActiveWorkspaceId = () => null;
      appActions.getActiveSessionId = () => null;
      appActions.hasActiveWorkspace = () => false;
      appActions.requestCreateWorkspace = () => {};
      appActions.requestNewTerminal = () => {};
      appActions.notifyNoSpace = () => {};
      appActions.notifyLimit = () => {};
    };
  }, [createWorkspace, newTerminal, showToast]);

  const renameWorkspace = useCallback((id: string, name: string) => {
    setWorkspaces((prev) => ({
      ...prev,
      list: prev.list.map((workspace) =>
        workspace.id === id
          ? // Ручное имя фиксируется: перепривязка папки его не перезапишет.
            { ...workspace, displayName: name, nameMode: "custom" as const }
          : workspace,
      ),
    }));
  }, []);

  const renameSession = useCallback(
    (workspaceId: string, sessionId: string, name: string) => {
      setWorkspaces((previous) => ({
        ...previous,
        list: previous.list.map((workspace) =>
          workspace.id !== workspaceId
            ? workspace
            : {
                ...workspace,
                sessions: workspace.sessions.map((session) =>
                  session.id === sessionId
                    ? {
                        ...session,
                        displayName: name,
                        nameMode: "custom" as const,
                      }
                    : session,
                ),
              },
        ),
      }));
    },
    [],
  );

  const sessionPanelCount = useCallback(
    (workspace: Workspace, session: TerminalSession): number => {
      if (
        workspace.id === workspaces.activeId &&
        session.id === workspace.activeSessionId
      ) {
        return apiRef.current?.panels.length ?? 0;
      }
      return session.layout
        ? Object.keys(session.layout.panels).length
        : 0;
    },
    [workspaces.activeId],
  );

  const workspacePanelCount = useCallback(
    (workspace: Workspace): number =>
      workspace.sessions.reduce(
        (total, session) => total + sessionPanelCount(workspace, session),
        0,
      ),
    [sessionPanelCount],
  );

  const deleteSession = useCallback(
    (workspaceId: string, sessionId: string) => {
      const current = workspacesRef.current;
      const currentWorkspace = current.list.find(
        (workspace) => workspace.id === workspaceId,
      );
      if (!currentWorkspace) {
        return;
      }
      if (currentWorkspace.sessions.length <= 1) {
        showToast(translate("session.cannotDeleteLast"));
        return;
      }

      const list = snapshotActiveSession(current.list, current.activeId);
      const workspace = list.find((item) => item.id === workspaceId)!;
      const sessionIndex = workspace.sessions.findIndex(
        (session) => session.id === sessionId,
      );
      if (sessionIndex < 0) {
        return;
      }
      const session = workspace.sessions[sessionIndex];
      const deletingSelectedSession =
        workspace.activeSessionId === sessionId;
      const deletingVisibleSession =
        current.activeId === workspaceId && deletingSelectedSession;

      if (deletingVisibleSession) {
        // Без suppress: закрытие сессии должно завершить только её PTY.
        apiRef.current?.closeAllGroups();
      } else {
        for (const panelId of Object.keys(session.layout?.panels ?? {})) {
          void destroyTerminal(panelId);
        }
      }

      const remainingSessions = workspace.sessions.filter(
        (item) => item.id !== sessionId,
      );
      const fallback =
        remainingSessions[Math.min(sessionIndex, remainingSessions.length - 1)];
      const target: Workspace = {
        ...workspace,
        sessions: remainingSessions,
        activeSessionId: deletingSelectedSession
          ? fallback.id
          : workspace.activeSessionId,
      };
      const next = {
        list: list.map((item) => (item.id === workspaceId ? target : item)),
        activeId: current.activeId,
      };
      workspacesRef.current = next;
      setWorkspaces(next);
      if (deletingVisibleSession) {
        loadSession(target, fallback);
      }
    },
    [loadSession, showToast, snapshotActiveSession],
  );

  // Удаление воркспейса: все его терминалы убиваются.
  const deleteWorkspace = useCallback(
    (workspace: Workspace) => {
      if (isTauri) {
        void invoke("workspace_unregister_root", {
          workspaceId: workspace.id,
        }).catch((error) => showToast(localizeBackendError(error)));
      }
      const nextErrors = { ...rootErrorsRef.current };
      delete nextErrors[workspace.id];
      rootErrorsRef.current = nextErrors;
      setRootErrors(nextErrors);
      const current = workspacesRef.current;
      const deletingActive = workspace.id === current.activeId;
      if (deletingActive) {
        // Активная сессия закрывается обычным путём и убивает свои PTY.
        apiRef.current?.closeAllGroups();
      }
      for (const session of workspace.sessions) {
        for (const panelId of Object.keys(session.layout?.panels ?? {})) {
          void destroyTerminal(panelId);
        }
      }
      const remaining = current.list.filter(
        (item) => item.id !== workspace.id,
      );
      if (remaining.length === 0) {
        const next = { list: [], activeId: null };
        workspacesRef.current = next;
        setWorkspaces(next);
        setTerminalCount(0);
        return;
      }
      if (!deletingActive) {
        const next = { list: remaining, activeId: current.activeId };
        workspacesRef.current = next;
        setWorkspaces(next);
        return;
      }
      const target = remaining[0];
      const session = activeSession(target);
      const next = { list: remaining, activeId: target.id };
      workspacesRef.current = next;
      setWorkspaces(next);
      if (session) {
        loadSession(target, session);
      }
    },
    [loadSession, showToast],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      for (const disposable of dockviewDisposablesRef.current) {
        disposable.dispose();
      }
      dockviewDisposablesRef.current = [];
      ptyTitleUnlistenRef.current?.();
      ptyTitleUnlistenRef.current = null;
      apiRef.current = event.api;
      const keep = (disposable: { dispose(): void }) => {
        dockviewDisposablesRef.current.push(disposable);
      };

      // Закрытие панели любым путём (крестик, группа, хоткей) должно
      // убивать процесс — кроме временного swap между сессиями.
      keep(
        event.api.onDidRemovePanel((panel) => {
          if (!suppressCleanupRef.current) {
            void destroyTerminal(panel.id);
          }
          setTerminalCount(event.api.panels.length);
        }),
      );
      keep(
        event.api.onDidAddPanel(() => {
          setTerminalCount(event.api.panels.length);
        }),
      );
      // Вкладок нет: перетаскивание может целиться только в сплиты,
      // дроп в центр/таббар чужой группы запрещён.
      keep(
        event.api.onWillShowOverlay((overlay) => {
          if (
            overlay.kind === "tab" ||
            overlay.kind === "header_space" ||
            (overlay.kind === "content" && overlay.position === "center")
          ) {
            overlay.preventDefault();
          }
        }),
      );

      if ("__TAURI_INTERNALS__" in window) {
        void listen<{ id: string; title: string }>(
          "pty-title",
          (titleEvent) => {
            rememberAutoTitle(titleEvent.payload.id, titleEvent.payload.title);
            const panel = event.api.getPanel(titleEvent.payload.id);
            const titleKind = panel?.api.getParameters<{
              titleKind?: string;
            }>().titleKind;
            if (
              panel &&
              titleKind !== "manual" &&
              !isManualTitle(titleEvent.payload.id)
            ) {
              panel.api.setTitle(titleEvent.payload.title);
              panel.api.updateParameters({
                ...panel.api.getParameters(),
                titleKind: "process",
              });
            }
          },
        )
          .then((unlisten) => {
            if (
              dockviewDisposedRef.current ||
              apiRef.current !== event.api
            ) {
              unlisten();
              return;
            }
            ptyTitleUnlistenRef.current?.();
            ptyTitleUnlistenRef.current = unlisten;
          })
          .catch(() => {});
      }

      // Восстанавливаем только последнюю активную сессию проекта.
      const { list, activeId } = workspacesRef.current;
      const workspace = list.find((item) => item.id === activeId);
      const session = workspace ? activeSession(workspace) : undefined;
      if (
        workspace?.folder &&
        session &&
        !rootErrorsRef.current[workspace.id] &&
        session.layout
      ) {
        try {
          event.api.fromJSON(localizeDefaultPanelTitles(session.layout)!);
        } catch {
          event.api.closeAllGroups();
          addPanel(event.api, workspace.id, session.id);
        }
      } else if (
        workspace?.folder &&
        session &&
        !rootErrorsRef.current[workspace.id]
      ) {
        addPanel(event.api, workspace.id, session.id);
      }
      applyAutoTitles(event.api);
      setTerminalCount(event.api.panels.length);

      keep(event.api.onDidLayoutChange(schedulePersist));
      keep(
        event.api.onDidMaximizedGroupChange(() => {
          setZoomed(event.api.hasMaximizedGroup());
        }),
      );
    },
    [applyAutoTitles, schedulePersist],
  );

  const activeWorkspace = workspaces.list.find(
    (workspace) => workspace.id === workspaces.activeId,
  );
  const sidebarWorkspaces = workspaces.list.map((workspace) => {
    const sessions = workspace.sessions.map((session) => ({
      id: session.id,
      name: sessionDisplayName(session, (index) =>
        t("session.defaultName", { index }),
      ),
      count: sessionPanelCount(workspace, session),
      isActive:
        workspace.id === workspaces.activeId &&
        session.id === workspace.activeSessionId,
    }));
    return {
      id: workspace.id,
      name: workspace.displayName,
      folder: workspace.folder?.selectedPath ?? null,
      count: sessions.reduce((total, session) => total + session.count, 0),
      sessions,
    };
  });
  const deleteSessionWorkspace = deleteSessionRequest
    ? workspaces.list.find(
        (workspace) => workspace.id === deleteSessionRequest.workspaceId,
      )
    : undefined;
  const deleteSessionTarget =
    deleteSessionWorkspace && deleteSessionRequest
      ? deleteSessionWorkspace.sessions.find(
          (session) => session.id === deleteSessionRequest.sessionId,
        )
      : undefined;

  return (
    <div className={`app-shell ${sidebarVisible ? "" : "sidebar-hidden"}`}>
      <Titlebar
        workspaceName={activeWorkspace?.displayName ?? WORKSPACE_NAME}
        workspaceFolder={activeWorkspace?.folder?.selectedPath ?? null}
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible((visible) => !visible)}
        onNewTerminal={newTerminal}
        onOpenSettings={() => setSettingsOpen(true)}
        updater={updater}
      />
      <div className="app-body">
        <div className="sidebar-rail" aria-hidden={!sidebarVisible}>
          <Sidebar
            workspaces={sidebarWorkspaces}
            activeId={workspaces.activeId}
            onSelectWorkspace={selectWorkspace}
            onSelectSession={selectSession}
            onCreateProject={createWorkspace}
            onCreateSession={createSession}
            onCreateTerminal={newTerminalForSession}
            onRenameWorkspace={renameWorkspace}
            onRenameSession={renameSession}
            onDeleteSession={(workspaceId, sessionId) => {
              const workspace = workspaces.list.find(
                (item) => item.id === workspaceId,
              );
              if (!workspace) {
                return;
              }
              if (workspace.sessions.length <= 1) {
                showToast(t("session.cannotDeleteLast"));
                return;
              }
              setDeleteSessionRequest({ workspaceId, sessionId });
            }}
            onDeleteWorkspace={(id) => {
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
            <div className="workspace-loading">{t("workspace.checking")}</div>
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
      {zoomed && (
        <button
          type="button"
          className="zoom-indicator"
          title={t("layout.restore")}
          aria-label={t("layout.restore")}
          onClick={() => apiRef.current?.exitMaximizedGroup()}
        >
          <MaximizeIcon /> {t("layout.terminalExpanded")}
          <span className="zoom-indicator-hint">
            <kbd>{isMac ? "⌘↩" : "Ctrl+Enter"}</kbd>{" "}
            {t("layout.restoreShortcut")}
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
          text={t("confirm.closeTerminal")}
          confirmLabel={t("common.close")}
          onConfirm={() => {
            closeGroupAnimated(closeGroupRequest);
            setCloseGroupRequest(null);
          }}
          onCancel={() => setCloseGroupRequest(null)}
        />
      )}
      {deleteSessionRequest && deleteSessionWorkspace && deleteSessionTarget && (
        <ConfirmDialog
          text={t("confirm.deleteSession", {
            name: sessionDisplayName(deleteSessionTarget, (index) =>
              t("session.defaultName", { index }),
            ),
            terminals: formatTerminalCount(
              sessionPanelCount(deleteSessionWorkspace, deleteSessionTarget),
              locale,
            ),
          })}
          confirmLabel={t("common.delete")}
          onConfirm={() => {
            deleteSession(
              deleteSessionRequest.workspaceId,
              deleteSessionRequest.sessionId,
            );
            setDeleteSessionRequest(null);
          }}
          onCancel={() => setDeleteSessionRequest(null)}
        />
      )}
      {deleteWorkspaceRequest && (
        <ConfirmDialog
          text={t("confirm.deleteWorkspace", {
            name: deleteWorkspaceRequest.displayName,
            terminals: formatTerminalCount(
              workspacePanelCount(deleteWorkspaceRequest),
              locale,
            ),
          })}
          confirmLabel={t("common.delete")}
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
          shell={shell}
          shellBusy={shellBusy}
          terminalFontSize={terminalFontSize}
          onSelectTheme={(nextThemeId) => {
            setThemeId(nextThemeId);
            saveTheme(nextThemeId);
            applyTerminalTheme(nextThemeId);
          }}
          onSelectAccent={(color) => {
            setAccent(color);
            saveAccent(color);
          }}
          onSelectShell={requestShellChange}
          onSelectTerminalFontSize={(size) => {
            setTerminalFontSize(size);
            saveTerminalFontSize(size);
            applyTerminalFontSize(size);
          }}
          onClose={() => {
            if (!pendingShell && !shellBusy) {
              setSettingsOpen(false);
            }
          }}
        />
      )}
      {pendingShell && (
        <ConfirmDialog
          text={t("settings.confirmShellChange", {
            name: pendingShell.label,
            terminals: formatTerminalCount(pendingShell.count, locale),
          })}
          confirmLabel={
            shellBusy
              ? t("settings.shellApplying")
              : t("settings.shellRestart")
          }
          busy={shellBusy}
          onConfirm={confirmShellChange}
          onCancel={() => setPendingShell(null)}
        />
      )}
    </div>
  );
}
