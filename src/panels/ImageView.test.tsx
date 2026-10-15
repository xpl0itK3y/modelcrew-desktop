// Открытая картинка: что видно и что происходит, когда её перерисовали.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";

const readWorkspaceMedia = vi.fn();
vi.mock("../files/media", async () => {
  const actual =
    await vi.importActual<typeof import("../files/media")>("../files/media");
  return {
    ...actual,
    readWorkspaceMedia: (...args: unknown[]) => readWorkspaceMedia(...args),
  };
});

const watchers = new Set<(dirs: string[], partial: boolean) => void>();
vi.mock("../files/fileTree", async () => {
  const actual =
    await vi.importActual<typeof import("../files/fileTree")>(
      "../files/fileTree",
    );
  return {
    ...actual,
    watchWorkspaceTree: (
      _id: string,
      onChanged: (dirs: string[], partial: boolean) => void,
    ) => {
      watchers.add(onChanged);
      return () => watchers.delete(onChanged);
    },
  };
});

const { ImageView } = await import("./ImageView");

function picture(data: string, extra: Record<string, unknown> = {}) {
  return {
    mime: "image/png",
    data,
    bytes: 4096,
    tooLarge: false,
    exists: true,
    ...extra,
  };
}

describe("ImageView", () => {
  beforeEach(() => {
    setLocale("ru");
    watchers.clear();
    readWorkspaceMedia.mockReset();
    readWorkspaceMedia.mockResolvedValue(picture("iVBOR"));
  });

  it("draws the file instead of calling it binary", async () => {
    render(<ImageView workspaceId="w" path="assets/logo.png" />);
    const shown = await screen.findByAltText("logo.png");
    expect(shown.getAttribute("src")).toBe("data:image/png;base64,iVBOR");
  });

  it("says how big the file is", async () => {
    render(<ImageView workspaceId="w" path="assets/logo.png" />);
    expect(await screen.findByText(/4 KB/)).toBeTruthy();
  });

  it("shows a picture too large to carry rather than a blank sheet", async () => {
    readWorkspaceMedia.mockResolvedValue(
      picture("", { tooLarge: true, bytes: 32 * 1024 * 1024 }),
    );
    render(<ImageView workspaceId="w" path="assets/huge.png" />);
    expect(
      await screen.findByText("Картинка слишком большая, чтобы её показать"),
    ).toBeTruthy();
    // Показывать нечего — переключать масштаб тоже нечему.
    expect(screen.queryByText("Настоящий размер")).toBeNull();
  });

  it("switches between fitting the window and the real pixels", async () => {
    const { container } = render(
      <ImageView workspaceId="w" path="assets/logo.png" />,
    );
    const zoom = await screen.findByText("Настоящий размер");
    expect(container.querySelector(".picture-sheet.is-actual")).toBeNull();
    fireEvent.click(zoom);
    expect(container.querySelector(".picture-sheet.is-actual")).toBeTruthy();
    expect(screen.getByText("Вписать в окно")).toBeTruthy();
  });

  it("picks up the picture the agent has just redrawn", async () => {
    render(<ImageView workspaceId="w" path="assets/logo.png" />);
    await screen.findByAltText("logo.png");
    readWorkspaceMedia.mockResolvedValue(picture("R0lGOD"));
    for (const listener of [...watchers]) {
      listener(["assets"], false);
    }
    await waitFor(() =>
      expect(screen.getByAltText("logo.png").getAttribute("src")).toBe(
        "data:image/png;base64,R0lGOD",
      ),
    );
  });

  it("leaves a hidden tab alone until it is opened", async () => {
    const view = render(
      <ImageView workspaceId="w" path="assets/logo.png" visible={false} />,
    );
    await screen.findByAltText("logo.png");
    expect(readWorkspaceMedia).toHaveBeenCalledTimes(1);
    readWorkspaceMedia.mockResolvedValue(picture("R0lGOD"));
    for (const listener of [...watchers]) {
      listener(["assets"], false);
    }
    // Вкладку не видно — за картинкой не ходим.
    expect(readWorkspaceMedia).toHaveBeenCalledTimes(1);
    view.rerender(
      <ImageView workspaceId="w" path="assets/logo.png" visible={true} />,
    );
    await waitFor(() =>
      expect(screen.getByAltText("logo.png").getAttribute("src")).toBe(
        "data:image/png;base64,R0lGOD",
      ),
    );
  });

  it("admits when the file is gone", async () => {
    readWorkspaceMedia.mockResolvedValue(
      picture("", { exists: false, bytes: 0 }),
    );
    render(<ImageView workspaceId="w" path="assets/gone.png" />);
    expect(await screen.findByText("Файла больше нет")).toBeTruthy();
  });
});
