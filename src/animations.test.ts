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
  const animations: Animation[] = [];
  const animate = vi.fn(
    (
      _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      _options?: number | KeyframeAnimationOptions,
    ) => {
      const animation = {
        cancel: vi.fn(),
        oncancel: null,
        onfinish: null,
      } as unknown as Animation;
      animations.push(animation);
      return animation;
    },
  );
  const element = {
    animate,
    style: { opacity: "", zIndex: "" },
    getBoundingClientRect: () =>
      maximized ? rect(1_000, 700) : rect(500, 350),
  } as unknown as HTMLElement;
  const backgroundAnimate = vi.fn(
    (
      _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      _options?: number | KeyframeAnimationOptions,
    ) =>
      ({
        cancel: vi.fn(),
        oncancel: null,
        onfinish: null,
      }) as unknown as Animation,
  );
  const backgroundElement = {
    animate: backgroundAnimate,
    style: { opacity: "", zIndex: "" },
    getBoundingClientRect: () => rect(500, 350),
  } as unknown as HTMLElement;
  const maximize = vi.fn(() => {
    maximized = true;
  });
  const exitMaximized = vi.fn(() => {
    maximized = false;
  });
  const group = { id: "group-1", element };
  const panel = {
    group,
    api: {
      isMaximized: () => maximized,
      maximize,
      exitMaximized,
    },
  } as unknown as IDockviewPanel;
  const api = {
    groups: [group, { id: "group-2", element: backgroundElement }],
  } as unknown as DockviewApi;
  return {
    api,
    panel,
    animate,
    animations,
    backgroundAnimate,
    element,
    backgroundElement,
    maximize,
    exitMaximized,
  };
}

describe("togglePanelMaximized", () => {
  it("does nothing when the only panel already fills the workspace", () => {
    const fixture = setup(false);
    const lonely = {
      groups: [fixture.api.groups[0]],
    } as unknown as DockviewApi;

    togglePanelMaximized(lonely, fixture.panel);

    // Иначе dockview считал бы панель развёрнутой, а на экране ничего бы
    // не изменилось — и индикатор «терминал развёрнут» врал бы.
    expect(fixture.maximize).not.toHaveBeenCalled();
    expect(fixture.animate).not.toHaveBeenCalled();
  });

  it("still restores the last panel left after its neighbours closed", () => {
    const fixture = setup(true);
    const lonely = {
      groups: [fixture.api.groups[0]],
    } as unknown as DockviewApi;

    togglePanelMaximized(lonely, fixture.panel);

    expect(fixture.exitMaximized).not.toHaveBeenCalled();
    // Возврат идёт через анимацию: exitMaximized вызовется по её ходу.
    expect(fixture.animate).toHaveBeenCalled();
  });

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

  it("waits for terminal renderers before revealing the restored grid", () => {
    vi.useFakeTimers();
    const fixture = setup(true);

    togglePanelMaximized(fixture.api, fixture.panel);

    expect(fixture.exitMaximized).not.toHaveBeenCalled();
    expect(fixture.maximize).not.toHaveBeenCalled();
    expect(fixture.animate).toHaveBeenCalledWith(
      [{ opacity: 1 }, { opacity: 0 }],
      {
        duration: 52,
        easing: "ease-in",
        fill: "forwards",
      },
    );
    fixture.animations[0]?.onfinish?.({} as AnimationPlaybackEvent);

    expect(fixture.exitMaximized).toHaveBeenCalledOnce();
    expect(fixture.element.style.opacity).toBe("0");
    expect(fixture.backgroundElement.style.opacity).toBe("0");
    expect(fixture.backgroundAnimate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(104);

    expect(fixture.animate).toHaveBeenLastCalledWith(
      [
        { opacity: 0, transform: "translateY(-4px)" },
        { opacity: 1, transform: "none" },
      ],
      {
        duration: 104,
        easing: "cubic-bezier(0.2, 0, 0.13, 1)",
      },
    );
    expect(fixture.backgroundAnimate).toHaveBeenCalledWith(
      [
        {
          opacity: 0,
          transform: "translateY(8px)",
        },
        { opacity: 1, transform: "none" },
      ],
      {
        duration: 104,
        easing: "cubic-bezier(0.2, 0, 0.13, 1)",
      },
    );
    expect(fixture.element.style.opacity).toBe("");
    expect(fixture.backgroundElement.style.opacity).toBe("");

    expect(JSON.stringify(fixture.animate.mock.calls)).not.toContain("scale");
    expect(JSON.stringify(fixture.backgroundAnimate.mock.calls)).not.toContain(
      "scale",
    );
    vi.useRealTimers();
  });
});
