// Правка истории: действия над коммитом из меню, сообщение коммита, amend,
// squash/fixup, удаление коммита и удаление тега.
//
// Почти каждая команда переписывает прошлое, поэтому получает ожидаемый HEAD:
// панель подтверждает то состояние, которое показала пользователю.

import { invoke } from "@tauri-apps/api/core";

// Действия над коммитом истории: checkout (отделить HEAD), branch (создать
// ветку от коммита), revert (отменить коммит новым), uncommit (снять локальный
// HEAD, сохранив изменения). Ошибки git поднимаются наверх и показываются в
// панели.
export type CommitAction = "checkout" | "branch" | "revert" | "uncommit";

export function commitAction(
  workspaceId: string,
  action: CommitAction,
  hash: string,
  name?: string,
): Promise<void> {
  return invoke("git_commit_action", {
    workspaceId,
    action,
    hash,
    ...(name === undefined ? {} : { name }),
  });
}

// Переписать сообщение локального коммита. Бэкенд разрешает только не
// запушенные свои не-merge коммиты; иначе — ошибка.
export function rewordCommit(
  workspaceId: string,
  hash: string,
  message: string,
): Promise<void> {
  return invoke("git_reword_commit", { workspaceId, hash, message });
}

// Правка локальной истории. Каждая команда получает вершину ветки, которую
// пользователь видел в панели: если её успели сдвинуть, бэкенд откажет вместо
// того, чтобы переписать чужой коммит.
export function amendCommit(
  workspaceId: string,
  expectedHead: string,
  message?: string,
): Promise<void> {
  return invoke("git_amend_commit", { workspaceId, expectedHead, message });
}

// squash объединяет оба сообщения, fixup оставляет сообщение родителя.
export type GitSquashMode = "squash" | "fixup";

export function squashCommit(
  workspaceId: string,
  hash: string,
  mode: GitSquashMode,
  expectedHead: string,
): Promise<void> {
  return invoke("git_squash_commit", {
    workspaceId,
    hash,
    mode,
    expectedHead,
  });
}

export function dropCommit(
  workspaceId: string,
  hash: string,
  expectedHead: string,
): Promise<void> {
  return invoke("git_drop_commit", { workspaceId, hash, expectedHead });
}

// Удаление локального тега. Тег на сервере не трогаем: это уже общий
// репозиторий.
export function deleteTag(workspaceId: string, name: string): Promise<void> {
  return invoke("git_delete_tag", { workspaceId, name });
}
