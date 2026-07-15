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
import { Titlebar } from "./ui/Titlebar";
import { Sidebar } from "./ui/Sidebar";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Settings } from "./ui/Settings";
import { MaximizeIcon } from "./ui/Icons";
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
import { defaultTerminalTitles } from "./layoutOps";
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

const components = { terminal: TerminalPanel };
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
