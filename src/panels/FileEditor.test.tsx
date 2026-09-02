// Колонка редактора: вкладки открытых файлов.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";

const readWorkspaceFile = vi.fn();
const writeWorkspaceFile = vi.fn();
/// Вотчер один, а подписчиков сколько открыто вкладок: событие получают все.
/// Держать только последнего — значит проверять не то, что происходит.
const watchers = new Set<(dirs: string[], partial: boolean) => void>();
function announce(dirs: string[], partial: boolean): void {
  for (const listener of [...watchers]) {
    listener(dirs, partial);
  }
}
vi.mock("../files/fileTree", async () => {
  const actual =
    await vi.importActual<typeof import("../files/fileTree")>(
      "../files/fileTree",
    );
  return {
    ...actual,
    readWorkspaceFile: (...args: unknown[]) => readWorkspaceFile(...args),
    writeWorkspaceFile: (...args: unknown[]) => writeWorkspaceFile(...args),
    watchWorkspaceTree: (
      _id: string,
      onChanged: (dirs: string[], partial: boolean) => void,
    ) => {
      watchers.add(onChanged);
      return () => watchers.delete(onChanged);
    },
  };
});

/// Сводка git и версия файла из истории: по ним редактор считает, какие строки
/// ещё не закоммичены. Настоящие ходят в Tauri, которого в тестах нет.
const gitSummary = vi.fn();
const readHeadFile = vi.fn();
vi.mock("../git/gitChanges", async () => {
  const actual =
    await vi.importActual<typeof import("../git/gitChanges")>(
      "../git/gitChanges",
    );
  return {
    ...actual,
    subscribeGitChanges: (
      _workspaceId: string,
      listener: (summary: unknown) => void,
    ) => {
      listener(gitSummary());
      return () => {};
    },
    readHeadFile: (...args: unknown[]) => readHeadFile(...args),
  };
});

/// Картинка приезжает из бэкенда в base64. Настоящая ходит в Tauri, которого
/// в тестах нет.
const readWorkspaceMedia = vi.fn();
vi.mock("../files/media", async () => {
  const actual =
    await vi.importActual<typeof import("../files/media")>("../files/media");
  return {
    ...actual,
    readWorkspaceMedia: (...args: unknown[]) => readWorkspaceMedia(...args),
  };
});

const { FileEditor } = await import("./FileEditor");

function file(content: string) {
  return { content, isBinary: false, tooLarge: false, exists: true };
}

/// Поле видимого файла: у скрытых вкладок поля тоже смонтированы.
function visibleField(): HTMLElement | undefined {
  return screen
    .getAllByRole("textbox")
    .find((field) => {
      const slot = field.closest(".file-view-slot") as HTMLElement | null;
      return slot?.style.display !== "none";
    });
}

function tabs(): string[] {
  return screen
    .getAllByRole("tab")
    .map((tab) => tab.querySelector(".file-tab-name")?.textContent ?? "");
}

beforeEach(() => {
  readWorkspaceFile.mockReset();
  writeWorkspaceFile.mockReset();
  readWorkspaceFile.mockResolvedValue(file("текст"));
  gitSummary.mockReset();
  readHeadFile.mockReset();
  // По умолчанию проект — не репозиторий: сравнивать не с чем, меток нет, и
  // всё, что не про них, их не видит.
  gitSummary.mockReturnValue({ isRepo: false, files: [] });
  readHeadFile.mockResolvedValue({
    content: "",
    isBinary: false,
    tooLarge: false,
    exists: false,
  });
  watchers.clear();
  readWorkspaceMedia.mockReset();
  readWorkspaceMedia.mockResolvedValue({
    mime: "image/png",
    data: "iVBOR",
    bytes: 4096,
    tooLarge: false,
    exists: true,
  });
  setLocale("ru");
});

/// Один открытый файл — этого хватает всему, что касается самого вида.
function open(path = "a.txt") {
  return render(
    <FileEditor
      workspaceId="w1"
      files={[path]}
      activePath={path}
      onSelect={() => {}}
      onClose={() => {}}
      width={520}
      dockWidth={800}
    />,
  );
}

