import { PlusIcon, TerminalGlyphIcon } from "./Icons";

type SidebarProps = {
  workspaceName: string;
  terminalCount: number;
};

export function Sidebar(props: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">
          Workspaces <span className="sidebar-count">1</span>
        </span>
        <button
          type="button"
          className="icon-button is-disabled"
          title="Несколько воркспейсов — скоро"
        >
          <PlusIcon />
        </button>
      </div>
      <ul className="workspace-list">
        <li className="workspace-item is-active">
          <span className="workspace-accent" />
          <TerminalGlyphIcon className="workspace-icon" />
          <span className="workspace-name">{props.workspaceName}</span>
          {props.terminalCount > 0 && (
            <span className="workspace-badge">{props.terminalCount}</span>
          )}
        </li>
      </ul>
    </aside>
  );
}
