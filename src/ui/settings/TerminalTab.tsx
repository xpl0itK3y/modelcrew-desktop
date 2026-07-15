import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import { type ShellOption } from "../../shell";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
} from "../../terminal/preferences";

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
    </>
  );
}
