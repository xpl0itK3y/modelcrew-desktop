import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import type { DockviewApi } from "dockview";
import type { WorkspacesState } from "../persist";
import { useWorkspacePersistence } from "./useWorkspacePersistence";

const STORAGE_KEY = "modelcrew.workspaces";

function makeRefs() {
  const workspacesRef: MutableRefObject<WorkspacesState> = {
    current: { list: [], activeId: null },
  };
  const apiRef: MutableRefObject<DockviewApi | null> = { current: null };
  return { workspacesRef, apiRef };
}

function storedVersion(): number | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw).version as number) : null;
}

describe("workspace persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("writes the snapshot and stops writing while suspended", () => {
    const { workspacesRef, apiRef } = makeRefs();
    const { result } = renderHook(() =>
      useWorkspacePersistence(workspacesRef, apiRef),
    );

    result.current.persistNow();
    expect(storedVersion()).toBe(3);

    // Заморозка: снапшот перед обновлением не должен перезаписываться.
    localStorage.clear();
    result.current.suspendPersistence();
    result.current.persistNow();
    expect(storedVersion()).toBeNull();

    result.current.resumePersistence();
    result.current.persistNow();
    expect(storedVersion()).toBe(3);
  });

  it("cancels a pending debounced write when suspended", () => {
    vi.useFakeTimers();
    try {
      const { workspacesRef, apiRef } = makeRefs();
      const { result } = renderHook(() =>
        useWorkspacePersistence(workspacesRef, apiRef),
      );

      result.current.schedulePersist();
      result.current.suspendPersistence();
      vi.advanceTimersByTime(1_000);
      expect(storedVersion()).toBeNull();

      // Новые отложенные записи в замороженном состоянии не планируются.
      result.current.schedulePersist();
      vi.advanceTimersByTime(1_000);
      expect(storedVersion()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
