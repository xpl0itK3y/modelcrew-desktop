import { IDockviewHeaderActionsProps } from "dockview";
import { appActions } from "../appActions";
import { isMac } from "../constants";
import { useI18n } from "../i18n";
import { CloseIcon, MaximizeIcon } from "../ui/Icons";

// Кнопки в шапке группы dockview: развернуть/свернуть и закрыть.
export function GroupActions(props: IDockviewHeaderActionsProps) {
  const { t } = useI18n();
  const maximizeShortcut = isMac ? "⌘↩" : "Ctrl+Enter";
  const closeShortcut = isMac ? "⌘⇧W" : "Ctrl+Shift+W";
  return (
    <div className="group-actions">
      <button
        type="button"
        className="icon-button"
        title={t("group.maximizeRestore", { shortcut: maximizeShortcut })}
        aria-label={t("group.maximizeRestore", { shortcut: maximizeShortcut })}
        onClick={() => {
          if (props.containerApi.hasMaximizedGroup()) {
            props.containerApi.exitMaximizedGroup();
          } else if (props.activePanel) {
            props.containerApi.maximizeGroup(props.activePanel);
          }
        }}
      >
        <MaximizeIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        title={t("group.close", { shortcut: closeShortcut })}
        aria-label={t("group.close", { shortcut: closeShortcut })}
        onClick={() => appActions.requestCloseGroup(props.group)}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
