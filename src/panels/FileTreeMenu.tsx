// Контекстное меню строки дерева.
//
// Встаёт по правому щелчку у курсора. Пункты те же, что в файловом менеджере:
// создать рядом, переименовать, удалить, показать в системе. Разрушительное —
// внизу и отдельно, чтобы промах по соседнему пункту не стоил файла.

import { useEffect, useRef, type KeyboardEvent } from "react";
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
      style={{ left: props.target.x, top: props.target.y }}
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
