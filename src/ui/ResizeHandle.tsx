// Разделитель между областями: тянется мышью и стрелками.
//
// Размер считает не он: он лишь сообщает, куда уехал указатель от места
// захвата. Кто именно меняет размер и в каких границах, решает владелец
// области — иначе разделитель пришлось бы учить всем правилам сразу.

import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useI18n } from "../i18n";

/// На сколько двигает одно нажатие стрелки. Мышью размер подбирают на глаз, а
/// клавишами — доводят, поэтому шаг мелкий.
const STEP = 16;

export function ResizeHandle(props: {
  /// Размер области за разделителем: с него начинается перетаскивание и его
  /// же двигают стрелки.
  size: number;
  min: number;
  max: number;
  label: string;
  /// Как стоит сам разделитель. Стоймя (так по умолчанию) он делит колонки и
  /// двигает ширину той, что слева. Лёжа — отделяет область снизу, как консоль
  /// под страницей, и двигает её высоту: потянули вверх — стала выше.
  orientation?: "vertical" | "horizontal";
  onResize: (size: number) => void;
  /// Перетаскивание закончилось — самое время сохранить.
  onResizeEnd?: (size: number) => void;
  /// Двойной щелчок: вернуть области размер, с которого она начиналась.
  onReset?: () => void;
}) {
  const { t } = useI18n();
  const lying = props.orientation === "horizontal";
  const start = useRef<{ at: number; size: number } | null>(null);
  // Область может исчезнуть прямо во время перетаскивания — сменили проект,
  // спрятали дерево. Без уборки окно осталось бы без выделения текста и с
  // курсором изменения размера до самой перезагрузки.
  useEffect(
    () => () =>
      document.body.classList.remove("is-resizing", "is-resizing-rows"),
    [],
  );
  const latest = useRef(props.size);
  latest.current = props.size;

  // Где указатель вдоль хода разделителя. У лежачего ось перевёрнута: область
  // под ним растёт, когда указатель идёт вверх.
  const along = (event: PointerEvent<HTMLDivElement>) =>
    lying ? -event.clientY : event.clientX;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Только основная кнопка: правой вызывают меню, средней вставляют.
    if (event.button !== 0) {
      return;
    }
    start.current = { at: along(event), size: props.size };
    // Пока тянут, окно не должно ни выделять текст под курсором, ни доигрывать
    // переходы размера: и то и другое превращает перетаскивание в резину.
    document.body.classList.add("is-resizing");
    if (lying) {
      document.body.classList.add("is-resizing-rows");
    }
    // Захват указателя обязателен: без него быстрый рывок уводит курсор за
    // пределы полоски, события уходят другому элементу и область застывает
    // на полпути.
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (!from) {
      return;
    }
    props.onResize(from.size + (along(event) - from.at));
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) {
      return;
    }
    start.current = null;
    document.body.classList.remove("is-resizing", "is-resizing-rows");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    props.onResizeEnd?.(latest.current);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const [less, more] = lying
      ? ["ArrowDown", "ArrowUp"]
      : ["ArrowLeft", "ArrowRight"];
    const step = event.key === less ? -STEP : event.key === more ? STEP : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const next = props.size + step;
    props.onResize(next);
    props.onResizeEnd?.(next);
  };

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation={lying ? "horizontal" : "vertical"}
      aria-label={t(lying ? "layout.resizeHeight" : "layout.resize", {
        area: props.label,
      })}
      aria-valuenow={props.size}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
      // Двойной щелчок возвращает область к тому, с чего она начиналась:
      // подобрать размер обратно на глаз заметно дольше.
      onDoubleClick={() => props.onReset?.()}
    />
  );
}
