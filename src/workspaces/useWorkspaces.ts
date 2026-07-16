import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import { DockviewApi } from "dockview";
import { appActions } from "../appActions";
import {
  destroyTerminal,
  getAutoTitle,
  isManualTitle,
  prespawnSessionPanels,
} from "../terminal/registry";
import { loadEagerSessionRestore } from "../terminal/preferences";
import { translate, type Locale } from "../i18n";
import { MAX_TERMINALS } from "../constants";
import {
  addPanel,
  localizeDefaultPanelTitles,
  snapshotActiveSessionLayout,
} from "../layoutOps";
import {
  activeSession,
  hasPersistedWorkspacesState,
  isActiveSession,
  loadWorkspacesState,
  type TerminalSession,
  type Workspace,
  type WorkspacesState,
} from "../persist";
import { useSessionCreation } from "./useSessionCreation";
import { useWorkspaceCrud } from "./useWorkspaceCrud";
import { useWorkspacePersistence } from "./useWorkspacePersistence";
import { useWorkspaceRoots } from "./useWorkspaceRoots";

type UseWorkspacesOptions = {
  apiRef: RefObject<DockviewApi | null>;
  // Во время swap/переключения воркспейса layout пересоздаётся через
  // fromJSON: панели формально удаляются, но PTY должны остаться живыми.
  suppressCleanupRef: MutableRefObject<boolean>;
  setTerminalCount: (count: number) => void;
  showToast: (text: string) => void;
  locale: Locale;
};

