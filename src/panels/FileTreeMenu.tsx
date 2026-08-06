// Контекстное меню строки дерева.
//
// Встаёт по правому щелчку у курсора. Пункты те же, что в файловом менеджере:
// создать рядом, переименовать, удалить, показать в системе. Разрушительное —
// внизу и отдельно, чтобы промах по соседнему пункту не стоил файла.

import {
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useI18n } from "../i18n";

export type MenuTarget = {
  path: string;
  name: string;
  isDir: boolean;
  x: number;
  y: number;
};

export type MenuAction = "newFile" | "newFolder" | "rename" | "delete" | "reveal";

export function FileTreeMenu(props: {
  target: MenuTarget;
  onPick: (action: MenuAction) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Куда меню в итоге встало. До замера его не показываем: у нижних строк оно
  // иначе успевает мигнуть за краем окна.
  const [placed, setPlaced] = useState<{
    left: number;
    top: number;
    up: boolean;
  } | null>(null);

  // Раскрывается вниз-вправо, пока помещается, и переворачивается, когда нет.
  // Без этого меню у последних строк дерева уходит под край окна целиком — и
  // выглядит так, будто его нет вовсе.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) {
      return;
    }
    const { width, height } = element.getBoundingClientRect();
    const edge = 8;
    const room = {
      right: window.innerWidth - props.target.x,
      below: window.innerHeight - props.target.y,
    };
    const up = room.below < height + edge && props.target.y > height + edge;
    const left =
      room.right < width + edge
        ? Math.max(edge, props.target.x - width)
        : props.target.x;
    // Места нет ни снизу, ни сверху — прижимаем к краю: обрезанное меню лучше
    // невидимого, в нём хотя бы видны первые пункты.
    const top = up
      ? props.target.y - height
      : Math.min(props.target.y, Math.max(edge, window.innerHeight - height - edge));
    setPlaced({ left, top, up });
  }, [props.target.x, props.target.y]);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, []);

  // Щелчок мимо и потеря фокуса закрывают меню: висящее меню перехватывает
  // следующий щелчок, и человек нажимает дважды там, где хватило бы раза.
  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        props.onClose();
      }
    };
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("blur", props.onClose);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("blur", props.onClose);
    };
  }, [props]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      props.onClose();
      return;
    }
    const step =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]"),
    );
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    // По кругу: в коротком меню это быстрее, чем упираться в край.
    const next = (at + step + items.length) % items.length;
    items[next]?.focus();
  };

  const items: { action: MenuAction; label: string; danger?: boolean }[] = [
    { action: "newFile", label: t("files.newFile") },
    { action: "newFolder", label: t("files.newFolder") },
    { action: "rename", label: t("files.rename") },
    { action: "reveal", label: t("files.reveal") },
    { action: "delete", label: t("files.delete"), danger: true },
  ];

  return (
    <div
      ref={menuRef}
      className="file-menu"
      role="menu"
      aria-label={props.target.name}
      style={{
        left: placed?.left ?? props.target.x,
        top: placed?.top ?? props.target.y,
        // До замера меню уже в дереве — его нужно измерить, — но показывать
        // его на непроверенном месте нельзя.
        visibility: placed ? "visible" : "hidden",
        transformOrigin: placed?.up ? "bottom left" : "top left",
      }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          className={`file-menu-item ${item.danger ? "is-danger" : ""}`}
          onClick={() => props.onPick(item.action)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
