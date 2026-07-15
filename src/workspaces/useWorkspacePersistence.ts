import {
  useCallback,
  useEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from "react";
import { DockviewApi } from "dockview";
import { snapshotActiveSessionLayout } from "../layoutOps";
import { saveWorkspacesState, type WorkspacesState } from "../persist";

// Снимок всего состояния воркспейсов в localStorage; активный —
// с живой раскладкой из dockview.
export function useWorkspacePersistence(
  workspacesRef: MutableRefObject<WorkspacesState>,
  apiRef: RefObject<DockviewApi | null>,
) {
  const persistTimer = useRef<number | undefined>(undefined);
  // Заморозка записи. Включается перед установкой обновления: снапшот,
  // снятый до pty_kill_all, не должен быть перезаписан «опустевшим»
  // состоянием умирающего экземпляра (beforeunload, отложенный дебаунс).
  const suspendedRef = useRef(false);

  const persistNow = useCallback(() => {
    if (suspendedRef.current) {
      return;
    }
    const { list, activeId } = workspacesRef.current;
    const snapshot = snapshotActiveSessionLayout(list, activeId, apiRef.current);
    saveWorkspacesState({ list: snapshot, activeId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schedulePersist = useCallback(() => {
    if (suspendedRef.current) {
      return;
    }
    if (persistTimer.current !== undefined) {
      window.clearTimeout(persistTimer.current);
    }
    persistTimer.current = window.setTimeout(persistNow, 500);
  }, [persistNow]);

  const suspendPersistence = useCallback(() => {
    suspendedRef.current = true;
    if (persistTimer.current !== undefined) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = undefined;
    }
  }, []);

  const resumePersistence = useCallback(() => {
    suspendedRef.current = false;
  }, []);

  useEffect(() => {
    window.addEventListener("beforeunload", persistNow);
    return () => window.removeEventListener("beforeunload", persistNow);
  }, [persistNow]);

  return { persistNow, schedulePersist, suspendPersistence, resumePersistence };
}
