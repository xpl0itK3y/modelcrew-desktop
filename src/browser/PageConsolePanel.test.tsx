// Консоль под страницей: высота, которую тянут за верхний край.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import { KEYS, readSetting, writeSetting } from "../settings/storage";
import { PageConsolePanel } from "./PageConsolePanel";

// jsdom ничего не раскладывает: высоту ящика задаём сами.
const ROOM = 600;

// Наблюдатель отвечает сразу, как и настоящий после первой раскладки.
class InstantObserver {
  private readonly report: () => void;
  constructor(report: () => void) {
    this.report = report;
  }
  observe() {
    this.report();
  }
  disconnect() {}
}

beforeEach(() => {
  setLocale("ru");
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", InstantObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function openConsole() {
  const drawer = document.createElement("div");
  Object.defineProperty(drawer, "clientHeight", { value: ROOM });
  document.body.append(drawer);
  render(
    <PageConsolePanel
      entries={[]}
      lost={0}
      running
      trouble={null}
      onClear={() => {}}
    />,
    { container: drawer },
  );
  const edge = screen.getByRole("separator");
  // jsdom не знает о захвате указателя.
  edge.setPointerCapture = vi.fn();
  edge.releasePointerCapture = vi.fn();
  edge.hasPointerCapture = vi.fn(() => true);
  return { edge, panel: screen.getByRole("region", { name: "Консоль" }) };
}

function drag(edge: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(edge, { button: 0, clientY: from, pointerId: 1 });
  fireEvent.pointerMove(edge, { clientY: to, pointerId: 1 });
  fireEvent.pointerUp(edge, { pointerId: 1 });
}

describe("PageConsolePanel height", () => {
  it("takes about a third of the drawer until pulled", () => {
    const { panel } = openConsole();

    expect(panel.style.height).toBe("216px");
  });

  it("grows when its top edge is pulled up and remembers it", () => {
    const { edge, panel } = openConsole();

    drag(edge, 400, 340);

    expect(panel.style.height).toBe("276px");
    expect(readSetting(KEYS.browserConsoleHeight)).toBe("276");
  });

  it("leaves the page in sight however far it is pulled", () => {
    const { edge, panel } = openConsole();

    drag(edge, 400, -2_000);
    // Консоль не съедает ящик: странице с её строками остаётся своё.
    expect(panel.style.height).toBe("400px");

    drag(edge, 100, 2_000);
    // И не схлопывается: за пустую полоску потом не взяться.
    expect(panel.style.height).toBe("96px");
    expect(readSetting(KEYS.browserConsoleHeight)).toBe("96");
  });

  it("comes back at the height it was left at", () => {
    writeSetting(KEYS.browserConsoleHeight, "300");

    const { panel } = openConsole();

    expect(panel.style.height).toBe("300px");
  });

  it("signs a frame's and a worker's messages with their address", () => {
    render(
      <PageConsolePanel
        entries={[
          { index: 0, level: "log", text: "страница" },
          {
            index: 1,
            level: "error",
            text: "карта",
            frame: "https://pay.test/widget",
          },
          {
            index: 2,
            level: "exception",
            text: "boom",
            worker: "http://app.test/w.js",
          },
        ]}
        lost={0}
        running
        trouble={null}
        onClear={() => {}}
      />,
    );

    const frame = screen.getByText("рамка pay.test/widget");
    expect(frame.title).toBe("рамка https://pay.test/widget");
    expect(screen.getByText("поток app.test/w.js").title).toBe(
      "поток http://app.test/w.js",
    );
    // Своё страница пишет без подписи.
    expect(
      screen
        .getByText("страница")
        .closest(".browser-console-line")
        ?.querySelector(".browser-console-source"),
    ).toBeNull();
  });

  it("shows where a message came from and how often, like an inspector", () => {
    const { container } = render(
      <PageConsolePanel
        entries={[
          {
            index: 0,
            level: "error",
            text: "boom",
            at: "http://127.0.0.1:4321/assets/main.js?v=2:12:7",
            count: 3,
          },
          {
            index: 1,
            level: "warn",
            text: "осторожно",
            frame: "https://pay.test/widget",
            at: "https://pay.test/pay.js:9:1",
          },
          { index: 2, level: "log", text: "просто" },
        ]}
        lost={0}
        running
        trouble={null}
        onClear={() => {}}
      />,
    );

    // Справа — файл и строка, целиком — в подсказке.
    const place = screen.getByText("main.js:12");
    expect(place.title).toBe("http://127.0.0.1:4321/assets/main.js?v=2:12:7");
    expect(screen.getByText("рамка pay.test/widget · pay.js:9").title).toBe(
      "рамка https://pay.test/widget\nhttps://pay.test/pay.js:9:1",
    );
    // Повтор — число вместо значка, предупреждение — со значком, а простая
    // запись — без.
    expect(screen.getByTitle("Повторилось подряд: 3")).toHaveTextContent("3");
    const rows = container.querySelectorAll(".browser-console-entry");
    expect(rows[0].querySelector(".browser-console-icon")).toBeNull();
    expect(rows[1].querySelector(".browser-console-icon")).not.toBeNull();
    expect(rows[2].querySelector(".browser-console-icon")).toBeNull();
  });

  it("goes back to the usual height on a double click", () => {
    writeSetting(KEYS.browserConsoleHeight, "300");
    const { edge, panel } = openConsole();

    fireEvent.doubleClick(edge);

    expect(panel.style.height).toBe("216px");
    expect(readSetting(KEYS.browserConsoleHeight)).toBeNull();
  });
});

describe("PageConsolePanel details", () => {
  const warning = {
    index: 4,
    level: "error",
    text: [
      "Warning: Maximum update depth exceeded.",
      "App@http://localhost:1420/src/App.tsx:151:32",
    ].join("\n"),
    at: "http://localhost:1420/node_modules/.vite/deps/chunk-P5E.js:521:15",
    stack: [
      "printWarning@http://localhost:1420/node_modules/.vite/deps/chunk-P5E.js:521:15",
      "App@http://localhost:1420/src/App.tsx:151:32",
    ].join("\n"),
    count: 989,
    time: new Date(2026, 10, 5, 10, 15, 4, 120).getTime(),
    until: new Date(2026, 10, 5, 10, 15, 9, 7).getTime(),
  };

  function showWarning() {
    render(
      <PageConsolePanel
        entries={[warning]}
        lost={0}
        running
        trouble={null}
        onClear={() => {}}
      />,
    );
    return screen.getByRole("button", { name: "Показать подробности" });
  }

  it("shows only the first line until the message is opened", () => {
    showWarning();

    expect(
      screen.getByText("Warning: Maximum update depth exceeded."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/App\.tsx:151:32/)).toBeNull();
    expect(screen.queryByText("Кто вызвал")).toBeNull();
  });

  it("opens with the whole text, the stack, the place and the time", () => {
    const toggle = showWarning();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Скрыть подробности");
    expect(document.querySelector(".browser-console-text")?.textContent).toBe(
      warning.text,
    );
    expect(screen.getByText("Кто вызвал")).toBeInTheDocument();
    expect(screen.getByText(/^printWarning@/)).toBeInTheDocument();
    expect(screen.getByText(warning.at)).toBeInTheDocument();
    // Число повторов — и в кружке слева, и среди подробностей.
    expect(
      screen.getByText("Повторов подряд").nextElementSibling,
    ).toHaveTextContent("989");
    expect(screen.getByText("10:15:04.120 – 10:15:09.007")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByText("Кто вызвал")).toBeNull();
  });

  it("opens by a click anywhere on the line, but not while text is selected", () => {
    showWarning();
    const line = screen.getByText("Warning: Maximum update depth exceeded.");

    const selection = vi
      .spyOn(window, "getSelection")
      .mockReturnValue({ toString: () => "Maximum" } as Selection);
    fireEvent.click(line);
    expect(screen.queryByText("Кто вызвал")).toBeNull();

    selection.mockRestore();
    fireEvent.click(line);
    expect(screen.getByText("Кто вызвал")).toBeInTheDocument();
  });

  it("copies the whole message as text", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    fireEvent.click(showWarning());

    fireEvent.click(screen.getByRole("button", { name: "Скопировать" }));

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(
        "[error] Warning: Maximum update depth exceeded.",
      ),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("    printWarning@"),
    );
    expect(
      await screen.findByRole("button", { name: "Скопировано" }),
    ).toBeInTheDocument();
  });
});
