import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";

const mocks = vi.hoisted(() => ({
  platform: "mac" as "mac" | "windows" | "linux",
  isGitAvailable: vi.fn<() => Promise<boolean>>(async () => false),
  installGitTools: vi.fn(async () => {}),
  openGitLinuxInstructions: vi.fn(async () => {}),
}));

vi.mock("../../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../platform")>()),
  hasTauri: () => true,
  get platform() {
    return mocks.platform;
  },
}));

vi.mock("../../git/gitTools", () => ({
  isGitAvailable: mocks.isGitAvailable,
  installGitTools: mocks.installGitTools,
  openGitLinuxInstructions: mocks.openGitLinuxInstructions,
}));

import { GitToolRow } from "./GitToolRow";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform = "mac";
  mocks.isGitAvailable.mockResolvedValue(false);
  setLocale("ru");
});

afterEach(() => setLocale("ru"));

describe("GitToolRow", () => {
  it("offers the system installer on macOS while git is missing", async () => {
    render(<GitToolRow />);

    fireEvent.click(await screen.findByRole("button", { name: "Установить" }));
    await waitFor(() => expect(mocks.installGitTools).toHaveBeenCalled());
    expect(
      await screen.findByText(/Окно установки открыто/),
    ).toBeInTheDocument();

    mocks.isGitAvailable.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
    expect(await screen.findByText(/Git найден/)).toBeInTheDocument();
  });

  it("points Linux to the package manager instead of installing", async () => {
    mocks.platform = "linux";
    render(<GitToolRow />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Открыть инструкцию" }),
    );
    expect(mocks.openGitLinuxInstructions).toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Установить" }),
    ).not.toBeInTheDocument();
  });

  it("stays out of the way when git is already there", async () => {
    mocks.isGitAvailable.mockResolvedValue(true);
    const { container } = render(<GitToolRow />);

    await waitFor(() => expect(mocks.isGitAvailable).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("leaves Windows to the Git Bash row", () => {
    mocks.platform = "windows";
    const { container } = render(<GitToolRow />);

    expect(mocks.isGitAvailable).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
});
