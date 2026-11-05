import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import {
  DockviewComponent,
  type DockviewApi,
  type SerializedDockview,
} from "dockview";
import { MAX_TERMINALS } from "../constants";
import {
  createTerminalSession,
  loadWorkspacesState,
  saveWorkspacesState,
  type TerminalSession,
  type Workspace,
  type WorkspacesState,
} from "../persist";
import { placeArrivingPanels } from "../layoutOps";
import { arrivingPanels, terminalDropVerdict } from "./terminalMove";
import { useWorkspaces } from "./useWorkspaces";

// Корни регистрирует Rust; без него хук считает их готовыми сразу.
vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  isTauri: false,
}));
vi.mock("../terminal/registry", () => ({
  destroyTerminal: vi.fn(),
  isManualTitle: () => false,
  acknowledgeTerminalPanel: vi.fn(),
}));

// Сетке dockview этого хватает: размер ей задаём сами. Нужен он уже при
// сборе тестов — раскладки для них строит настоящая сетка.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeEach(() => {
  localStorage.clear();
});

// Настоящая сетка dockview, только панели в ней пустые: терминалу здесь
// жить незачем, важно, где стоит его панель.
function grid(width = 1200, height = 800): DockviewApi {
  const host = document.createElement("div");
  document.body.append(host);
  const dockview = new DockviewComponent(host, {
    createComponent: () => ({
      element: document.createElement("div"),
      init: () => {},
    }),
  });
  dockview.layout(width, height);
  return dockview.api;
}

function layoutOf(
  workspaceId: string,
  sessionId: string,
  ids: string[],
): SerializedDockview {
  const api = grid();
  for (const id of ids) {
    api.addPanel({
      id,
      component: "terminal",
      title: id,
      params: { workspaceId, sessionId, titleKind: "process" },
      ...(api.panels.length > 0 ? { position: { direction: "right" } } : {}),
    });
  }
  return api.toJSON();
}

function session(
  workspaceId: string,
  sessionId: string,
  ids: string[] | null,
): TerminalSession {
  return createTerminalSession(
    workspaceId,
    sessionId,
    1,
    ids ? layoutOf(workspaceId, sessionId, ids) : null,
    0,
  );
}

function project(id: string, sessions: TerminalSession[]): Workspace {
  return {
    id,
    displayName: id,
    nameMode: "folder",
    folder: {
      selectedPath: `/projects/${id}`,
      canonicalPath: `/projects/${id}`,
      identityKey: null,
    },
    sessions,
    activeSessionId: sessions[0].id,
    createdAt: 0,
    lastOpenedAt: 0,
  };
}

// Приложение в разрезе: состояние проектов, сетка с активной сессией и
// хук, который ими управляет. Панели, закрытые не на время перестройки, —
// это убитые процессы; их собираем, как собирает App.
function app(list: Workspace[]) {
  saveWorkspacesState({ list, activeId: list[0].id });
  const api = grid();
  const apiRef: MutableRefObject<DockviewApi | null> = { current: api };
  const suppressCleanupRef = { current: false };
  const killed: string[] = [];
  api.onDidRemovePanel((panel) => {
    if (!suppressCleanupRef.current) {
      killed.push(panel.id);
    }
  });
  const { result } = renderHook(() =>
    useWorkspaces({
      apiRef,
      suppressCleanupRef,
      setTerminalCount: vi.fn(),
      showToast: vi.fn(),
      locale: "ru",
    }),
  );
  api.fromJSON(list[0].sessions[0].layout!);
  const sessionOf = (workspaceId: string, sessionId: string) =>
    result.current.workspacesRef.current.list
      .find((workspace) => workspace.id === workspaceId)!
      .sessions.find((item) => item.id === sessionId)!;
  return {
    api,
    result,
    killed,
    suppressCleanupRef,
    sessionOf,
    onScreen: () => api.panels.map((panel) => panel.id).sort(),
  };
}

