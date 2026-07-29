import { describe, expect, it } from "vitest";
import { agentHookAlert } from "./agentHookEvent";

const hook = (event: string, message = "", agent = "codex") => ({
  panelId: "panel-1",
  agent,
  event,
  message,
});

describe("agentHookAlert", () => {
  it("reads a finished codex turn together with its message", () => {
    const alert = agentHookAlert(
      hook("agent-turn-complete", "Готово: обновил три файла"),
    );

    expect(alert?.kind).toBe("completed");
    expect(alert?.notification).toEqual({
      protocol: "hook",
      title: "",
      body: "Готово: обновил три файла",
      types: ["agent-turn-complete"],
    });
  });

  it("treats an approval request as a permission signal even without text", () => {
    expect(agentHookAlert(hook("approval-requested"))?.kind).toBe("permission");
  });

  it("prefers the message over the event name", () => {
    // У Claude Code один хук Notification на все поводы — что именно
    // случилось, написано в тексте.
    expect(
      agentHookAlert(
        hook("Notification", "Claude needs your permission to run Bash", "claude"),
      )?.kind,
    ).toBe("permission");

    expect(
      agentHookAlert(hook("Notification", "Waiting for your input", "claude"))
        ?.kind,
    ).toBe("question");
  });

  it("understands the opencode and copilot event names", () => {
    expect(agentHookAlert(hook("session.idle", "", "opencode"))?.kind).toBe(
      "completed",
    );
    expect(agentHookAlert(hook("permission.asked", "", "opencode"))?.kind).toBe(
      "permission",
    );
    expect(
      agentHookAlert(hook("permission_prompt", "", "copilot"))?.kind,
    ).toBe("permission");
  });

  it("falls back to waiting for an unknown event", () => {
    expect(agentHookAlert(hook("something-new", "", "newcli"))?.kind).toBe(
      "waiting",
    );
  });

  it("ignores an event without a panel", () => {
    expect(
      agentHookAlert({ panelId: "", agent: "codex", event: "stop", message: "" }),
    ).toBeNull();
  });
});
