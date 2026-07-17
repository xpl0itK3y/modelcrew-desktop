import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => true }),
}));

import {
  clearAgentAttention,
  getAgentAttentionCount,
  scanTerminalAttention,
  subscribeAgentAttention,
} from "./agentAlerts";

describe("scanTerminalAttention", () => {
  it("counts plain bells", () => {
    const result = scanTerminalAttention("hello\x07world\x07", 0);
    expect(result).toEqual({ bells: 2, state: 0 });
  });

  it("ignores the BEL that terminates an OSC title sequence", () => {
    // Смена заголовка окна: OSC 0;title BEL — это не «звонок».
    const result = scanTerminalAttention("\x1b]0;my title\x07after", 0);
    expect(result).toEqual({ bells: 0, state: 0 });
  });

  it("handles ST-terminated OSC and real bell after it", () => {
    const result = scanTerminalAttention("\x1b]8;;link\x1b\\text\x07", 0);
    expect(result).toEqual({ bells: 1, state: 0 });
  });

  it("keeps state across chunk boundaries", () => {
    // OSC разорван между чанками: BEL из второго чанка — терминатор, не звонок.
    const first = scanTerminalAttention("\x1b]0;par", 0);
    expect(first.bells).toBe(0);
    expect(first.state).toBe(2);
    const second = scanTerminalAttention("tial\x07\x07", first.state);
    expect(second).toEqual({ bells: 1, state: 0 });
  });

  it("does not treat CSI sequences as OSC", () => {
    const result = scanTerminalAttention("\x1b[31mred\x07", 0);
    expect(result.bells).toBe(1);
  });

  it("scans binary chunks too", () => {
    const bytes = new Uint8Array([104, 7, 105]).buffer;
    expect(scanTerminalAttention(bytes, 0).bells).toBe(1);
  });
});

describe("agent attention store", () => {
  it("notifies subscribers and clears acknowledged panels", () => {
    const seen: number[] = [];
    const unsubscribe = subscribeAgentAttention((count) => seen.push(count));
    expect(seen).toEqual([getAgentAttentionCount()]);
    // Прямых add снаружи нет — проверяем идемпотентность clear.
    clearAgentAttention("missing-panel");
    expect(seen).toHaveLength(1);
    unsubscribe();
  });
});
