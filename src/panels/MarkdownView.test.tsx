// Просмотр разметки: что он показывает и чего никогда не делает.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";

const openUrl = vi.fn((_url: string) => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => openUrl(url),
}));

const { MarkdownView } = await import("./MarkdownView");

beforeEach(() => {
  openUrl.mockClear();
  setLocale("ru");
});

describe("MarkdownView", () => {
  it("shows a document the way it was written", () => {
    render(
      <MarkdownView
        text={[
          "# Первый",
          "",
          "Абзац с *наклоном*.",
          "",
          "> цитата",
          "",
          "| имя | что |",
          "| --- | --- |",
          "| a | раз |",
        ].join("\n")}
      />,
    );

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Первый");
    expect(document.querySelector("em")?.textContent).toBe("наклоном");
    expect(document.querySelector("blockquote")?.textContent).toContain("цитата");
    expect(document.querySelectorAll("th")).toHaveLength(2);
    expect(document.querySelectorAll("td")[1]?.textContent).toBe("раз");
  });

  it("opens an outside link outside, and never in this window", () => {
    // Обычный переход увёл бы всё окно приложения на чужую страницу, и
    // вернуться было бы нечем: ни адресной строки, ни кнопки «назад».
    render(<MarkdownView text="читайте [тут](https://ya.ru)" />);
    const link = screen.getByText("тут");

    fireEvent.click(link);

    expect(openUrl).toHaveBeenCalledWith("https://ya.ru");
  });

  it("does not pretend a link to a neighbouring file leads anywhere", () => {
    render(<MarkdownView text="смотри [рядом](./OTHER.md) и [якорь](#глава)" />);

    fireEvent.click(screen.getByText("рядом"));
    fireEvent.click(screen.getByText("якорь"));

    expect(openUrl).not.toHaveBeenCalled();
    expect(screen.getByText("рядом").className).toContain("is-local");
  });

  it("never lets the document bring its own markup", () => {
    // Файл пишет агент. Тег, скрипт или обработчик, набранный в нём, обязан
    // доехать до читателя буквами: путь от чужого текста к исполняемому коду
    // не должен существовать вовсе.
    const attack = '<img src=x onerror="boom()"> и <script>boom()</script>';
    render(<MarkdownView text={attack} />);

    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain(attack);
  });

  it("says plainly when there is nothing to show", () => {
    // Скобки не для красоты: в JSX внутри кавычек обратный слэш ничего не
    // экранирует, и перевод строки пришёл бы сюда двумя буквами.
    render(<MarkdownView text={"   \n\n  "} />);

    expect(screen.getByText("В файле пусто")).toBeInTheDocument();
  });
});
