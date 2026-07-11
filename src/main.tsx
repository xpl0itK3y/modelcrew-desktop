import ReactDOM from "react-dom/client";
import App from "./App";

// Без StrictMode: его двойное монтирование эффектов в dev-режиме плодит
// побочные эффекты у имеющих внешнее состояние панелей (PTY, xterm).
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
