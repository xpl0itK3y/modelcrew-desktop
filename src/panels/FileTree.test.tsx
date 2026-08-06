// Дерево проекта: что оно показывает и когда ходит на диск.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import type { TreeListing } from "../files/fileTree";

const readWorkspaceDir = vi.fn();
vi.mock("../files/fileTree", async () => {
  const actual =
    await vi.importActual<typeof import("../files/fileTree")>(
      "../files/fileTree",
    );
  return { ...actual, readWorkspaceDir: (...args: unknown[]) =>
    readWorkspaceDir(...args) };
});

const { FileTree } = await import("./FileTree");

function listing(
  entries: [name: string, isDir: boolean][],
  parent = "",
  truncated = false,
): TreeListing {
  return {
    entries: entries.map(([name, isDir]) => ({
      name,
      path: parent ? `${parent}/${name}` : name,
      isDir,
    })),
    truncated,
  };
}

/// Отвечает на запрос каталога тем, что для него положили.
function serve(dirs: Record<string, TreeListing>) {
  readWorkspaceDir.mockImplementation((_id: string, path: string) => {
    const found = dirs[path];
    return found
      ? Promise.resolve(found)
      : Promise.reject(new Error(`нет каталога ${path}`));
  });
}

function names(): string[] {
  return screen
    .getAllByRole("treeitem")
    .map((row) => row.querySelector(".file-name")?.textContent ?? "");
}

beforeEach(() => {
  readWorkspaceDir.mockReset();
  setLocale("ru");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FileTree", () => {
  it("shows the project root as soon as it is read", async () => {
    serve({ "": listing([["src", true], ["README.md", false]]) });

    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);

    await waitFor(() => expect(names()).toEqual(["src", "README.md"]));
  });

  it("asks for a folder only when it is opened", async () => {
    serve({
      "": listing([["src", true]]),
      src: listing([["main.rs", false]], "src"),
    });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["src"]));

    // До раскрытия внутрь никто не заглядывал: на большом проекте это и есть
    // разница между мгновенным деревом и секундной паузой.
    expect(readWorkspaceDir).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle("src"));

    await waitFor(() => expect(names()).toEqual(["src", "main.rs"]));
    expect(readWorkspaceDir).toHaveBeenCalledWith("w1", "src");
  });

  it("does not read the same folder twice", async () => {
    serve({
      "": listing([["src", true]]),
      src: listing([["main.rs", false]], "src"),
    });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["src"]));

    fireEvent.click(screen.getByTitle("src"));
    await waitFor(() => expect(names()).toEqual(["src", "main.rs"]));
    fireEvent.click(screen.getByTitle("src"));
    await waitFor(() => expect(names()).toEqual(["src"]));
    fireEvent.click(screen.getByTitle("src"));
    await waitFor(() => expect(names()).toEqual(["src", "main.rs"]));

    // Свернуть и снова развернуть — не повод идти на диск: содержимое уже
    // прочитано, а лишний вызов виден глазом как мигание списка.
    expect(readWorkspaceDir).toHaveBeenCalledTimes(2);
  });

  it("opens a file instead of expanding it", async () => {
    const opened = vi.fn();
    serve({ "": listing([["README.md", false]]) });
    render(<FileTree workspaceId="w1" onOpenFile={opened} />);
    await waitFor(() => expect(names()).toEqual(["README.md"]));

    fireEvent.click(screen.getByTitle("README.md"));

    expect(opened).toHaveBeenCalledWith("README.md");
  });

  it("unfolds the way down to the file already open", async () => {
    serve({
      "": listing([["src", true]]),
      src: listing([["panels", true]], "src"),
      "src/panels": listing([["Tree.tsx", false]], "src/panels"),
    });

    render(
      <FileTree
        workspaceId="w1"
        activePath="src/panels/Tree.tsx"
        onOpenFile={() => {}}
      />,
    );

    // Открытый файл должен быть виден без единого щелчка: иначе подсветка
    // «где я» показывает пустоту, а до файла надо доклацывать руками.
    await waitFor(() =>
      expect(names()).toEqual(["src", "panels", "Tree.tsx"]),
    );
    expect(
      screen.getByTitle("src/panels/Tree.tsx").getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("throws away another project's tree when the project changes", async () => {
    serve({ "": listing([["первый.txt", false]]) });
    const view = render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["первый.txt"]));

    serve({ "": listing([["второй.txt", false]]) });
    await act(async () => {
      view.rerender(<FileTree workspaceId="w2" onOpenFile={() => {}} />);
    });

    // Чужие файлы не должны мелькнуть даже на кадр: щелчок по такому открыл бы
    // файл не из того проекта.
    await waitFor(() => expect(names()).toEqual(["второй.txt"]));
  });

  it("says when a folder was too big to show whole", async () => {
    serve({ "": listing([["много.txt", false]], "", true) });

    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);

    // Молча обрезанный список читается как полный, и пропавший файл ищут в
    // проекте, а не в границе показа.
    await waitFor(() =>
      expect(screen.getByText(/слишком много файлов/)).toBeInTheDocument(),
    );
  });

  it("reports a failure instead of showing an empty project", async () => {
    readWorkspaceDir.mockRejectedValue({ code: "workspaceRootUnavailable" });

    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument(),
    );
  });
});
