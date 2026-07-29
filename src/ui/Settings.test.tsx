import { fireEvent, render, screen, within } from "@testing-library/react";
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

const searchBox = () => screen.getByRole("searchbox");

const SECTION_IDS = [
  "appearance",
  "terminal",
  "agents",
  "notifications",
  "account",
] as const;

afterEach(() => setLocale("ru"));

describe("Settings sections", () => {
  it("connects every section to a stable labelled panel and uses roving tabindex", () => {
    renderSettings();

    const appearanceTab = screen.getByRole("tab", { name: "Внешний вид" });
    const terminalTab = screen.getByRole("tab", { name: "Терминал" });
    const agentsTab = screen.getByRole("tab", { name: "Агенты" });
    const notificationsTab = screen.getByRole("tab", { name: "Уведомления" });
    const accountTab = screen.getByRole("tab", { name: "GitHub" });

    const tabPanelPairs = [
      [appearanceTab, "appearance"],
      [terminalTab, "terminal"],
      [agentsTab, "agents"],
      [notificationsTab, "notifications"],
      [accountTab, "account"],
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
    for (const tab of [terminalTab, agentsTab, notificationsTab, accountTab]) {
      expect(tab).toHaveAttribute("tabindex", "-1");
    }

    expect(
      document.getElementById("settings-panel-appearance"),
    ).not.toHaveAttribute("hidden");
    for (const id of SECTION_IDS.filter((entry) => entry !== "appearance")) {
      expect(document.getElementById(`settings-panel-${id}`)).toHaveAttribute(
        "hidden",
      );
    }
  });

  it("keeps the navigation lists free of anything but tabs", () => {
    renderSettings();

    for (const list of screen.getAllByRole("tablist")) {
      expect(list).toHaveAttribute("aria-orientation", "vertical");
      for (const child of Array.from(list.children)) {
        expect(child).toHaveAttribute("role", "tab");
      }
    }
  });

  it("switches and focuses sections with arrow keys, including wraparound", () => {
    renderSettings();

    const appearanceTab = screen.getByRole("tab", { name: "Внешний вид" });
    const terminalTab = screen.getByRole("tab", { name: "Терминал" });
    const agentsTab = screen.getByRole("tab", { name: "Агенты" });
    const notificationsTab = screen.getByRole("tab", { name: "Уведомления" });
    const accountTab = screen.getByRole("tab", { name: "GitHub" });

    appearanceTab.focus();
    fireEvent.keyDown(appearanceTab, { key: "ArrowDown" });

    expect(terminalTab).toHaveFocus();
    expect(terminalTab).toHaveAttribute("aria-selected", "true");
    expect(
      document.getElementById("settings-panel-terminal"),
    ).not.toHaveAttribute("hidden");

    fireEvent.keyDown(terminalTab, { key: "ArrowDown" });
    expect(agentsTab).toHaveFocus();

    fireEvent.keyDown(agentsTab, { key: "ArrowDown" });
    expect(notificationsTab).toHaveFocus();

    // Через границу группы навигации — «Аккаунт» отдельным списком.
    fireEvent.keyDown(notificationsTab, { key: "ArrowDown" });
    expect(accountTab).toHaveFocus();

    fireEvent.keyDown(accountTab, { key: "ArrowDown" });
    expect(appearanceTab).toHaveFocus();

    fireEvent.keyDown(appearanceTab, { key: "ArrowUp" });
    expect(accountTab).toHaveFocus();
    expect(accountTab).toHaveAttribute("tabindex", "0");
    expect(appearanceTab).toHaveAttribute("tabindex", "-1");
  });

  it("supports Home, End and the existing mouse activation", () => {
    renderSettings();

    const appearanceTab = screen.getByRole("tab", { name: "Внешний вид" });
    const terminalTab = screen.getByRole("tab", { name: "Терминал" });
    const accountTab = screen.getByRole("tab", { name: "GitHub" });

    fireEvent.click(terminalTab);
    expect(terminalTab).toHaveAttribute("aria-selected", "true");
    expect(
      document.getElementById("settings-panel-terminal"),
    ).not.toHaveAttribute("hidden");

    terminalTab.focus();
    fireEvent.keyDown(terminalTab, { key: "End" });
    expect(accountTab).toHaveFocus();

    fireEvent.keyDown(accountTab, { key: "Home" });
    expect(appearanceTab).toHaveFocus();
    expect(appearanceTab).toHaveAttribute("aria-selected", "true");
  });

  it("shows the app version beneath the navigation", () => {
    renderSettings();
    expect(
      screen.getByText(/ModelCrew · версия \d+\.\d+\.\d+/),
    ).toBeInTheDocument();
  });

  it("marks the agent notification content row as beta and finds it by that word", () => {
    renderSettings();
    fireEvent.click(screen.getByRole("tab", { name: "Уведомления" }));

    // Метка есть и в разделе терминала, поэтому ищем внутри этой панели.
    const panel = screen.getByRole("tabpanel", { name: "Уведомления" });
    expect(within(panel).getByText("Бета")).toBeVisible();

    // Метка попадает в поиск: «бета» показывает обкатываемые настройки.
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "бета" },
    });
    expect(screen.getByText("Содержимое уведомлений агентов")).toBeVisible();
    expect(screen.queryByText("Громкость уведомлений")).not.toBeInTheDocument();
  });

  it("persists notification volume and restores it after reopening Settings", () => {
    localStorage.removeItem("modelcrew.notificationVolume");
    const first = renderSettings();
    fireEvent.click(screen.getByRole("tab", { name: "Уведомления" }));

    const volume = screen.getByRole("slider", {
      name: "Громкость уведомлений",
    });
    expect(volume).toHaveValue("100");
    expect(screen.getByText("100%")).toBeVisible();

    fireEvent.change(volume, { target: { value: "35" } });
    expect(volume).toHaveValue("35");
    expect(screen.getByText("35%")).toBeVisible();
    expect(localStorage.getItem("modelcrew.notificationVolume")).toBe("35");

    first.unmount();
    renderSettings();
    fireEvent.click(screen.getByRole("tab", { name: "Уведомления" }));
    expect(
      screen.getByRole("slider", { name: "Громкость уведомлений" }),
    ).toHaveValue("35");
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

  it("re-reads the hang verdict after replaying the current sound", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("tab", { name: "Уведомления" }));
    expect(screen.queryByRole("alert")).toBeNull();

    // Аудио подвисло на этом воспроизведении — следующее нажатие обязано
    // показать объяснение, а не молчать.
    soundSuppressed.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /Прослушать/ }));

    expect(screen.getByRole("alert")).toBeInTheDocument();
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

  it("shows brief agent notifications by default and persists detailed mode", () => {
    const first = renderSettings();
    fireEvent.click(screen.getByRole("tab", { name: "Уведомления" }));

    const detail = screen.getByRole("combobox", {
      name: "Содержимое уведомлений агентов",
    });
    expect(detail).toHaveValue("brief");
    expect(screen.getByText(/Кратко — только статус и проект/)).toBeVisible();

    fireEvent.change(detail, { target: { value: "detailed" } });
    expect(detail).toHaveValue("detailed");
    expect(localStorage.getItem("modelcrew.agentAlertDetail")).toBe("detailed");

    first.unmount();
    renderSettings();
    fireEvent.click(screen.getByRole("tab", { name: "Уведомления" }));
    expect(
      screen.getByRole("combobox", {
        name: "Содержимое уведомлений агентов",
      }),
    ).toHaveValue("detailed");
  });
});

