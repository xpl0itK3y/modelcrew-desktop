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

const searchBox = () =>
  screen.getByRole("searchbox", { name: "Поиск настроек" });

afterEach(() => setLocale("ru"));

describe("Settings sections", () => {
  it("connects every section to a stable labelled panel and uses roving tabindex", () => {
    renderSettings();

    const appearanceTab = screen.getByRole("tab", { name: "Внешний вид" });
    const terminalTab = screen.getByRole("tab", { name: "Терминал" });
    const agentsTab = screen.getByRole("tab", { name: "Агенты" });
    const notificationsTab = screen.getByRole("tab", {
      name: "Уведомления",
    });

    const tabPanelPairs = [
      [appearanceTab, "appearance"],
      [terminalTab, "terminal"],
      [agentsTab, "agents"],
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
    expect(agentsTab).toHaveAttribute("tabindex", "-1");
    expect(notificationsTab).toHaveAttribute("tabindex", "-1");

    expect(document.getElementById("settings-panel-appearance")).not.toHaveAttribute(
      "hidden",
    );
    expect(document.getElementById("settings-panel-terminal")).toHaveAttribute(
      "hidden",
    );
    expect(document.getElementById("settings-panel-agents")).toHaveAttribute(
      "hidden",
    );
    expect(
      document.getElementById("settings-panel-notifications"),
    ).toHaveAttribute("hidden");
  });

  it("switches and focuses sections with arrow keys, including wraparound", () => {
    renderSettings();

    const appearanceTab = screen.getByRole("tab", { name: "Внешний вид" });
    const terminalTab = screen.getByRole("tab", { name: "Терминал" });
    const agentsTab = screen.getByRole("tab", { name: "Агенты" });
    const notificationsTab = screen.getByRole("tab", {
      name: "Уведомления",
    });

    appearanceTab.focus();
    fireEvent.keyDown(appearanceTab, { key: "ArrowDown" });

    expect(terminalTab).toHaveFocus();
    expect(terminalTab).toHaveAttribute("aria-selected", "true");
    expect(document.getElementById("settings-panel-terminal")).not.toHaveAttribute(
      "hidden",
    );

    fireEvent.keyDown(terminalTab, { key: "ArrowDown" });
    expect(agentsTab).toHaveFocus();

    fireEvent.keyDown(agentsTab, { key: "ArrowDown" });
    expect(notificationsTab).toHaveFocus();

    fireEvent.keyDown(notificationsTab, { key: "ArrowDown" });
    expect(appearanceTab).toHaveFocus();

    fireEvent.keyDown(appearanceTab, { key: "ArrowUp" });
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

  it("shows the app version beneath the navigation", () => {
    renderSettings();
    expect(screen.getByText(/ModelCrew · версия \d+\.\d+\.\d+/)).toBeInTheDocument();
  });

  it("warns in the notifications section when audio is suppressed after a hang", () => {
    soundSuppressed.mockReturnValue(true);
    renderSettings();

    fireEvent.click(screen.getByRole("tab", { name: "Уведомления" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "звук временно отключён",
    );
    soundSuppressed.mockReturnValue(false);
  });

  it("flips a switch setting and reports the new state", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("tab", { name: "Агенты" }));
    const alerts = screen.getByRole("switch", {
      name: "Уведомления от агентов",
    });
    const before = alerts.getAttribute("aria-checked");

    fireEvent.click(alerts);

    expect(alerts.getAttribute("aria-checked")).not.toBe(before);
  });
});

describe("Settings search", () => {
  it("keeps only the sections and rows that match the query", () => {
    renderSettings();

    fireEvent.change(searchBox(), { target: { value: "тема" } });

    expect(screen.getByRole("tab", { name: "Внешний вид" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Терминал" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Агенты" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Уведомления" })).toBeNull();

    expect(screen.getByText("Тема интерфейса")).toBeInTheDocument();
    expect(screen.queryByText("Цвет подсветки")).toBeNull();
    expect(screen.queryByText("Язык интерфейса")).toBeNull();
  });

  it("opens the first matching section when the query hides the open one", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("tab", { name: "Уведомления" }));
    fireEvent.change(searchBox(), { target: { value: "тема" } });

    expect(screen.getByRole("tab", { name: "Внешний вид" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(document.getElementById("settings-panel-appearance")).not.toHaveAttribute(
      "hidden",
    );
  });

  it("reports an empty result and hides every panel", () => {
    renderSettings();

    fireEvent.change(searchBox(), { target: { value: "щщщ" } });

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getAllByText("Ничего не нашлось")).toHaveLength(2);
    for (const id of ["appearance", "terminal", "agents", "notifications"]) {
      expect(document.getElementById(`settings-panel-${id}`)).toHaveAttribute(
        "hidden",
      );
    }
  });

  it("restores every section once the query is cleared", () => {
    renderSettings();

    fireEvent.change(searchBox(), { target: { value: "тема" } });
    fireEvent.change(searchBox(), { target: { value: "" } });

    expect(screen.queryAllByRole("tab")).toHaveLength(4);
    expect(screen.getByText("Цвет подсветки")).toBeInTheDocument();
  });
});
