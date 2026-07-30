// Чтение журнала коммитов: сам список с фильтрами, файлы коммита и diff по
// ним, ссылка на коммит на GitHub. Здесь только чтение — правка истории живёт
// в gitHistory, ветки в gitBranches.

import { invoke } from "@tauri-apps/api/core";
import type { GitFileDiff } from "./gitChanges";
import type { GitRefKind } from "./gitBranches";

export type GitCommitRefInfo = {
  name: string;
  fullName: string;
  kind: GitRefKind;
};

export type GitCommitInfo = {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authorEmail: string;
  epochMs: number;
  // Коммит есть только на этом компьютере.
  unpushed: boolean;
  // Коммит не достижим ни из одной remote-tracking ветки.
  localOnly: boolean;
  // Можно безопасно переписать сообщение в текущей first-parent цепочке.
  editable: boolean;
  // На этот коммит указывает HEAD (текущий checkout).
  isHead: boolean;
  // Полные хеши родителей (для графа веток).
  parents: string[];
  refs: string[];
  refDetails: GitCommitRefInfo[];
  remoteRefs: string[];
  // Исходное полное сообщение, включая mixed trailer block.
  fullMessage: string;
  body?: string;
  coAuthors?: string[];
};

// Фильтр применяет git, а не панель: иначе пришлось бы вычитывать всю историю,
// чтобы отобрать пару коммитов.
export type GitLogFilter = {
  text?: string;
  author?: string;
  path?: string;
};

export function fetchLog(
  workspaceId: string,
  limit = 100,
  all = false,
  filter?: GitLogFilter,
): Promise<GitCommitInfo[]> {
  return invoke<GitCommitInfo[]>("git_log", {
    workspaceId,
    limit,
    all,
    filter,
  });
}

export type GitCommitFile = {
  path: string;
  additions?: number;
  deletions?: number;
};

export function fetchCommitFiles(
  workspaceId: string,
  hash: string,
): Promise<GitCommitFile[]> {
  return invoke<GitCommitFile[]>("git_commit_files", { workspaceId, hash });
}

// Diff файла внутри коммита — для просмотра истории по строкам.
export function commitFileDiff(
  workspaceId: string,
  hash: string,
  path: string,
): Promise<GitFileDiff> {
  return invoke<GitFileDiff>("git_commit_file_diff", {
    workspaceId,
    hash,
    path,
  });
}

// Ссылка на коммит на GitHub; null — репозиторий не связан с GitHub. Команда
// живёт в модуле авторизации, но нужна именно панели истории.
export function githubCommitUrl(
  workspaceId: string,
  hash: string,
): Promise<string | null> {
  return invoke<string | null>("github_commit_url", { workspaceId, hash });
}
