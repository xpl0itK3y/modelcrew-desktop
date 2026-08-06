// Колонка редактора: вкладки открытых файлов.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";

const readWorkspaceFile = vi.fn();
const writeWorkspaceFile = vi.fn();
vi.mock("../files/fileTree", async () => {
  const actual =
    await vi.importActual<typeof import("../files/fileTree")>(
      "../files/fileTree",
    );
  return {
    ...actual,
    readWorkspaceFile: (...args: unknown[]) => readWorkspaceFile(...args),
    writeWorkspaceFile: (...args: unknown[]) => writeWorkspaceFile(...args),
  };
});

const { FileEditor } = await import("./FileEditor");

function file(content: string) {
  return { content, isBinary: false, tooLarge: false, exists: true };
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
  setLocale("ru");
});

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

    // На вкладке имя, а не путь: путь не помещается, он в подсказке.
    expect(tabs()).toEqual(["main.rs", "README.md"]);
    expect(screen.getByTitle("src/main.rs")).toBeInTheDocument();
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
