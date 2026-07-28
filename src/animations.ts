import { DockviewApi, DockviewGroupPanel, IDockviewPanel } from "dockview";

// Правила ТЗ: анимируем только transform/opacity, реальный layout меняется
// мгновенно, а плавность рисуется поверх (FLIP). При prefers-reduced-motion
// всё отключается.

const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

export function reducedMotion(): boolean {
  return reducedMotionQuery.matches;
}

const FLIP_EASING = "cubic-bezier(0.2, 0, 0.13, 1)";
const RESTORE_EASING = FLIP_EASING;
const restoringPanels = new WeakSet<IDockviewPanel>();

/** Снимок позиций всех групп перед изменением layout. */
export function snapshotGroupRects(api: DockviewApi): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>();
  for (const group of api.groups) {
    rects.set(group.id, group.element.getBoundingClientRect());
  }
  return rects;
}

/**
 * FLIP: layout уже применён — «доезжаем» transform'ом от старых позиций.
 * Работает и после fromJSON: группы сохраняют id, элементы могут быть новыми.
 */
export function flipGroups(
  api: DockviewApi,
  before: Map<string, DOMRect>,
  duration: number,
): void {
  if (reducedMotion()) {
    return;
  }
  for (const group of api.groups) {
    const from = before.get(group.id);
    if (!from || from.width === 0 || from.height === 0) {
      continue;
    }
    const element = group.element;
    const to = element.getBoundingClientRect();
    if (to.width === 0 || to.height === 0) {
      continue;
    }
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const sx = from.width / to.width;
    const sy = from.height / to.height;
    if (
      Math.abs(dx) < 1 &&
      Math.abs(dy) < 1 &&
      Math.abs(sx - 1) < 0.01 &&
      Math.abs(sy - 1) < 0.01
    ) {
      continue;
    }
    element.animate(
      [
        {
          transformOrigin: "top left",
          transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
        },
        { transformOrigin: "top left", transform: "none" },
      ],
      { duration, easing: FLIP_EASING },
    );
  }
}

function restoreMaximizedPanel(
  api: DockviewApi,
  panel: IDockviewPanel,
  duration: number,
): void {
  if (reducedMotion()) {
    panel.api.exitMaximized();
    return;
  }

  restoringPanels.add(panel);

  const groups = [...api.groups];
  const previousOpacities = new Map(
    groups.map((group) => [group.element, group.element.style.opacity]),
  );
  const fadeOutDuration = Math.max(1, Math.round(duration * 0.2));
  const settleDuration = Math.max(1, Math.round(duration * 0.4));
  const fadeInDuration = Math.max(
    1,
    duration - fadeOutDuration - settleDuration,
  );
  const fadeOut = panel.group.element.animate(
    [{ opacity: 1 }, { opacity: 0 }],
    {
      duration: fadeOutDuration,
      easing: "ease-in",
      fill: "forwards",
    },
  );
  let layoutRestored = false;

  const showRestoredGrid = () => {
    let pending = groups.length;
    if (pending === 0) {
      restoringPanels.delete(panel);
      return;
    }

    const releasePanel = () => {
      pending -= 1;
      if (pending === 0) {
        restoringPanels.delete(panel);
      }
    };

    for (const group of groups) {
      const element = group.element;
      const isActive = group.id === panel.group.id;
      const animation = element.animate(
        [
          {
            opacity: 0,
            transform: isActive ? "translateY(-4px)" : "translateY(8px)",
          },
          { opacity: 1, transform: "none" },
        ],
        {
          duration: fadeInDuration,
          easing: RESTORE_EASING,
        },
      );
      element.style.opacity = previousOpacities.get(element) ?? "";
      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        releasePanel();
      };
      animation.onfinish = finish;
      animation.oncancel = finish;
      window.setTimeout(finish, fadeInDuration + 80);
    }
  };

  const restoreLayout = () => {
    if (layoutRestored) {
      return;
    }
    layoutRestored = true;
    fadeOut.cancel();
    for (const group of groups) {
      group.element.style.opacity = "0";
    }
    panel.api.exitMaximized();
    window.setTimeout(showRestoredGrid, settleDuration);
  };

  fadeOut.onfinish = restoreLayout;
  fadeOut.oncancel = restoreLayout;
  window.setTimeout(restoreLayout, fadeOutDuration + 80);
}

/** Плавно разворачивает активную панель или возвращает сетку. */
export function togglePanelMaximized(
  api: DockviewApi,
  panel: IDockviewPanel,
  duration = 260,
): void {
  if (restoringPanels.has(panel)) {
    return;
  }

  const before = snapshotGroupRects(api);
  if (panel.api.isMaximized()) {
    restoreMaximizedPanel(api, panel, duration);
  } else {
    panel.api.maximize();
    flipGroups(api, before, duration);
  }
}

/**
 * «Перелёт» панели при свапе: элемент приподнимается (лёгкое уменьшение
 * + тень), плывёт со старого места на новое и мягко приземляется.
 * Группы при свапе остаются на местах — летают панели, поэтому дельта
 * считается по прямоугольнику панели до/после, а не по группам.
 */
export function swapFlight(element: HTMLElement, from: DOMRect): void {
  if (reducedMotion()) {
    return;
  }
  const to = element.getBoundingClientRect();
  if (
    from.width === 0 ||
    to.width === 0 ||
    from.height === 0 ||
    to.height === 0
  ) {
    return;
  }
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
    return;
  }

  const previousZIndex = element.style.zIndex;
  element.style.zIndex = "40";

  const midScaleX = (sx + 1) / 2 * 0.965;
  const midScaleY = (sy + 1) / 2 * 0.965;
  const animation = element.animate(
    [
      {
        transformOrigin: "top left",
        transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
        boxShadow: "0 0 0 transparent",
      },
      {
        offset: 0.45,
        transformOrigin: "top left",
        transform: `translate(${dx * 0.5}px, ${dy * 0.5}px) scale(${midScaleX}, ${midScaleY})`,
        boxShadow: "0 22px 56px var(--mc-shadow)",
      },
      {
        transformOrigin: "top left",
        transform: "none",
        boxShadow: "0 0 0 transparent",
      },
    ],
    { duration: 360, easing: "cubic-bezier(0.25, 0.8, 0.25, 1)" },
  );
  const restore = () => {
    element.style.zIndex = previousZIndex;
  };
  animation.onfinish = restore;
  animation.oncancel = restore;
}

function fadeOutElement(element: HTMLElement, done: () => void): void {
  if (reducedMotion()) {
    done();
    return;
  }
  const animation = element.animate(
    [
      { opacity: 1, transform: "scale(1)" },
      { opacity: 0, transform: "scale(0.97)" },
    ],
    { duration: 130, easing: "ease-in", fill: "forwards" },
  );
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      done();
    }
  };
  animation.onfinish = finish;
  animation.oncancel = finish;
  // Страховка: если анимация не завершится, всё равно закрываем.
  window.setTimeout(finish, 250);
}

/** Закрытие терминала: короткий fade + scale, затем реальное закрытие. */
export function closePanelAnimated(panel: IDockviewPanel): void {
  const soleInGroup = panel.group.panels.length === 1;
  const element = soleInGroup ? panel.group.element : undefined;
  if (!element) {
    panel.api.close();
    return;
  }
  fadeOutElement(element, () => panel.api.close());
}

/** Удаление группы: схлопывание, затем закрытие всех её терминалов. */
export function closeGroupAnimated(group: DockviewGroupPanel): void {
  fadeOutElement(group.element, () => group.api.close());
}
