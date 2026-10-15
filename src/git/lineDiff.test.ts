// Построчный разбор: что именно правили в открытом файле.

import { describe, expect, it } from "vitest";
import { diffLines, type LineMark } from "./lineDiff";

function marksOf(committed: string | null, current: string): (LineMark | null)[] {
  const marks = diffLines(committed, current);
  return current.split("\n").map((_, line) => marks.get(line) ?? null);
}

describe("diffLines", () => {
  it("says nothing about a file nobody touched", () => {
    expect(diffLines("одна\nдве\nтри", "одна\nдве\nтри").size).toBe(0);
  });

  it("marks the lines that were added and only them", () => {
    expect(marksOf("одна\nтри", "одна\nдве\nтри")).toEqual([
      null,
      "added",
      null,
    ]);
  });

  it("tells a rewritten line from a new one", () => {
    // Правка строки приходит парой «убрали, добавили» — и это одна правка, а
    // не две: показать её как удаление плюс добавление значило бы соврать про
    // то, что произошло.
    expect(marksOf("одна\nдве\nтри", "одна\nДВЕ\nтри")).toEqual([
      null,
      "changed",
      null,
    ]);
  });

  it("puts the mark of a gone line on the one still above it", () => {
    // Самих удалённых строк в файле уже нет: повесить метку больше не на что.
    expect(marksOf("одна\nдве\nтри", "одна\nтри")).toEqual([
      "removed",
      null,
    ]);
  });

  it("keeps the mark inside the file when the gone lines were the first", () => {
    // Соседа сверху нет — метку принимает первая уцелевшая строка. Иначе она
    // указывала бы на строку с номером −1, и рисовать её было бы негде.
    expect(marksOf("одна\nдве\nтри", "три")).toEqual(["removed"]);
  });

  it("marks the whole file when there is nothing to compare it with", () => {
    // Файла ещё нет в истории: он новый весь, до последней строки.
    expect(marksOf(null, "одна\nдве")).toEqual(["added", "added"]);
    expect(marksOf(null, "")).toEqual(["added"]);
  });

  it("does not mark the lines an edit merely pushed down", () => {
    // Вставка в начале сдвигает весь файл, но не меняет в нём ни строки.
    // Разбор по номерам строк покрасил бы весь файл целиком.
    const before = Array.from({ length: 50 }, (_, i) => `строка ${i}`).join("\n");
    const after = `новая\n${before}`;
    const marks = diffLines(before, after);

    expect(marks.size).toBe(1);
    expect(marks.get(0)).toBe("added");
  });

  it("finds one changed line in a file of ten thousand", () => {
    // Общее начало и общий конец отрезаются до разбора: без этого сюда пришли
    // бы двадцать тысяч строк, и подсчёт занял бы секунды на каждое нажатие.
    const lines = Array.from({ length: 10_000 }, (_, i) => `строка ${i}`);
    const before = lines.join("\n");
    lines[7_000] = "правленая";
    const after = lines.join("\n");

    const started = Date.now();
    const marks = diffLines(before, after);
    expect(Date.now() - started).toBeLessThan(500);
    expect([...marks]).toEqual([[7_000, "changed"]]);
  });

  it("still says something when the file was replaced wholesale", () => {
    // Перепутанная кодировка, автоформатирование, склейка веток — искать в них
    // кратчайший путь правок незачем и не на что: там другой файл. Молчать про
    // это нельзя, молчание читается как «изменений нет».
    const before = Array.from({ length: 3_000 }, (_, i) => `было ${i}`).join("\n");
    const after = Array.from({ length: 3_000 }, (_, i) => `стало ${i}`).join("\n");
    const marks = diffLines(before, after);

    expect(marks.size).toBe(3_000);
    expect(marks.get(0)).toBe("changed");
    expect(marks.get(2_999)).toBe("changed");
  });

  it("never points at a line the file does not have", () => {
    // Метку рисует слой поверх текста, строка за строкой: номер за краем файла
    // сдвинул бы весь слой относительно поля ввода.
    const samples: [string | null, string][] = [
      ["одна\nдве\nтри", ""],
      ["", "одна\nдве"],
      ["одна\n", "одна"],
      ["одна", "одна\n"],
      ["a\nb\nc\nd", "d\nc\nb\na"],
      [null, "одна"],
      ["хвост\nушёл", "хвост"],
    ];
    for (const [committed, current] of samples) {
      const total = current.split("\n").length;
      for (const line of diffLines(committed, current).keys()) {
        expect(line, `${committed} → ${current}`).toBeGreaterThanOrEqual(0);
        expect(line, `${committed} → ${current}`).toBeLessThan(total);
      }
    }
  });

  it("marks an emptied file on its one remaining line", () => {
    expect(marksOf("одна\nдве", "")).toEqual(["changed"]);
  });
});
