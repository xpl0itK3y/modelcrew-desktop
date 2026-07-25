import { useState } from "react";
import { type MessageKey, useI18n } from "../../i18n";
import {
  loadAgentAlertsEnabled,
  saveAgentAlertsEnabled,
} from "../../terminal/preferences";
import {
  AGENTS,
  loadAgentResumeMode,
  saveAgentResumeMode,
  type AgentResumeMode,
} from "../../agents";
import {
  SettingRow,
  SettingsPage,
  SettingsSelect,
  SettingsSwitch,
} from "./SettingsControls";

const resumeModeMessageKeys: Record<AgentResumeMode, MessageKey> = {
  off: "settings.agentResumeOff",
  insert: "settings.agentResumeInsert",
  auto: "settings.agentResumeAuto",
};

const RESUME_MODES: AgentResumeMode[] = ["auto", "insert", "off"];

export function AgentsTab() {
  const { t } = useI18n();
  const [resumeMode, setResumeMode] = useState<AgentResumeMode>(() =>
    loadAgentResumeMode(),
  );
  const [agentAlerts, setAgentAlerts] = useState(() =>
    loadAgentAlertsEnabled(),
  );
  const supported = AGENTS.map((agent) => agent.label).join(" · ");

  return (
    <SettingsPage
      section="agents"
      title={t("settings.tabAgents")}
      intro={t("settings.agentsIntro")}
    >
      <SettingRow
        title={t("settings.agentResume")}
        description={t("settings.agentResumeNote")}
        keywords={supported}
        control={
          <SettingsSelect<AgentResumeMode>
            label={t("settings.agentResume")}
            value={resumeMode}
            options={RESUME_MODES.map((mode) => ({
              value: mode,
              label: t(resumeModeMessageKeys[mode]),
            }))}
            onChange={(mode) => {
              setResumeMode(mode);
              saveAgentResumeMode(mode);
            }}
          />
        }
        note={
          <p className="settings-note">
            {t("settings.agentResumeSupported", { agents: supported })}
          </p>
        }
      />

      <SettingRow
        title={t("settings.agentAlerts")}
        description={t("settings.agentAlertsNote")}
        control={
          <SettingsSwitch
            label={t("settings.agentAlerts")}
            checked={agentAlerts}
            onChange={(enabled) => {
              setAgentAlerts(enabled);
              saveAgentAlertsEnabled(enabled);
            }}
          />
        }
      />
    </SettingsPage>
  );
}
