import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { IDockviewPanelHeaderProps } from "dockview";
import {
  getTerminalStatus,
  markManualTitle,
  onTerminalStatus,
  type TerminalStatus,
} from "../terminal/registry";
import {
  isAgentPanelWaiting,
  subscribeAgentAttention,
} from "../terminal/attentionStore";
import { getPanelClaims, subscribePanelClaims } from "../crew/claimStore";
import { useI18n } from "../i18n";

// Имя файла без пути: на вкладке шириной в пару слов путь не поместится, а
// полный лежит в подсказке.
function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function TerminalTab(props: IDockviewPanelHeaderProps) {
  const { t } = useI18n();
  const [title, setTitle] = useState(props.api.title ?? "");
  const [status, setStatus] = useState<TerminalStatus>(() =>
    getTerminalStatus(props.api.id),
  );
  const [waiting, setWaiting] = useState(() =>
    isAgentPanelWaiting(props.api.id),
  );
  const [blockedBy, setBlockedBy] = useState<string | null>(
    () => getPanelClaims(props.api.id).waitingFor,
  );
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTitle(props.api.title ?? "");
    setStatus(getTerminalStatus(props.api.id));
    const titleDisposable = props.api.onDidTitleChange((event) => {
      setTitle(event.title);
    });
    const statusUnsubscribe = onTerminalStatus((id, next) => {
      if (id === props.api.id) {
        setStatus(next);
      }
    });
    // Счётчик из подписки не годится: он мог не измениться, когда одна панель
    // отпустила внимание, а другая его забрала. Спрашиваем про свою.
    const attentionUnsubscribe = subscribeAgentAttention(() => {
      setWaiting(isAgentPanelWaiting(props.api.id));
    });
    setBlockedBy(getPanelClaims(props.api.id).waitingFor);
    const claimsUnsubscribe = subscribePanelClaims(() => {
      setBlockedBy(getPanelClaims(props.api.id).waitingFor);
    });
    return () => {
      titleDisposable.dispose();
      statusUnsubscribe();
      attentionUnsubscribe();
      claimsUnsubscribe();
    };
  }, [props.api]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.select();
    }
  }, [editing]);

  const commitRename = () => {
    const value = inputRef.current?.value.trim();
    if (value) {
      props.api.setTitle(value);
      props.api.updateParameters({
        ...props.api.getParameters(),
        titleKind: "manual",
      });
      markManualTitle(props.api.id);
    }
    setEditing(false);
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      commitRename();
    } else if (event.key === "Escape") {
      setEditing(false);
    }
  };

  // «Ждёт ответа» перекрывает всё: агент закончил ход и ждёт человека, это
  // самое срочное. Дальше — упёрся в занятый файл: разберётся сам, но пока
  // стоит. И только потом обычное «работает».
  //
  // Признак нужен именно на вкладке: подпись в шапке группы показывает лишь
  // выбранную панель, и застрявшего соседа за ней не видно.
  const dotState = waiting ? "waiting" : blockedBy ? "blocked" : status;
  const dotLabel = waiting
    ? t("terminal.statusWaiting")
    : blockedBy
      ? t("crew.waitingFor", { path: blockedBy })
      : status === "running"
        ? t("terminal.statusRunning")
        : t("terminal.statusExited");

  return (
    <div className="terminal-tab" onDoubleClick={() => setEditing(true)}>
      <span
        className={`tab-dot is-${dotState}`}
        role="img"
        title={dotLabel}
        aria-label={dotLabel}
      />
      {editing ? (
        <input
          ref={inputRef}
          className="tab-rename-input"
          defaultValue={title}
          aria-label={t("terminal.rename")}
          onBlur={commitRename}
          onKeyDown={onInputKeyDown}
          onPointerDown={(event) => event.stopPropagation()}
        />
      ) : (
        <span className="tab-title" title={title}>
          {title}
        </span>
      )}
      {/* Имя занятого файла — рядом с именем агента: «кто стоит и на чём».
          Без него точка говорит только «что-то не так». */}
      {!editing && blockedBy && (
        <span
          className="tab-blocked"
          title={t("crew.waitingFor", { path: blockedBy })}
        >
          {fileName(blockedBy)}
        </span>
      )}
    </div>
  );
}
