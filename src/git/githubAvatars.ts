// Реальные GitHub-аватарки коммиттеров: карта «почта → URL аватара», собранная
// из коммитов origin-репозитория через GitHub API (нужен вход). Глобальная —
// одна почта = один GitHub-аккаунт = один аватар, между проектами общая.
// Приоритетнее Gravatar/инициалов: подставляется первой в AuthorAvatar.

import { githubCommitAvatars } from "../github/auth";

const byEmail = new Map<string, string>();
// Проекты, для которых карта уже загружена — не тянем повторно.
const loaded = new Set<string>();
const inflight = new Set<string>();

// Событие «карта обновилась» — смонтированные аватарки перечитывают URL.
const CHANGED_EVENT = "modelcrew:github-avatars";

export function githubAvatarForEmail(email: string): string | undefined {
  return byEmail.get(email.trim().toLowerCase());
}

// Подтягивает карту для проекта один раз. Пустой ответ (нет входа/доступа) —
// не ошибка: просто останется откат на Gravatar/инициалы.
export function loadGithubCommitAvatars(workspaceId: string): void {
  if (!workspaceId || loaded.has(workspaceId) || inflight.has(workspaceId)) {
    return;
  }
  inflight.add(workspaceId);
  void githubCommitAvatars(workspaceId)
    .then((list) => {
      let changed = false;
      for (const item of list) {
        const key = item.email.trim().toLowerCase();
        if (key && item.avatarUrl && byEmail.get(key) !== item.avatarUrl) {
          byEmail.set(key, item.avatarUrl);
          changed = true;
        }
      }
      loaded.add(workspaceId);
      if (changed) {
        window.dispatchEvent(new Event(CHANGED_EVENT));
      }
    })
    .catch(() => {
      // Сетевой сбой — попробуем при следующем поводе (не помечаем loaded).
    })
    .finally(() => {
      inflight.delete(workspaceId);
    });
}

// После входа/выхода состав видимых аватарок мог поменяться: сбрасываем кэш и
// тянем заново для уже виденных проектов.
export function refreshGithubCommitAvatars(): void {
  const seen = Array.from(loaded);
  loaded.clear();
  byEmail.clear();
  window.dispatchEvent(new Event(CHANGED_EVENT));
  for (const workspaceId of seen) {
    loadGithubCommitAvatars(workspaceId);
  }
}

export function subscribeGithubAvatars(listener: () => void): () => void {
  window.addEventListener(CHANGED_EVENT, listener);
  return () => window.removeEventListener(CHANGED_EVENT, listener);
}
