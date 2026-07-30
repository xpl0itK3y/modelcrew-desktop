import { describe, expect, it } from "vitest";
import { KEYS, readSetting, removeSetting, writeSetting } from "./storage";

// Обращения к хранилищу жили в одиннадцати модулях, каждое со своей копией
// try/catch, а имена ключей — там же рядом. Сторож держит и то и другое в
// одном месте: без него следующая настройка снова заведёт свою копию.
const sources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Кому можно: самому модулю, его тесту и подмене хранилища в тестовой среде.
const ALLOWED = /(^|\/)storage\.ts$|^\.\.\/test\/setup\.ts$|\.test\.tsx?$/;

describe("хранилище настроек", () => {
  it("единственное место, которое трогает localStorage", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !ALLOWED.test(path))
      .filter(([, text]) => /localStorage\.(get|set|remove)Item/.test(text))
      .map(([path]) => path)
      .sort();

    expect(offenders).toEqual([]);
  });

  it("единственный список ключей", () => {
    // Строковый литерал "modelcrew.…" вне реестра — это ключ в обход него.
    const offenders = Object.entries(sources)
      .filter(([path]) => !ALLOWED.test(path))
      .filter(([, text]) => /"modelcrew\.[a-zA-Z]/.test(text))
      .map(([path]) => path)
      .sort();

    expect(offenders).toEqual([]);
  });

  it("все ключи с общим префиксом и без повторов", () => {
    const names = Object.values(KEYS);
    expect(names.every((key) => key.startsWith("modelcrew."))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("читает, пишет и забывает значение", () => {
    removeSetting(KEYS.accent);
    expect(readSetting(KEYS.accent)).toBeNull();

    writeSetting(KEYS.accent, "#4ade80");
    expect(readSetting(KEYS.accent)).toBe("#4ade80");

    removeSetting(KEYS.accent);
    expect(readSetting(KEYS.accent)).toBeNull();
  });
});
