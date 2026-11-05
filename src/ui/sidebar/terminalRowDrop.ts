import { useEffect, useState, type DragEvent } from "react";
import type { TerminalSessionDrop } from "../../hotkeys/useCmdDrag";
import type { TerminalDropVerdict } from "../../workspaces/terminalMove";

// Строки проектов и сессий как место, куда роняют терминал.
//
// Терминал сюда приносят двумя путями. ⌘-перетаскивание ищет строку само — по
// атрибутам data-terminal-drop, data-workspace-id и data-session-id. А за
// шапку панель тащит dockview обычным перетаскиванием браузера, и его ловят
// обработчики строки ниже.
export type TerminalRowDrop = TerminalSessionDrop & {
  // Какой терминал тащат за шапку прямо сейчас. null — тащат не терминал:
  // файл, текст или ничего.
  dragged: () => string | null;
};

export type RowDrop = {
  className: string;
  props: {
    "data-terminal-drop": "workspace" | "session";
    "data-workspace-id": string;
    "data-session-id"?: string;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
};

type Over = { key: string; verdict: TerminalDropVerdict };

export function dropClassName(verdict: TerminalDropVerdict | null): string {
  if (verdict === "move") {
    return "is-terminal-drop";
  }
  return verdict === "foreign" || verdict === "full"
    ? "is-terminal-drop-refused"
    : "";
}

export function useTerminalRowDrop(drop: TerminalRowDrop | undefined) {
  const [over, setOver] = useState<Over | null>(null);

  // Перетаскивание могли бросить где угодно — или отменить Esc: подсветка
  // не должна пережить его.
  useEffect(() => {
    if (!over) {
      return;
    }
    const clear = () => setOver(null);
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    return () => {
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("drop", clear, true);
    };
  }, [over]);

  return (workspaceId: string, sessionId: string | null): RowDrop => {
    const key = `${workspaceId}:${sessionId ?? ""}`;
    return {
      className: dropClassName(over?.key === key ? over.verdict : null),
      props: {
        "data-terminal-drop": sessionId ? "session" : "workspace",
        "data-workspace-id": workspaceId,
        ...(sessionId ? { "data-session-id": sessionId } : {}),
        onDragOver: (event) => {
          if (!drop?.dragged()) {
            return;
          }
          const verdict = drop.verdict(workspaceId, sessionId);
          if (verdict === "here") {
            setOver(null);
            return;
          }
          // Отказ тоже принимаем: отпущенный над чужим проектом терминал
          // никуда не уедет, но приложение объяснит почему.
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setOver((current) =>
            current?.key === key && current.verdict === verdict
              ? current
              : { key, verdict },
          );
        },
        onDragLeave: (event) => {
          // Переход на значок или кнопку внутри той же строки — не уход.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          setOver((current) => (current?.key === key ? null : current));
        },
        onDrop: (event) => {
          setOver(null);
          const panelId = drop?.dragged();
          if (!drop || !panelId) {
            return;
          }
          event.preventDefault();
          // Следом придёт dragend, в нём dockview закончит своё
          // перетаскивание. Панель убираем после: иначе он доделывал бы его
          // над шапкой, которой уже нет.
          window.setTimeout(() => drop.drop(panelId, workspaceId, sessionId), 0);
        },
      },
    };
  };
}
