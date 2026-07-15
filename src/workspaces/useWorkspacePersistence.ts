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

  const persistNow = useCallback(() => {
    const { list, activeId } = workspacesRef.current;
    const snapshot = snapshotActiveSessionLayout(list, activeId, apiRef.current);
    saveWorkspacesState({ list: snapshot, activeId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schedulePersist = useCallback(() => {
    if (persistTimer.current !== undefined) {
      window.clearTimeout(persistTimer.current);
    }
    persistTimer.current = window.setTimeout(persistNow, 500);
  }, [persistNow]);

  useEffect(() => {
    window.addEventListener("beforeunload", persistNow);
    return () => window.removeEventListener("beforeunload", persistNow);
  }, [persistNow]);

  return { persistNow, schedulePersist };
}
