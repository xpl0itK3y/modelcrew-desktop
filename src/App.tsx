import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DockviewApi,
  DockviewGroupPanel,
  DockviewReact,
  DockviewTheme,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import { invoke } from "@tauri-apps/api/core";
import { TerminalPanel } from "./panels/TerminalPanel";
import { GitChangesPanel, GitChangesView } from "./panels/GitChangesPanel";
import {
  aggregateCounts,
  subscribeGitChanges,
  type GitChangesSummary,
} from "./git/gitChanges";
import { TerminalTab } from "./panels/TerminalTab";
import { GroupActions } from "./panels/GroupActions";
import { Welcome } from "./panels/Welcome";
import {
  applyTerminalFontSize,
  applyTerminalTheme,
  getRunningTerminalCount,
  isManualTitle,
  restartRunningTerminals,
} from "./terminal/registry";
import { flushAllSnapshots, pruneSnapshots } from "./terminal/snapshots";
import { pruneAgentRecords } from "./agents";
import { Titlebar } from "./ui/Titlebar";
import { Sidebar } from "./ui/Sidebar";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Settings } from "./ui/Settings";
import { CloseIcon, MaximizeIcon } from "./ui/Icons";
import { useAnimatedPresence } from "./ui/useAnimatedPresence";
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
import { arrangeEvenGrid, defaultTerminalTitles } from "./layoutOps";
import { sessionDisplayName, type Workspace } from "./persist";
import {
  formatTerminalCount,
  localizeBackendError,
  translate,
  useI18n,
} from "./i18n";
import { isMac, WORKSPACE_NAME } from "./constants";
import { loadShell, saveShell } from "./shell";
import {
  loadTerminalFontSize,
  saveTerminalFontSize,
} from "./terminal/preferences";
import { useAppUpdater } from "./updater/useAppUpdater";
import { useNotificationSounds } from "./updater/useNotificationSounds";
import { useWorkspaces } from "./workspaces/useWorkspaces";
import { useDockviewSetup } from "./useDockviewSetup";
import "./styles/index.css";

