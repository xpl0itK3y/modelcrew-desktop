import { IWatermarkPanelProps } from "dockview";
import { useAppActions } from "../ui/AppActions";
import { isMac } from "../platform";
import { useI18n } from "../i18n";
import { FolderIcon, PlusIcon } from "../ui/Icons";

// Watermark dockview: онбординг без проекта или пустая сессия без терминалов.
//
// Знак приложения — вся марка, какая здесь есть: пустой экран единственное
// место, где приложение показывает само себя, а не работу пользователя, и
// названия по буквам под знаком тут не нужно — оно стоит и в титлбаре, и в
// доке, и в меню. Подпись у картинки пустая: имя приложения на пустом экране
// не сообщение, а фон, и читалке объявлять его нечем. Файл берётся с той же
// иконки, из которой собран бандл, в удвоенном размере: 256 точек на 56
// пикселей хватает любому экрану.
export function Welcome(_props: IWatermarkPanelProps) {
  const { t } = useI18n();
  const actions = useAppActions();
  const newTerminalShortcut = isMac ? "⌘T" : "Ctrl+T";
  const panelNumbersShortcut = isMac ? "⌘⌥" : "Ctrl+Alt";
  const zoomShortcut = isMac ? "⌘↩" : "Ctrl+Enter";
  // Первый запуск (воркспейса нет) — онбординг через выбор папки проекта.
  if (!actions.hasActiveWorkspace()) {
    return (
      <div className="welcome">
        <img
          className="welcome-logo"
          src="/logo.png"
          width={56}
          height={56}
          alt=""
        />
        <h1 className="welcome-title">{t("welcome.title")}</h1>
        <p className="welcome-subtitle">{t("welcome.chooseProject")}</p>
        <button
          type="button"
          className="welcome-button"
          onClick={() => actions.requestCreateWorkspace()}
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
      <img
        className="welcome-logo"
        src="/logo.png"
        width={56}
        height={56}
        alt=""
      />
      <h1 className="welcome-title">{t("welcome.title")}</h1>
      <p className="welcome-subtitle">{t("welcome.terminalsTogether")}</p>
      <button
        type="button"
        className="welcome-button"
        onClick={() => actions.requestNewTerminal()}
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
