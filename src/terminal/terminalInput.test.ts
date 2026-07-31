// Отличить отчёт мыши от набора текста: от этого зависит, считается ли проход
// курсора над панелью работой пользователя.

import { describe, expect, it } from "vitest";
import { isMouseReport } from "./terminalInput";

describe("isMouseReport", () => {
  it("recognises the SGR reports modern agents send", () => {
    // Движение курсора при включённом трекинге — то самое, что гасило сигнал
    // «агент ждёт» от одного проноса мыши над панелью.
    expect(isMouseReport("\x1b[<35;12;30M")).toBe(true);
    // Нажатие и отпускание кнопки.
    expect(isMouseReport("\x1b[<0;12;30M")).toBe(true);
    expect(isMouseReport("\x1b[<0;12;30m")).toBe(true);
    // Колесо.
    expect(isMouseReport("\x1b[<64;12;30M")).toBe(true);
  });

  it("recognises the older report forms", () => {
    expect(isMouseReport("\x1b[32;12;30M")).toBe(true);
    // X10: координаты идут сырыми байтами сразу за `CSI M`.
    expect(isMouseReport("\x1b[M\x20\x2c\x3e")).toBe(true);
  });

  it("leaves typing alone", () => {
    for (const typed of ["a", "привет", "\r", "\x7f", "\t", " "]) {
      expect(isMouseReport(typed)).toBe(false);
    }
  });

  it("leaves the keys that look like escape sequences alone", () => {
    // Стрелки, Home/End и функциональные клавиши приходят теми же CSI, и
    // спутать их с мышью значило бы не заметить настоящую работу в панели.
    for (const key of [
      "\x1b[A",
      "\x1b[B",
      "\x1b[1;5C",
      "\x1b[3~",
      "\x1b[H",
      "\x1bOP",
      "\x1b",
    ]) {
      expect(isMouseReport(key)).toBe(false);
    }
  });

  it("leaves a bracketed paste alone", () => {
    // Вставка — это работа пользователя, даже если он не набирал текст руками.
    expect(isMouseReport("\x1b[200~echo hi\x1b[201~")).toBe(false);
  });
});
