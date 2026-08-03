import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IDockviewPanelHeaderProps } from "dockview";
import { setLocale } from "../i18n";

vi.mock("../terminal/registry", () => ({
  getTerminalStatus: () => "running" as const,
  markManualTitle: vi.fn(),
  onTerminalStatus: () => () => {},
}));

import { raiseAgentAlert } from "../terminal/agentAlerts";
import { resetAgentAlertBurst } from "../terminal/alertDelivery";
import { clearAgentAttention } from "../terminal/attentionStore";
import { clearPanelClaims, setPanelClaims } from "../crew/claimStore";
import { rememberAgentProcess } from "../agents";
import { TerminalTab } from "./TerminalTab";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => false }),
}));
vi.mock("../sound", () => ({ playNotificationSound: vi.fn() }));
vi.mock("../notifications", () => ({
  sendSystemNotification: vi.fn(async () => {}),
}));

// Панель у каждого теста своя: повторный сигнал той же попал бы в окно тишины
// предыдущего теста и внимания уже не поднял.
const used: string[] = [];

function panel(id: string) {
  used.push(id);
  rememberAgentProcess(id, "claude");
  return id;
}

// Шапка дёргает у dockview только id, заголовок и подписку на него.
function headerProps(id: string): IDockviewPanelHeaderProps {
  return {
    api: {
      id,
      title: "claude",
      onDidTitleChange: () => ({ dispose: () => {} }),
      setTitle: vi.fn(),
      getParameters: () => ({}),
      updateParameters: vi.fn(),
    },
  } as unknown as IDockviewPanelHeaderProps;
}

function dot() {
  return screen.getByRole("img");
}

// Внимание меняется во внешнем хранилище, мимо событий React: без act
// перерисовка не успевает к проверке.
async function alert(id: string) {
  await act(async () => {
    await raiseAgentAlert(id, "permission", {
      visible: false,
      focused: false,
      workspaceId: "ws-1",
    });
  });
}

beforeEach(() => {
  localStorage.clear();
  setLocale("ru");
  resetAgentAlertBurst();
});

afterEach(() => {
  for (const id of used.splice(0)) {
    clearAgentAttention(id);
  }
  resetAgentAlertBurst();
  clearPanelClaims();
});

// Заявки живут во внешнем хранилище, мимо событий React.
async function blockOn(id: string, path: string) {
  await act(async () => {
    setPanelClaims(
      new Map([[id, { held: [], waitingFor: path, awaited: false }]]),
    );
  });
}

describe("terminal tab claim state", () => {
  it("shows on the tab which file the panel is stuck on", async () => {
    const id = panel("blocked-1");
    render(<TerminalTab {...headerProps(id)} />);

    await blockOn(id, "/w/src/сервер.rs");

    // Подпись в шапке группы показывает только выбранную панель — застрявшего
    // соседа за ней не видно, поэтому признак нужен на самой вкладке.
    expect(screen.getByText("сервер.rs")).toBeInTheDocument();
    expect(dot().className).toContain("is-blocked");
  });

  it("keeps a call for the user above a busy file", async () => {
    const id = panel("blocked-2");
    render(<TerminalTab {...headerProps(id)} />);
    await blockOn(id, "/w/занят.rs");

    await alert(id);

    // Ожидание человека важнее: занятый файл разойдётся сам, а тут ход
    // закончен и без ответа ничего не сдвинется.
    expect(dot().className).toContain("is-waiting");
  });

  it("goes back to plain running once the file is free", async () => {
    const id = panel("blocked-3");
    render(<TerminalTab {...headerProps(id)} />);
    await blockOn(id, "/w/занят.rs");

    await act(async () => setPanelClaims(new Map()));

    expect(screen.queryByText("занят.rs")).not.toBeInTheDocument();
    expect(dot().className).toContain("is-running");
  });

  it("leaves another panel alone", async () => {
    const id = panel("blocked-4");
    render(<TerminalTab {...headerProps(id)} />);

    await blockOn("другая-панель", "/w/чужой.rs");

    expect(screen.queryByText("чужой.rs")).not.toBeInTheDocument();
    expect(dot().className).toContain("is-running");
  });
});

describe("terminal tab attention dot", () => {
  it("marks the panel the notification came from", async () => {
    const id = panel("marks-panel");
    render(<TerminalTab {...headerProps(id)} />);
    expect(dot()).toHaveClass("is-running");

    await alert(id);

    // Уведомление одно на всех — по точке видно, какая панель зовёт.
    expect(dot()).toHaveClass("is-waiting");
    expect(dot()).toHaveAccessibleName("Агент ждёт ответа");
  });

  it("goes quiet once the panel is acknowledged", async () => {
    const id = panel("quiet-panel");
    render(<TerminalTab {...headerProps(id)} />);
    await alert(id);
    expect(dot()).toHaveClass("is-waiting");

    act(() => clearAgentAttention(id));

    expect(dot()).toHaveClass("is-running");
  });

  it("ignores another panel waiting for an answer", async () => {
    const id = panel("bystander-panel");
    render(<TerminalTab {...headerProps(id)} />);

    await alert(panel("caller-panel"));

    expect(dot()).toHaveClass("is-running");
  });
});
