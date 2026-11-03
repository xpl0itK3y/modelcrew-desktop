import { Suspense, lazy, type ComponentProps } from "react";
import type { FileEditor } from "./FileEditor";
import type { FileTree } from "./FileTree";
import type { BrowserView } from "./BrowserView";

// Дерево файлов, редактор и браузер проекта на старте не видны: их открывают
// кнопками. Редактор к тому же тянет подсветку на сотню языков и разбор
// разметки — больше всего прочего нашего кода. Грузим каждый при первом
// открытии, а в тихую минуту после старта — заранее, чтобы первое открытие
// не ждало диска.

const loadEditor = () => import("./FileEditor");
const loadTree = () => import("./FileTree");
const loadBrowser = () => import("./BrowserView");

const Editor = lazy(() =>
  loadEditor().then((module) => ({ default: module.FileEditor })),
);
const Tree = lazy(() =>
  loadTree().then((module) => ({ default: module.FileTree })),
);
const Browser = lazy(() =>
  loadBrowser().then((module) => ({ default: module.BrowserView })),
);

// После первого кадра и терминалов: подгрузка не должна отнимать у них время.
const PRELOAD_DELAY_MS = 1500;

/// Загрузить панели заранее. Ошибка не страшна: при открытии их загрузят снова.
export function preloadFilePanels(): () => void {
  const timer = window.setTimeout(() => {
    for (const load of [loadTree, loadEditor, loadBrowser]) {
      void load().catch(() => undefined);
    }
  }, PRELOAD_DELAY_MS);
  return () => window.clearTimeout(timer);
}

export function FileEditorLazy(props: ComponentProps<typeof FileEditor>) {
  // Пока чанк грузится, место колонки держит подставка той же ширины: иначе
  // сетка сдвинулась бы дважды, и терминалы получили бы лишний SIGWINCH.
  return (
    <Suspense
      fallback={
        <div
          className="file-editor-placeholder"
          aria-hidden="true"
          style={{ width: props.width }}
        />
      }
    >
      <Editor {...props} />
    </Suspense>
  );
}

export function FileTreeLazy(props: ComponentProps<typeof FileTree>) {
  // Колонку держит обёртка в App, заглушке незачем что-то рисовать.
  return (
    <Suspense fallback={null}>
      <Tree {...props} />
    </Suspense>
  );
}

export function BrowserViewLazy(props: ComponentProps<typeof BrowserView>) {
  return (
    <Suspense fallback={null}>
      <Browser {...props} />
    </Suspense>
  );
}
