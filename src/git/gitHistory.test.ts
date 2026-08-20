import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  amendCommit,
  commitAction,
  dropCommit,
  squashCommit,
} from "./gitHistory";

describe("history rewriting IPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("sends the uncommit action without an optional name", async () => {
    await commitAction("ws-4", "uncommit", "abcdef123456");

    expect(mocks.invoke).toHaveBeenCalledWith("git_commit_action", {
      workspaceId: "ws-4",
      action: "uncommit",
      hash: "abcdef123456",
    });
  });

  it("amends the last commit against the confirmed head", async () => {
    await amendCommit("ws-1", "a".repeat(40));

    expect(mocks.invoke).toHaveBeenCalledWith("git_amend_commit", {
      workspaceId: "ws-1",
      expectedHead: "a".repeat(40),
      message: undefined,
    });
  });

  it("separates squash from fixup", async () => {
    await squashCommit("ws-1", "b".repeat(40), "fixup", "a".repeat(40));

    expect(mocks.invoke).toHaveBeenCalledWith("git_squash_commit", {
      workspaceId: "ws-1",
      hash: "b".repeat(40),
      mode: "fixup",
      expectedHead: "a".repeat(40),
    });
  });

  it("drops a commit against the confirmed head", async () => {
    await dropCommit("ws-1", "b".repeat(40), "a".repeat(40));

    expect(mocks.invoke).toHaveBeenCalledWith("git_drop_commit", {
      workspaceId: "ws-1",
      hash: "b".repeat(40),
      expectedHead: "a".repeat(40),
    });
  });
});
