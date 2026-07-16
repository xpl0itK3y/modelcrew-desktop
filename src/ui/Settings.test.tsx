import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import { Settings } from "./Settings";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
}));

const { soundSuppressed } = vi.hoisted(() => ({
  soundSuppressed: vi.fn(() => false),
}));

vi.mock("../sound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sound")>();
  return {
    ...actual,
    isNotificationSoundSuppressed: () => soundSuppressed(),
  };
});

function renderSettings() {
  return render(
    <Settings
      themeId="midnight"
      accent="#4ade80"
      shell={null}
      shellBusy={false}
      terminalFontSize={14}
      onSelectTheme={vi.fn()}
      onSelectAccent={vi.fn()}
      onSelectShell={vi.fn()}
      onSelectTerminalFontSize={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

afterEach(() => setLocale("ru"));

describe("Settings tabs", () => {
  it("connects every tab to a stable labelled panel and uses roving tabindex", () => {
    renderSettings();

    const appearanceTab = screen.getByRole("tab", { name: "Внешний вид" });
    const terminalTab = screen.getByRole("tab", { name: "Терминал" });
    const notificationsTab = screen.getByRole("tab", {
      name: "Уведомления",
    });

    const tabPanelPairs = [
      [appearanceTab, "appearance"],
      [terminalTab, "terminal"],
      [notificationsTab, "notifications"],
    ] as const;

    for (const [tab, id] of tabPanelPairs) {
      expect(tab).toHaveAttribute("id", `settings-tab-${id}`);
      expect(tab).toHaveAttribute("aria-controls", `settings-panel-${id}`);

      const panel = document.getElementById(`settings-panel-${id}`);
      expect(panel).toHaveAttribute("role", "tabpanel");
      expect(panel).toHaveAttribute("aria-labelledby", `settings-tab-${id}`);
    }

    expect(appearanceTab).toHaveAttribute("aria-selected", "true");
    expect(appearanceTab).toHaveAttribute("tabindex", "0");
    expect(terminalTab).toHaveAttribute("tabindex", "-1");
    expect(notificationsTab).toHaveAttribute("tabindex", "-1");

    const appearancePanel = document.getElementById("settings-panel-appearance");
    const terminalPanel = document.getElementById("settings-panel-terminal");
    const notificationsPanel = document.getElementById(
      "settings-panel-notifications",
    );

    expect(appearancePanel).not.toHaveAttribute("hidden");
    expect(terminalPanel).toHaveAttribute("hidden");
    expect(notificationsPanel).toHaveAttribute("hidden");
  });

  it("switches and focuses tabs with arrow keys, including wraparound", () => {
    renderSettings();

    const appearanceTab = screen.getByRole("tab", { name: "Внешний вид" });
    const terminalTab = screen.getByRole("tab", { name: "Терминал" });
    const notificationsTab = screen.getByRole("tab", {
      name: "Уведомления",
    });

    appearanceTab.focus();
    fireEvent.keyDown(appearanceTab, { key: "ArrowRight" });

    expect(terminalTab).toHaveFocus();
    expect(terminalTab).toHaveAttribute("aria-selected", "true");
    expect(document.getElementById("settings-panel-terminal")).not.toHaveAttribute(
      "hidden",
    );

    fireEvent.keyDown(terminalTab, { key: "ArrowRight" });
    expect(notificationsTab).toHaveFocus();

    fireEvent.keyDown(notificationsTab, { key: "ArrowRight" });
    expect(appearanceTab).toHaveFocus();

    fireEvent.keyDown(appearanceTab, { key: "ArrowLeft" });
    expect(notificationsTab).toHaveFocus();
    expect(notificationsTab).toHaveAttribute("tabindex", "0");
    expect(appearanceTab).toHaveAttribute("tabindex", "-1");
  });

  it("supports Home, End and the existing mouse activation", () => {
    renderSettings();

    const appearanceTab = screen.getByRole("tab", { name: "Внешний вид" });
    const terminalTab = screen.getByRole("tab", { name: "Терминал" });
    const notificationsTab = screen.getByRole("tab", {
      name: "Уведомления",
    });

    fireEvent.click(terminalTab);
    expect(terminalTab).toHaveAttribute("aria-selected", "true");
    expect(document.getElementById("settings-panel-terminal")).not.toHaveAttribute(
      "hidden",
    );

    terminalTab.focus();
    fireEvent.keyDown(terminalTab, { key: "End" });
    expect(notificationsTab).toHaveFocus();

    fireEvent.keyDown(notificationsTab, { key: "Home" });
    expect(appearanceTab).toHaveFocus();
    expect(appearanceTab).toHaveAttribute("aria-selected", "true");
  });

  it("shows the app version in the dialog footer", () => {
    renderSettings();
    expect(screen.getByText(/ModelCrew · версия \d+\.\d+\.\d+/)).toBeInTheDocument();
  });

  it("warns on the notifications tab when audio is suppressed after a hang", () => {
    soundSuppressed.mockReturnValue(true);
    renderSettings();

    fireEvent.click(screen.getByRole("tab", { name: "Уведомления" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "звук временно отключён",
    );
  });
});
