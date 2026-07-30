// Разбор потока PTY сам по себе: ни звука, ни баннеров, ни настроек — а
// значит, ни одного мока.

import { describe, expect, it } from "vitest";
import {
  createAttentionScanState,
  scanTerminalAttention,
} from "./attentionScanner";

describe("scanTerminalAttention", () => {
  it("counts plain bells", () => {
    const result = scanTerminalAttention(
      "hello\x07world\x07",
      createAttentionScanState(),
    );
    expect(result.bells).toBe(2);
    expect(result.notifications).toEqual([]);
    expect(result.state.mode).toBe(0);
  });

  it("ignores the BEL that terminates an OSC title sequence", () => {
    // Смена заголовка окна: OSC 0;title BEL — это не «звонок».
    const result = scanTerminalAttention(
      "\x1b]0;my title\x07after",
      createAttentionScanState(),
    );
    expect(result.bells).toBe(0);
    expect(result.notifications).toEqual([]);
    expect(result.state.mode).toBe(0);
  });

  it("handles ST-terminated OSC and real bell after it", () => {
    const result = scanTerminalAttention(
      "\x1b]8;;link\x1b\\text\x07",
      createAttentionScanState(),
    );
    expect(result.bells).toBe(1);
    expect(result.notifications).toEqual([]);
    expect(result.state.mode).toBe(0);
  });

  it("keeps state across chunk boundaries", () => {
    // OSC разорван между чанками: BEL из второго чанка — терминатор, не звонок.
    const first = scanTerminalAttention(
      "\x1b]0;par",
      createAttentionScanState(),
    );
    expect(first.bells).toBe(0);
    expect(first.state.mode).toBe(2);
    const second = scanTerminalAttention("tial\x07\x07", first.state);
    expect(second.bells).toBe(1);
    expect(second.notifications).toEqual([]);
    expect(second.state.mode).toBe(0);
  });

  it("does not treat CSI sequences as OSC", () => {
    const result = scanTerminalAttention(
      "\x1b[31mred\x07",
      createAttentionScanState(),
    );
    expect(result.bells).toBe(1);
  });

  it("resyncs when a CSI interrupts an unterminated OSC", () => {
    // Оборванная гиперссылка (OSC 8 без ST): сканер обязан выйти из OSC на
    // первой же CSI, иначе он съест следующий звонок агента как терминатор.
    const opened = scanTerminalAttention(
      "\x1b]8;;https://example.com",
      createAttentionScanState(),
    );
    expect(opened.state.mode).toBe(2);

    const redrawn = scanTerminalAttention("\x1b[0m text \x1b[1m\r\n", opened.state);
    expect(redrawn.state.mode).toBe(0);

    expect(scanTerminalAttention("\x07", redrawn.state).bells).toBe(1);
  });

  it("starts over when a new OSC begins inside an unterminated one", () => {
    const result = scanTerminalAttention(
      "\x1b]0;title\x1b]9;Agent waiting\x07",
      createAttentionScanState(),
    );
    expect(result.bells).toBe(0);
    expect(result.notifications).toEqual([
      { protocol: "osc9", title: "Agent waiting", body: "", types: [] },
    ]);
  });

  it("decodes UTF-8 text out of the raw PTY bytes", () => {
    // PTY отдаёт байты: без декодирования кириллица в теле уведомления
    // рассыпается на «Ð°Ð½Ð°Ð»Ð¾Ð³» — по символу на байт.
    const bytes = new TextEncoder().encode(
      "\x1b]777;notify;Codex;Odysseus — аналог ChatGPT с агентами\x07",
    ).buffer;

    const result = scanTerminalAttention(bytes, createAttentionScanState());

    expect(result.notifications).toEqual([
      {
        protocol: "osc777",
        title: "Codex",
        body: "Odysseus — аналог ChatGPT с агентами",
        types: [],
      },
    ]);
  });

  it("keeps a multi-byte character split across chunks", () => {
    const bytes = new TextEncoder().encode("\x1b]9;Готово\x07");
    // Разрез приходится на середину первой кириллической буквы.
    const state = createAttentionScanState();
    scanTerminalAttention(bytes.slice(0, 5).buffer, state);

    const result = scanTerminalAttention(bytes.slice(5).buffer, state);

    expect(result.notifications[0]?.title).toBe("Готово");
  });

  it("survives any chunk split of a realistic stream", () => {
    // Перерисовка TUI, смена заголовка и само уведомление в одном потоке:
    // PTY может разрезать его в любом месте, включая середину буквы.
    const stream =
      "\x1b[?25l\x1b[2K\x1b[38;5;39m▌\x1b[0m работаю…\r\n" +
      "\x1b]0;codex — odysseus\x07" +
      "\x1b]777;notify;Codex;Odysseus — аналог ChatGPT с агентами\x07" +
      "\x1b[?25h";
    const bytes = new TextEncoder().encode(stream);
    const failures: number[] = [];

    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const state = createAttentionScanState();
      const first = scanTerminalAttention(bytes.slice(0, cut).buffer, state);
      const second = scanTerminalAttention(bytes.slice(cut).buffer, state);
      const found = [...first.notifications, ...second.notifications];
      if (
        found.length !== 1 ||
        found[0].body !== "Odysseus — аналог ChatGPT с агентами"
      ) {
        failures.push(cut);
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps working with a state that predates the decoder", () => {
    // Состояние живёт в панели дольше модуля: после hot reload в dev-режиме
    // сюда приходит объект, собранный прежней версией кода.
    const stale = createAttentionScanState() as Record<string, unknown>;
    delete stale.decoder;

    const result = scanTerminalAttention(
      new TextEncoder().encode("\x1b]9;Готово\x07").buffer,
      stale as ReturnType<typeof createAttentionScanState>,
    );

    expect(result.notifications[0]?.title).toBe("Готово");
  });

  it("scans binary chunks too", () => {
    const bytes = new Uint8Array([104, 7, 105]).buffer;
    expect(scanTerminalAttention(bytes, createAttentionScanState()).bells).toBe(
      1,
    );
  });

  it("extracts OSC 9 and OSC 777 notifications", () => {
    const state = createAttentionScanState();
    const result = scanTerminalAttention(
      "\x1b]9;Agent turn complete\x1b\\" +
        "\x1b]777;notify;Permission needed;Approve Bash\x07",
      state,
    );
    expect(result.bells).toBe(0);
    expect(result.notifications).toEqual([
      {
        protocol: "osc9",
        title: "Agent turn complete",
        body: "",
        types: [],
      },
      {
        protocol: "osc777",
        title: "Permission needed",
        body: "Approve Bash",
        types: [],
      },
    ]);
  });

  it("assembles chunked OSC 99 title, body, and notification type", () => {
    const state = createAttentionScanState();
    const first = scanTerminalAttention(
      "\x1b]99;i=turn-1:d=0:p=title;Codex\x1b\\",
      state,
    );
    expect(first.notifications).toEqual([]);
    const second = scanTerminalAttention(
      "\x1b]99;i=turn-1:p=body:t=cXVlc3Rpb24=;Waiting for input\x1b\\",
      first.state,
    );
    expect(second.notifications).toEqual([
      {
        protocol: "osc99",
        title: "Codex",
        body: "Waiting for input",
        types: ["question"],
      },
    ]);
  });

  it("drops oversized OSC payloads without turning their terminator into BEL", () => {
    const result = scanTerminalAttention(
      `\x1b]9;${"x".repeat(20_000)}\x07`,
      createAttentionScanState(),
    );
    expect(result.bells).toBe(0);
    expect(result.notifications).toEqual([]);
    expect(result.state.mode).toBe(0);
  });
});
