import { useEffect, useRef } from "react";
import { IDockviewPanelProps } from "dockview";
import {
  destroyTerminal,
  ensureSpawned,
  getOrCreateTerminal,
} from "../terminal/registry";

export { destroyTerminal };

export function TerminalPanel(
  props: IDockviewPanelProps<{ cwd?: string | null }>,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const entry = getOrCreateTerminal(props.api.id);
    host.appendChild(entry.container);
    entry.fit.fit();
    // Стартовый cwd зафиксирован в params панели при создании — он же
    // используется при восстановлении раскладки после рестарта.
    void ensureSpawned(entry, props.params?.cwd ?? null);

    // Появление нового терминала: fade + scale только при первом маунте,
    // переносы/свопы того же инстанса не мигают.
    if (!entry.everAttached) {
      entry.everAttached = true;
      host.classList.add("panel-enter");
      host.addEventListener(
        "animationend",
        () => host.classList.remove("panel-enter"),
        { once: true },
      );
    }

    const observer = new ResizeObserver(() => {
      if (entry.container.isConnected) {
        entry.fit.fit();
      }
    });
    observer.observe(host);

    const activeDisposable = props.api.onDidActiveChange((event) => {
      if (event.isActive) {
        entry.term.focus();
      }
    });
    if (props.api.isActive) {
      entry.term.focus();
    }

    return () => {
      observer.disconnect();
      activeDisposable.dispose();
      // Инстанс остаётся в реестре: при переносе панели тот же container
      // просто примонтируется к новому узлу, сессия не прерывается.
      if (entry.container.parentElement === host) {
        host.removeChild(entry.container);
      }
    };
  }, [props.api]);

  return <div ref={hostRef} className="terminal-panel" />;
}