describe("moving a terminal to another session", () => {
  it("carries it to a session of the same project without stopping it", () => {
    const { api, result, killed, suppressCleanupRef, sessionOf, onScreen } =
      app([
        project("w1", [session("w1", "s1", ["a", "b"]), session("w1", "s2", ["c"])]),
      ]);

    let verdict = "";
    act(() => {
      verdict = result.current.moveTerminalToSession("b", "w1", "s2");
    });

    expect(verdict).toBe("move");
    // С экрана ушла, но процесс жив: панель убрали не закрытием.
    expect(onScreen()).toEqual(["a"]);
    expect(killed).toEqual([]);
    expect(suppressCleanupRef.current).toBe(false);
    // Мы остались в своей сессии, а терминал числится уже за другой.
    expect(sessionOf("w1", "s2").layout!.panels.b.params).toMatchObject({
      workspaceId: "w1",
      sessionId: "s2",
    });
    const workspace = result.current.workspacesRef.current.list[0];
    expect(workspace.activeSessionId).toBe("s1");
    expect(result.current.sessionPanelCount(workspace, sessionOf("w1", "s2"))).toBe(2);
    expect(result.current.sessionPanelCount(workspace, sessionOf("w1", "s1"))).toBe(1);
    expect(api.panels).toHaveLength(1);
  });

  it("puts the terminal into the grid once its new session is opened", () => {
    const { result, killed, sessionOf, onScreen } = app([
      project("w1", [session("w1", "s1", ["a", "b"]), session("w1", "s2", ["c"])]),
    ]);

    act(() => {
      result.current.moveTerminalToSession("b", "w1", "s2");
    });
    act(() => result.current.selectSession("w1", "s2"));

    expect(onScreen()).toEqual(["b", "c"]);
    // И обратно: в старой сессии его больше нет, в новой он стоит в сетке.
    act(() => result.current.selectSession("w1", "s1"));
    expect(onScreen()).toEqual(["a"]);
    expect(arrivingPanels(sessionOf("w1", "s2").layout)).toEqual([]);
    expect(Object.keys(sessionOf("w1", "s2").layout!.panels).sort()).toEqual([
      "b",
      "c",
    ]);
    expect(killed).toEqual([]);
  });

  it("takes the last terminal away and fills a session that was never saved", () => {
    const { result, sessionOf, onScreen } = app([
      project("w1", [session("w1", "s1", ["a"]), session("w1", "s2", null)]),
    ]);

    act(() => {
      result.current.moveTerminalToSession("a", "w1", "s2");
    });
    expect(onScreen()).toEqual([]);

    act(() => result.current.selectSession("w1", "s2"));
    // Только он: пустую сессию при открытии не заполняют новым терминалом,
    // раз в ней уже есть перенесённый.
    expect(onScreen()).toEqual(["a"]);
    expect(sessionOf("w1", "s2").layout!.panels.a.params?.sessionId).toBe("s2");
  });

  it("keeps a moved terminal through a restart before its session is opened", () => {
    const { result } = app([
      project("w1", [session("w1", "s1", ["a", "b"]), session("w1", "s2", ["c"])]),
    ]);

    act(() => {
      result.current.moveTerminalToSession("b", "w1", "s2");
    });
    act(() => result.current.persistNow());

    const restored = loadWorkspacesState()!;
    const [s1, s2] = restored.list[0].sessions;
    expect(Object.keys(s1.layout!.panels)).toEqual(["a"]);
    expect(arrivingPanels(s2.layout).map((panel) => panel.id)).toEqual(["b"]);
  });

  it("refuses to carry a terminal into another project", () => {
    const { result, onScreen } = app([
      project("w1", [session("w1", "s1", ["a", "b"])]),
      project("w2", [session("w2", "t1", ["x"])]),
    ]);

    let verdict = "";
    act(() => {
      verdict = result.current.moveTerminalToSession("b", "w2", "t1");
    });

    expect(verdict).toBe("foreign");
    expect(onScreen()).toEqual(["a", "b"]);
    expect(
      Object.keys(result.current.workspacesRef.current.list[1].sessions[0].layout!.panels),
    ).toEqual(["x"]);
  });

  it("leaves a full session alone", () => {
    const full = Array.from({ length: MAX_TERMINALS }, (_, index) => `t${index}`);
    const { result, onScreen } = app([
      project("w1", [session("w1", "s1", ["a"]), session("w1", "s2", full)]),
    ]);

    let verdict = "";
    act(() => {
      verdict = result.current.moveTerminalToSession("a", "w1", "s2");
    });

    expect(verdict).toBe("full");
    expect(onScreen()).toEqual(["a"]);
  });
});

