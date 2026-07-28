import { describe, expect, it, vi } from "vitest";
import type { DockviewApi, IDockviewPanel } from "dockview";
import { togglePanelMaximized } from "./animations";

const rect = (width: number, height: number): DOMRect =>
  ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  }) as DOMRect;

function setup(initiallyMaximized: boolean) {
  let maximized = initiallyMaximized;
  const animate = vi.fn(() => ({}) as Animation);
  const element = {
    animate,
    getBoundingClientRect: () =>
      maximized ? rect(1_000, 700) : rect(500, 350),
  } as unknown as HTMLElement;
  const maximize = vi.fn(() => {
    maximized = true;
  });
  const exitMaximized = vi.fn(() => {
    maximized = false;
  });
  const panel = {
    api: {
      isMaximized: () => maximized,
      maximize,
      exitMaximized,
    },
  } as unknown as IDockviewPanel;
  const api = {
    groups: [{ id: "group-1", element }],
  } as unknown as DockviewApi;
  return { api, panel, animate, maximize, exitMaximized };
}

describe("togglePanelMaximized", () => {
  it("animates a panel from its grid cell into the full workspace", () => {
    const fixture = setup(false);

    togglePanelMaximized(fixture.api, fixture.panel);

    expect(fixture.maximize).toHaveBeenCalledOnce();
    expect(fixture.exitMaximized).not.toHaveBeenCalled();
    expect(fixture.animate).toHaveBeenCalledWith(
      [
        {
          transformOrigin: "top left",
          transform: "translate(0px, 0px) scale(0.5, 0.5)",
        },
        { transformOrigin: "top left", transform: "none" },
      ],
      {
        duration: 260,
        easing: "cubic-bezier(0.2, 0, 0.13, 1)",
      },
    );
  });

  it("uses the same transition when restoring the grid", () => {
    const fixture = setup(true);

    togglePanelMaximized(fixture.api, fixture.panel);

    expect(fixture.exitMaximized).toHaveBeenCalledOnce();
    expect(fixture.maximize).not.toHaveBeenCalled();
    expect(fixture.animate).toHaveBeenCalledOnce();
  });
});
