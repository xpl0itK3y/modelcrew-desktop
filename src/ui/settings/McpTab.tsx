import { useI18n } from "../../i18n";
import { SettingRow, SettingsPage } from "./SettingsControls";

// Раздел-заглушка: инструментов агентов в приложении ещё нет, но место для
// них уже понятно, и честнее показать план, чем прятать его до готовности.
export function McpTab() {
  const { t } = useI18n();
  const soon = <span className="soon-badge">{t("common.soon")}</span>;

  return (
    <SettingsPage
      section="mcp"
      title={t("settings.tabMcp")}
      intro={t("settings.mcpIntro")}
    >
      <SettingRow
        title={t("settings.mcpServers")}
        description={t("settings.mcpServersNote")}
        keywords="MCP CodeGraph CocoIndex сервер server"
        control={soon}
      />

      <SettingRow
        title={t("settings.mcpSkills")}
        description={t("settings.mcpSkillsNote")}
        keywords="skills скиллы навыки"
        control={soon}
      />
    </SettingsPage>
  );
}