describe("where a terminal may be dropped", () => {
  const state: WorkspacesState = {
    activeId: "w1",
    list: [
      project("w1", [session("w1", "s1", ["a"]), session("w1", "s2", null)]),
      project("w2", [session("w2", "t1", null)]),
    ],
  };

  it("moves only between sessions of the project on screen", () => {
    expect(terminalDropVerdict(state, "w1", "s2")).toBe("move");
    expect(terminalDropVerdict(state, "w2", "t1")).toBe("foreign");
    // Строка чужого проекта — тоже отказ, а не тишина.
    expect(terminalDropVerdict(state, "w2", null)).toBe("foreign");
  });

  it("does nothing over its own session or its own project", () => {
    expect(terminalDropVerdict(state, "w1", "s1")).toBe("here");
    expect(terminalDropVerdict(state, "w1", null)).toBe("here");
    expect(terminalDropVerdict(state, "w1", "gone")).toBe("here");
  });

  it("counts only terminals toward the limit", () => {
    const layout = layoutOf(
      "w1",
      "s2",
      Array.from({ length: MAX_TERMINALS - 1 }, (_, index) => `t${index}`),
    );
    // Панель изменений из старых раскладок терминалом не считается.
    layout.panels["git-changes"] = { id: "git-changes", contentComponent: "git" };
    const crowded: WorkspacesState = {
      activeId: "w1",
      list: [
        project("w1", [
          session("w1", "s1", ["a"]),
          { ...session("w1", "s2", null), layout },
        ]),
      ],
    };
    expect(terminalDropVerdict(crowded, "w1", "s2")).toBe("move");
  });
});

describe("terminals waiting for a place in the grid", () => {
  it("are those the layout lists but its grid does not hold", () => {
    const layout = layoutOf("w1", "s1", ["a", "b"]);
    layout.panels.c = { id: "c", contentComponent: "terminal" };
    expect(arrivingPanels(layout).map((panel) => panel.id)).toEqual(["c"]);
    expect(arrivingPanels(null)).toEqual([]);
  });

  it("do not include panels of an old floating window", () => {
    const layout = layoutOf("w1", "s1", ["a"]);
    layout.panels.f = { id: "f", contentComponent: "terminal" };
    layout.floatingGroups = [
      {
        data: { id: "g9", views: ["f"], activeView: "f" },
        position: { left: 0, top: 0, width: 300, height: 200 },
      },
    ];
    expect(arrivingPanels(layout)).toEqual([]);
  });

  it("still get a place when the grid has no room left", () => {
    const api = grid(300, 200);
    api.addPanel({ id: "a", component: "terminal" });
    const layout = api.toJSON();
    layout.panels.b = { id: "b", contentComponent: "terminal", title: "codex" };

    expect(placeArrivingPanels(api, layout, "w1", "s1", "balanced")).toBe(1);
    expect(api.getPanel("b")?.title).toBe("codex");
    expect(api.getPanel("b")?.params).toMatchObject({
      workspaceId: "w1",
      sessionId: "s1",
    });
  });
});
