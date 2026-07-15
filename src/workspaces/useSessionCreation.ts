import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import { DockviewApi } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { appActions } from "../appActions";
import { localizeBackendError, translate } from "../i18n";
import { MAX_TERMINALS } from "../constants";
import { addTerminalAutoGrid } from "../layoutOps";
import {
  activeSession,
  createTerminalSession,
  isActiveSession,
  nextSessionDefaultIndex,
  type FolderRuntimeStatus,
  type TerminalSession,
  type Workspace,
  type WorkspacesState,
} from "../persist";

const isTauri = "__TAURI_INTERNALS__" in window;

type UseSessionCreationOptions = {
  apiRef: RefObject<DockviewApi | null>;
  workspacesRef: MutableRefObject<WorkspacesState>;
  setWorkspaces: Dispatch<SetStateAction<WorkspacesState>>;
  rootErrorsRef: MutableRefObject<Record<string, FolderRuntimeStatus>>;
  rootRegistryReady: boolean;
  markRootUnavailable: (workspaceId: string, error: unknown) => void;
  showToast: (text: string) => void;
  snapshotActiveSession: (
    list: Workspace[],
    activeId: string | null,
  ) => Workspace[];
  selectWorkspace: (id: string) => void;
  selectSession: (workspaceId: string, sessionId: string) => void;
  loadSession: (workspace: Workspace, session: TerminalSession) => void;
};

// Создание новых сессий и терминалов: перед каждым созданием корень проекта
// перепроверяется в Rust, чтобы не спавнить PTY в исчезнувшую папку.
export function useSessionCreation({
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
}: UseSessionCreationOptions) {
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
    [loadSession, setWorkspaces, snapshotActiveSession, workspacesRef],
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
          markRootUnavailable(workspaceId, error);
          showToast(localizeBackendError(error));
          if (workspacesRef.current.activeId === workspaceId) {
            appActions.requestCreateWorkspace();
          }
        });
    },
    [
      createSessionAfterValidation,
      markRootUnavailable,
      rootErrorsRef,
      rootRegistryReady,
      selectWorkspace,
      showToast,
      workspacesRef,
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
          markRootUnavailable(workspaceId, error);
          showToast(localizeBackendError(error));
          if (isActiveSession(workspacesRef.current, workspaceId, sessionId)) {
            appActions.requestCreateWorkspace();
          }
        });
    },
    [
      apiRef,
      markRootUnavailable,
      rootErrorsRef,
      rootRegistryReady,
      selectSession,
      showToast,
      workspacesRef,
    ],
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
  }, [newTerminalForSession, workspacesRef]);

  return {
    createSession,
    newTerminal,
    newTerminalForSession,
  };
}
