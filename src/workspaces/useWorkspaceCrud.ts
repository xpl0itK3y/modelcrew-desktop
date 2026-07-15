import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import { DockviewApi } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { destroyTerminal } from "../terminal/registry";
import { localizeBackendError, translate, type Locale } from "../i18n";
import {
  activeSession,
  createDefaultSession,
  folderBaseName,
  type FolderRuntimeStatus,
  type TerminalSession,
  type Workspace,
  type WorkspacesState,
} from "../persist";
import type { WorkspaceRootResult } from "./useWorkspaceRoots";

const isTauri = "__TAURI_INTERNALS__" in window;

type UseWorkspaceCrudOptions = {
  apiRef: RefObject<DockviewApi | null>;
  workspacesRef: MutableRefObject<WorkspacesState>;
  setWorkspaces: Dispatch<SetStateAction<WorkspacesState>>;
  setTerminalCount: (count: number) => void;
  rootErrorsRef: MutableRefObject<Record<string, FolderRuntimeStatus>>;
  clearRootError: (workspaceId: string) => void;
  showToast: (text: string) => void;
  locale: Locale;
  snapshotActiveSession: (
    list: Workspace[],
    activeId: string | null,
  ) => Workspace[];
  selectWorkspace: (id: string) => void;
  loadSession: (workspace: Workspace, session: TerminalSession) => void;
};

// Создание/перепривязка проекта через нативный picker, переименования и
// удаления проектов и сессий.
export function useWorkspaceCrud({
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
}: UseWorkspaceCrudOptions) {
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
    clearRootError(workspaceId);

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
  }, [
    clearRootError,
    loadSession,
    locale,
    rootErrorsRef,
    selectWorkspace,
    setWorkspaces,
    showToast,
    snapshotActiveSession,
    workspacesRef,
  ]);

  const renameWorkspace = useCallback(
    (id: string, name: string) => {
      setWorkspaces((prev) => ({
        ...prev,
        list: prev.list.map((workspace) =>
          workspace.id === id
            ? // Ручное имя фиксируется: перепривязка папки его не перезапишет.
              { ...workspace, displayName: name, nameMode: "custom" as const }
            : workspace,
        ),
      }));
    },
    [setWorkspaces],
  );

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
    [setWorkspaces],
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
    [
      apiRef,
      loadSession,
      setWorkspaces,
      showToast,
      snapshotActiveSession,
      workspacesRef,
    ],
  );

  // Удаление воркспейса: все его терминалы убиваются.
  const deleteWorkspace = useCallback(
    (workspace: Workspace) => {
      if (isTauri) {
        void invoke("workspace_unregister_root", {
          workspaceId: workspace.id,
        }).catch((error) => showToast(localizeBackendError(error)));
      }
      clearRootError(workspace.id);
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
    [
      apiRef,
      clearRootError,
      loadSession,
      setTerminalCount,
      setWorkspaces,
      showToast,
      workspacesRef,
    ],
  );

  return {
    createWorkspace,
    renameWorkspace,
    renameSession,
    deleteSession,
    deleteWorkspace,
  };
}
