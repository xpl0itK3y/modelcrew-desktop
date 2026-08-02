// Стор занятости: что видит шапка панели и когда она перерисовывается.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPanelClaims,
  getPanelClaims,
  setPanelClaims,
  subscribePanelClaims,
  type PanelClaims,
} from "./claimStore";

function claims(
  fields: Partial<PanelClaims> = {},
): PanelClaims {
  return { held: [], waitingFor: null, awaited: false, ...fields };
}

afterEach(() => clearPanelClaims());

describe("panel claims store", () => {
  it("gives an empty answer for a panel nobody reported", () => {
    // Обычный шелл без агента в реестре не появляется вовсе, а шапка про него
    // всё равно спрашивает.
    expect(getPanelClaims("panel-unknown")).toEqual({
      held: [],
      waitingFor: null,
      awaited: false,
    });
  });

  it("keeps what each panel holds apart", () => {
    setPanelClaims(
      new Map([
        ["panel-a", claims({ held: ["src/app.ts", "src/model.ts"] })],
        ["panel-b", claims({ waitingFor: "src/app.ts" })],
      ]),
    );

    expect(getPanelClaims("panel-a").held).toEqual([
      "src/app.ts",
      "src/model.ts",
    ]);
    expect(getPanelClaims("panel-b").waitingFor).toBe("src/app.ts");
  });

  it("notifies subscribers when the picture changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePanelClaims(listener);

    setPanelClaims(new Map([["panel-a", claims({ held: ["src/app.ts"] })]]));
    expect(listener).toHaveBeenCalledTimes(1);

    setPanelClaims(new Map([["panel-a", claims({ held: ["src/other.ts"] })]]));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setPanelClaims(new Map());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when the same picture arrives again", () => {
    // Срез приходит по таймеру и меняется редко: без сравнения дюжина шапок
    // перерисовывалась бы на каждом тике.
    setPanelClaims(new Map([["panel-a", claims({ held: ["src/app.ts"] })]]));
    const listener = vi.fn();
    const unsubscribe = subscribePanelClaims(listener);

    setPanelClaims(new Map([["panel-a", claims({ held: ["src/app.ts"] })]]));
    setPanelClaims(new Map([["panel-a", claims({ held: ["src/app.ts"] })]]));

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("notices a change that keeps the same number of files", () => {
    setPanelClaims(new Map([["panel-a", claims({ held: ["a.ts", "b.ts"] })]]));
    const listener = vi.fn();
    const unsubscribe = subscribePanelClaims(listener);

    setPanelClaims(new Map([["panel-a", claims({ held: ["a.ts", "c.ts"] })]]));

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("notices that someone started waiting for the panel", () => {
    setPanelClaims(new Map([["panel-a", claims({ held: ["a.ts"] })]]));
    const listener = vi.fn();
    const unsubscribe = subscribePanelClaims(listener);

    setPanelClaims(
      new Map([["panel-a", claims({ held: ["a.ts"], awaited: true })]]),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPanelClaims("panel-a").awaited).toBe(true);
    unsubscribe();
  });

  it("forgets everything when the project is left", () => {
    setPanelClaims(new Map([["panel-a", claims({ held: ["a.ts"] })]]));

    clearPanelClaims();

    expect(getPanelClaims("panel-a").held).toEqual([]);
  });
});
