import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { CloseIcon, PlusIcon, TerminalGlyphIcon } from "./Icons";
import { useI18n } from "../i18n";

export type WorkspaceItem = {
  id: string;
  name: string;
  folder: string | null;
  count: number;
};

type SidebarProps = {
  workspaces: WorkspaceItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
};

export function Sidebar(props: SidebarProps) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingId !== null) {
      inputRef.current?.select();
    }
  }, [editingId]);

  const commitRename = (id: string) => {
    const value = inputRef.current?.value.trim();
    if (value) {
      props.onRename(id, value);
    }
    setEditingId(null);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">
          {t("sidebar.title")}{" "}
          <span className="sidebar-count">{props.workspaces.length}</span>
        </span>
        <button
          type="button"
          className="icon-button"
          title={t("sidebar.newWorkspace")}
          aria-label={t("sidebar.newWorkspace")}
          onClick={props.onCreate}
        >
          <PlusIcon />
        </button>
      </div>
      <ul className="workspace-list">
        {props.workspaces.map((workspace) => (
          <li
            key={workspace.id}
            className={`workspace-item ${
              workspace.id === props.activeId ? "is-active" : ""
            }`}
            onClick={() => props.onSelect(workspace.id)}
            onDoubleClick={() => setEditingId(workspace.id)}
          >
            <span className="workspace-accent" />
            <TerminalGlyphIcon className="workspace-icon" />
            {editingId === workspace.id ? (
              <input
                ref={inputRef}
                className="workspace-rename-input"
                defaultValue={workspace.name}
                aria-label={t("sidebar.renameWorkspace")}
                onClick={(event) => event.stopPropagation()}
                onBlur={() => commitRename(workspace.id)}
                onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    commitRename(workspace.id);
                  } else if (event.key === "Escape") {
                    setEditingId(null);
                  }
                }}
              />
            ) : (
              <span
                className="workspace-name"
                title={workspace.folder ?? t("sidebar.homeFolder")}
              >
                {workspace.name}
              </span>
            )}
            {workspace.count > 0 && (
              <span className="workspace-badge">{workspace.count}</span>
            )}
            <button
              type="button"
              className="workspace-delete"
              title={t("sidebar.deleteWorkspace")}
              aria-label={t("sidebar.deleteWorkspace")}
              onClick={(event) => {
                event.stopPropagation();
                props.onDelete(workspace.id);
              }}
            >
              <CloseIcon width={11} height={11} />
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
