import { beforeEach, describe, expect, it } from "vitest";
import { setGithubAuthError, setGithubUser } from "../github/authState";
import {
  getProviderRepositoryState,
  subscribeProviderRepositoryState,
} from "./providerState";

describe("provider repository state", () => {
  beforeEach(() => setGithubUser(null));

  it("keeps provider identity separate and requires an authenticated account", () => {
    const signedOut = getProviderRepositoryState("workspace-a");
    expect(signedOut.workspaceId).toBe("workspace-a");
    expect(signedOut.status).toBe("ready");
    expect(signedOut.account).toBeNull();
    expect(signedOut.commitIdentities).toEqual([]);

    setGithubUser({
      login: "denis",
      avatarUrl: "https://avatars.example/denis",
      commitIdentity: {
        name: "Denis Provider",
        email: "denis@users.noreply.github.com",
      },
    });

    const signedIn = getProviderRepositoryState("workspace-b");
    expect(signedIn.workspaceId).toBe("workspace-b");
    expect(signedIn.generation).toBeGreaterThan(signedOut.generation);
    expect(signedIn.account).toEqual({
      provider: "github",
      login: "denis",
      avatarUrl: "https://avatars.example/denis",
    });
    expect(signedIn.commitIdentities).toEqual([
      {
        provider: "github",
        login: "denis",
        identity: {
          name: "Denis Provider",
          email: "denis@users.noreply.github.com",
        },
      },
    ]);
  });

  it("publishes account generations without changing local Git state", () => {
    const states: number[] = [];
    const unsubscribe = subscribeProviderRepositoryState(
      "workspace-a",
      (state) => states.push(state.generation),
    );

    setGithubUser({
      login: "octocat",
      avatarUrl: "https://avatars.example/octocat",
    });
    unsubscribe();

    expect(states).toHaveLength(2);
    expect(states[1]).toBeGreaterThan(states[0]);
  });

  it("reports provider errors without replacing the account snapshot", () => {
    setGithubUser({
      login: "denis",
      avatarUrl: "https://avatars.example/denis",
    });
    const ready = getProviderRepositoryState("workspace-a");

    setGithubAuthError("github-current-user");
    const failed = getProviderRepositoryState("workspace-a");

    expect(failed.status).toBe("error");
    expect(failed.error).toBe("github-current-user");
    expect(failed.account).toEqual(ready.account);
    expect(failed.generation).toBeGreaterThan(ready.generation);
  });
});
