import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { backendErrorReason, localizeBackendError, translate } from "../i18n";
import type { FolderRuntimeStatus, WorkspacesState } from "../persist";

const isTauri = "__TAURI_INTERNALS__" in window;

export type WorkspaceRootResult =
  | { status: "cancelled" }
  | { status: "bound"; workspaceId: string; path: string }
  | { status: "alreadyOpen"; workspaceId: string; path: string };

export function unavailable(error: unknown): FolderRuntimeStatus {
  return {
    kind: "unavailable",
    reason: backendErrorReason(error),
    message: localizeBackendError(error),
  };
}

type UseWorkspaceRootsOptions = {
  workspacesRef: MutableRefObject<WorkspacesState>;
  setWorkspaces: Dispatch<SetStateAction<WorkspacesState>>;
  showToast: (text: string) => void;
};

// Регистрация корней проектов в Rust при старте и учёт их доступности.
// Терминалы не создаются, пока корень не зарегистрирован или помечен ошибкой.
export function useWorkspaceRoots({
  workspacesRef,
  setWorkspaces,
  showToast,
}: UseWorkspaceRootsOptions) {
  // Dockview не монтируется, пока Rust не зарегистрировал корни: иначе
  // восстановленные панели успеют запросить PTY раньше workspace roots.
  const [rootRegistryReady, setRootRegistryReady] = useState(!isTauri);
  const [rootErrors, setRootErrors] = useState<
    Record<string, FolderRuntimeStatus>
  >({});
  const rootErrorsRef = useRef(rootErrors);
  rootErrorsRef.current = rootErrors;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showToast]);

  const markRootUnavailable = useCallback(
    (workspaceId: string, error: unknown) => {
      const nextErrors = {
        ...rootErrorsRef.current,
        [workspaceId]: unavailable(error),
      };
      rootErrorsRef.current = nextErrors;
      setRootErrors(nextErrors);
    },
    [],
  );

  const clearRootError = useCallback((workspaceId: string) => {
    const nextErrors = { ...rootErrorsRef.current };
    delete nextErrors[workspaceId];
    rootErrorsRef.current = nextErrors;
    setRootErrors(nextErrors);
  }, []);

  return { rootRegistryReady, rootErrorsRef, markRootUnavailable, clearRootError };
}