// Workspace-машина приложения: состояние проектов/сессий, их выбор и загрузка
// в dockview, создание, переименование и удаление плюс персист и регистрация
// корней. App остаётся оркестратором UI поверх возвращаемых операций.
export function useWorkspaces({
  apiRef,
  suppressCleanupRef,
  setTerminalCount,
  showToast,
  locale,
}: UseWorkspacesOptions) {
  const initialStateRef = useRef<WorkspacesState | null>();
  if (initialStateRef.current === undefined) {
    initialStateRef.current = loadWorkspacesState();
  }
  const [workspaces, setWorkspaces] = useState<WorkspacesState>(
    // Первый запуск — без воркспейсов: пользователь начинает с выбора
    // папки проекта на welcome-экране.
    () => initialStateRef.current ?? { list: [], activeId: null },
  );
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;

  const { rootRegistryReady, rootErrorsRef, markRootUnavailable, clearRootError } =
    useWorkspaceRoots({ workspacesRef, setWorkspaces, showToast });
  const {
    persistNow,
    schedulePersist,
    suspendPersistence,
    resumePersistence,
  } = useWorkspacePersistence(workspacesRef, apiRef);

  useEffect(() => {
    schedulePersist();
  }, [workspaces, schedulePersist]);

  // Данные в хранилище есть, но прочитать их не удалось (гонка чтения после
  // перезапуска обновления, повреждённый JSON). Пустое состояние этой сессии
  // не должно затереть их: сохранение выключается до перезапуска приложения.
  useEffect(() => {
    if (initialStateRef.current === null && hasPersistedWorkspacesState()) {
      suspendPersistence();
      showToast(translate("workspace.persistReadFailed"));
    }
    // Разовая проверка состояния загрузки при монтировании.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Плейсхолдерные заголовки в сохранённых раскладках следуют за языком.
  useEffect(() => {
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
    [apiRef],
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
    [apiRef, applyAutoTitles, rootErrorsRef, setTerminalCount, suppressCleanupRef],
  );

  // Оживляет скрытые сессии проекта фоном (PTY + снимок + авто-resume
  // агентов): переключение на них становится мгновенным. Только для
  // проектов с рабочим корнем и при включённой настройке.
  const prespawnWorkspaceSessions = useCallback(
    (workspace: Workspace) => {
      if (
        !loadEagerSessionRestore() ||
        !workspace.folder ||
        rootErrorsRef.current[workspace.id]
      ) {
        return;
      }
      for (const session of workspace.sessions) {
        if (session.id === workspace.activeSessionId) {
          continue; // активную поднимает dockview
        }
        // PTY поднимаем только терминалам: панель git-изменений и другие
        // будущие типы панелей оболочки не имеют.
        prespawnSessionPanels(
          workspace.id,
          Object.entries(session.layout?.panels ?? {})
            .filter(
              ([, panel]) =>
                (panel.contentComponent ?? "terminal") === "terminal",
            )
            .map(([panelId]) => panelId),
        );
      }
    },
    [rootErrorsRef],
  );

  // При старте — как только Rust зарегистрировал корни (раньше PTY нельзя).
  useEffect(() => {
    if (!rootRegistryReady) {
      return;
    }
    const { list, activeId } = workspacesRef.current;
    const active = list.find((workspace) => workspace.id === activeId);
    if (active) {
      prespawnWorkspaceSessions(active);
    }
  }, [rootRegistryReady, prespawnWorkspaceSessions]);

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
      prespawnWorkspaceSessions(target);
    },
    [loadSession, prespawnWorkspaceSessions, snapshotActiveSession],
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

  const creation = useSessionCreation({
    apiRef,
    workspacesRef,
    setWorkspaces,
    rootErrorsRef,
    rootRegistryReady,
    markRootUnavailable,
    showToast,
    snapshotActiveSession,
    selectWorkspace,
    selectSession,
    loadSession,
  });

  const crud = useWorkspaceCrud({
    apiRef,
    workspacesRef,
    setWorkspaces,
    setTerminalCount,
    rootErrorsRef,
    clearRootError,
    showToast,
    locale,
    snapshotActiveSession,
    selectWorkspace,
    loadSession,
  });

  const sessionPanelCount = useCallback(
    (workspace: Workspace, session: TerminalSession): number => {
      // Счётчик в сайдбаре — только терминалы, без панели изменений.
      if (
        workspace.id === workspaces.activeId &&
        session.id === workspace.activeSessionId
      ) {
        return (
          apiRef.current?.panels.filter(
            (panel) => panel.view?.contentComponent === "terminal",
          ).length ?? 0
        );
      }
      return session.layout
        ? Object.values(session.layout.panels).filter(
            (panel) => (panel.contentComponent ?? "terminal") === "terminal",
          ).length
        : 0;
    },
    [apiRef, workspaces.activeId],
  );

  const workspacePanelCount = useCallback(
    (workspace: Workspace): number =>
      workspace.sessions.reduce(
        (total, session) => total + sessionPanelCount(workspace, session),
        0,
      ),
    [sessionPanelCount],
  );

  // Глобальные экшены (welcome-экран, хоткеи, watermark) смотрят на живое
  // состояние машины через appActions; UI-поля (requestCloseGroup) вешает App.
  useEffect(() => {
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
      void crud.createWorkspace();
    };
    appActions.requestNewTerminal = creation.newTerminal;
    appActions.notifyNoSpace = () => showToast(translate("layout.noSplitSpace"));
    appActions.notifyLimit = () =>
      showToast(translate("layout.terminalLimit", { max: MAX_TERMINALS }));
    return () => {
      appActions.getActiveWorkspaceId = () => null;
      appActions.getActiveSessionId = () => null;
      appActions.hasActiveWorkspace = () => false;
      appActions.requestCreateWorkspace = () => {};
      appActions.requestNewTerminal = () => {};
      appActions.notifyNoSpace = () => {};
      appActions.notifyLimit = () => {};
    };
  }, [creation.newTerminal, crud.createWorkspace, rootErrorsRef, showToast]);

  return {
    workspaces,
    workspacesRef,
    rootRegistryReady,
    rootErrorsRef,
    persistNow,
    schedulePersist,
    suspendPersistence,
    resumePersistence,
    applyAutoTitles,
    selectWorkspace,
    selectSession,
    sessionPanelCount,
    workspacePanelCount,
    ...creation,
    ...crud,
  };
}
