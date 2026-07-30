import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { gitPull, gitPullRebase, gitPush, publishBranch } from "./gitSync";

describe("sync IPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("binds every sync command to the confirmed branch and HEAD", async () => {
    const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await gitPull("ws-5", "main", head);
    await gitPush("ws-5", "main", head);
    await gitPullRebase("ws-5", "main", head);

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "git_pull", {
      workspaceId: "ws-5",
      expectedBranch: "main",
      expectedHead: head,
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "git_push", {
      workspaceId: "ws-5",
      expectedBranch: "main",
      expectedHead: head,
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "git_pull_rebase", {
      workspaceId: "ws-5",
      expectedBranch: "main",
      expectedHead: head,
    });
  });

  it("publishes without forcing a remote choice", async () => {
    await publishBranch("ws-1", "feature/x", "a".repeat(40));

    expect(mocks.invoke).toHaveBeenCalledWith("git_publish_branch", {
      workspaceId: "ws-1",
      expectedBranch: "feature/x",
      expectedHead: "a".repeat(40),
      remote: undefined,
    });
  });
});
