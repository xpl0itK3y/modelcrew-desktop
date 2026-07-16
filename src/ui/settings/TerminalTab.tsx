import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type MessageKey, useI18n } from "../../i18n";
import { type ShellOption } from "../../shell";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  loadEagerSessionRestore,
  loadTerminalHistoryIsolation,
  saveEagerSessionRestore,
  saveTerminalHistoryIsolation,
} from "../../terminal/preferences";
import {
  AGENTS,
  loadAgentResumeMode,
  saveAgentResumeMode,
  type AgentResumeMode,
} from "../../agents";

const resumeModeMessageKeys: Record<AgentResumeMode, MessageKey> = {
  off: "settings.agentResumeOff",
  insert: "settings.agentResumeInsert",
  auto: "settings.agentResumeAuto",
};

const RESUME_MODES: AgentResumeMode[] = ["auto", "insert", "off"];

const isTauri = "__TAURI_INTERNALS__" in window;

type TerminalTabProps = {
  shell: string | null;
  shellBusy: boolean;
  terminalFontSize: number;
  onSelectShell: (command: string | null, label: string) => void;
  onSelectTerminalFontSize: (size: number) => void;
};

export function TerminalTab(props: TerminalTabProps) {
  const { t } = useI18n();
  const [shells, setShells] = useState<ShellOption[]>([]);
  const [resumeMode, setResumeMode] = useState<AgentResumeMode>(() =>
    loadAgentResumeMode(),
  );
  const [historyIsolated, setHistoryIsolated] = useState(() =>
    loadTerminalHistoryIsolation(),
  );
  const [eagerRestore, setEagerRestore] = useState(() =>
    loadEagerSessionRestore(),
  );
  const fontSizeProgress =
    ((props.terminalFontSize - MIN_TERMINAL_FONT_SIZE) /
      (MAX_TERMINAL_FONT_SIZE - MIN_TERMINAL_FONT_SIZE)) *
    100;

  useEffect(() => {
    if (!isTauri) {
      return;
    }
    let cancelled = false;
    void invoke<ShellOption[]>("list_shells")
      .then((list) => {
        if (!cancelled) {
          setShells(list);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      {isTauri && shells.length > 0 && (
        <div className="settings-section">
          <div className="settings-label">{t("settings.shell")}</div>
          <div
            className="shell-options"
            role="group"
            aria-label={t("settings.shell")}
            aria-busy={props.shellBusy}
          >
            <button
              type="button"
              disabled={props.shellBusy}
              aria-pressed={props.shell === null}
              className={`shell-option ${props.shell === null ? "is-selected" : ""}`}
              onClick={() =>
                props.onSelectShell(null, t("settings.shellDefault"))
              }
            >
              {t("settings.shellDefault")}
            </button>
            {shells.map((option) => (
              <button
                key={option.command}
                type="button"
                disabled={props.shellBusy}
                title={t("settings.selectShell", { name: option.label })}
                aria-label={t("settings.selectShell", {
                  name: option.label,
                })}
                aria-pressed={props.shell === option.command}
                className={`shell-option ${
                  props.shell === option.command ? "is-selected" : ""
                }`}
                onClick={() =>
                  props.onSelectShell(option.command, option.label)
                }
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="settings-note">
            {props.shellBusy
              ? t("settings.shellApplying")
              : t("settings.shellNote")}
          </p>
        </div>
      )}

      <div className="settings-section">
        <div className="settings-label">{t("settings.terminalFontSize")}</div>
        <div className="terminal-font-size-control">
          <input
            type="range"
            className="terminal-font-size-slider"
            min={MIN_TERMINAL_FONT_SIZE}
            max={MAX_TERMINAL_FONT_SIZE}
            step={1}
            value={props.terminalFontSize}
            aria-label={t("settings.terminalFontSize")}
            aria-valuetext={t("settings.terminalFontSizeValue", {
              size: props.terminalFontSize,
            })}
            style={
              {
                "--terminal-font-size-progress": `${fontSizeProgress}%`,
              } as CSSProperties
            }
            onChange={(event) =>
              props.onSelectTerminalFontSize(Number(event.target.value))
            }
          />
          <output className="terminal-font-size-value" aria-live="polite">
            {t("settings.terminalFontSizeValue", {
              size: props.terminalFontSize,
            })}
          </output>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label">{t("settings.agentResume")}</div>
        <div
          className="shell-options"
          role="group"
          aria-label={t("settings.agentResume")}
        >
          {RESUME_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={resumeMode === mode}
              className={`shell-option ${resumeMode === mode ? "is-selected" : ""}`}
              onClick={() => {
                setResumeMode(mode);
                saveAgentResumeMode(mode);
              }}
            >
              {t(resumeModeMessageKeys[mode])}
            </button>
          ))}
        </div>
        <p className="settings-note">{t("settings.agentResumeNote")}</p>
        <p className="settings-note">
          {t("settings.agentResumeSupported", {
            agents: AGENTS.map((agent) => agent.label).join(" · "),
          })}
        </p>
      </div>

      <div className="settings-section">
        <div className="settings-label">{t("settings.sessionRestore")}</div>
        <div
          className="shell-options"
          role="group"
          aria-label={t("settings.sessionRestore")}
        >
          {[true, false].map((eager) => (
            <button
              key={String(eager)}
              type="button"
              aria-pressed={eagerRestore === eager}
              className={`shell-option ${
                eagerRestore === eager ? "is-selected" : ""
              }`}
              onClick={() => {
                setEagerRestore(eager);
                saveEagerSessionRestore(eager);
              }}
            >
              {t(
                eager
                  ? "settings.sessionRestoreAll"
                  : "settings.sessionRestoreActive",
              )}
            </button>
          ))}
        </div>
        <p className="settings-note">{t("settings.sessionRestoreNote")}</p>
      </div>

      <div className="settings-section">
        <div className="settings-label">{t("settings.terminalHistory")}</div>
        <div
          className="shell-options"
          role="group"
          aria-label={t("settings.terminalHistory")}
        >
          {[true, false].map((isolated) => (
            <button
              key={String(isolated)}
              type="button"
              aria-pressed={historyIsolated === isolated}
              className={`shell-option ${
                historyIsolated === isolated ? "is-selected" : ""
              }`}
              onClick={() => {
                setHistoryIsolated(isolated);
                saveTerminalHistoryIsolation(isolated);
              }}
            >
              {t(
                isolated
                  ? "settings.terminalHistoryPerPanel"
                  : "settings.terminalHistoryShared",
              )}
            </button>
          ))}
        </div>
        <p className="settings-note">{t("settings.terminalHistoryNote")}</p>
      </div>
    </>
  );
}
