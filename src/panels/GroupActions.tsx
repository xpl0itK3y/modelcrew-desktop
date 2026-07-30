import { useEffect, useState } from "react";
import { IDockviewHeaderActionsProps } from "dockview";
import { useAppActions } from "../ui/AppActions";
import { canMaximizePanel, togglePanelMaximized } from "../animations";
import { platform } from "../platform";
import { shortcutLabel } from "../hotkeys/shortcuts";
import { useI18n } from "../i18n";
import { CloseIcon, MaximizeIcon } from "../ui/Icons";

// Кнопки в шапке группы dockview: развернуть/свернуть и закрыть.
export function GroupActions(props: IDockviewHeaderActionsProps) {
  const { t } = useI18n();
  const actions = useAppActions();
  const api = props.containerApi;
  // Пока терминал один, разворачивать нечего — кнопку не показываем вовсе,
  // чтобы она не притворялась работающей.
  const [canMaximize, setCanMaximize] = useState(() => canMaximizePanel(api));
  const maximizeShortcut = shortcutLabel(["mod", "enter"], platform);
  const closeShortcut = shortcutLabel(["mod", "shift", "w"], platform);

  useEffect(() => {
    const update = () => setCanMaximize(canMaximizePanel(api));
    update();
    const disposables = [
      api.onDidAddGroup(update),
      api.onDidRemoveGroup(update),
    ];
    return () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    };
  }, [api]);

  return (
    <div className="group-actions">
      {canMaximize && (
        <button
          type="button"
          className="icon-button"
          title={t("group.maximizeRestore", { shortcut: maximizeShortcut })}
          aria-label={t("group.maximizeRestore", { shortcut: maximizeShortcut })}
          onClick={() => {
            if (props.activePanel) {
              togglePanelMaximized(api, props.activePanel);
            }
          }}
        >
          <MaximizeIcon />
        </button>
      )}
      <button
        type="button"
        className="icon-button"
        title={t("group.close", { shortcut: closeShortcut })}
        aria-label={t("group.close", { shortcut: closeShortcut })}
        onClick={() => actions.requestCloseGroup(props.group)}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
