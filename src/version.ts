// Версия приложения, вшитая Vite'ом на сборке (см. vite.config.ts).
// Вне Vite/Vitest константа не определена — откатываемся к dev-метке.
export const APP_VERSION =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0-dev";
