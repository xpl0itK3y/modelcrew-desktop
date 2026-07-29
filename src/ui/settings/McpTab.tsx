import { useI18n } from "../../i18n";
import { SettingsPage } from "./SettingsControls";

// Раздел-заглушка: подключать серверы из приложения ещё нельзя, поэтому здесь
// нечего объяснять — заголовок и одно слово. Имена серверов остаются в
// ключевых словах, чтобы раздел находился поиском.
export function McpTab() {
  const { t } = useI18n();

  return (
    <SettingsPage
      section="mcp"
      title={t("settings.tabMcp")}
      keywords="MCP CodeGraph CocoIndex сервер server"
    >
      <p className="settings-soon">{t("common.soon")}</p>
    </SettingsPage>
  );
}
