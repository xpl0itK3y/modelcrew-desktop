import { describe, expect, it } from "vitest";
import { extractPanelTail, joinWrappedRows } from "./panelTail";

// Экран Codex после ответа: рамка, реплики, подсказка композера и статусная
// строка внизу. Ровно то, что попадало в баннер криво.
const CODEX_SCREEN = [
  "  • Скорее да, но с оговорками. Это хороший амбициозный open-source проект.",
  "",
  "  Мой вывод: для личного self-hosted использования — хороший проект; для",
  "  критичных данных пока сомнительный выбор.",
  "",
  "╭──────────────────────────────────────────────────────────╮",
  "│ › Summarize recent commits                               │",
  "╰──────────────────────────────────────────────────────────╯",
  "  gpt-5.6-sol · high · Context 92% left · 41K used · odysseus · dev",
];

describe("extractPanelTail", () => {
  it("takes the last paragraph, not the composer or the status bar", () => {
    expect(extractPanelTail(CODEX_SCREEN)).toBe(
      "Мой вывод: для личного self-hosted использования — хороший проект; для" +
        " критичных данных пока сомнительный выбор.",
    );
  });

  it("skips input lines even when they sit inside a box", () => {
    const tail = extractPanelTail([
      "Готово, файлы обновлены.",
      "│ › а он хорош проект?                     │",
    ]);

    expect(tail).toBe("Готово, файлы обновлены.");
  });

  it("falls back to the last meaningful line when nothing reads as a sentence", () => {
    expect(
      extractPanelTail(["╭────────╮", "⠋ собираю проект", "▌▌▌▌"]),
    ).toBe("собираю проект");
  });

  it("returns nothing when only decoration is left", () => {
    expect(extractPanelTail(["────────────", "▌▌▌▌", "⠴⠦⠧", "❯", "  "])).toBe(
      null,
    );
  });

  it("stops collecting the paragraph at the banner budget", () => {
    const long = "слово ".repeat(30).trim();

    const tail = extractPanelTail([long, "Итог: всё готово и проверено."]);

    expect(tail).toBe("Итог: всё готово и проверено.");
  });

  it("collapses whitespace", () => {
    expect(extractPanelTail(["первая   строка\tи   ещё."])).toBe(
      "первая строка и ещё.",
    );
  });
});

describe("joinWrappedRows", () => {
  it("glues a line the terminal wrapped by window width", () => {
    const joined = joinWrappedRows([
      { text: "Мой вывод: для личного использова", wrapped: false },
      { text: "ния это хороший проект.", wrapped: true },
      { text: "Следующая строка", wrapped: false },
    ]);

    expect(joined).toEqual([
      "Мой вывод: для личного использования это хороший проект.",
      "Следующая строка",
    ]);
  });

  it("keeps a leading continuation as its own line", () => {
    // Начало фразы осталось выше окна просмотра — склеивать не с чем.
    expect(joinWrappedRows([{ text: "конец фразы.", wrapped: true }])).toEqual([
      "конец фразы.",
    ]);
  });
});
