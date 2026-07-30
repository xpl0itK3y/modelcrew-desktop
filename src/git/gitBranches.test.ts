import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  createBranch,
  deleteBranch,
  mergeRef,
  rebaseOnto,
  renameBranch,
} from "./gitBranches";

describe("branch IPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("creates a branch with the expected command arguments", async () => {
    await createBranch("ws-1", "feature/history");

    expect(mocks.invoke).toHaveBeenCalledWith("git_create_branch", {
      workspaceId: "ws-1",
      name: "feature/history",
    });
  });

  it("renames a branch with the expected command arguments", async () => {
    await renameBranch("ws-2", "old-name", "new-name");

    expect(mocks.invoke).toHaveBeenCalledWith("git_rename_branch", {
      workspaceId: "ws-2",
      branch: "old-name",
      newName: "new-name",
    });
  });

  it("deletes a branch with the expected command arguments", async () => {
    await deleteBranch("ws-3", "obsolete", true, "abc123def456");

    expect(mocks.invoke).toHaveBeenCalledWith("git_delete_branch", {
      workspaceId: "ws-3",
      branch: "obsolete",
      force: true,
      expectedTip: "abc123def456",
    });
  });

  it("merges a full ref against the confirmed branch and head", async () => {
    await mergeRef("ws-1", "refs/remotes/origin/dev", "main", "a".repeat(40));

    expect(mocks.invoke).toHaveBeenCalledWith("git_merge_ref", {
      workspaceId: "ws-1",
      reference: "refs/remotes/origin/dev",
      expectedBranch: "main",
      expectedHead: "a".repeat(40),
      noFf: false,
    });
  });

  it("rebases onto a full ref", async () => {
    await rebaseOnto("ws-1", "refs/heads/main", "topic", "a".repeat(40));

    expect(mocks.invoke).toHaveBeenCalledWith("git_rebase_onto", {
      workspaceId: "ws-1",
      reference: "refs/heads/main",
      expectedBranch: "topic",
      expectedHead: "a".repeat(40),
    });
  });
});
