import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ workspaceId: null as string | null }));

vi.mock("./registry", () => ({
  getTerminalWorkspaceId: () => mocks.workspaceId,
}));
vi.mock("./panelTitles", () => ({
  getAutoTitle: () => "claude",
}));

import { rememberAgentProcess } from "../agents";
import type { TerminalSession, Workspace } from "../persist";
import { describeWaitingPanel } from "./waitingPanels";

function session(id: string, name: string, panelIds: string[]): TerminalSession {
  return {
    id,
    displayName: name,
    generatedName: name,
    nameMode: "generated",
    defaultIndex: 1,
    createdAt: 0,
    layout:
      panelIds.length > 0
        ? {
            panels: Object.fromEntries(panelIds.map((panelId) => [panelId, {}])),
          }
        : null,
  } as unknown as TerminalSession;
}

function workspace(sessions: TerminalSession[], activeSessionId: string): Workspace {
  return {
    id: "ws-1",
    displayName: "ModelCrew",
    nameMode: "folder",
    folder: null,
    sessions,
    activeSessionId,
    createdAt: 0,
    lastOpenedAt: 0,
  };
}

const formatDefault = (index: number) => `Session ${index}`;

describe("who is waiting", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.workspaceId = "ws-1";
  });

  it("names the session of a panel opened since the last snapshot", () => {
    // Раскладка активной сессии в persist пишется снимком, а панели живут в
    // dockview: только что открытая в ней панель в сохранённой раскладке не
    // значится. Имя сессии пропадало ровно у таких панелей — то есть у тех,
    // ради различения которых его и показывают.
    rememberAgentProcess("fresh-panel", "claude");
    const workspaces = [
      workspace(
        [session("s-1", "Работа", []), session("s-2", "Старая", ["old-panel"])],
        "s-1",
      ),
    ];

    const described = describeWaitingPanel("fresh-panel", workspaces, formatDefault);

    expect(described.session).toBe("Работа");
    expect(described.project).toBe("ModelCrew");
    expect(described.agent).toBe("Claude Code");
  });

  it("keeps naming the saved session of a panel from a hidden one", () => {
    rememberAgentProcess("old-panel", "claude");
    const workspaces = [
      workspace(
        [session("s-1", "Работа", []), session("s-2", "Старая", ["old-panel"])],
        "s-1",
      ),
    ];

    expect(
      describeWaitingPanel("old-panel", workspaces, formatDefault).session,
    ).toBe("Старая");
  });

  it("leaves the session unnamed when the project is unknown", () => {
    mocks.workspaceId = null;
    const workspaces = [workspace([session("s-1", "Работа", [])], "s-1")];

    const described = describeWaitingPanel("stray", workspaces, formatDefault);

    expect(described.session).toBeNull();
    expect(described.project).toBeNull();
  });
});
