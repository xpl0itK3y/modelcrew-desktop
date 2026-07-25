import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import { type ShellOption } from "../../shell";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  loadEagerSessionRestore,
  loadGridOrientation,
  loadTerminalHistoryIsolation,
  saveEagerSessionRestore,
  saveGridOrientation,
  saveTerminalHistoryIsolation,
  type GridOrientation,
} from "../../terminal/preferences";
import { SettingRow, SettingsPage, SettingsSelect } from "./SettingsControls";

// Значение «системная оболочка» приходит из App как null, а <select> умеет
// хранить только строки — пустая строка и есть этот случай.
const SYSTEM_SHELL = "";

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
  const [historyIsolated, setHistoryIsolated] = useState(() =>
    loadTerminalHistoryIsolation(),
  );
  const [eagerRestore, setEagerRestore] = useState(() =>
    loadEagerSessionRestore(),
  );
  const [gridOrientation, setGridOrientation] = useState<GridOrientation>(() =>
    loadGridOrientation(),
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
    <SettingsPage
      section="terminal"
      title={t("settings.tabTerminal")}
      intro={t("settings.terminalIntro")}
    >
      {isTauri && shells.length > 0 && (
        <SettingRow
          title={t("settings.shell")}
          description={
            props.shellBusy
              ? t("settings.shellApplying")
              : t("settings.shellNote")
          }
          keywords={shells.map((option) => option.label).join(" ")}
          control={
            <SettingsSelect
              label={t("settings.shell")}
              value={props.shell ?? SYSTEM_SHELL}
              busy={props.shellBusy}
              disabled={props.shellBusy}
              options={[
                {
                  value: SYSTEM_SHELL,
                  label: t("settings.shellDefault"),
                },
                ...shells.map((option) => ({
                  value: option.command,
                  label: option.label,
                })),
              ]}
              onChange={(value) => {
                if (value === SYSTEM_SHELL) {
                  props.onSelectShell(null, t("settings.shellDefault"));
                  return;
                }
                const picked = shells.find(
                  (option) => option.command === value,
                );
                props.onSelectShell(value, picked?.label ?? value);
              }}
            />
          }
        />
      )}

      <SettingRow
        title={t("settings.terminalFontSize")}
        description={t("settings.terminalFontSizeNote")}
        control={
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
        }
      />

      <SettingRow
        title={t("settings.terminalHistory")}
        description={t("settings.terminalHistoryNote")}
        control={
          <SettingsSelect
            label={t("settings.terminalHistory")}
            value={historyIsolated ? "panel" : "shared"}
            options={[
              {
                value: "panel",
                label: t("settings.terminalHistoryPerPanel"),
              },
              { value: "shared", label: t("settings.terminalHistoryShared") },
            ]}
            onChange={(value) => {
              const isolated = value === "panel";
              setHistoryIsolated(isolated);
              saveTerminalHistoryIsolation(isolated);
            }}
          />
        }
      />

      <SettingRow
        title={t("settings.gridOrientation")}
        description={t("settings.gridOrientationNote")}
        control={
          <SettingsSelect<GridOrientation>
            label={t("settings.gridOrientation")}
            value={gridOrientation}
            options={[
              { value: "columns", label: t("settings.gridColumns") },
              { value: "rows", label: t("settings.gridRows") },
            ]}
            onChange={(value) => {
              setGridOrientation(value);
              saveGridOrientation(value);
            }}
          />
        }
      />

      <SettingRow
        title={t("settings.sessionRestore")}
        description={t("settings.sessionRestoreNote")}
        control={
          <SettingsSelect
            label={t("settings.sessionRestore")}
            value={eagerRestore ? "all" : "active"}
            options={[
              { value: "all", label: t("settings.sessionRestoreAll") },
              { value: "active", label: t("settings.sessionRestoreActive") },
            ]}
            onChange={(value) => {
              const eager = value === "all";
              setEagerRestore(eager);
              saveEagerSessionRestore(eager);
            }}
          />
        }
      />
    </SettingsPage>
  );
}