describe("FileEditor", () => {
  it("stays out of the way while nothing is open", () => {
    const { container } = render(
      <FileEditor
        workspaceId="w1"
        files={[]}
        activePath={null}
        onSelect={() => {}}
        onClose={() => {}}
        width={520}
        dockWidth={800}
      />,
    );

    // Пустая колонка отнимала бы у терминалов половину окна ни за чем.
    expect(container).toBeEmptyDOMElement();
  });

  it("names every open file on its own tab", () => {
    render(
      <FileEditor
        workspaceId="w1"
        files={["src/main.rs", "README.md"]}
        activePath="README.md"
        onSelect={() => {}}
        onClose={() => {}}
        width={520}
        dockWidth={800}
      />,
    );

    // На вкладке имя, а не путь: путь не помещается, он в подсказке. Ищем
    // именно на вкладке — теперь смонтированы все открытые файлы, и путь
    // встречается ещё и в шапке каждого вида.
    expect(tabs()).toEqual(["main.rs", "README.md"]);
    const first = screen.getAllByRole("tab")[0];
    expect(first.querySelector(".file-tab-open")?.getAttribute("title")).toBe(
      "src/main.rs",
    );
  });

  it("shows the file that was chosen", async () => {
    readWorkspaceFile.mockImplementation((_id: string, path: string) =>
      Promise.resolve(file(`внутри ${path}`)),
    );

    render(
      <FileEditor
        workspaceId="w1"
        files={["a.txt", "b.txt"]}
        activePath="b.txt"
        onSelect={() => {}}
        onClose={() => {}}
        width={520}
        dockWidth={800}
      />,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("b.txt")).toHaveValue("внутри b.txt"),
    );
  });

  it("falls back to the first tab when the chosen file is gone", async () => {
    // Закрыли видимый файл, а новый выбор ещё не доехал: показать пустоту
    // нельзя — под вкладками должен быть файл.
    render(
      <FileEditor
        workspaceId="w1"
        files={["a.txt"]}
        activePath="закрытый.txt"
        onSelect={() => {}}
        onClose={() => {}}
        width={520}
        dockWidth={800}
      />,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toBeInTheDocument(),
    );
  });

  it("asks to close exactly the file whose cross was clicked", () => {
    const closed = vi.fn();
    render(
      <FileEditor
        workspaceId="w1"
        files={["a.txt", "b.txt"]}
        activePath="a.txt"
        onSelect={() => {}}
        onClose={closed}
        width={520}
        dockWidth={800}
      />,
    );

    fireEvent.click(screen.getByLabelText("Закрыть файл: b.txt"));

    expect(closed).toHaveBeenCalledWith("b.txt");
  });

  it("keeps an unsaved edit while another tab is looked at", async () => {
    readWorkspaceFile.mockImplementation((_id: string, path: string) =>
      Promise.resolve(file(`внутри ${path}`)),
    );
    const view = render(
      <FileEditor
        workspaceId="w1"
        files={["a.txt", "b.txt"]}
        activePath="a.txt"
        onSelect={() => {}}
        onClose={() => {}}
        width={520}
        dockWidth={800}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("внутри a.txt"),
    );
    fireEvent.change(screen.getByLabelText("a.txt"), {
      target: { value: "моя правка" },
    });

    view.rerender(
      <FileEditor
        workspaceId="w1"
        files={["a.txt", "b.txt"]}
        activePath="b.txt"
        onSelect={() => {}}
        onClose={() => {}}
        width={520}
        dockWidth={800}
      />,
    );
    await waitFor(() => expect(visibleField()).toHaveValue("внутри b.txt"));
    view.rerender(
      <FileEditor
        workspaceId="w1"
        files={["a.txt", "b.txt"]}
        activePath="a.txt"
        onSelect={() => {}}
        onClose={() => {}}
        width={520}
        dockWidth={800}
      />,
    );

    // Правка на месте. Раньше вид перемонтировался по пути, и возвращение на
    // вкладку показывало файл, перечитанный с диска, — работа исчезала молча.
    await waitFor(() => expect(screen.getByLabelText("a.txt")).toHaveValue("моя правка"));
  });

  it("asks before closing a tab that holds unsaved work", async () => {
    const closed = vi.fn();
    render(
      <FileEditor
        workspaceId="w1"
        files={["a.txt"]}
        activePath="a.txt"
        onSelect={() => {}}
        onClose={closed}
        width={520}
        dockWidth={800}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("текст"),
    );
    fireEvent.change(screen.getByLabelText("a.txt"), {
      target: { value: "не сохранил" },
    });
    await waitFor(() =>
      expect(screen.getByTitle("Есть несохранённая правка")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByLabelText("Закрыть файл: a.txt"));

    // Закрытая вкладка уносит работу, а вернуть её неоткуда.
    expect(closed).not.toHaveBeenCalled();
    expect(
      screen.getByText(/есть несохранённая правка/i),
    ).toBeInTheDocument();
  });

  it("closes a clean tab without a word", async () => {
    const closed = vi.fn();
    render(
      <FileEditor
        workspaceId="w1"
        files={["a.txt"]}
        activePath="a.txt"
        onSelect={() => {}}
        onClose={closed}
        width={520}
        dockWidth={800}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("текст"),
    );

    fireEvent.click(screen.getByLabelText("Закрыть файл: a.txt"));

    // Вопрос там, где терять нечего, — это лишний щелчок на каждое закрытие.
    expect(closed).toHaveBeenCalledWith("a.txt");
  });

  it("paints the code under the very text being edited", async () => {
    readWorkspaceFile.mockResolvedValue(file('const x = 1; // хвост'));

    render(
      <FileEditor
        workspaceId="w1"
        files={["main.ts"]}
        activePath="main.ts"
        onSelect={() => {}}
        onClose={() => {}}
        width={520}
        dockWidth={800}
      />,
    );

    await waitFor(() =>
      expect(document.querySelector(".tok-keyword")).toHaveTextContent("const"),
    );
    expect(document.querySelector(".tok-comment")).toHaveTextContent("// хвост");
    // И слой подсветки повторяет текст целиком: поле ввода лежит поверх него,
    // и любое расхождение сдвинет курсор относительно букв.
    const painted = document.querySelector(".file-view-paint")?.textContent;
    expect(painted?.startsWith("const x = 1; // хвост")).toBe(true);
  });

  it("leaves a file it cannot read as plain text", async () => {
    readWorkspaceFile.mockResolvedValue(file("просто текст"));

    render(
      <FileEditor
        workspaceId="w1"
        files={["ЛИЦЕНЗИЯ"]}
        activePath="ЛИЦЕНЗИЯ"
        onSelect={() => {}}
        onClose={() => {}}
        width={520}
        dockWidth={800}
      />,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("ЛИЦЕНЗИЯ")).toHaveValue("просто текст"),
    );
    // Выдуманная разметка мешает сильнее, чем её отсутствие.
    expect(document.querySelector(".tok-keyword")).toBeNull();
  });

  it("keeps showing its tabs while it is leaving", () => {
    // Колонку сняли с показа, но кадр исчезания ещё идёт: опустевшая на кадр
    // колонка мигнула бы пустотой перед уходом.
    const { container } = render(
      <FileEditor
        workspaceId="w1"
        files={["a.txt"]}
        activePath="a.txt"
        onSelect={() => {}}
        onClose={() => {}}
        width={520}
        dockWidth={800}
        leaving
      />,
    );

    expect(tabs()).toEqual(["a.txt"]);
    expect(container.querySelector(".file-editor")?.className).toContain(
      "is-leaving",
    );
  });

  it("marks a tab whose file has unsaved work", async () => {
    render(
      <FileEditor
        workspaceId="w1"
        files={["a.txt"]}
        activePath="a.txt"
        onSelect={() => {}}
        onClose={() => {}}
        width={520}
        dockWidth={800}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("текст"),
    );

    fireEvent.change(screen.getByLabelText("a.txt"), {
      target: { value: "текст с правкой" },
    });

    // Без метки закрытая вкладка уносит правку молча.
    await waitFor(() =>
      expect(screen.getByTitle("Есть несохранённая правка")).toBeInTheDocument(),
    );
  });

  it("drops the mark once the file is saved", async () => {
    writeWorkspaceFile.mockResolvedValue(undefined);
    render(
      <FileEditor
        workspaceId="w1"
        files={["a.txt"]}
        activePath="a.txt"
        onSelect={() => {}}
        onClose={() => {}}
        width={520}
        dockWidth={800}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("текст"),
    );
    fireEvent.change(screen.getByLabelText("a.txt"), {
      target: { value: "сохранённое" },
    });
    await waitFor(() =>
      expect(screen.getByTitle("Есть несохранённая правка")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(writeWorkspaceFile).toHaveBeenCalledWith("w1", "a.txt", "сохранённое"),
    );
    // Метка обязана погаснуть: иначе она перестаёт что-либо значить.
    await waitFor(() =>
      expect(
        screen.queryByTitle("Есть несохранённая правка"),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("FileView on a long file", () => {
  function gutter(): HTMLElement | null {
    return document.querySelector(".file-view-lines");
  }

  /// jsdom не считает раскладки: подставляем ту, что поле имело бы на экране.
  /// Без этого окно показа всегда стоит на первой строке, и его переезд —
  /// главное, что здесь может сломаться, — проверить нечем.
  let scrolled = 0;
  function measureAs(lineCount: number, lineHeight = 19, visible = 400) {
    scrolled = 0;
    for (const [name, value] of [
      ["scrollHeight", lineCount * lineHeight],
      ["clientHeight", visible],
    ] as const) {
      Object.defineProperty(HTMLTextAreaElement.prototype, name, {
        configurable: true,
        get: () => value,
      });
    }
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollTop", {
      configurable: true,
      get: () => scrolled,
      set: (value: number) => {
        scrolled = value;
      },
    });
  }

  afterEach(() => {
    for (const name of ["scrollHeight", "clientHeight", "scrollTop"]) {
      Reflect.deleteProperty(HTMLTextAreaElement.prototype, name);
    }
  });

  it("numbers the lines", async () => {
    readWorkspaceFile.mockResolvedValue(file("первая\nвторая\nтретья"));
    open();
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue(
        "первая\nвторая\nтретья",
      ),
    );

    expect(gutter()?.textContent).toBe("1 \n2 \n3 \n");
  });

  it("paints a window of a long file, not the whole of it", async () => {
    const long = Array.from(
      { length: 5_000 },
      (_, index) => `const строка${index} = ${index};`,
    ).join("\n");
    readWorkspaceFile.mockResolvedValue(file(long));
    open("app.js");
    await waitFor(() =>
      expect(screen.getByLabelText("app.js")).toHaveValue(long),
    );
    const paint = document.querySelector(".file-view-paint");

    // Нарисовано окно, а не файл: по элементу на токен на все пять тысяч строк
    // — это сорок пять тысяч элементов, и прокрутка на них рвётся. Видно всё
    // равно экран.
    const drawn = paint?.textContent
      ?.split("\n")
      .filter((line) => line.length > 0).length;
    expect(drawn).toBe(600);
    // Но высота слоя обязана остаться прежней: строки до окна и после него —
    // ровно столько переводов строки, сколько их в файле. Иначе подсветка
    // разъедется с текстом, который лежит поверх неё.
    expect(paint?.textContent?.split("\n").length).toBe(5_001);
    expect(gutter()?.textContent?.split("\n").length).toBe(5_001);
  });

  it("moves the window to where the file was scrolled", async () => {
    const long = Array.from(
      { length: 5_000 },
      (_, index) => `строка ${index + 1}`,
    ).join("\n");
    measureAs(5_000);
    readWorkspaceFile.mockResolvedValue(file(long));
    open("app.js");
    const field = await screen.findByLabelText("app.js");
    await waitFor(() => expect(field).toHaveValue(long));

    field.scrollTop = 2_400 * 19;
    fireEvent.scroll(field);

    // Окно уехало за взглядом…
    await waitFor(() =>
      expect(gutter()?.textContent).toContain("\n2401 \n"),
    );
    const paint = document.querySelector(".file-view-paint");
    expect(paint?.textContent).toContain("строка 2401");
    // …а высота обоих слоёв осталась прежней: строки до окна — это ровно
    // столько же переводов строки. Иначе подсветка и номера съезжают вверх на
    // всё, что не нарисовано, и текст остаётся сам по себе.
    expect(paint?.textContent?.split("\n").length).toBe(5_001);
    expect(gutter()?.textContent?.split("\n").length).toBe(5_001);
  });
});

describe("FileView and the disk under it", () => {
  it("picks up what the agent wrote while the file sat untouched", async () => {
    open();
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("текст"),
    );

    readWorkspaceFile.mockResolvedValue(file("написанное агентом"));
    act(() => announce([""], false));

    // Нетронутый буфер догоняет диск сам: это то же самое, что открыть файл
    // заново, только без щелчка.
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("написанное агентом"),
    );
  });

  it("says so instead of quietly replacing work in progress", async () => {
    open();
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("текст"),
    );
    fireEvent.change(screen.getByLabelText("a.txt"), {
      target: { value: "моя правка" },
    });

    readWorkspaceFile.mockResolvedValue(file("написанное агентом"));
    act(() => announce([""], false));

    // Правку из-под рук не забирают: пришедшее с диска предлагают, а не
    // подставляют.
    await screen.findByText("Файл изменился на диске, пока вы его правили");
    expect(screen.getByLabelText("a.txt")).toHaveValue("моя правка");
  });

  it("asks before saving over what appeared on disk", async () => {
    writeWorkspaceFile.mockResolvedValue(undefined);
    open();
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("текст"),
    );
    fireEvent.change(screen.getByLabelText("a.txt"), {
      target: { value: "моя правка" },
    });
    readWorkspaceFile.mockResolvedValue(file("написанное агентом"));
    act(() => announce([""], false));
    await screen.findByText("Файл изменился на диске, пока вы его правили");

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    // Это тот самый случай, ради которого приложение и написано: два автора у
    // одного файла. Сохранение стирало версию агента без единого слова.
    expect(writeWorkspaceFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить поверх" }));
    await waitFor(() =>
      expect(writeWorkspaceFile).toHaveBeenCalledWith("w1", "a.txt", "моя правка"),
    );
  });

  it("takes the disk version when that is what was asked", async () => {
    open();
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("текст"),
    );
    fireEvent.change(screen.getByLabelText("a.txt"), {
      target: { value: "моя правка" },
    });
    readWorkspaceFile.mockResolvedValue(file("написанное агентом"));
    act(() => announce([""], false));
    await screen.findByText("Файл изменился на диске, пока вы его правили");

    fireEvent.click(screen.getByRole("button", { name: "Прочитать заново" }));

    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("написанное агентом"),
    );
    expect(
      screen.queryByText("Файл изменился на диске, пока вы его правили"),
    ).not.toBeInTheDocument();
  });

  it("does not send every hidden tab to the disk on someone else's change", async () => {
    readWorkspaceFile.mockImplementation((_id: string, path: string) =>
      Promise.resolve(file(`внутри ${path}`)),
    );
    render(
      <FileEditor
        workspaceId="w1"
        files={["a.txt", "b.txt", "c.txt"]}
        activePath="a.txt"
        onSelect={() => {}}
        onClose={() => {}}
        width={520}
        dockWidth={800}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("внутри a.txt"),
    );
    readWorkspaceFile.mockClear();

    act(() => announce([""], false));

    // Агент правит файлы непрерывно, а вкладок открыто сколько открыто. Чтение
    // на каждую из них — это работа, которой никто не видит: пока окно ею
    // занято, за ним не успевает вывод терминалов.
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledTimes(1));
    expect(readWorkspaceFile).toHaveBeenCalledWith("w1", "a.txt");
  });

  it("catches up with the disk when a hidden tab is opened", async () => {
    readWorkspaceFile.mockImplementation((_id: string, path: string) =>
      Promise.resolve(file(`внутри ${path}`)),
    );
    const view = render(
      <FileEditor
        workspaceId="w1"
        files={["a.txt", "b.txt"]}
        activePath="a.txt"
        onSelect={() => {}}
        onClose={() => {}}
        width={520}
        dockWidth={800}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("b.txt")).toHaveValue("внутри b.txt"),
    );

    readWorkspaceFile.mockResolvedValue(file("переписано агентом"));
    act(() => announce([""], false));
    view.rerender(
      <FileEditor
        workspaceId="w1"
        files={["a.txt", "b.txt"]}
        activePath="b.txt"
        onSelect={() => {}}
        onClose={() => {}}
        width={520}
        dockWidth={800}
      />,
    );

    // Отложенное — не забытое: вкладка догоняет диск, когда её открывают.
    await waitFor(() =>
      expect(screen.getByLabelText("b.txt")).toHaveValue("переписано агентом"),
    );
  });

  it("says nothing when the change on disk is our own save", async () => {
    writeWorkspaceFile.mockResolvedValue(undefined);
    open();
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("текст"),
    );
    fireEvent.change(screen.getByLabelText("a.txt"), {
      target: { value: "сохранённое" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(writeWorkspaceFile).toHaveBeenCalled());

    readWorkspaceFile.mockResolvedValue(file("сохранённое"));
    act(() => announce([""], false));

    // Своё же сохранение возвращается событием вотчера. Полоска на него —
    // это предупреждение ни о чём, и цена ему та же: на следующее её уже не
    // читают.
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByText("Файл изменился на диске, пока вы его правили"),
    ).not.toBeInTheDocument();
  });
  it("spreads over everything and comes back where it was", async () => {
    // Колонка ограничена ради сетки терминалов — и правильно ограничена, — но
    // читать длинную строку в ней тесно. Разворот лежит поверх всего, а
    // раскладка под ним остаётся нетронутой и ждёт.
    const { container } = open();
    const editor = container.querySelector(".file-editor")!;
    expect(editor.className).not.toContain("is-maximized");

    fireEvent.click(screen.getByRole("button", { name: "Развернуть редактор" }));
    expect(editor.className).toContain("is-maximized");
    // Накрывает свою колонку и сетку — и ровно столько. Дерево и список
    // проектов остаются на виду: по ним переключаются, и прятать их значит
    // заставить свернуть редактор ради соседнего файла.
    expect((editor as HTMLElement).style.getPropertyValue("--maximized-width")).toBe(
      "calc(1320px + var(--mc-gap))",
    );
    // Место колонки в ряду занимает подставка: иначе сетка разъехалась бы на
    // него, а на возврате схлопнулась обратно.
    const placeholder = container.querySelector(".file-editor-placeholder");
    expect(placeholder).toBeInTheDocument();
    expect((placeholder as HTMLElement).style.width).toBe("520px");

    fireEvent.click(
      screen.getByRole("button", { name: "Вернуть редактор в колонку" }),
    );
    // Возврат — это движение обратно, а не подмена кадра: пока оно идёт,
    // колонка ещё поверх раскладки, и подставка держит её место. Снять их
    // сразу значило бы, что колонка исчезнет из-под курсора и появится левее.
    expect(editor.className).toContain("is-restoring");
    expect(editor.className).toContain("is-overlay");
    expect(container.querySelector(".file-editor-placeholder")).toBeInTheDocument();

    await waitFor(() =>
      expect(
        container.querySelector(".file-editor-placeholder"),
      ).not.toBeInTheDocument(),
    );
    expect(editor.className).not.toContain("is-overlay");
  });

  it("comes back on Escape, the first thing anyone presses", async () => {
    const { container } = open();
    fireEvent.click(screen.getByRole("button", { name: "Развернуть редактор" }));
    expect(container.querySelector(".file-editor")!.className).toContain(
      "is-maximized",
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(container.querySelector(".file-editor")!.className).not.toContain(
      "is-maximized",
    );
    await waitFor(() =>
      expect(container.querySelector(".file-editor")!.className).not.toContain(
        "is-overlay",
      ),
    );
  });
});

