import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { IDockviewPanelHeaderProps } from "dockview";
import {
  getTerminalStatus,
  markManualTitle,
  onTerminalStatus,
  type TerminalStatus,
} from "../terminal/registry";

export function TerminalTab(props: IDockviewPanelHeaderProps) {
  const [title, setTitle] = useState(props.api.title ?? "");
  const [status, setStatus] = useState<TerminalStatus>(() =>
    getTerminalStatus(props.api.id),
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
    return () => {
      titleDisposable.dispose();
      statusUnsubscribe();
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

  return (
    <div className="terminal-tab" onDoubleClick={() => setEditing(true)}>
      <span className={`tab-dot is-${status}`} />
      {editing ? (
        <input
          ref={inputRef}
          className="tab-rename-input"
          defaultValue={title}
          onBlur={commitRename}
          onKeyDown={onInputKeyDown}
          onPointerDown={(event) => event.stopPropagation()}
        />
      ) : (
        <span className="tab-title" title={title}>
          {title}
        </span>
      )}
    </div>
  );
}