const components = { terminal: TerminalPanel, gitChanges: GitChangesPanel };
const tabComponents = { terminal: TerminalTab };
const isTauri = "__TAURI_INTERNALS__" in window;

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
  const [deleteWorkspaceRequest, setDeleteWorkspaceRequest] =
    useState<Workspace | null>(null);
  const [deleteSessionRequest, setDeleteSessionRequest] =
    useState<SessionDeleteRequest | null>(null);
  const dockviewTheme = useMemo<DockviewTheme>(
    () => ({ ...modelcrewTheme, colorScheme: getAppTheme(themeId).scheme }),
    [themeId],
  );

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current !== undefined) {
      window.clearTimeout(toastTimer.current);
    }
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const {
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
    createSession,
    newTerminal,
    newTerminalForSession,
    createWorkspace,
    renameWorkspace,
    renameSession,
    deleteSession,
    deleteWorkspace,
  } = useWorkspaces({
    apiRef,
    suppressCleanupRef,
    setTerminalCount,
    showToast,
    locale,
  });

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
  }, [locale]);

  useEffect(() => {
    applyTerminalTheme(themeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Сироты-снимки терминалов (панели/сессии удалены в прошлых запусках)
  // вычищаются один раз на старте по актуальным раскладкам.
  useEffect(() => {
    const keep: string[] = [];
    for (const workspace of workspacesRef.current.list) {
      for (const session of workspace.sessions) {
        keep.push(...Object.keys(session.layout?.panels ?? {}));
      }
    }
    pruneSnapshots(keep);
    pruneAgentRecords(keep);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prepareForUpdate = useCallback(async () => {
    // Фиксируем Dockview/Workspace и явно гасим процессы перед заменой
    // self-update или перед перезапуском уже установленного Linux-пакета.
    // Native Linux install идёт раньше, чтобы отмена системной авторизации
    // не закрывала пользовательские терминалы.
    // После снапшота запись замораживается: «опустевшее» состояние умирающего
    // экземпляра (beforeunload, дебаунс) не должно затереть сохранённые
    // проекты во время установки и перезапуска.
    persistNow();
    suspendPersistence();
    // Историю терминалов фиксируем до гашения процессов: после обновления
    // панели восстановятся с последним текстом.
    await flushAllSnapshots();
    if (isTauri) {
      try {
        await invoke("pty_kill_all");
      } catch (error) {
        throw new Error(localizeBackendError(error));
      }
    }
  }, [persistNow, suspendPersistence]);

  const updater = useAppUpdater({
    locale,
    beforeInstall: prepareForUpdate,
    // Установка сорвалась, приложение живёт дальше — сохранение снова нужно.
    onInstallAborted: resumePersistence,
  });

  useNotificationSounds(updater.center.items);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== undefined) {
        window.clearTimeout(toastTimer.current);
      }
    };
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

  const onReady = useDockviewSetup({
    apiRef,
    suppressCleanupRef,
    workspacesRef,
    rootErrorsRef,
    applyAutoTitles,
    schedulePersist,
    setTerminalCount,
    setZoomed,
  });

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

  // Machine-поля appActions вешает useWorkspaces; за App — только UI-запросы.
  useEffect(() => {
    appActions.requestCloseGroup = setCloseGroupRequest;
    return () => {
      appActions.requestCloseGroup = () => {};
    };
  }, []);

  // Оверлеи (настройки, диалоги, тост) доигрывают exit-анимацию после
  // закрытия; presence хранит последние данные для текста, даже если
  // исходное состояние уже обнулено (например, сессия удалена).
  const settingsPresence = useAnimatedPresence(settingsOpen || null, 160);
  const toastPresence = useAnimatedPresence(toast, 190);
  const closeGroupPresence = useAnimatedPresence(closeGroupRequest, 160);
  const deleteWorkspacePresence = useAnimatedPresence(
    deleteWorkspaceRequest,
    160,
  );
  const pendingShellPresence = useAnimatedPresence(pendingShell, 160);
  const deleteSessionView = useMemo(() => {
    if (!deleteSessionRequest) {
      return null;
    }
    const workspace = workspaces.list.find(
      (item) => item.id === deleteSessionRequest.workspaceId,
    );
    const target = workspace?.sessions.find(
      (session) => session.id === deleteSessionRequest.sessionId,
    );
    return workspace && target
      ? { request: deleteSessionRequest, workspace, target }
      : null;
  }, [deleteSessionRequest, workspaces]);
  const deleteSessionPresence = useAnimatedPresence(deleteSessionView, 160);

  const activeWorkspace = workspaces.list.find(
    (workspace) => workspace.id === workspaces.activeId,
  );

  // Живой агрегат git-изменений активного проекта для бейджа в титлбаре.
  const [gitSummary, setGitSummary] = useState<GitChangesSummary | null>(null);
  const activeGitWorkspaceId =
    rootRegistryReady && activeWorkspace?.folder ? activeWorkspace.id : null;
  useEffect(() => {
    setGitSummary(null);
    if (!activeGitWorkspaceId) {
      return;
    }
    return subscribeGitChanges(activeGitWorkspaceId, setGitSummary);
  }, [activeGitWorkspaceId]);

  // Выравнивание активной сессии в ровную сетку; PTY переживают пересборку.
  // Повторное нажатие переключает вариант (в дереве-раскладке «только пару»
  // могут двигать границы лишь одной оси), тост подсказывает, какой применён.
  const gridOrientationRef = useRef<"columns" | "rows">("columns");
  const arrangeGrid = useCallback(() => {
    const api = apiRef.current;
    if (!api) {
      return;
    }
    const orientation = gridOrientationRef.current;
    suppressCleanupRef.current = true;
    try {
      if (!arrangeEvenGrid(api, orientation)) {
        return;
      }
    } finally {
      suppressCleanupRef.current = false;
    }
    gridOrientationRef.current =
      orientation === "columns" ? "rows" : "columns";
    showToast(
      t(
        orientation === "columns"
          ? "layout.gridColumns"
          : "layout.gridRows",
      ),
    );
    schedulePersist();
  }, [schedulePersist, showToast, t]);

  // Оверлей поверх терминалов: панель изменений не двигает раскладку.
  const [gitDrawerOpen, setGitDrawerOpen] = useState(false);
  const [gitDrawerMaximized, setGitDrawerMaximized] = useState(false);
  const gitDrawerPresence = useAnimatedPresence(
    gitDrawerOpen && activeGitWorkspaceId ? activeGitWorkspaceId : null,
    160,
  );
  useEffect(() => {
    if (!gitDrawerOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setGitDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [gitDrawerOpen]);
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
  return (
    <div className={`app-shell ${sidebarVisible ? "" : "sidebar-hidden"}`}>
      <Titlebar
        workspaceName={activeWorkspace?.displayName ?? WORKSPACE_NAME}
        workspaceFolder={activeWorkspace?.folder?.selectedPath ?? null}
        sidebarVisible={sidebarVisible}
        gitCounts={
          gitSummary?.isRepo ? aggregateCounts(gitSummary) : null
        }
        onToggleSidebar={() => setSidebarVisible((visible) => !visible)}
        onNewTerminal={newTerminal}
        onArrangeGrid={arrangeGrid}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenGitChanges={() => setGitDrawerOpen((open) => !open)}
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
              // Дроп-зоны у краёв всей сетки: полноширинная строка/колонка.
              // Полоска узкая нарочно — иначе она перехватывает дропы,
              // которыми пользователь хочет встать РЯДОМ с крайней панелью
              // (это делается через половинки самой панели).
              dndEdges={{
                activationSize: { type: "pixels", value: 16 },
                size: { type: "pixels", value: 48 },
              }}
            />
          ) : (
            <div className="workspace-loading">{t("workspace.checking")}</div>
          )}
          {gitDrawerPresence && (
            <aside
              className={`git-drawer ${
                gitDrawerMaximized ? "is-maximized" : ""
              } ${gitDrawerPresence.closing ? "is-closing" : ""}`}
              aria-label={t("git.panelTitle")}
            >
              <div className="git-drawer-header">
                <span className="git-drawer-title">{t("git.panelTitle")}</span>
                {gitSummary?.isRepo && (
                  <span className="git-drawer-branch" title={t("git.branch")}>
                    {gitSummary.branch ?? t("git.detachedHead")}
                    {gitSummary.ahead ? ` ↑${gitSummary.ahead}` : ""}
                    {gitSummary.behind ? ` ↓${gitSummary.behind}` : ""}
                  </span>
                )}
                <span className="git-drawer-spacer" />
                {gitSummary?.isRepo &&
                  aggregateCounts(gitSummary).files > 0 && (
                    <span className="git-file-counts">
                      <span className="git-count-add">
                        +{aggregateCounts(gitSummary).additions}
                      </span>
                      <span className="git-count-del">
                        −{aggregateCounts(gitSummary).deletions}
                      </span>
                    </span>
                  )}
                <button
                  type="button"
                  className="icon-button"
                  title={t(
                    gitDrawerMaximized ? "git.restore" : "git.maximize",
                  )}
                  aria-label={t(
                    gitDrawerMaximized ? "git.restore" : "git.maximize",
                  )}
                  aria-pressed={gitDrawerMaximized}
                  onClick={() => setGitDrawerMaximized((value) => !value)}
                >
                  <MaximizeIcon />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title={t("git.close")}
                  aria-label={t("git.close")}
                  onClick={() => setGitDrawerOpen(false)}
                >
                  <CloseIcon />
                </button>
              </div>
              <GitChangesView workspaceId={gitDrawerPresence.item} />
            </aside>
          )}
        </main>
      </div>
      {toastPresence && (
        <div
          className={`toast ${toastPresence.closing ? "is-closing" : ""}`}
          role="status"
          aria-live="polite"
        >
          {toastPresence.item}
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
      {closeGroupPresence && (
        <ConfirmDialog
          text={t("confirm.closeTerminal")}
          confirmLabel={t("common.close")}
          closing={closeGroupPresence.closing}
          onConfirm={() => {
            closeGroupAnimated(closeGroupPresence.item);
            setCloseGroupRequest(null);
          }}
          onCancel={() => setCloseGroupRequest(null)}
        />
      )}
      {deleteSessionPresence && (
        <ConfirmDialog
          text={t("confirm.deleteSession", {
            name: sessionDisplayName(deleteSessionPresence.item.target, (index) =>
              t("session.defaultName", { index }),
            ),
            terminals: formatTerminalCount(
              sessionPanelCount(
                deleteSessionPresence.item.workspace,
                deleteSessionPresence.item.target,
              ),
              locale,
            ),
          })}
          confirmLabel={t("common.delete")}
          closing={deleteSessionPresence.closing}
          onConfirm={() => {
            deleteSession(
              deleteSessionPresence.item.request.workspaceId,
              deleteSessionPresence.item.request.sessionId,
            );
            setDeleteSessionRequest(null);
          }}
          onCancel={() => setDeleteSessionRequest(null)}
        />
      )}
      {deleteWorkspacePresence && (
        <ConfirmDialog
          text={t("confirm.deleteWorkspace", {
            name: deleteWorkspacePresence.item.displayName,
            terminals: formatTerminalCount(
              workspacePanelCount(deleteWorkspacePresence.item),
              locale,
            ),
          })}
          confirmLabel={t("common.delete")}
          closing={deleteWorkspacePresence.closing}
          onConfirm={() => {
            deleteWorkspace(deleteWorkspacePresence.item);
            setDeleteWorkspaceRequest(null);
          }}
          onCancel={() => setDeleteWorkspaceRequest(null)}
        />
      )}
      {settingsPresence && (
        <Settings
          closing={settingsPresence.closing}
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
      {pendingShellPresence && (
        <ConfirmDialog
          text={t("settings.confirmShellChange", {
            name: pendingShellPresence.item.label,
            terminals: formatTerminalCount(
              pendingShellPresence.item.count,
              locale,
            ),
          })}
          closing={pendingShellPresence.closing}
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