describe("FileView beside git", () => {
  function marks(): string[] {
    return [...document.querySelectorAll(".file-mark")].map((mark) =>
      mark.className.replace("file-mark ", ""),
    );
  }

  /// Сводка репозитория, в котором открытый файл уже правили.
  function inRepo(committed: string, prefix?: string) {
    gitSummary.mockReturnValue({
      isRepo: true,
      headHash: "abc",
      files: [],
      ...(prefix ? { prefix } : {}),
    });
    readHeadFile.mockResolvedValue({
      content: committed,
      isBinary: false,
      tooLarge: false,
      exists: true,
    });
  }

  it("marks the line that is not committed yet, and only it", async () => {
    inRepo("первая\nтретья");
    readWorkspaceFile.mockResolvedValue(file("первая\nвторая\nтретья"));
    open();
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue(
        "первая\nвторая\nтретья",
      ),
    );

    await waitFor(() => expect(marks()).toEqual(["is-added"]));
    // Номера от полоски не съезжают: она занимает место пробела, который стоит
    // после номера на каждой строке — покрашен он или нет.
    expect(
      document.querySelector(".file-view-lines")?.textContent,
    ).toBe("1 \n2 \n3 \n");
  });

  it("follows the text as it is typed, without waiting for a save", async () => {
    // Ради этого метки и считаются здесь, а не спрашиваются у `git diff`:
    // ответ git относится к файлу на диске, и первая же набранная строка
    // сдвинула бы все метки под ней на одну.
    inRepo("одна\nдве");
    readWorkspaceFile.mockResolvedValue(file("одна\nдве"));
    open();
    const field = await screen.findByLabelText("a.txt");
    await waitFor(() => expect(field).toHaveValue("одна\nдве"));
    await waitFor(() => expect(marks()).toEqual([]));

    fireEvent.change(field, { target: { value: "одна\nновая\nдве" } });

    await waitFor(() => expect(marks()).toEqual(["is-added"]));
    expect(writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it("tells a rewritten line from a new one and from a gone one", async () => {
    inRepo("одна\nдве\nтри\nчетыре");
    readWorkspaceFile.mockResolvedValue(file("одна\nДВЕ\nтри"));
    open();
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("одна\nДВЕ\nтри"),
    );

    // Вторую переписали, последняя пропала — и метка о пропаже стоит на строке
    // над ней, потому что самой строки в файле уже нет.
    await waitFor(() => expect(marks()).toEqual(["is-changed", "is-removed"]));
  });

  it("asks git for the file by the name git knows it under", async () => {
    // Проектом открыли подкаталог монорепозитория: пути git идут от корня
    // репозитория, и без приставки он ответил бы про несуществующий файл.
    inRepo("одна", "apps/web");
    readWorkspaceFile.mockResolvedValue(file("одна\nдве"));
    open();
    await waitFor(() =>
      expect(readHeadFile).toHaveBeenCalledWith("w1", "apps/web/a.txt"),
    );
  });

  it("marks the tab of a file that is not committed yet", async () => {
    // Колонку держат открытой подолгу, и вкладка остаётся единственным следом
    // файла, когда дерево прокручено совсем в другое место.
    gitSummary.mockReturnValue({
      isRepo: true,
      headHash: "abc",
      files: [{ path: "a.txt", status: "modified" }],
    });
    readWorkspaceFile.mockResolvedValue(file("одна"));
    open();
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("одна"),
    );

    await waitFor(() =>
      expect(
        document.querySelector(".file-tab")?.className,
      ).toContain("is-git-modified"),
    );
  });

  it("stays out of the way where there is no repository", async () => {
    readWorkspaceFile.mockResolvedValue(file("одна\nдве"));
    open();
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("одна\nдве"),
    );

    expect(readHeadFile).not.toHaveBeenCalled();
    expect(marks()).toEqual([]);
  });
});

