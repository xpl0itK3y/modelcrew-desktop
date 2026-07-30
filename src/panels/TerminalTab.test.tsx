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
