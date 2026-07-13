import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { ChevronRightIcon, FolderIcon, MoreIcon, PlusIcon } from "./Icons";
import { formatTerminalCount, useI18n } from "../i18n";

export type SessionNavItem = {
  id: string;
  name: string;
  count: number;
  isActive: boolean;
};

export type WorkspaceItem = {
  id: string;
  name: string;
  folder: string | null;
  count: number;
  sessions: SessionNavItem[];
};

type SidebarProps = {
  workspaces: WorkspaceItem[];
  activeId: string | null;
  onSelectWorkspace: (id: string) => void;
  onSelectSession: (workspaceId: string, sessionId: string) => void;
  onCreateProject: () => void;
  onCreateSession: (workspaceId: string) => void;
  onCreateTerminal: (workspaceId: string, sessionId: string) => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onDeleteWorkspace: (id: string) => void;
  onRenameSession: (
    workspaceId: string,
    sessionId: string,
    name: string,
  ) => void;
  onDeleteSession: (workspaceId: string, sessionId: string) => void;
};

type EditingTarget =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "session"; workspaceId: string; sessionId: string };

type MenuTarget = EditingTarget;

function sameTarget(left: EditingTarget | null, right: EditingTarget): boolean {
  if (
    !left ||
    left.kind !== right.kind ||
    left.workspaceId !== right.workspaceId
  ) {
    return false;
  }
  if (left.kind === "workspace") {
    return true;
  }
  return right.kind === "session" && left.sessionId === right.sessionId;
}

