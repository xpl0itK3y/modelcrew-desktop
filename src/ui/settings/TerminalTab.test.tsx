import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { GIT_BASH_DOWNLOAD_URL } from "../../gitBash";
import { TerminalTab } from "./TerminalTab";

const { invokeMock, openUrlMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openUrlMock: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: openUrlMock,
}));

const powershell = {
  id: "powershell",
  label: "PowerShell",
  command: "powershell.exe",
};

const gitBash = {
  id: "bash",
  label: "Git Bash",
  command: String.raw`C:\Program Files\Git\bin\bash.exe`,
};

function renderTerminalTab(onSelectShell = vi.fn()) {
  return {
    onSelectShell,
    ...render(
      <TerminalTab
        shell={null}
        shellBusy={false}
        terminalFontSize={14}
        onSelectShell={onSelectShell}
        onSelectTerminalFontSize={vi.fn()}
      />,
    ),
  };
}

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  invokeMock.mockReset();
  openUrlMock.mockClear();
});

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  setLocale("ru");
});

describe("Git Bash setup", () => {
  it("asks for confirmation, installs through the backend and refreshes the shell list", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_shells") {
        return [powershell];
      }
      if (command === "git_bash_status") {
        return { status: "installable" };
      }
      if (command === "git_bash_install") {
        return gitBash;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { onSelectShell } = renderTerminalTab();

    fireEvent.click(await screen.findByRole("button", { name: "Установить" }));

    const confirmation = screen.getByRole("alertdialog");
    expect(confirmation).toHaveTextContent("WinGet");
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Установить" }),
    );

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("git_bash_install"),
    );
    expect(await screen.findByRole("option", { name: "Git Bash" })).toHaveValue(
      gitBash.command,
    );
    expect(
      screen.getByText(/Git Bash установлен.+Выберите его/u),
    ).toBeInTheDocument();
    expect(onSelectShell).not.toHaveBeenCalled();
  });

  it("opens the official download page when WinGet is unavailable", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_shells") {
        return [powershell];
      }
      if (command === "git_bash_status") {
        return { status: "manual" };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    renderTerminalTab();

    fireEvent.click(await screen.findByRole("button", { name: "Открыть сайт" }));

    await waitFor(() =>
      expect(openUrlMock).toHaveBeenCalledWith(GIT_BASH_DOWNLOAD_URL),
    );
  });

  it("detects a manually installed Git Bash without reopening Settings", async () => {
    let statusChecks = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_shells") {
        return statusChecks === 0 ? [powershell] : [powershell, gitBash];
      }
      if (command === "git_bash_status") {
        statusChecks += 1;
        return statusChecks === 1
          ? { status: "manual" }
          : { status: "installed", shell: gitBash };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    renderTerminalTab();

    fireEvent.click(
      await screen.findByRole("button", { name: "Проверить снова" }),
    );

    expect(await screen.findByRole("option", { name: "Git Bash" })).toHaveValue(
      gitBash.command,
    );
    expect(
      screen.getByText(/Git Bash найден.+можно выбрать/u),
    ).toBeInTheDocument();
  });

  it("shows a localized failure instead of raw backend diagnostics", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_shells") {
        return [powershell];
      }
      if (command === "git_bash_status") {
        return { status: "installable" };
      }
      if (command === "git_bash_install") {
        throw {
          code: "git_bash_install_failed",
          debug: "raw winget failure that must stay in the console",
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    renderTerminalTab();

    fireEvent.click(await screen.findByRole("button", { name: "Установить" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Установить",
      }),
    );

    expect(
      await screen.findByText(/Git Bash не был установлен/u),
    ).toBeInTheDocument();
    expect(screen.queryByText(/raw winget failure/u)).toBeNull();
  });
});
