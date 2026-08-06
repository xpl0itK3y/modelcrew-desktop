// Колонка редактора: вкладки открытых файлов.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";

const readRepoFile = vi.fn();
const writeRepoFile = vi.fn();
vi.mock("../git/gitChanges", () => ({
  readRepoFile: (...args: unknown[]) => readRepoFile(...args),
  writeRepoFile: (...args: unknown[]) => writeRepoFile(...args),
}));

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
  readRepoFile.mockReset();
  writeRepoFile.mockReset();
  readRepoFile.mockResolvedValue(file("текст"));
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
    readRepoFile.mockImplementation((_id: string, path: string) =>
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
    writeRepoFile.mockResolvedValue(undefined);
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
      expect(writeRepoFile).toHaveBeenCalledWith("w1", "a.txt", "сохранённое"),
    );
    // Метка обязана погаснуть: иначе она перестаёт что-либо значить.
    await waitFor(() =>
      expect(
        screen.queryByTitle("Есть несохранённая правка"),
      ).not.toBeInTheDocument(),
    );
  });
});
