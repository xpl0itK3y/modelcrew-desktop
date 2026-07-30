import { describe, expect, it } from "vitest";
import { en } from "./en";
import { ru } from "./ru";

// Строки удалённых функций живут в каталогах вечно: их никто не видит, а
// переводить и вычитывать приходится. Проверяем, что каждый ключ кто-то
// использует, и заодно что обе локали совпадают ключ в ключ.
//
// Исходники читаем через import.meta.glob: node:fs в этом проекте недоступен
// (типы браузерные), а Vite отдаёт содержимое файлов и в тестах.
const sources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Ключи, которые собираются из частей в коде: буквально их не найти.
const TEMPLATED = ["git.status."];

const code = Object.entries(sources)
  .filter(([path]) => !/\/(ru|en)\.ts$/.test(path))
  .map(([, text]) => text)
  .join("\n");

describe("каталоги переводов", () => {
  it("не содержат ключей, которых нет в коде", () => {
    const unused = Object.keys(ru).filter(
      (key) =>
        !TEMPLATED.some((prefix) => key.startsWith(prefix)) &&
        !code.includes(`"${key}"`),
    );

    expect(unused).toEqual([]);
  });

  it("совпадают ключ в ключ", () => {
    // Типы уже требуют полноты en, но не запрещают лишнее — проверяем сами.
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });
});
