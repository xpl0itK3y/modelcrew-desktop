import { useLayoutEffect, type RefObject } from "react";

/**
 * Полоса прокрутки в колонке настроек — только когда страница правда не
 * помещается.
 *
 * `overflow: auto` решил бы это сам, но в его счёт входит и нижний отступ
 * колонки. Раздел «Внешний вид» в окне 980×680 виден целиком, до последней
 * карточки, а полоса всё равно стояла: прокрутить можно было восемь пикселей
 * пустоты. Поэтому решаем сами: прокрутка нужна, когда страница не влезает
 * между верхним отступом и низом колонки. Нижний отступ нужен прокрученной
 * до конца странице, а у той, что видна целиком, его можно съесть.
 *
 * Решение — атрибут `data-scrollable` на колонке; что он значит, говорят
 * стили. Ставим его сами, мимо React: он меняется при каждом изменении
 * размера, и перерисовывать ради него весь диалог незачем. ResizeObserver
 * зовёт нас до отрисовки кадра, так что лишняя полоса не мелькнёт.
 */
export function useScrollWhenNeeded(
  column: RefObject<HTMLElement | null>,
  page: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    const box = column.current;
    const content = page.current;
    if (!box || !content) {
      return;
    }
    const update = () => {
      const top = parseFloat(getComputedStyle(box).paddingTop) || 0;
      const scrollable = content.offsetHeight > box.clientHeight - top;
      if (scrollable === box.hasAttribute("data-scrollable")) {
        return;
      }
      box.toggleAttribute("data-scrollable", scrollable);
      // Без полосы колонку прокрутить нечем, а сдвиг мог остаться от прошлой
      // страницы или от фокуса.
      if (!scrollable) {
        box.scrollTop = 0;
      }
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    // Колонка меняется с окном, страница — со сменой раздела, поиском и
    // догрузкой списков.
    const observer = new ResizeObserver(update);
    observer.observe(box);
    observer.observe(content);
    return () => observer.disconnect();
  }, [column, page]);
}
