// Колонка редактора: вкладки открытых файлов.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";

const readWorkspaceFile = vi.fn();
const writeWorkspaceFile = vi.fn();
/// Сообщить редактору о правке на диске так, как это делает вотчер дерева.
let announce: ((dirs: string[], partial: boolean) => void) | null = null;
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
      announce = onChanged;
      return () => {};
    },
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
  announce = null;
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

describe("FileView and the disk under it", () => {
  it("picks up what the agent wrote while the file sat untouched", async () => {
    open();
    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("текст"),
    );

    readWorkspaceFile.mockResolvedValue(file("написанное агентом"));
    act(() => announce?.([""], false));

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
    act(() => announce?.([""], false));

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
    act(() => announce?.([""], false));
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
    act(() => announce?.([""], false));
    await screen.findByText("Файл изменился на диске, пока вы его правили");

    fireEvent.click(screen.getByRole("button", { name: "Прочитать заново" }));

    await waitFor(() =>
      expect(screen.getByLabelText("a.txt")).toHaveValue("написанное агентом"),
    );
    expect(
      screen.queryByText("Файл изменился на диске, пока вы его правили"),
    ).not.toBeInTheDocument();
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
    act(() => announce?.([""], false));

    // Своё же сохранение возвращается событием вотчера. Полоска на него —
    // это предупреждение ни о чём, и цена ему та же: на следующее её уже не
    // читают.
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByText("Файл изменился на диске, пока вы его правили"),
    ).not.toBeInTheDocument();
  });
});
