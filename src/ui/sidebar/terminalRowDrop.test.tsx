import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { Sidebar, type WorkspaceItem } from "../Sidebar";
import type { TerminalRowDrop } from "./terminalRowDrop";

// Два проекта: в первом, открытом, две сессии, во втором — одна.
const workspaces: WorkspaceItem[] = [
  {
    id: "w1",
    name: "modelcrew-desktop",
    folder: "/projects/desktop",
    count: 3,
    sessions: [
      { id: "s1", name: "fern-ember", count: 3, isActive: true },
      { id: "s2", name: "amber-lynx", count: 0, isActive: false },
    ],
  },
  {
    id: "w2",
    name: "modelcrew.com",
    folder: "/projects/site",
    count: 1,
    sessions: [{ id: "t1", name: "quiet-heron", count: 1, isActive: false }],
  },
];

function sidebar(dragged: string | null = "panel-1") {
  const drop = vi.fn();
  const terminalDrop: TerminalRowDrop = {
    dragged: () => dragged,
    verdict: (workspaceId, sessionId) =>
      workspaceId !== "w1" ? "foreign" : sessionId === "s2" ? "move" : "here",
    drop,
  };
  render(
    <Sidebar
      workspaces={workspaces}
      activeId="w1"
      onSelectWorkspace={vi.fn()}
      onSelectSession={vi.fn()}
      onCreateProject={vi.fn()}
      onCreateSession={vi.fn()}
      onCreateTerminal={vi.fn()}
      onRenameWorkspace={vi.fn()}
      onDeleteWorkspace={vi.fn()}
      onRenameSession={vi.fn()}
      onDeleteSession={vi.fn()}
      terminalDrop={terminalDrop}
    />,
  );
  return { drop };
}

function row(name: string): HTMLElement {
  const button = screen.getByRole("button", {
    name: new RegExp(`^${name},`),
    hidden: true,
  });
  return button.closest<HTMLElement>(".session-item, .workspace-item")!;
}

// fireEvent отвечает false, когда событие отменили — то есть строка
// согласилась принять перетаскиваемое.
function dragOver(element: HTMLElement): boolean {
  return !fireEvent.dragOver(element, { dataTransfer: { dropEffect: "none" } });
}

beforeEach(() => {
  setLocale("ru");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dragging a terminal by its header onto the sidebar", () => {
  it("moves it to another session of its project", () => {
    const { drop } = sidebar();
    const target = row("amber-lynx");

    expect(dragOver(target)).toBe(true);
    expect(target).toHaveClass("is-terminal-drop");

    fireEvent.drop(target, { dataTransfer: {} });
    expect(target).not.toHaveClass("is-terminal-drop");
    // Панель уберут после того, как dockview закончит своё перетаскивание.
    expect(drop).not.toHaveBeenCalled();
    act(() => vi.runAllTimers());
    expect(drop).toHaveBeenCalledWith("panel-1", "w1", "s2");
  });

  it("marks a session of another project as off limits", () => {
    const { drop } = sidebar();
    const foreign = row("quiet-heron");

    // Отпустить можно — приложение объяснит, почему терминал остался.
    expect(dragOver(foreign)).toBe(true);
    expect(foreign).toHaveClass("is-terminal-drop-refused");
    expect(row("modelcrew.com").getAttribute("data-terminal-drop")).toBe(
      "workspace",
    );

    fireEvent.drop(foreign, { dataTransfer: {} });
    act(() => vi.runAllTimers());
    expect(drop).toHaveBeenCalledWith("panel-1", "w2", "t1");
  });

  it("ignores the drag over the session the terminal is already in", () => {
    sidebar();
    const own = row("fern-ember");

    expect(dragOver(own)).toBe(false);
    expect(own).not.toHaveClass("is-terminal-drop");
    expect(own).not.toHaveClass("is-terminal-drop-refused");
  });

  it("ignores anything that is not a terminal", () => {
    const { drop } = sidebar(null);
    const target = row("amber-lynx");

    expect(dragOver(target)).toBe(false);
    expect(target).not.toHaveClass("is-terminal-drop");
    fireEvent.drop(target, { dataTransfer: {} });
    act(() => vi.runAllTimers());
    expect(drop).not.toHaveBeenCalled();
  });

  it("drops the highlight when the drag ends elsewhere", () => {
    sidebar();
    const target = row("amber-lynx");

    dragOver(target);
    expect(target).toHaveClass("is-terminal-drop");

    fireEvent.dragEnd(window);
    expect(target).not.toHaveClass("is-terminal-drop");
  });
});
