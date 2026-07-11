import { useEffect, useRef } from "react";
import { IDockviewPanelProps } from "dockview";
import {
  destroyTerminal,
  ensureSpawned,
  getOrCreateTerminal,
} from "../terminal/registry";

export { destroyTerminal };

export function TerminalPanel(props: IDockviewPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const entry = getOrCreateTerminal(props.api.id);
    host.appendChild(entry.container);
    entry.fit.fit();
    void ensureSpawned(entry);

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
