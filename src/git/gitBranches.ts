// Ветки проекта: список, переключение, создание, переименование и удаление,
// слияние и перенос. Разрушающие команды получают обратно вершину ветки,
// которую видел пользователь: бэкенд откажется, если она успела сдвинуться.

import { invoke } from "@tauri-apps/api/core";

export type GitBranchInfo = {
  name: string;
  refName: string;
  // Ref tip observed when the branch list was loaded. Destructive actions
  // send it back so the backend can reject a stale confirmation.
  tipHash: string;
  isCurrent: boolean;
  // Есть только на сервере: переключение создаст локальную со слежением.
  isRemote: boolean;
  // Уже влита в текущую ветку — кандидат на удаление.
  isMerged: boolean;
  lastCommitAt?: number;
};

export function fetchBranches(workspaceId: string): Promise<GitBranchInfo[]> {
  return invoke<GitBranchInfo[]>("git_branches", { workspaceId });
}

export type GitRefKind = "local" | "remote" | "tag";

export function switchBranch(
  workspaceId: string,
  refName: string,
  kind: GitRefKind = "local",
): Promise<void> {
  return invoke("git_switch_branch", { workspaceId, branch: refName, kind });
}

export function createBranch(workspaceId: string, name: string): Promise<void> {
  return invoke("git_create_branch", { workspaceId, name });
}

export function renameBranch(
  workspaceId: string,
  branch: string,
  newName: string,
): Promise<void> {
  return invoke("git_rename_branch", { workspaceId, branch, newName });
}

export function deleteBranch(
  workspaceId: string,
  branch: string,
  force: boolean,
  expectedTip: string,
): Promise<void> {
  return invoke("git_delete_branch", {
    workspaceId,
    branch,
    force,
    expectedTip,
  });
}

// Слияние и перенос принимают полное имя ref: по короткому git мог бы выбрать
// одноимённую локальную ветку вместо серверной.
export function mergeRef(
  workspaceId: string,
  reference: string,
  expectedBranch: string,
  expectedHead: string,
  noFf = false,
): Promise<void> {
  return invoke("git_merge_ref", {
    workspaceId,
    reference,
    expectedBranch,
    expectedHead,
    noFf,
  });
}

export function rebaseOnto(
  workspaceId: string,
  reference: string,
  expectedBranch: string,
  expectedHead: string,
): Promise<void> {
  return invoke("git_rebase_onto", {
    workspaceId,
    reference,
    expectedBranch,
    expectedHead,
  });
}
