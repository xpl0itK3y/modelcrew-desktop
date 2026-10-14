import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_WORKSPACES } from "../constants";
import { setLocale } from "../i18n";
import { Sidebar, type WorkspaceItem } from "./Sidebar";

function projects(count: number): WorkspaceItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `workspace-${index}`,
    name: `project-${index}`,
    folder: `/projects/${index}`,
    count: 0,
    sessions: [],
  }));
}

function sidebar(count: number, onCreateProject = vi.fn()) {
  render(
    <Sidebar
      workspaces={projects(count)}
      activeId={null}
      onSelectWorkspace={vi.fn()}
      onSelectSession={vi.fn()}
      onCreateProject={onCreateProject}
      onCreateSession={vi.fn()}
      onCreateTerminal={vi.fn()}
      onRenameWorkspace={vi.fn()}
      onDeleteWorkspace={vi.fn()}
      onRenameSession={vi.fn()}
      onDeleteSession={vi.fn()}
    />,
  );
  return screen.getByRole("button", { name: "Новый проект" });
}

describe("new project button", () => {
  beforeEach(() => {
    setLocale("ru");
  });

  it("stays live while there is room for another project", () => {
    const button = sidebar(MAX_WORKSPACES - 1);

    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).toHaveAttribute("title", "Новый проект");
  });

  it("dims at the limit and says why on hover", () => {
    const onCreateProject = vi.fn();
    const button = sidebar(MAX_WORKSPACES, onCreateProject);

    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button.getAttribute("title")).toContain(String(MAX_WORKSPACES));

    // Нажатие доходит до приложения: оно и объяснит тостом, почему нельзя.
    fireEvent.click(button);
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });
});
