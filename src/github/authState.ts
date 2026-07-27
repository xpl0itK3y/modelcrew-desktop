// Общее состояние «вошёл ли пользователь через GitHub». Нужно аватаркам (сетевые
// показываем только после входа) и настройкам (кнопка «Из сети» доступна только
// вошедшим). GithubAuth — единственный, кто это состояние меняет.

let signedIn = false;
const EVENT = "modelcrew:github-auth";

export function isGithubSignedIn(): boolean {
  return signedIn;
}

export function setGithubSignedIn(value: boolean): void {
  if (signedIn === value) {
    return;
  }
  signedIn = value;
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
