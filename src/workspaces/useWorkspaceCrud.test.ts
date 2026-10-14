import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import type { DockviewApi } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { MAX_WORKSPACES } from "../constants";
import { setLocale } from "../i18n";
import {
  createDefaultSession,
  type Workspace,
  type WorkspacesState,
} from "../persist";
import { useWorkspaceCrud } from "./useWorkspaceCrud";

vi.mock("../platform", () => ({ isTauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../terminal/registry", () => ({ destroyTerminal: vi.fn() }));

const invokeMock = vi.mocked(invoke);

function workspace(index: number, folder = true): Workspace {
  const id = `workspace-${index}`;
  const session = createDefaultSession(id, null, 0);
  return {
    id,
    displayName: `project-${index}`,
    nameMode: "folder",
    folder: folder
      ? {
          selectedPath: `/projects/${index}`,
          canonicalPath: `/projects/${index}`,
          identityKey: null,
        }
      : null,
    sessions: [session],
    activeSessionId: session.id,
    createdAt: 0,
    lastOpenedAt: 0,
  };
}

function setup(list: Workspace[]) {
  const workspacesRef: MutableRefObject<WorkspacesState> = {
    current: { list, activeId: list[0]?.id ?? null },
  };
  const apiRef: MutableRefObject<DockviewApi | null> = { current: null };
  const showToast = vi.fn();
  const { result } = renderHook(() =>
    useWorkspaceCrud({
      apiRef,
      workspacesRef,
      setWorkspaces: vi.fn(),
      setTerminalCount: vi.fn(),
      rootErrorsRef: { current: {} },
      clearRootError: vi.fn(),
      showToast,
      locale: "ru",
      snapshotActiveSession: (items) => items,
      selectWorkspace: vi.fn(),
      loadSession: vi.fn(),
    }),
  );
  return { createWorkspace: result.current.createWorkspace, showToast };
}

function pickerOpened(): boolean {
  return invokeMock.mock.calls.some(([command]) => command === "workspace_pick_root");
}

describe("project limit", () => {
  beforeEach(() => {
    setLocale("ru");
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command) =>
      command === "workspace_pick_root" ? { status: "cancelled" } : undefined,
    );
  });

  it("does not open the folder picker once the sidebar is full", async () => {
    const full = Array.from({ length: MAX_WORKSPACES }, (_, index) =>
      workspace(index),
    );
    const { createWorkspace, showToast } = setup(full);

    await createWorkspace();

    expect(pickerOpened()).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining(String(MAX_WORKSPACES)),
    );
  });

  it("still lets the last free slot be taken", async () => {
    const almost = Array.from({ length: MAX_WORKSPACES - 1 }, (_, index) =>
      workspace(index),
    );
    const { createWorkspace, showToast } = setup(almost);

    await createWorkspace();

    expect(pickerOpened()).toBe(true);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("lets a full sidebar point a lost project at a new folder", async () => {
    // Активный проект без папки: выбор папки чинит его, а не добавляет новый.
    const full = [
      workspace(0, false),
      ...Array.from({ length: MAX_WORKSPACES - 1 }, (_, index) =>
        workspace(index + 1),
      ),
    ];
    const { createWorkspace, showToast } = setup(full);

    await createWorkspace();

    expect(pickerOpened()).toBe(true);
    expect(showToast).not.toHaveBeenCalled();
  });
});
