import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { forgetMcpStatus } from "../../mcp";
import { PluginsTab } from "./PluginsTab";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const RUNNING = {
  enabled: true,
  listening: true,
  socket:
    "/Users/tester/Library/Application Support/com.modelcrew.desktop/mcp.sock",
  tools: ["crew_ping", "browser_open", "browser_navigate"],
  agents: 2,
};

const SWITCHED_OFF = {
  ...RUNNING,
  enabled: false,
  listening: false,
  socket: null,
};

// В фигурных скобках намеренно: возвращённую из beforeEach функцию vitest
// принимает за уборку и зовёт её после теста — а `invoke` в ответ отдаёт
// вечное обещание, на котором прогон и виснет.
beforeEach(() => {
  invoke.mockReset();
  // Состояние плагина общее на всё приложение и переживает размонтирование:
  // без сброса соседний тест видел бы чужой ответ.
  forgetMcpStatus();
});
afterEach(() => setLocale("ru"));

const theSwitch = () => screen.getByRole("switch", { name: "Браузер" });

describe("PluginsTab", () => {
  it("shows what the agent actually gets", async () => {
    invoke.mockResolvedValue(RUNNING);
    render(<PluginsTab />);

    // Имена инструментов — те же, что уходят агенту: по ним человек и
    // сверяет, то ли он видит в /mcp у себя.
    await waitFor(() =>
      expect(
        screen.getByText(
          "Инструменты: crew_ping · browser_open · browser_navigate",
        ),
      ).toBeVisible(),
    );
    expect(screen.getByText(RUNNING.socket)).toBeVisible();
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it("takes the whole server down, not just the tools", async () => {
    invoke.mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(SWITCHED_OFF);
    render(<PluginsTab />);
    await waitFor(() =>
      expect(theSwitch()).toHaveAttribute("aria-checked", "true"),
    );

    fireEvent.click(theSwitch());

    await waitFor(() =>
      expect(
        screen.getByText(
          "Плагин выключен: агент не видит ни сервера, ни инструментов.",
        ),
      ).toBeVisible(),
    );
    expect(invoke).toHaveBeenLastCalledWith("mcp_set_enabled", {
      enabled: false,
    });
    // Список инструментов исчезает вместе с сервером: показывать его при
    // выключенном сервере значило бы обещать то, чего агент не увидит.
    expect(screen.queryByText(/crew_ping/)).toBeNull();
  });

  it("counts the agents that are on the line right now", async () => {
    // Единственное, чем человек проверяет, что агент его видит: сам агент об
    // этом не скажет, а открытый сокет говорит лишь о нашей половине трубы.
    invoke.mockResolvedValue(RUNNING);
    render(<PluginsTab />);

    await waitFor(() =>
      expect(screen.getByText("Агентов на связи: 2")).toBeVisible(),
    );
  });

  it("does not promise a server that failed to come up", async () => {
    invoke.mockResolvedValue({ ...RUNNING, listening: false, socket: null });
    render(<PluginsTab />);

    await waitFor(() =>
      expect(
        screen.getByText(
          "Плагин включён, но сервер не поднялся. Выключите и снова включите его или перезапустите ModelCrew.",
        ),
      ).toBeVisible(),
    );
  });

  it("says out loud when the switch could not be remembered", async () => {
    invoke
      .mockResolvedValueOnce(RUNNING)
      .mockRejectedValueOnce({ code: "mcp_settings_write_failed" });
    render(<PluginsTab />);
    await waitFor(() =>
      expect(theSwitch()).toHaveAttribute("aria-checked", "true"),
    );

    fireEvent.click(theSwitch());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Не удалось запомнить настройку MCP",
      ),
    );
  });

  it("keeps its hands off a switch it knows nothing about", () => {
    // Бэкенд не ответил: положение выключателя неизвестно, и трогать его
    // нельзя — щелчок вслепую снял бы работающий сервер.
    invoke.mockReturnValue(new Promise(() => {}));
    render(<PluginsTab />);

    expect(theSwitch()).toBeDisabled();
  });
});
