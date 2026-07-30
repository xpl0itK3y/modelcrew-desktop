import { Suspense, lazy, type ComponentProps } from "react";
import type { Settings } from "./Settings";

// Диалог настроек — большой (девять разделов, палитра тем, список сочетаний) и
// на старте не нужен: его открывают руками. Грузим при первом открытии, чтобы
// первый кадр приложения не разбирал этот код.
//
// Заглушка пустая нарочно: чанк лежит рядом на диске, пауза незаметна, а
// мелькающий спиннер поверх терминалов заметен.
const SettingsDialog = lazy(() =>
  import("./Settings").then((module) => ({ default: module.Settings })),
);

export function SettingsLazy(props: ComponentProps<typeof Settings>) {
  return (
    <Suspense fallback={null}>
      <SettingsDialog {...props} />
    </Suspense>
  );
}
