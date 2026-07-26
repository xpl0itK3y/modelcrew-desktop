import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadGridOrientation,
  saveGridOrientation,
  subscribeGridOrientation,
} from "./preferences";

describe("grid orientation preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("notifies the active layout immediately when the orientation changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeGridOrientation(listener);

    saveGridOrientation("rows");

    expect(loadGridOrientation()).toBe("rows");
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("rows");

    unsubscribe();
    saveGridOrientation("columns");
    expect(listener).toHaveBeenCalledOnce();
  });
});
