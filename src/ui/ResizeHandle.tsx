// Разделитель между колонками: тянется мышью и стрелками.
//
// Ширину считает не он: он лишь сообщает, куда уехал указатель от места
// захвата. Кто именно меняет размер и в каких границах, решает владелец
// колонки — иначе разделитель пришлось бы учить всем правилам сразу.

import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useI18n } from "../i18n";

/// На сколько двигает одно нажатие стрелки. Мышью ширину подбирают на глаз, а
/// клавишами — доводят, поэтому шаг мелкий.
const STEP = 16;

export function ResizeHandle(props: {
  /// Ширина колонки слева от разделителя: с неё начинается перетаскивание и
  /// её же двигают стрелки.
  width: number;
  min: number;
  max: number;
  label: string;
  onResize: (width: number) => void;
  /// Перетаскивание закончилось — самое время сохранить.
  onResizeEnd?: (width: number) => void;
  /// Двойной щелчок: вернуть колонке ширину, с которой она начиналась.
  onReset?: () => void;
}) {
  const { t } = useI18n();
  const start = useRef<{ x: number; width: number } | null>(null);
  // Колонка может исчезнуть прямо во время перетаскивания — сменили проект,
  // спрятали дерево. Без уборки окно осталось бы без выделения текста и с
  // курсором изменения размера до самой перезагрузки.
  useEffect(() => () => document.body.classList.remove("is-resizing"), []);
  const latest = useRef(props.width);
  latest.current = props.width;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Только основная кнопка: правой вызывают меню, средней вставляют.
    if (event.button !== 0) {
      return;
    }
    start.current = { x: event.clientX, width: props.width };
    // Пока тянут, окно не должно ни выделять текст под курсором, ни доигрывать
    // переходы ширины: и то и другое превращает перетаскивание в резину.
    document.body.classList.add("is-resizing");
    // Захват указателя обязателен: без него быстрый рывок уводит курсор за
    // пределы полоски, события уходят другому элементу и колонка застывает
    // на полпути.
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (!from) {
      return;
    }
    props.onResize(from.width + (event.clientX - from.x));
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) {
      return;
    }
    start.current = null;
    document.body.classList.remove("is-resizing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    props.onResizeEnd?.(latest.current);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowLeft" ? -STEP : event.key === "ArrowRight" ? STEP : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const next = props.width + step;
    props.onResize(next);
    props.onResizeEnd?.(next);
  };

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={t("layout.resize", { area: props.label })}
      aria-valuenow={props.width}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
      // Двойной щелчок возвращает колонку к тому, с чего она начиналась:
      // подобрать ширину обратно на глаз заметно дольше.
      onDoubleClick={() => props.onReset?.()}
    />
  );
}
