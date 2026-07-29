import { useEffect, useState } from "react";
import { type MessageKey, useI18n } from "../../i18n";
import {
  loadAgentHookStates,
  setAgentHook,
  type AgentHookState,
} from "../../agentHooks";
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
  const [hooks, setHooks] = useState<AgentHookState[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [hookError, setHookError] = useState<string | null>(null);
  const supported = AGENTS.map((agent) => agent.label).join(" · ");

  useEffect(() => {
    let cancelled = false;
    void loadAgentHookStates()
      .then((states) => {
        if (!cancelled) {
          setHooks(states);
        }
      })
      .catch(() => {
        // Список не собрался — переключателей просто не будет.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const agentLabel = (id: string) =>
    AGENTS.find((agent) => agent.id === id)?.label ?? id;

  // Правка чужого конфига может не удаться (нет прав, битый JSON), и тогда
  // тумблер обязан вернуться назад: показывать «подключено» там, где ничего
  // не подключилось, хуже, чем не иметь тумблера вовсе.
  const toggleHook = async (agent: string, enabled: boolean) => {
    setBusy(agent);
    setHookError(null);
    try {
      const next = await setAgentHook(agent, enabled);
      setHooks((current) =>
        current.map((state) => (state.agent === agent ? next : state)),
      );
    } catch {
      setHookError(agent);
    } finally {
      setBusy(null);
    }
  };

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

      {hooks
        .filter((state) => state.supported)
        .map((state) => (
          <SettingRow
            key={state.agent}
            title={t("settings.agentHook", { agent: agentLabel(state.agent) })}
            description={t("settings.agentHookNote")}
            keywords={state.config}
            control={
              <SettingsSwitch
                label={t("settings.agentHook", {
                  agent: agentLabel(state.agent),
                })}
                checked={state.installed}
                disabled={busy === state.agent}
                onChange={(enabled) => void toggleHook(state.agent, enabled)}
              />
            }
            note={
              <p
                className={`settings-note${hookError === state.agent ? " is-error" : ""}`}
                role={hookError === state.agent ? "alert" : undefined}
              >
                {hookError === state.agent
                  ? t("settings.agentHookFailed")
                  : t("settings.agentHookFile", { file: state.config })}
              </p>
            }
          />
        ))}
    </SettingsPage>
  );
}
