import { useI18n } from "../../i18n";
import { SettingsPage } from "./SettingsControls";

// Раздел-заглушка: подключать серверы из приложения ещё нельзя, но место для
// них уже понятно. Показываем честную отметку и говорим, где настраивать
// сейчас, — это полезнее пустой страницы.
export function McpTab() {
  const { t } = useI18n();

  return (
    <SettingsPage
      section="mcp"
      title={t("settings.tabMcp")}
      intro={t("settings.mcpIntro")}
    >
      <div className="settings-soon">
        <span className="soon-badge">{t("common.soon")}</span>
        <p className="settings-note">{t("settings.mcpSoonNote")}</p>
      </div>
    </SettingsPage>
  );
}