describe("FileView on a markdown file", () => {
  function view(): HTMLElement | null {
    return document.querySelector(".markdown-view");
  }

  const doc = [
    "# Заголовок",
    "",
    "Абзац со **важным** и `кодом`.",
    "",
    "- пункт",
    "- второй",
    "",
    "```ts",
    "const a = 1;",
    "```",
  ].join("\n");

  it("shows the document instead of its source when the eye is pressed", async () => {
    readWorkspaceFile.mockResolvedValue(file(doc));
    open("README.md");
    await waitFor(() =>
      expect(screen.getByLabelText("README.md")).toHaveValue(doc),
    );
    // Пока не просили — редактор остаётся редактором.
    expect(view()).toBeNull();

    fireEvent.click(screen.getByLabelText("Показать разметку"));

    const shown = view();
    expect(shown).not.toBeNull();
    expect(shown?.querySelector("h1")?.textContent).toBe("Заголовок");
    expect(shown?.querySelector("strong")?.textContent).toBe("важным");
    expect(shown?.querySelectorAll("li")).toHaveLength(2);
    // Кодовый блок подсвечен своим языком, а не разметкой.
    expect(shown?.querySelector(".md-block-code .tok-keyword")?.textContent).toBe(
      "const",
    );
    // Поле ввода уходит вместе с исходником: показывать оба разом негде.
    expect(screen.queryByLabelText("README.md")).not.toBeInTheDocument();
  });

  it("shows what is in the buffer, not what is on disk", async () => {
    // Файл правят прямо сейчас, и просмотр обязан показывать правку: иначе он
    // рассказывает про версию, которой уже нет.
    readWorkspaceFile.mockResolvedValue(file("# Было"));
    open("README.md");
    const field = await screen.findByLabelText("README.md");
    fireEvent.change(field, { target: { value: "# Стало" } });

    fireEvent.click(screen.getByLabelText("Показать разметку"));

    expect(view()?.querySelector("h1")?.textContent).toBe("Стало");
  });

  it("remembers the choice for every markdown file after it", async () => {
    readWorkspaceFile.mockResolvedValue(file(doc));
    const first = open("README.md");
    await waitFor(() =>
      expect(screen.getByLabelText("README.md")).toHaveValue(doc),
    );
    fireEvent.click(screen.getByLabelText("Показать разметку"));
    expect(view()).not.toBeNull();
    first.unmount();

    // Тот, кто открывает разметку чтобы прочитать, открывает так каждый раз.
    open("OTHER.md");
    await waitFor(() => expect(view()).not.toBeNull());
    expect(screen.getByLabelText("Показать исходник")).toBeInTheDocument();
  });

  it("offers the eye only where there is markup to show", async () => {
    readWorkspaceFile.mockResolvedValue(file("const a = 1;"));
    open("app.ts");
    await waitFor(() =>
      expect(screen.getByLabelText("app.ts")).toHaveValue("const a = 1;"),
    );

    expect(screen.queryByLabelText("Показать разметку")).not.toBeInTheDocument();
  });
});

