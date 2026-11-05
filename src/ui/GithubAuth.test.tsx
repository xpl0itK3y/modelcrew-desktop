import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import type { DeviceStart } from "../github/auth";
import { GithubAuth } from "./GithubAuth";

// Кнопка входа есть только в настоящем приложении.
vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  isTauri: true,
}));

const { deviceStart } = vi.hoisted(() => ({
  deviceStart: vi.fn<() => Promise<DeviceStart>>(),
}));

vi.mock("../github/auth", () => ({
  githubCurrentUser: vi.fn(async () => null),
  githubDeviceStart: deviceStart,
  // Человек ещё не подтвердил вход в браузере.
  githubDevicePoll: vi.fn(async () => ({ status: "pending" })),
  githubLogout: vi.fn(async () => {}),
  githubCommitAvatars: vi.fn(async () => []),
  openUrl: vi.fn(async () => {}),
}));

const device: DeviceStart = {
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  deviceCode: "device-code",
  interval: 5,
  expiresIn: 900,
};

beforeEach(() => {
  setLocale("ru");
  deviceStart.mockReset();
});

async function signIn() {
  render(<GithubAuth />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
  });
}

describe("waiting for GitHub to confirm the sign-in", () => {
  it("shows the moving mark next to the code while the browser is out", async () => {
    deviceStart.mockResolvedValue(device);
    await signIn();

    expect(screen.getByRole("button", { name: "ABCD-1234" })).toBeTruthy();
    const waiting = screen.getByRole("status");
    expect(waiting).toHaveTextContent("Ждём подтверждения в браузере…");
    expect(waiting.querySelector(".waiting-mark")).not.toBeNull();
    // Знак — украшение: диктору хватит текста.
    expect(waiting.querySelector(".waiting-mark")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("shows it while the code itself is still being requested", async () => {
    deviceStart.mockReturnValue(new Promise(() => {}));
    await signIn();

    const waiting = screen.getByRole("status");
    expect(waiting.querySelector(".waiting-mark")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "ABCD-1234" })).toBeNull();
  });

  it("drops it once the sign-in has failed", async () => {
    deviceStart.mockRejectedValue(new Error("offline"));
    await signIn();

    expect(screen.getByText("Не удалось войти")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelector(".waiting-mark")).toBeNull();
  });
});
