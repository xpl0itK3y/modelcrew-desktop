import ReactDOM from "react-dom/client";
import App from "./App";
import { applyAccent, applyTheme, loadAccent, loadTheme } from "./theme";
import { initializeLocale } from "./i18n";
import { dropRetiredPreferences } from "./terminal/preferences";

// Применяем сохранённый внешний вид до первого React-render, чтобы при старте
// не было вспышки стандартной тёмной темы.
applyTheme(loadTheme());
applyAccent(loadAccent());
initializeLocale();
dropRetiredPreferences();

// Без StrictMode: его двойное монтирование эффектов в dev-режиме плодит
// побочные эффекты у имеющих внешнее состояние панелей (PTY, xterm).
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
