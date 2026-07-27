// Асинхронное состояние GitHub-аккаунта живёт отдельно от локального Git.
// GithubAuth остаётся единственным владельцем device flow и обновляет store
// после загрузки профиля, входа и выхода.

import type { GithubUser } from "./auth";

let user: GithubUser | null = null;
let resolved = false;
let error: string | null = null;
let generation = 0;
const EVENT = "modelcrew:github-auth";

export function isGithubSignedIn(): boolean {
  return user !== null;
}

export function getGithubUser(): GithubUser | null {
  return user;
}

export function isGithubAuthResolved(): boolean {
  return resolved;
}

export function getGithubAuthGeneration(): number {
  return generation;
}

export function getGithubAuthError(): string | null {
  return error;
}

export function setGithubUser(value: GithubUser | null): void {
  const unchanged =
    resolved &&
    error === null &&
    user?.login === value?.login &&
    user?.avatarUrl === value?.avatarUrl &&
    user?.commitIdentity?.name === value?.commitIdentity?.name &&
    user?.commitIdentity?.email === value?.commitIdentity?.email;
  if (unchanged) {
    return;
  }
  user = value;
  resolved = true;
  error = null;
  generation += 1;
  window.dispatchEvent(new Event(EVENT));
}

export function setGithubAuthError(value: string): void {
  if (resolved && error === value) {
    return;
  }
  resolved = true;
  error = value;
  generation += 1;
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeGithubAuth(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

// Вход и выход остаются целиком за GithubAuth: там живёт устройство-флоу с
// опросом и там же лежит текущий пользователь. Настройки не повторяют эту
// логику, а просят её выполнить — иначе на экране оказались бы два независимых
// опроса подтверждения.
export type GithubAuthRequest = "login" | "logout";

const REQUEST_EVENT = "modelcrew:github-auth-request";

export function requestGithubAuth(request: GithubAuthRequest): void {
  window.dispatchEvent(
    new CustomEvent<GithubAuthRequest>(REQUEST_EVENT, { detail: request }),
  );
}

export function subscribeGithubAuthRequests(
  listener: (request: GithubAuthRequest) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<GithubAuthRequest>).detail);
  };
  window.addEventListener(REQUEST_EVENT, handler);
  return () => window.removeEventListener(REQUEST_EVENT, handler);
}
