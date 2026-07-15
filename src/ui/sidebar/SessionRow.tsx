import { type KeyboardEvent, type Ref } from "react";
import { MoreIcon, PlusIcon, TerminalGlyphIcon } from "../Icons";
import { formatTerminalCount, useI18n } from "../../i18n";
import { SidebarMenu } from "./SidebarMenu";
import { sameTarget, type EditingTarget, type MenuTarget } from "./targets";

export type SessionNavItem = {
  id: string;
  name: string;
  count: number;
  isActive: boolean;
};

type SessionRowProps = {
  workspaceId: string;
  session: SessionNavItem;
  // Сессии свёрнутого проекта не участвуют в табуляции.
  isExpanded: boolean;
  isWorkspaceActive: boolean;
  editing: EditingTarget | null;
  openMenu: MenuTarget | null;
  inputRef: Ref<HTMLInputElement>;
  menuRef: Ref<HTMLDivElement>;
  activeSessionRef: Ref<HTMLDivElement>;
  onSelect: (workspaceId: string, sessionId: string) => void;
  onCreateTerminal: (workspaceId: string, sessionId: string) => void;
  onDelete: (workspaceId: string, sessionId: string) => void;
  onBeginRename: (target: EditingTarget) => void;
  onCommitRename: (target: EditingTarget) => void;
  onRenameKeyDown: (
    event: KeyboardEvent<HTMLInputElement>,
    target: EditingTarget,
  ) => void;
  onToggleMenu: (target: MenuTarget, trigger: HTMLButtonElement) => void;
  onCloseMenu: (restoreFocus: boolean) => void;
};

export function SessionRow(props: SessionRowProps) {
  const { locale, t } = useI18n();
  const { session, workspaceId, isExpanded } = props;
  const sessionTarget: EditingTarget = {
    kind: "session",
    workspaceId,
    sessionId: session.id,
  };

  return (
    <li className="session-node">
      <div
        ref={
          props.isWorkspaceActive && session.isActive
            ? props.activeSessionRef
            : undefined
        }
        className={`session-item ${session.isActive ? "is-active" : ""}`}
      >
        {sameTarget(props.editing, sessionTarget) ? (
          <div className="session-main is-editing">
            <TerminalGlyphIcon className="session-icon" />
            <input
              ref={props.inputRef}
              className="session-rename-input"
              defaultValue={session.name}
              aria-label={t("sidebar.renameSession")}
              onBlur={() => props.onCommitRename(sessionTarget)}
              onKeyDown={(event) => props.onRenameKeyDown(event, sessionTarget)}
            />
          </div>
        ) : (
          <button
            type="button"
            className="session-main"
            tabIndex={isExpanded ? 0 : -1}
            title={session.name}
            aria-current={session.isActive ? "page" : undefined}
            aria-label={`${session.name}, ${formatTerminalCount(session.count, locale)}`}
            onClick={() => props.onSelect(workspaceId, session.id)}
            onDoubleClick={() => props.onBeginRename(sessionTarget)}
          >
            <TerminalGlyphIcon className="session-icon" />
            <span className="session-name">{session.name}</span>
          </button>
        )}

        <span className="session-badge" aria-hidden="true">
          {session.count}
        </span>
        <div className="session-row-actions">
          <button
            type="button"
            className="sidebar-row-action"
            tabIndex={isExpanded ? 0 : -1}
            title={t("sidebar.newTerminalIn", { name: session.name })}
            aria-label={t("sidebar.newTerminalIn", { name: session.name })}
            onClick={() => props.onCreateTerminal(workspaceId, session.id)}
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            className="sidebar-row-action sidebar-more"
            tabIndex={isExpanded ? 0 : -1}
            title={t("sidebar.sessionActions", { name: session.name })}
            aria-label={t("sidebar.sessionActions", { name: session.name })}
            aria-haspopup="menu"
            aria-expanded={sameTarget(props.openMenu, sessionTarget)}
            onClick={(event) =>
              props.onToggleMenu(sessionTarget, event.currentTarget)
            }
          >
            <MoreIcon />
          </button>
        </div>

        {sameTarget(props.openMenu, sessionTarget) && (
          <SidebarMenu
            menuRef={props.menuRef}
            renameLabel={t("sidebar.renameSession")}
            deleteLabel={t("sidebar.deleteSession")}
            onRename={() => props.onBeginRename(sessionTarget)}
            onDelete={() => {
              props.onCloseMenu(false);
              props.onDelete(workspaceId, session.id);
            }}
            onClose={props.onCloseMenu}
          />
        )}
      </div>
    </li>
  );
}
