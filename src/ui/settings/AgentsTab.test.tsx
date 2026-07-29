import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { AgentsTab } from "./AgentsTab";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const CLAUDE_HOOK = {
  agent: "claude",
  supported: true,
  installed: false,
  config: "/Users/x/.claude/settings.json",
};

function respond(states: unknown[], onSet?: (args: unknown) => unknown) {
  invokeMock.mockImplementation(async (command: string, args: unknown) => {
    if (command === "agent_hook_status") return states;
    if (command === "agent_hook_set") {
      if (!onSet) throw new Error("нет прав");
      return onSet(args);
    }
    return null;
  });
}

beforeEach(() => {
  localStorage.clear();
  setLocale("ru");
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  invokeMock.mockReset();
});

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("agent hook switches", () => {
  it("offers a switch only for an agent we can actually connect", async () => {
    respond([
      CLAUDE_HOOK,
      { agent: "qwen", supported: false, installed: false, config: "" },
    ]);

    render(<AgentsTab />);

    await screen.findByRole("switch", { name: "Уведомления от Claude Code" });
    // У qwen канала нет — тумблер, который ничего не делает, хуже его отсутствия.
    expect(
      screen.queryByRole("switch", { name: /Qwen/u }),
    ).toBeNull();
  });

  it("names the file it is about to edit", async () => {
    respond([CLAUDE_HOOK]);

    render(<AgentsTab />);

    await screen.findByText(/\/Users\/x\/\.claude\/settings\.json/u);
  });

  it("turns the switch on only after the backend confirms", async () => {
    respond([CLAUDE_HOOK], () => ({ ...CLAUDE_HOOK, installed: true }));

    render(<AgentsTab />);
    const toggle = await screen.findByRole("switch", {
      name: "Уведомления от Claude Code",
    });
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(invokeMock).toHaveBeenCalledWith("agent_hook_set", {
      agent: "claude",
      enabled: true,
    });
  });

  it("keeps the switch off when the config could not be changed", async () => {
    respond([CLAUDE_HOOK]);

    render(<AgentsTab />);
    const toggle = await screen.findByRole("switch", {
      name: "Уведомления от Claude Code",
    });
    fireEvent.click(toggle);

    // «Подключено» там, где ничего не подключилось, — худшее из состояний.
    await screen.findByRole("alert");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
