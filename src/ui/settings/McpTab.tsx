import { useI18n } from "../../i18n";
import { SettingsPage } from "./SettingsControls";

// Раздел-заглушка: подключать серверы из приложения ещё нельзя. Вместо
// придуманных строк настроек — одно слово; что делать сейчас, сказано во
// вступлении раздела.
export function McpTab() {
  const { t } = useI18n();

  return (
    <SettingsPage
      section="mcp"
      title={t("settings.tabMcp")}
      intro={t("settings.mcpIntro")}
    >
      <p className="settings-soon">{t("common.soon")}</p>
    </SettingsPage>
  );
}
