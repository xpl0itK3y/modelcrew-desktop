import { useEffect, useRef } from "react";
import { IDockviewPanelProps } from "dockview";
import {
  destroyTerminal,
  ensureSpawned,
  fitTerminal,
  getAutoTitle,
  getOrCreateTerminal,
  isManualTitle,
} from "../terminal/registry";
import { clearAgentAttention } from "../terminal/agentAlerts";

export { destroyTerminal };

export function TerminalPanel(
  props: IDockviewPanelProps<{ workspaceId?: string; sessionId?: string }>,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const entry = getOrCreateTerminal(props.api.id);
    let mounted = true;
    host.appendChild(entry.container);
    // Панель на экране — сигнал «агент ждёт» для неё снят.
    clearAgentAttention(entry.id);
    fitTerminal(entry);
    // Панель знает только владельца. Фактический cwd разрешает Rust-реестр,
    // поэтому восстановленные панели одного воркспейса не могут разъехаться.
    void ensureSpawned(entry, props.params?.workspaceId ?? "").then(() => {
      if (!mounted) {
        return;
      }
      const title = getAutoTitle(entry.id);
      const parameters = props.api.getParameters<{ titleKind?: string }>();
      if (
        title &&
        parameters.titleKind !== "manual" &&
        !isManualTitle(entry.id)
      ) {
        props.api.setTitle(title);
        props.api.updateParameters({
          ...parameters,
          titleKind: "process",
        });
      }
    });

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
        fitTerminal(entry);
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
      mounted = false;
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
