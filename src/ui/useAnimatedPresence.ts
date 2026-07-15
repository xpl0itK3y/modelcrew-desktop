import { useEffect, useState } from "react";

type Presence<T> = { item: T; closing: boolean };

// Держит элемент смонтированным на время exit-анимации. Пока value есть —
// рендерим обычно; когда value пропало — ещё exitMs рендерим с closing=true,
// чтобы CSS успел проиграть исчезание, и только потом размонтируем.
// item хранит последнее непустое значение: данные для текста диалога остаются
// доступными, даже если исходное состояние уже обнулили.
export function useAnimatedPresence<T>(
  value: T | null | undefined,
  exitMs: number,
): Presence<T> | null {
  const [state, setState] = useState<Presence<T> | null>(() =>
    value == null ? null : { item: value, closing: false },
  );

  useEffect(() => {
    if (value != null) {
      setState({ item: value, closing: false });
      return;
    }
    setState((current) =>
      current && !current.closing ? { ...current, closing: true } : current,
    );
    const timer = window.setTimeout(() => setState(null), exitMs);
    return () => window.clearTimeout(timer);
  }, [value, exitMs]);

  return state;
}
