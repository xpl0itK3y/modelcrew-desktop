import { type KeyboardEvent, type Ref } from "react";

type SidebarMenuProps = {
  menuRef: Ref<HTMLDivElement>;
  renameLabel: string;
  deleteLabel: string;
  onRename: () => void;
  onDelete: () => void;
  // restoreFocus: true — закрытие с возвратом фокуса на кнопку-триггер.
  onClose: (restoreFocus: boolean) => void;
};

// Контекстное меню строки сайдбара (проект или сессия): переименовать/удалить
// плюс клавиатурная навигация по пунктам.
export function SidebarMenu(props: SidebarMenuProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose(true);
      return;
    }
    if (event.key === "Tab") {
      props.onClose(false);
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ),
    );
    if (items.length === 0) {
      return;
    }
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowUp"
            ? (currentIndex - 1 + items.length) % items.length
            : (currentIndex + 1) % items.length;
    event.preventDefault();
    event.stopPropagation();
    items[nextIndex]?.focus();
  };

  return (
    <div
      ref={props.menuRef}
      className="sidebar-menu"
      role="menu"
      onKeyDown={onKeyDown}
    >
      <button type="button" role="menuitem" onClick={props.onRename}>
        {props.renameLabel}
      </button>
      <button
        type="button"
        role="menuitem"
        className="is-danger"
        onClick={props.onDelete}
      >
        {props.deleteLabel}
      </button>
    </div>
  );
}