describe("FileEditor pictures", () => {
  it("opens a picture as a picture, not as a binary file", async () => {
    open("assets/logo.png");
    const shown = await screen.findByAltText("logo.png");
    expect(shown.getAttribute("src")).toBe("data:image/png;base64,iVBOR");
    // Текстового поля у картинки нет: править в ней нечего.
    expect(screen.queryByRole("textbox")).toBeNull();
    // И на диск за текстом никто не ходил.
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("keeps a drawing editable and still lets it be seen", async () => {
    const drawing = '<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>';
    readWorkspaceFile.mockResolvedValue(file(drawing));
    open("mark.svg");
    await waitFor(() =>
      expect(screen.getByLabelText("mark.svg")).toHaveValue(drawing),
    );
    // Разметку SVG подсвечиваем как разметку: значение атрибута — строка.
    expect(
      document.querySelector(".file-view-paint .tok-string")?.textContent,
    ).toBe('"http://www.w3.org/2000/svg"');

    fireEvent.click(screen.getByLabelText("Показать картинку"));

    const shown = screen.getByAltText("mark.svg");
    const source = shown.getAttribute("src") ?? "";
    expect(source.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(source.split(",")[1])).toBe(drawing);
  });

  it("draws what is in the buffer, not what is on disk", async () => {
    readWorkspaceFile.mockResolvedValue(file("<svg><rect /></svg>"));
    open("mark.svg");
    const field = await screen.findByLabelText("mark.svg");
    fireEvent.change(field, { target: { value: "<svg><circle /></svg>" } });

    fireEvent.click(screen.getByLabelText("Показать картинку"));

    const source = screen.getByAltText("mark.svg").getAttribute("src") ?? "";
    expect(decodeURIComponent(source.split(",")[1])).toBe("<svg><circle /></svg>");
  });
});

describe("FileEditor keys", () => {
  /// Поле открытого файла с курсором, поставленным в нужное место.
  async function field(content: string, from: number, to = from) {
    readWorkspaceFile.mockResolvedValue(file(content));
    open("app.ts");
    const found = (await screen.findByLabelText("app.ts")) as HTMLTextAreaElement;
    await waitFor(() => expect(found).toHaveValue(content));
    found.setSelectionRange(from, to);
    return found;
  }

  it("puts an indent in the field instead of leaving it", async () => {
    const found = await field("const a = 1;", 12);

    fireEvent.keyDown(found, { key: "Tab", code: "Tab" });

    expect(found).toHaveValue("const a = 1;  ");
  });

  it("takes the indent back on shift", async () => {
    const found = await field("  const a = 1;", 14);

    fireEvent.keyDown(found, { key: "Tab", code: "Tab", shiftKey: true });

    expect(found).toHaveValue("const a = 1;");
  });

  it("starts the new line under the one before it", async () => {
    const found = await field("  const a = {", 13);

    fireEvent.keyDown(found, { key: "Enter", code: "Enter" });

    expect(found).toHaveValue("  const a = {\n    ");
  });

  it("comments the line with the mark of its own language", async () => {
    const found = await field("const a = 1;", 0, 12);

    fireEvent.keyDown(found, { key: "/", code: "Slash", metaKey: true });

    expect(found).toHaveValue("// const a = 1;");
  });

  it("answers the shortcut whatever the keyboard is set to", async () => {
    // На русской раскладке ⌘/ приходит другой буквой, а клавиша та же.
    const found = await field("const a = 1;", 0, 12);

    fireEvent.keyDown(found, { key: ".", code: "Slash", metaKey: true });

    expect(found).toHaveValue("// const a = 1;");
  });

  it("doubles the line under the cursor", async () => {
    const found = await field("a();\nb();", 5);

    fireEvent.keyDown(found, {
      key: "d",
      code: "KeyD",
      metaKey: true,
      shiftKey: true,
    });

    expect(found).toHaveValue("a();\nb();\nb();");
  });

  it("carries a line up and back down", async () => {
    const found = await field("a();\nb();\nc();", 5);

    fireEvent.keyDown(found, { key: "ArrowUp", code: "ArrowUp", altKey: true });
    expect(found).toHaveValue("b();\na();\nc();");

    fireEvent.keyDown(found, {
      key: "ArrowDown",
      code: "ArrowDown",
      altKey: true,
    });
    expect(found).toHaveValue("a();\nb();\nc();");
  });

  it("deletes the line together with its break", async () => {
    const found = await field("a();\nb();\nc();", 5);

    fireEvent.keyDown(found, {
      key: "Backspace",
      code: "Backspace",
      metaKey: true,
    });

    expect(found).toHaveValue("a();\nc();");
  });

  it("leaves a file it must not edit alone", async () => {
    readWorkspaceFile.mockResolvedValue({
      content: "двоичное",
      isBinary: true,
      tooLarge: false,
      exists: true,
    });
    open("icon.icns");
    const found = (await screen.findByLabelText(
      "icon.icns",
    )) as HTMLTextAreaElement;
    found.setSelectionRange(0, 0);

    fireEvent.keyDown(found, { key: "Tab", code: "Tab" });

    expect(found).toHaveValue("двоичное");
  });
});
