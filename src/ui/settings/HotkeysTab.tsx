import { platform } from "../../constants";
import { SHORTCUTS, shortcutKeys, shortcutLabel } from "../../hotkeys/shortcuts";
import { useI18n } from "../../i18n";
import { SettingRow, SettingsPage } from "./SettingsControls";

// Список сочетаний под клавиатуру пользователя: на маке ⌘⌥⇧, на Windows и
// Linux — Ctrl, Alt, Shift. Подписи берутся из общего модуля, чтобы не
// разъехаться с подсказками кнопок.
export function HotkeysTab() {
  const { t } = useI18n();

  return (
    <SettingsPage
      section="hotkeys"
      title={t("settings.tabHotkeys")}
      intro={t("settings.hotkeysIntro")}
    >
      {SHORTCUTS.map((shortcut) => (
        <SettingRow
          key={shortcut.id}
          title={t(shortcut.label)}
          // Ищут и по самому сочетанию: «ctrl+w» или «⌘⇧w».
          keywords={shortcutLabel(shortcut.keys, platform)}
          control={
            <span className="shortcut-keys">
              {shortcutKeys(shortcut.keys, platform).map((key, index) => (
                <kbd key={index}>{key}</kbd>
              ))}
            </span>
          }
        />
      ))}
    </SettingsPage>
  );
}
