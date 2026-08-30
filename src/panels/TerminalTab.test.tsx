import { act, render } from "@testing-library/react";
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

// Точек-картинок на вкладке теперь две — состояние терминала и значок
// файла; берём именно ту, что про терминал.
function dot() {
  const found = document.querySelector(".tab-dot");
  if (!found) {
    throw new Error("точки состояния на вкладке нет");
  }
  return found;
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
async function editingFiles(id: string, held: string[], awaited = false) {
  await act(async () => {
    setPanelClaims(new Map([[id, { held, waitingFor: null, awaited }]]));
  });
}

describe("terminal tab claim state", () => {
  it("marks the tab when the agent is stuck on a busy file", async () => {
    const id = panel("blocked-1");
    render(<TerminalTab {...headerProps(id)} />);

    await act(async () => {
      setPanelClaims(
        new Map([
          [id, { held: [], waitingFor: "/w/чужое.rs", awaited: false }],
        ]),
      );
    });

    // Что панель правит, показывает подпись справа. На вкладке остаётся
    // только остановка: её видно у всех панелей сразу, не переключаясь.
    expect(dot().className).toContain("is-blocked");
  });

  it("stays plain while the agent just works", async () => {
    const id = panel("holding-1");
    render(<TerminalTab {...headerProps(id)} />);

    await editingFiles(id, ["/w/src/auth.rs"]);

    // Правка — обычная работа, вкладке сказать нечего.
    expect(dot().className).toContain("is-running");
  });

  it("leaves another panel alone", async () => {
    const id = panel("blocked-2");
    render(<TerminalTab {...headerProps(id)} />);

    await act(async () => {
      setPanelClaims(
        new Map([
          ["другая", { held: [], waitingFor: "/w/чужое.rs", awaited: false }],
        ]),
      );
    });

    expect(dot().className).toContain("is-running");
  });
});

describe("what the tab glyph says about the panel", () => {
  it("tells a panel with an agent from a bare shell", () => {
    const agent = render(<TerminalTab {...headerProps(panel("glyph-agent"))} />);
    // Панель без записи об агенте: watcher видел там только оболочку.
    used.push("glyph-shell");
    const shell = render(<TerminalTab {...headerProps("glyph-shell")} />);

    expect(agent.container.querySelector(".tab-glyph")).toHaveClass("is-agent");
    expect(shell.container.querySelector(".tab-glyph")).toHaveClass("is-shell");
  });

  it("keeps the glyph out of the reading order", () => {
    const { container } = render(
      <TerminalTab {...headerProps(panel("glyph-silent"))} />,
    );

    // Что за агент, уже сказано именем панели рядом; второй раз — лишнее.
    expect(container.querySelector(".tab-glyph")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
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
