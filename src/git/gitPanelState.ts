import {
  getGitSummary,
  subscribeGitChanges,
  type LocalGitSnapshot,
} from "./gitChanges";
import {
  getProviderRepositoryState,
  subscribeProviderRepositoryState,
  type ProviderRepositoryState,
} from "./providerState";

export type GitPanelViewModel = {
  local: LocalGitSnapshot | null;
  provider: ProviderRepositoryState;
};

export function getGitPanelViewModel(workspaceId: string): GitPanelViewModel {
  return {
    local: getGitSummary(workspaceId),
    provider: getProviderRepositoryState(workspaceId),
  };
}

export function subscribeGitPanelViewModel(
  workspaceId: string,
  listener: (model: GitPanelViewModel) => void,
): () => void {
  let local = getGitSummary(workspaceId);
  let provider = getProviderRepositoryState(workspaceId);
  const publish = () => {
    listener({ local, provider });
  };
  const unsubscribeLocal = subscribeGitChanges(workspaceId, (snapshot) => {
    local = snapshot;
    publish();
  });
  const unsubscribeProvider = subscribeProviderRepositoryState(
    workspaceId,
    (state) => {
      provider = state;
      publish();
    },
  );
  publish();
  return () => {
    unsubscribeLocal();
    unsubscribeProvider();
  };
}
