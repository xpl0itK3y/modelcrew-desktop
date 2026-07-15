import { IWatermarkPanelProps } from "dockview";
import { appActions } from "../appActions";
import { isMac } from "../constants";
import { useI18n } from "../i18n";
import { FolderIcon, PlusIcon } from "../ui/Icons";

// Watermark dockview: онбординг без проекта или пустая сессия без терминалов.
export function Welcome(_props: IWatermarkPanelProps) {
  const { t } = useI18n();
  const newTerminalShortcut = isMac ? "⌘T" : "Ctrl+T";
  const panelNumbersShortcut = isMac ? "⌘⌥" : "Ctrl+Alt";
  const zoomShortcut = isMac ? "⌘↩" : "Ctrl+Enter";
  // Первый запуск (воркспейса нет) — онбординг через выбор папки проекта.
  if (!appActions.hasActiveWorkspace()) {
    return (
      <div className="welcome">
        <div className="welcome-badge">MODELCREW</div>
        <h1 className="welcome-title">{t("welcome.title")}</h1>
        <p className="welcome-subtitle">{t("welcome.chooseProject")}</p>
        <button
          type="button"
          className="welcome-button"
          onClick={() => appActions.requestCreateWorkspace()}
        >
          <FolderIcon /> {t("welcome.openProject")}
        </button>
        <div className="welcome-hints">
          <span>
            <kbd>{newTerminalShortcut}</kbd> {t("welcome.openProjectShortcut")}
          </span>
        </div>
      </div>
    );
  }
  // Воркспейс есть, но все терминалы закрыты.
  return (
    <div className="welcome">
      <div className="welcome-badge">MODELCREW</div>
      <h1 className="welcome-title">{t("welcome.title")}</h1>
      <p className="welcome-subtitle">{t("welcome.terminalsTogether")}</p>
      <button
        type="button"
        className="welcome-button"
        onClick={() => appActions.requestNewTerminal()}
      >
        <PlusIcon /> {t("welcome.newTerminal")}
      </button>
      <div className="welcome-hints">
        <span>
          <kbd>{newTerminalShortcut}</kbd> {t("welcome.newTerminalShortcut")}
        </span>
        <span>
          <kbd>{panelNumbersShortcut}</kbd> {t("welcome.panelNumbersShortcut")}
        </span>
        <span>
          <kbd>{zoomShortcut}</kbd> {t("welcome.zoomShortcut")}
        </span>
      </div>
    </div>
  );
}
