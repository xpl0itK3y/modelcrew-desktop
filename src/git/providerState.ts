import type { GitIdentity } from "../github/auth";
import {
  getGithubAuthGeneration,
  getGithubAuthError,
  getGithubUser,
  isGithubAuthResolved,
  subscribeGithubAuth,
} from "../github/authState";

export type GitProvider = "github" | "gitlab";

export type ProviderCommitIdentity = {
  provider: GitProvider;
  login: string;
  identity: GitIdentity;
};

export type ProviderRepositoryState = {
  workspaceId: string;
  generation: number;
  status: "loading" | "ready" | "error";
  account:
    | {
        provider: GitProvider;
        login: string;
        avatarUrl: string;
      }
    | null;
  commitIdentities: ProviderCommitIdentity[];
  error: string | null;
};

export function getProviderRepositoryState(
  workspaceId: string,
): ProviderRepositoryState {
  const user = getGithubUser();
  const error = getGithubAuthError();
  return {
    workspaceId,
    generation: getGithubAuthGeneration(),
    status: error ? "error" : isGithubAuthResolved() ? "ready" : "loading",
    account: user
      ? {
          provider: "github",
          login: user.login,
          avatarUrl: user.avatarUrl,
        }
      : null,
    commitIdentities:
      user?.commitIdentity === undefined
        ? []
        : [
            {
              provider: "github",
              login: user.login,
              identity: user.commitIdentity,
            },
          ],
    error,
  };
}

export function subscribeProviderRepositoryState(
  workspaceId: string,
  listener: (state: ProviderRepositoryState) => void,
): () => void {
  const publish = () => listener(getProviderRepositoryState(workspaceId));
  const unsubscribe = subscribeGithubAuth(publish);
  publish();
  return unsubscribe;
}
