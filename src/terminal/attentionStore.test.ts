// Множество ждущих панелей: своё состояние без доставки уведомлений, поэтому
// проверяется напрямую — ни моков, ни таймеров.

import { afterEach, describe, expect, it } from "vitest";
import {
  clearAgentAttention,
  getAgentAttentionCount,
  getWaitingPanelIds,
  isAgentPanelWaiting,
  markAgentPanelWaiting,
  subscribeAgentAttention,
} from "./attentionStore";

const used: string[] = [];

function waiting(id: string): string {
  used.push(id);
  markAgentPanelWaiting(id);
  return id;
}

afterEach(() => {
  for (const id of used.splice(0)) {
    clearAgentAttention(id);
  }
});

describe("agent attention store", () => {
  it("gives a new subscriber the current count at once", () => {
    waiting("store-current");
    const seen: number[] = [];

    const unsubscribe = subscribeAgentAttention((count) => seen.push(count));

    // Бейдж на иконке рисуется по первому же значению: подписчик, узнающий
    // счёт только со следующего изменения, показал бы ноль при ждущей панели.
    expect(seen).toEqual([1]);
    unsubscribe();
  });

  it("notifies on every change and stops after unsubscribe", () => {
    const seen: number[] = [];
    const unsubscribe = subscribeAgentAttention((count) => seen.push(count));

    waiting("store-one");
    waiting("store-two");
    clearAgentAttention("store-one");
    unsubscribe();
    waiting("store-three");

    expect(seen).toEqual([0, 1, 2, 1]);
  });

  it("stays quiet when nothing actually changed", () => {
    const id = waiting("store-repeat");
    const seen: number[] = [];
    const unsubscribe = subscribeAgentAttention((count) => seen.push(count));

    // Та же панель зовёт повторно, и снимается панель, которая не ждала:
    // размер множества не меняется — рассылать нечего.
    markAgentPanelWaiting(id);
    clearAgentAttention("store-never-waited");

    expect(seen).toEqual([1]);
    unsubscribe();
  });

  it("tells apart the panel that called from the rest", () => {
    waiting("store-called");

    expect(isAgentPanelWaiting("store-called")).toBe(true);
    expect(isAgentPanelWaiting("store-silent")).toBe(false);
  });

  it("keeps the waiting panels in the order they called", () => {
    // По этому списку колокольчик ведёт к панели: порядок — это очередь.
    waiting("store-first");
    waiting("store-second");
    markAgentPanelWaiting("store-first");

    expect(getWaitingPanelIds()).toEqual(["store-first", "store-second"]);

    clearAgentAttention("store-first");
    expect(getWaitingPanelIds()).toEqual(["store-second"]);
    expect(getAgentAttentionCount()).toBe(1);
  });
});
