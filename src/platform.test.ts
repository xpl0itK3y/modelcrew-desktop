import { describe, expect, it } from "vitest";
import { detectPlatform, isMac, isTauri, platform } from "./platform";

// Проверка окружения жила копиями в семнадцати файлах, определение мака — в
// двух, и копии разъезжались: где-то признак читался один раз при загрузке,
// где-то каждый вызов. Сторож не даёт им завестись снова.
const sources = import.meta.glob("./**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Кому можно: самому модулю и тестам — они признак как раз подставляют,
// чтобы разыграть запуск внутри приложения.
const ALLOWED = /^\.\/(platform\.ts|test\/setup\.ts)$|\.test\.tsx?$/;

function filesMentioning(needle: string): string[] {
  return Object.entries(sources)
    .filter(([path]) => !ALLOWED.test(path))
    .filter(([, text]) => text.includes(needle))
    .map(([path]) => path)
    .sort();
}

describe("определение платформы", () => {
  it("живёт в одном месте", () => {
    expect(filesMentioning("__TAURI_INTERNALS__")).toEqual([]);
    expect(filesMentioning("navigator.userAgent")).toEqual([]);
  });

  it("различает три клавиатуры", () => {
    expect(
      detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"),
    ).toBe("mac");
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(
      "windows",
    );
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    // Неизвестная система ведёт себя как PC: Ctrl вместо ⌘ — меньшее зло.
    expect(detectPlatform("")).toBe("linux");
  });

  it("читает jsdom одинаково на маке и на CI", () => {
    // jsdom пишет в user agent process.platform. Мак здесь — linux, как на CI:
    // иначе тест, зелёный локально, падал бы только после push.
    const jsdom = (os: string) =>
      `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/27.4.0`;
    expect(detectPlatform(jsdom("darwin"))).toBe("linux");
    expect(detectPlatform(jsdom("linux"))).toBe("linux");
    expect(detectPlatform(jsdom("win32"))).toBe("windows");
  });

  it("согласован сам с собой", () => {
    expect(isMac).toBe(platform === "mac");
    expect(typeof isTauri).toBe("boolean");
  });
});
