// Синхронизация с сервером: pull, push, pull --rebase, сброс на upstream и
// публикация ещё не отправленной ветки. Все — сетевые и без интерактивного
// запроса пароля: при необходимости авторизации падают с ошибкой, а не виснут.
// Каждая получает ветку и HEAD, которые видел пользователь.

import { invoke } from "@tauri-apps/api/core";

// Забрать с сервера (ff-only) и отправить локальные коммиты. Обе — сетевые,
// без интерактивного запроса пароля: при необходимости авторизации падают с
// ошибкой, а не виснут.
export function gitPull(
  workspaceId: string,
  expectedBranch: string,
  expectedHead: string,
): Promise<void> {
  return invoke("git_pull", { workspaceId, expectedBranch, expectedHead });
}

export function gitPush(
  workspaceId: string,
  expectedBranch: string,
  expectedHead: string,
): Promise<void> {
  return invoke("git_push", { workspaceId, expectedBranch, expectedHead });
}

// Забрать с rebase (для разошедшейся ветки): локальные коммиты кладутся поверх
// серверных. При конфликте Git оставляет стандартное незавершённое состояние,
// чтобы пользователь явно сделал continue/abort в терминале.
export function gitPullRebase(
  workspaceId: string,
  expectedBranch: string,
  expectedHead: string,
): Promise<void> {
  return invoke("git_pull_rebase", {
    workspaceId,
    expectedBranch,
    expectedHead,
  });
}

// Атомарно выровнять локальную ветку по серверной вершине. Локальные коммиты
// исчезают из истории, но их изменения, индекс и текущие правки сохраняются.
export function gitResetToUpstream(
  workspaceId: string,
  expectedBranch: string,
  expectedHead: string,
): Promise<void> {
  return invoke("git_reset_to_upstream", {
    workspaceId,
    expectedBranch,
    expectedHead,
  });
}

// Первая отправка ветки на сервер: создаёт серверную и связывает с ней локальную.
export function publishBranch(
  workspaceId: string,
  expectedBranch: string,
  expectedHead: string,
  remote?: string,
): Promise<void> {
  return invoke("git_publish_branch", {
    workspaceId,
    expectedBranch,
    expectedHead,
    remote,
  });
}