describe("Settings account", () => {
  it("asks GithubAuth to sign in instead of running its own flow", () => {
    const requests: string[] = [];
    const listener = (event: Event) => {
      requests.push((event as CustomEvent<string>).detail);
    };
    window.addEventListener("modelcrew:github-auth-request", listener);

    try {
      renderSettings();
      fireEvent.click(screen.getByRole("tab", { name: "GitHub" }));
      fireEvent.click(screen.getByRole("button", { name: "Войти" }));

      expect(requests).toEqual(["login"]);
      expect(screen.getByText(/Вы не вошли/)).toBeInTheDocument();
    } finally {
      window.removeEventListener("modelcrew:github-auth-request", listener);
    }
  });

  it("keeps the avatar source with the account it depends on", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("tab", { name: "GitHub" }));

    expect(screen.getByText("Аватары авторов")).toBeInTheDocument();
    // Без входа «Из сети» недоступна.
    expect(screen.getByRole("button", { name: "Из сети" })).toBeDisabled();
  });
});

describe("Settings search", () => {
  it("keeps only the sections and rows that match the query", () => {
    renderSettings();

    fireEvent.change(searchBox(), { target: { value: "подсветк" } });

    expect(screen.getByRole("tab", { name: "Внешний вид" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Терминал" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Агенты" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Уведомления" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "GitHub" })).toBeNull();

    expect(screen.getByText("Цвет подсветки")).toBeInTheDocument();
    expect(screen.queryByText("Тема интерфейса")).toBeNull();
    expect(screen.queryByText("Язык интерфейса")).toBeNull();
  });

  it("finds a section by its own name and then shows all of its rows", () => {
    renderSettings();

    fireEvent.change(searchBox(), { target: { value: "агенты" } });

    expect(screen.queryAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Агенты" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Возобновление агентов")).toBeInTheDocument();
    expect(screen.getByText("Уведомления от агентов")).toBeInTheDocument();
  });

  it("opens the first matching section when the query hides the open one", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("tab", { name: "Уведомления" }));
    fireEvent.change(searchBox(), { target: { value: "подсветк" } });

    expect(screen.getByRole("tab", { name: "Внешний вид" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      document.getElementById("settings-panel-appearance"),
    ).not.toHaveAttribute("hidden");
  });

  it("reports an empty result and hides every panel", () => {
    renderSettings();

    fireEvent.change(searchBox(), { target: { value: "щщщ" } });

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getAllByText("Ничего не нашлось")).toHaveLength(2);
    for (const id of SECTION_IDS) {
      expect(document.getElementById(`settings-panel-${id}`)).toHaveAttribute(
        "hidden",
      );
    }
  });

  it("restores every section once the query is cleared", () => {
    renderSettings();

    fireEvent.change(searchBox(), { target: { value: "подсветк" } });
    fireEvent.change(searchBox(), { target: { value: "" } });

    expect(screen.queryAllByRole("tab")).toHaveLength(5);
    expect(screen.getByText("Тема интерфейса")).toBeInTheDocument();
  });

  it("drops the query when the interface language changes", () => {
    renderSettings();

    fireEvent.change(searchBox(), { target: { value: "язык" } });
    expect(screen.queryAllByRole("tab")).toHaveLength(1);

    // Запрос набран по-русски: после переключения он не совпал бы ни с чем и
    // оставил бы диалог пустым — вместе с этим самым переключателем.
    fireEvent.click(screen.getByRole("button", { name: "English" }));

    expect(searchBox()).toHaveValue("");
    expect(screen.queryAllByRole("tab")).toHaveLength(5);
    expect(screen.getByRole("tab", { name: "Appearance" })).toBeInTheDocument();
  });
});
