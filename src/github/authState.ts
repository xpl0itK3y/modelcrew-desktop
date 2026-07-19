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
