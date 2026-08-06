// Дерево проекта: что оно показывает и когда ходит на диск.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import type { TreeListing } from "../files/fileTree";

const readWorkspaceDir = vi.fn();
const createEntry = vi.fn((..._args: unknown[]) => Promise.resolve());
const renameEntry = vi.fn((..._args: unknown[]) => Promise.resolve());
const deleteEntry = vi.fn((..._args: unknown[]) => Promise.resolve());
const revealEntry = vi.fn((..._args: unknown[]) => Promise.resolve());
const searchTree = vi.fn();
/// Сообщить дереву о правке на диске так, как это делает вотчер.
let announce: ((dirs: string[], partial: boolean) => void) | null = null;
const stopWatching = vi.fn();
vi.mock("../files/fileTree", async () => {
  const actual =
    await vi.importActual<typeof import("../files/fileTree")>(
      "../files/fileTree",
    );
  return {
    ...actual,
    readWorkspaceDir: (...args: unknown[]) => readWorkspaceDir(...args),
    createWorkspaceEntry: (...args: unknown[]) => createEntry(...args),
    renameWorkspaceEntry: (...args: unknown[]) => renameEntry(...args),
    deleteWorkspaceEntry: (...args: unknown[]) => deleteEntry(...args),
    revealWorkspaceEntry: (...args: unknown[]) => revealEntry(...args),
    searchWorkspaceTree: (...args: unknown[]) => searchTree(...args),
    watchWorkspaceTree: (
      _id: string,
      onChanged: (dirs: string[], partial: boolean) => void,
    ) => {
      announce = onChanged;
      return stopWatching;
    },
  };
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
  stopWatching.mockReset();
  searchTree.mockReset();
  searchTree.mockResolvedValue({ entries: [], truncated: false });
  for (const spy of [createEntry, renameEntry, deleteEntry, revealEntry]) {
    spy.mockClear();
  }
  announce = null;
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

  it("picks up a file that appeared on disk", async () => {
    const before = listing([["старый.txt", false]]);
    const after = listing([
      ["новый.txt", false],
      ["старый.txt", false],
    ]);
    let current = before;
    readWorkspaceDir.mockImplementation(() => Promise.resolve(current));
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["старый.txt"]));

    current = after;
    await act(async () => announce?.([""], false));

    // Агент в соседней панели создаёт и удаляет файлы: дерево, застывшее на
    // том, что было при раскрытии, врёт тем сильнее, чем дольше на него смотрят.
    await waitFor(() => expect(names()).toEqual(["новый.txt", "старый.txt"]));
  });

  it("rereads only the folders it actually holds", async () => {
    serve({
      "": listing([["src", true]]),
      src: listing([["main.rs", false]], "src"),
    });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["src"]));
    readWorkspaceDir.mockClear();

    await act(async () => announce?.(["src", "docs", "node_modules"], false));

    // Ни `docs`, ни `node_modules` мы не раскрывали: спрашивать про них — это
    // обход диска ради списка, который никто не увидит.
    expect(readWorkspaceDir).not.toHaveBeenCalled();
  });

  it("rereads everything it holds when the change list is cut", async () => {
    serve({
      "": listing([["src", true]]),
      src: listing([["main.rs", false]], "src"),
    });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["src"]));
    fireEvent.click(screen.getByTitle("src"));
    await waitFor(() => expect(names()).toEqual(["src", "main.rs"]));
    readWorkspaceDir.mockClear();

    await act(async () => announce?.([], true));

    // Список каталогов обрезан — значит названному верить нельзя, и
    // перечитывать надо всё, что показано.
    expect(readWorkspaceDir).toHaveBeenCalledTimes(2);
  });

  it("stops watching the project it left", async () => {
    serve({ "": listing([["a.txt", false]]) });
    const view = render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["a.txt"]));

    await act(async () => {
      view.rerender(<FileTree workspaceId="w2" onOpenFile={() => {}} />);
    });

    // Иначе вотчеры копятся по одному на каждый открытый за сеанс проект.
    expect(stopWatching).toHaveBeenCalled();
  });

  it("walks and opens from the keyboard", async () => {
    const opened = vi.fn();
    serve({
      "": listing([["src", true], ["README.md", false]]),
      src: listing([["main.rs", false]], "src"),
    });
    render(<FileTree workspaceId="w1" onOpenFile={opened} />);
    await waitFor(() => expect(names()).toEqual(["src", "README.md"]));

    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    await waitFor(() => expect(names()).toEqual(["src", "main.rs", "README.md"]));
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "Enter" });

    expect(opened).toHaveBeenCalledWith("src/main.rs");
  });

  it("keeps a single stop for the Tab key", async () => {
    serve({ "": listing([["a.txt", false], ["b.txt", false], ["c.txt", false]]) });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["a.txt", "b.txt", "c.txt"]));

    // Два десятка строк подряд в порядке обхода — это не навигация: входят в
    // дерево один раз и дальше ходят стрелками.
    const stops = screen
      .getAllByRole("treeitem")
      .filter((row) => row.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    expect(stops[0].getAttribute("data-path")).toBe("a.txt");
  });

  /// Правый щелчок по строке и выбор пункта меню.
  async function pick(row: string, item: string) {
    fireEvent.contextMenu(screen.getByTitle(row));
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("menuitem", { name: item }));
  }

  it("creates a file inside the folder it was asked from", async () => {
    serve({
      "": listing([["src", true]]),
      src: listing([], "src"),
    });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["src"]));

    await pick("src", "Создать файл");
    fireEvent.change(screen.getByLabelText("Имя"), {
      target: { value: "новый.rs" },
    });
    fireEvent.keyDown(screen.getByLabelText("Имя"), { key: "Enter" });

    // У папки — внутрь неё: спрашивали из неё, туда и кладём.
    await waitFor(() =>
      expect(createEntry).toHaveBeenCalledWith("w1", "src/новый.rs", false),
    );
  });

  it("creates a file beside the one it was asked from", async () => {
    serve({ "": listing([["src", true]]), src: listing([["main.rs", false]], "src") });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["src"]));
    fireEvent.click(screen.getByTitle("src"));
    await waitFor(() => expect(names()).toEqual(["src", "main.rs"]));

    await pick("src/main.rs", "Создать файл");
    fireEvent.change(screen.getByLabelText("Имя"), {
      target: { value: "сосед.rs" },
    });
    fireEvent.keyDown(screen.getByLabelText("Имя"), { key: "Enter" });

    // У файла — в его каталог, а не внутрь самого файла.
    await waitFor(() =>
      expect(createEntry).toHaveBeenCalledWith("w1", "src/сосед.rs", false),
    );
  });

  it("renames without moving the entry out of its folder", async () => {
    serve({ "": listing([["src", true]]), src: listing([["было.rs", false]], "src") });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["src"]));
    fireEvent.click(screen.getByTitle("src"));
    await waitFor(() => expect(names()).toEqual(["src", "было.rs"]));

    await pick("src/было.rs", "Переименовать");
    fireEvent.change(screen.getByLabelText("Имя"), {
      target: { value: "стало.rs" },
    });
    fireEvent.keyDown(screen.getByLabelText("Имя"), { key: "Enter" });

    await waitFor(() =>
      expect(renameEntry).toHaveBeenCalledWith("w1", "src/было.rs", "src/стало.rs"),
    );
  });

  it("asks before deleting anything", async () => {
    serve({ "": listing([["важное.txt", false]]) });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["важное.txt"]));

    await pick("важное.txt", "Удалить");

    // Удаление необратимо, и один промах по пункту меню не должен его
    // выполнять.
    expect(deleteEntry).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText(/Удалить «важное.txt»/)).toBeInTheDocument(),
    );
  });

  it("deletes once the question is answered", async () => {
    serve({ "": listing([["лишнее.txt", false]]) });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["лишнее.txt"]));
    await pick("лишнее.txt", "Удалить");
    await waitFor(() =>
      expect(screen.getByText(/Удалить «лишнее.txt»/)).toBeInTheDocument(),
    );

    const buttons = screen.getAllByRole("button", { name: "Удалить" });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() =>
      expect(deleteEntry).toHaveBeenCalledWith("w1", "лишнее.txt"),
    );
  });

  it("drops the name it was typing when told to", async () => {
    serve({ "": listing([["a.txt", false]]) });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["a.txt"]));

    await pick("a.txt", "Создать файл");
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "зря" } });
    fireEvent.keyDown(screen.getByLabelText("Имя"), { key: "Escape" });

    expect(createEntry).not.toHaveBeenCalled();
  });

  it("hands the path to the system to reveal", async () => {
    serve({ "": listing([["a.txt", false]]) });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["a.txt"]));

    await pick("a.txt", "Показать в системе");

    await waitFor(() => expect(revealEntry).toHaveBeenCalledWith("w1", "a.txt"));
  });

  it("shows what the search found instead of the tree", async () => {
    vi.useFakeTimers();
    try {
      serve({ "": listing([["src", true]]) });
      searchTree.mockResolvedValue(
        listing([["FileTree.tsx", false]], "src/panels"),
      );
      render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
      await vi.waitFor(() => expect(names()).toEqual(["src"]));

      fireEvent.change(screen.getByLabelText("Поиск по имени"), {
        target: { value: "tree" },
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      await vi.waitFor(() => expect(names()).toEqual(["FileTree.tsx"]));
      expect(searchTree).toHaveBeenCalledWith("w1", "tree");
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits out the typing before going to disk", async () => {
    vi.useFakeTimers();
    try {
      serve({ "": listing([["src", true]]) });
      render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
      await vi.waitFor(() => expect(names()).toEqual(["src"]));
      const box = screen.getByLabelText("Поиск по имени");

      for (const value of ["t", "tr", "tre", "tree"]) {
        fireEvent.change(box, { target: { value } });
        await act(async () => {
          vi.advanceTimersByTime(40);
        });
      }
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      // Печатают быстро, а поиск идёт на диск: без паузы каждый символ
      // запускал бы обход всего проекта, и отвечали бы они вразнобой.
      expect(searchTree).toHaveBeenCalledTimes(1);
      expect(searchTree).toHaveBeenCalledWith("w1", "tree");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says plainly when the search found nothing", async () => {
    vi.useFakeTimers();
    try {
      serve({ "": listing([["src", true]]) });
      render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
      await vi.waitFor(() => expect(names()).toEqual(["src"]));

      fireEvent.change(screen.getByLabelText("Поиск по имени"), {
        target: { value: "такого-нет" },
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      // Пустое дерево читалось бы как пустой проект.
      await vi.waitFor(() =>
        expect(screen.getByText("Ничего не нашлось")).toBeInTheDocument(),
      );
      // И поле остаётся на месте: очистить запрос надо уметь и отсюда.
      expect(screen.getByLabelText("Поиск по имени")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("brings the tree back when the query is cleared", async () => {
    vi.useFakeTimers();
    try {
      serve({ "": listing([["src", true]]) });
      searchTree.mockResolvedValue(listing([["найдено.txt", false]]));
      render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
      await vi.waitFor(() => expect(names()).toEqual(["src"]));
      const box = screen.getByLabelText("Поиск по имени");
      fireEvent.change(box, { target: { value: "най" } });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      await vi.waitFor(() => expect(names()).toEqual(["найдено.txt"]));

      fireEvent.change(box, { target: { value: "" } });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      await vi.waitFor(() => expect(names()).toEqual(["src"]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates at the project root from the header", async () => {
    serve({ "": listing([["src", true]]) });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["src"]));

    fireEvent.click(screen.getByRole("button", { name: "Создать папку" }));
    fireEvent.change(screen.getByLabelText("Имя"), {
      target: { value: "новая" },
    });
    fireEvent.keyDown(screen.getByLabelText("Имя"), { key: "Enter" });

    // Из шапки — в корень: у неё нет выбранной строки, и класть рядом не с чем.
    await waitFor(() =>
      expect(createEntry).toHaveBeenCalledWith("w1", "новая", true),
    );
  });

  it("folds the whole tree back up", async () => {
    serve({
      "": listing([["src", true]]),
      src: listing([["main.rs", false]], "src"),
    });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["src"]));
    fireEvent.click(screen.getByTitle("src"));
    await waitFor(() => expect(names()).toEqual(["src", "main.rs"]));

    fireEvent.click(screen.getByRole("button", { name: "Свернуть всё" }));

    await waitFor(() => expect(names()).toEqual(["src"]));
  });

  it("offers nothing to fold while nothing is open", async () => {
    serve({ "": listing([["src", true]]) });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["src"]));

    // Живая кнопка, которая ничего не делает, врёт о состоянии дерева.
    expect(screen.getByRole("button", { name: "Свернуть всё" })).toBeDisabled();
  });

  it("hides the column when asked", async () => {
    const closed = vi.fn();
    serve({ "": listing([["a.txt", false]]) });
    render(
      <FileTree workspaceId="w1" onOpenFile={() => {}} onClose={closed} />,
    );
    await waitFor(() => expect(names()).toEqual(["a.txt"]));

    fireEvent.click(screen.getByRole("button", { name: "Скрыть дерево" }));

    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("keeps its header while there is nothing to show", async () => {
    serve({ "": listing([]) });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText("В проекте пусто")).toBeInTheDocument(),
    );
    // Создать первый файл надо уметь именно в пустом проекте — иначе кнопки
    // появляются только там, где без них уже обошлись.
    expect(
      screen.getByRole("button", { name: "Создать файл" }),
    ).toBeInTheDocument();
  });

  /// Классы строки: по ним видно, что дерево считает новым.
  function classesOf(name: string): string {
    return screen.getByTitle(name).className;
  }

  it("moves in only the rows that just appeared", async () => {
    serve({
      "": listing([["src", true], ["README.md", false]]),
      src: listing([["main.rs", false]], "src"),
    });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["src", "README.md"]));

    fireEvent.click(screen.getByTitle("src"));
    await waitFor(() =>
      expect(names()).toEqual(["src", "main.rs", "README.md"]),
    );

    // Въезжает только содержимое раскрытой папки. Если бы въезжало всё, одно
    // раскрытие дёргало бы дерево целиком.
    expect(classesOf("src/main.rs")).toContain("is-arriving");
    expect(classesOf("README.md")).not.toContain("is-arriving");
    expect(classesOf("src")).not.toContain("is-arriving");
  });

  it("does not stage an entrance for the tree it starts with", async () => {
    serve({ "": listing([["a.txt", false], ["b.txt", false]]) });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["a.txt", "b.txt"]));

    // Первый показ — это не появление: дерево уже было там, куда посмотрели.
    expect(classesOf("a.txt")).not.toContain("is-arriving");
  });

  it("flashes a file that appeared on disk by itself", async () => {
    let current = listing([["старый.txt", false]]);
    readWorkspaceDir.mockImplementation(() => Promise.resolve(current));
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["старый.txt"]));

    current = listing([["новый.txt", false], ["старый.txt", false]]);
    await act(async () => announce?.([""], false));
    await waitFor(() =>
      expect(names()).toEqual(["новый.txt", "старый.txt"]),
    );

    // Мало показать файл, созданный агентом, — надо показать где он.
    expect(classesOf("новый.txt")).toContain("is-fresh");
    expect(classesOf("старый.txt")).not.toContain("is-fresh");
  });

  it("does not flash what was merely unfolded", async () => {
    serve({
      "": listing([["src", true]]),
      src: listing([["main.rs", false]], "src"),
    });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["src"]));

    fireEvent.click(screen.getByTitle("src"));
    await waitFor(() => expect(names()).toEqual(["src", "main.rs"]));

    // Вспышка значит «появилось на диске». Раскрытие — это не появление, и
    // вспыхивать на нём значит обесценить сам знак.
    expect(classesOf("src/main.rs")).not.toContain("is-fresh");
  });

  it("puts the name field inside the folder it will land in", async () => {
    serve({
      "": listing([["src", true], ["README.md", false]]),
      src: listing([["main.rs", false]], "src"),
    });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["src", "README.md"]));

    fireEvent.contextMenu(screen.getByTitle("src"));
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("menuitem", { name: "Создать файл" }));

    // Поле встаёт под своей папкой и с её вложенностью. Сверху списка оно
    // сообщало бы не то место, куда файл ляжет.
    const field = await screen.findByLabelText("Имя");
    const draft = field.closest(".file-row") as HTMLElement;
    const rows = Array.from(
      document.querySelectorAll(".file-tree > .file-row"),
    );
    expect(rows.indexOf(draft)).toBe(1);
    expect(draft.style.getPropertyValue("--file-depth")).toBe("1");
  });

  it("shows what is being created beside the field", async () => {
    serve({ "": listing([["a.txt", false]]) });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["a.txt"]));

    fireEvent.click(screen.getByRole("button", { name: "Создать папку" }));

    const field = await screen.findByLabelText("Имя");
    const glyph = field.parentElement?.querySelector(".file-glyph svg");
    // Без значка «создать файл» и «создать папку» выглядят одинаково, и
    // ошибиться можно уже после того, как имя набрано.
    expect(glyph).toBeTruthy();
  });

  it("keeps the name field inside the column", async () => {
    serve({ "": listing([["a.txt", false]]) });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["a.txt"]));

    fireEvent.click(screen.getByRole("button", { name: "Создать файл" }));

    // Поле занимает остаток строки, а не её ширину: со `width: 100%` вместе с
    // рамкой оно вылезало за колонку — общего border-box в проекте нет.
    const field = await screen.findByLabelText("Имя");
    expect(field.className).not.toContain("file-row");
    expect(field.closest(".file-row")).toBeTruthy();
  });

  it("asks to delete from the keyboard just as from the menu", async () => {
    serve({ "": listing([["важное.txt", false], ["сосед.txt", false]]) });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() =>
      expect(names()).toEqual(["важное.txt", "сосед.txt"]),
    );

    fireEvent.keyDown(screen.getByRole("tree"), { key: "Delete" });

    // Клавиша рядом со стрелками — тем более не повод обходиться без вопроса.
    expect(deleteEntry).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText(/Удалить «важное.txt»/)).toBeInTheDocument(),
    );
  });

  it("deletes the row the keyboard was on, not the first one", async () => {
    serve({ "": listing([["первый.txt", false], ["второй.txt", false]]) });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() =>
      expect(names()).toEqual(["первый.txt", "второй.txt"]),
    );
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });

    fireEvent.keyDown(tree, { key: "Backspace" });

    await waitFor(() =>
      expect(screen.getByText(/Удалить «второй.txt»/)).toBeInTheDocument(),
    );
  });

  it("moves the keyboard onto a neighbour of what it deleted", async () => {
    serve({
      "": listing([["первый.txt", false], ["второй.txt", false]]),
    });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() =>
      expect(names()).toEqual(["первый.txt", "второй.txt"]),
    );
    fireEvent.keyDown(screen.getByRole("tree"), { key: "Delete" });
    await waitFor(() =>
      expect(screen.getByText(/Удалить «первый.txt»/)).toBeInTheDocument(),
    );

    const buttons = screen.getAllByRole("button", { name: "Удалить" });
    fireEvent.click(buttons[buttons.length - 1]);

    // Строки под курсором больше не будет, и клавиатура иначе осталась бы ни
    // на чём: следующее нажатие стрелки прыгнуло бы в начало списка.
    await waitFor(() => expect(deleteEntry).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.getByTitle("второй.txt").getAttribute("tabindex"),
      ).toBe("0"),
    );
  });

  it("leaves the delete key to the search box while typing there", async () => {
    serve({ "": listing([["файл.txt", false]]) });
    render(<FileTree workspaceId="w1" onOpenFile={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["файл.txt"]));

    fireEvent.keyDown(screen.getByLabelText("Поиск по имени"), {
      key: "Delete",
    });

    // Стирать букву в запросе не значит удалять файл.
    expect(screen.queryByText(/Удалить «/)).not.toBeInTheDocument();
  });

  it("tells the editor that the path is gone", async () => {
    const removed = vi.fn();
    serve({ "": listing([["лишнее.txt", false]]) });
    render(
      <FileTree workspaceId="w1" onOpenFile={() => {}} onRemoved={removed} />,
    );
    await waitFor(() => expect(names()).toEqual(["лишнее.txt"]));
    await pick("лишнее.txt", "Удалить");
    await waitFor(() =>
      expect(screen.getByText(/Удалить «лишнее.txt»/)).toBeInTheDocument(),
    );

    const buttons = screen.getAllByRole("button", { name: "Удалить" });
    fireEvent.click(buttons[buttons.length - 1]);

    // Иначе вкладка удалённого файла остаётся и предлагает сохранить его в
    // никуда.
    await waitFor(() => expect(removed).toHaveBeenCalledWith("лишнее.txt"));
  });

  it("says nothing when the deletion failed", async () => {
    const removed = vi.fn();
    deleteEntry.mockRejectedValue({ code: "workspaceRootUnavailable" });
    serve({ "": listing([["занятое.txt", false]]) });
    render(
      <FileTree workspaceId="w1" onOpenFile={() => {}} onRemoved={removed} />,
    );
    await waitFor(() => expect(names()).toEqual(["занятое.txt"]));
    await pick("занятое.txt", "Удалить");
    await waitFor(() =>
      expect(screen.getByText(/Удалить «занятое.txt»/)).toBeInTheDocument(),
    );

    const buttons = screen.getAllByRole("button", { name: "Удалить" });
    fireEvent.click(buttons[buttons.length - 1]);

    // Файл на месте — закрывать его вкладку не за что.
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(removed).not.toHaveBeenCalled();
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