export function Sidebar(props: SidebarProps) {
  const { locale, t } = useI18n();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() =>
    props.activeId ? new Set([props.activeId]) : new Set(),
  );
  const [editing, setEditing] = useState<EditingTarget | null>(null);
  const [openMenu, setOpenMenu] = useState<MenuTarget | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const activeSessionRef = useRef<HTMLDivElement | null>(null);
  const cancelRenameRef = useRef(false);
  const activeWorkspace = props.workspaces.find(
    (workspace) => workspace.id === props.activeId,
  );
  const activeSession = activeWorkspace?.sessions.find(
    (session) => session.isActive,
  );
  const activeSessionKey =
    activeWorkspace && activeSession
      ? `${activeWorkspace.id}:${activeSession.id}`
      : undefined;
  const activeWorkspaceExpanded = props.activeId
    ? expandedIds.has(props.activeId)
    : false;

  const closeMenu = (restoreFocus = false) => {
    const trigger = menuTriggerRef.current;
    setOpenMenu(null);
    if (restoreFocus && trigger) {
      window.requestAnimationFrame(() => trigger.focus());
    }
  };

  useEffect(() => {
    if (!props.activeId) {
      return;
    }
    setExpandedIds((current) => {
      if (current.has(props.activeId!)) {
        return current;
      }
      const next = new Set(current);
      next.add(props.activeId!);
      return next;
    });
  }, [props.activeId]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (activeWorkspaceExpanded && activeSessionKey) {
      const item = activeSessionRef.current;
      const scroller = item?.closest<HTMLElement>(".workspace-list");
      if (!item || !scroller) {
        return;
      }
      const itemRect = item.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      if (itemRect.top < scrollerRect.top) {
        scroller.scrollTop -= scrollerRect.top - itemRect.top;
      } else if (itemRect.bottom > scrollerRect.bottom) {
        scroller.scrollTop += itemRect.bottom - scrollerRect.bottom;
      }
    }
  }, [activeSessionKey, activeWorkspaceExpanded]);

  useEffect(() => {
    if (!openMenu) {
      return;
    }
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Node) ||
        menuRef.current?.contains(target) ||
        (target instanceof Element && target.closest(".sidebar-more"))
      ) {
        return;
      }
      setOpenMenu(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu(true);
      }
    };
    document.addEventListener("pointerdown", closeOnPointerDown, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  const toggleWorkspace = (workspaceId: string) => {
    if (expandedIds.has(workspaceId)) {
      if (
        openMenu?.kind === "session" &&
        openMenu.workspaceId === workspaceId
      ) {
        setOpenMenu(null);
      }
      if (editing?.kind === "session" && editing.workspaceId === workspaceId) {
        setEditing(null);
      }
    }
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  };

  const beginRename = (target: EditingTarget) => {
    cancelRenameRef.current = false;
    setOpenMenu(null);
    setEditing(target);
  };

  const commitRename = (target: EditingTarget) => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      setEditing(null);
      return;
    }
    const value = inputRef.current?.value.trim();
    if (value) {
      if (target.kind === "workspace") {
        props.onRenameWorkspace(target.workspaceId, value);
      } else {
        props.onRenameSession(target.workspaceId, target.sessionId, value);
      }
    }
    setEditing(null);
  };

  const renameKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    target: EditingTarget,
  ) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      commitRename(target);
    } else if (event.key === "Escape") {
      cancelRenameRef.current = true;
      setEditing(null);
    }
  };

  const toggleMenu = (
    target: MenuTarget,
    trigger: HTMLButtonElement,
  ) => {
    menuTriggerRef.current = trigger;
    setOpenMenu((current) => (sameTarget(current, target) ? null : target));
  };

  const menuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      closeMenu();
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ),
    );
    if (items.length === 0) {
      return;
    }
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowUp"
            ? (currentIndex - 1 + items.length) % items.length
            : (currentIndex + 1) % items.length;
    event.preventDefault();
    event.stopPropagation();
    items[nextIndex]?.focus();
  };

  return (
    <aside className="sidebar" aria-label={t("sidebar.title")}>
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
          onClick={props.onCreateProject}
        >
          <PlusIcon />
        </button>
      </div>

      <ul className="workspace-list">
        {props.workspaces.map((workspace) => {
          const isActive = workspace.id === props.activeId;
          const isExpanded = expandedIds.has(workspace.id);
          const workspaceTarget: EditingTarget = {
            kind: "workspace",
            workspaceId: workspace.id,
          };
          const sessionsId = `workspace-sessions-${workspace.id}`;

          return (
            <li key={workspace.id} className="workspace-node">
              <div className={`workspace-item ${isActive ? "is-active" : ""}`}>
                <span className="workspace-accent" />
                <button
                  type="button"
                  className="workspace-disclosure"
                  aria-expanded={isExpanded}
                  aria-controls={sessionsId}
                  aria-label={t(
                    isExpanded
                      ? "sidebar.collapseWorkspace"
                      : "sidebar.expandWorkspace",
                    { name: workspace.name },
                  )}
                  title={t(
                    isExpanded
                      ? "sidebar.collapseWorkspace"
                      : "sidebar.expandWorkspace",
                    { name: workspace.name },
                  )}
                  onClick={() => toggleWorkspace(workspace.id)}
                >
                  <ChevronRightIcon
                    className={isExpanded ? "is-expanded" : ""}
                  />
                </button>

                {sameTarget(editing, workspaceTarget) ? (
                  <div className="workspace-main is-editing">
                    <FolderIcon className="workspace-icon" />
                    <input
                      ref={inputRef}
                      className="workspace-rename-input"
                      defaultValue={workspace.name}
                      aria-label={t("sidebar.renameWorkspace")}
                      onBlur={() => commitRename(workspaceTarget)}
                      onKeyDown={(event) =>
                        renameKeyDown(event, workspaceTarget)
                      }
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="workspace-main"
                    title={workspace.folder ?? t("sidebar.homeFolder")}
                    aria-current={isActive ? "page" : undefined}
                    aria-label={`${workspace.name}, ${formatTerminalCount(workspace.count, locale)}`}
                    onClick={() => props.onSelectWorkspace(workspace.id)}
                    onDoubleClick={() => beginRename(workspaceTarget)}
                  >
                    <FolderIcon className="workspace-icon" />
                    <span className="workspace-name">{workspace.name}</span>
                  </button>
                )}

                <span className="workspace-badge" aria-hidden="true">
                  {workspace.count}
                </span>
                <div className="workspace-row-actions">
                  <button
                    type="button"
                    className="sidebar-row-action"
                    title={t("sidebar.newSessionIn", { name: workspace.name })}
                    aria-label={t("sidebar.newSessionIn", {
                      name: workspace.name,
                    })}
                    onClick={() => {
                      setExpandedIds((current) =>
                        new Set(current).add(workspace.id),
                      );
                      props.onCreateSession(workspace.id);
                    }}
                  >
                    <PlusIcon />
                  </button>
                  <button
                    type="button"
                    className="sidebar-row-action sidebar-more"
                    title={t("sidebar.workspaceActions", {
                      name: workspace.name,
                    })}
                    aria-label={t("sidebar.workspaceActions", {
                      name: workspace.name,
                    })}
                    aria-haspopup="menu"
                    aria-expanded={sameTarget(openMenu, workspaceTarget)}
                    onClick={(event) =>
                      toggleMenu(workspaceTarget, event.currentTarget)
                    }
                  >
                    <MoreIcon />
                  </button>
                </div>

                {sameTarget(openMenu, workspaceTarget) && (
                  <div
                    ref={menuRef}
                    className="sidebar-menu"
                    role="menu"
                    onKeyDown={menuKeyDown}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => beginRename(workspaceTarget)}
                    >
                      {t("sidebar.renameWorkspace")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="is-danger"
                      onClick={() => {
                        setOpenMenu(null);
                        props.onDeleteWorkspace(workspace.id);
                      }}
                    >
                      {t("sidebar.deleteWorkspace")}
                    </button>
                  </div>
                )}
              </div>

              <div
                className={`session-list-shell ${isExpanded ? "is-expanded" : ""}`}
                aria-hidden={!isExpanded}
              >
                <div className="session-list-clip">
                  <ul id={sessionsId} className="session-list">
                    {workspace.sessions.map((session) => {
                      const sessionTarget: EditingTarget = {
                        kind: "session",
                        workspaceId: workspace.id,
                        sessionId: session.id,
                      };
                      return (
                        <li key={session.id} className="session-node">
                          <div
                            ref={
                              isActive && session.isActive
                                ? activeSessionRef
                                : undefined
                            }
                            className={`session-item ${session.isActive ? "is-active" : ""}`}
                          >
                            {sameTarget(editing, sessionTarget) ? (
                              <div className="session-main is-editing">
                                <FolderIcon className="session-icon" />
                                <input
                                  ref={inputRef}
                                  className="session-rename-input"
                                  defaultValue={session.name}
                                  aria-label={t("sidebar.renameSession")}
                                  onBlur={() => commitRename(sessionTarget)}
                                  onKeyDown={(event) =>
                                    renameKeyDown(event, sessionTarget)
                                  }
                                />
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="session-main"
                                tabIndex={isExpanded ? 0 : -1}
                                title={session.name}
                                aria-current={
                                  session.isActive ? "page" : undefined
                                }
                                aria-label={`${session.name}, ${formatTerminalCount(session.count, locale)}`}
                                onClick={() =>
                                  props.onSelectSession(
                                    workspace.id,
                                    session.id,
                                  )
                                }
                                onDoubleClick={() => beginRename(sessionTarget)}
                              >
                                <FolderIcon className="session-icon" />
                                <span className="session-name">
                                  {session.name}
                                </span>
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
                                title={t("sidebar.newTerminalIn", {
                                  name: session.name,
                                })}
                                aria-label={t("sidebar.newTerminalIn", {
                                  name: session.name,
                                })}
                                onClick={() =>
                                  props.onCreateTerminal(
                                    workspace.id,
                                    session.id,
                                  )
                                }
                              >
                                <PlusIcon />
                              </button>
                              <button
                                type="button"
                                className="sidebar-row-action sidebar-more"
                                tabIndex={isExpanded ? 0 : -1}
                                title={t("sidebar.sessionActions", {
                                  name: session.name,
                                })}
                                aria-label={t("sidebar.sessionActions", {
                                  name: session.name,
                                })}
                                aria-haspopup="menu"
                                aria-expanded={sameTarget(
                                  openMenu,
                                  sessionTarget,
                                )}
                                onClick={(event) =>
                                  toggleMenu(
                                    sessionTarget,
                                    event.currentTarget,
                                  )
                                }
                              >
                                <MoreIcon />
                              </button>
                            </div>

                            {sameTarget(openMenu, sessionTarget) && (
                              <div
                                ref={menuRef}
                                className="sidebar-menu"
                                role="menu"
                                onKeyDown={menuKeyDown}
                              >
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => beginRename(sessionTarget)}
                                >
                                  {t("sidebar.renameSession")}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="is-danger"
                                  onClick={() => {
                                    setOpenMenu(null);
                                    props.onDeleteSession(
                                      workspace.id,
                                      session.id,
                                    );
                                  }}
                                >
                                  {t("sidebar.deleteSession")}
                                </button>
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
