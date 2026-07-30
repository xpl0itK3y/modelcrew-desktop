import { Suspense, lazy, type ComponentProps } from "react";
import type { GitChangesPanel, GitChangesView } from "../GitChangesPanel";

// Панель гита — самая большая часть интерфейса (история с графом, ветки,
// diff), и на старте её никто не видит: она открывается кнопкой в тайтлбаре.
// Грузим при первом открытии.
//
// Вариант GitChangesPanel остаётся для раскладок, сохранённых когда «Изменения»
// были панелью dockview: он же приходит из карты компонентов сетки, поэтому
// оборачивать его в Suspense приходится здесь, а не в App.

const View = lazy(() =>
  import("../GitChangesPanel").then((module) => ({
    default: module.GitChangesView,
  })),
);

const Panel = lazy(() =>
  import("../GitChangesPanel").then((module) => ({
    default: module.GitChangesPanel,
  })),
);

export function GitChangesViewLazy(
  props: ComponentProps<typeof GitChangesView>,
) {
  return (
    <Suspense fallback={<div className="git-empty" />}>
      <View {...props} />
    </Suspense>
  );
}

export function GitChangesPanelLazy(
  props: ComponentProps<typeof GitChangesPanel>,
) {
  return (
    <Suspense fallback={<div className="git-empty" />}>
      <Panel {...props} />
    </Suspense>
  );
}
