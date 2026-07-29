import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { localizeBackendError, useI18n } from "../../i18n";
import {
  getGitBashAvailability,
  installGitBash,
  openGitBashDownload,
  type GitBashAvailability,
} from "../../gitBash";
import { type ShellOption } from "../../shell";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  loadTerminalHistoryIsolation,
  loadTerminalSpawnMode,
  saveTerminalHistoryIsolation,
  saveTerminalSpawnMode,
  type TerminalSpawnMode,
} from "../../terminal/preferences";
import { ConfirmDialog } from "../ConfirmDialog";
import {
  SettingRow,
  SettingsButton,
  SettingsPage,
  SettingsSelect,
} from "./SettingsControls";

// Значение «системная оболочка» приходит из App как null, а <select> умеет
// хранить только строки — пустая строка и есть этот случай.
const SYSTEM_SHELL = "";

const isTauri = () => "__TAURI_INTERNALS__" in window;

type ShellCatalog = {
  shells?: ShellOption[];
  gitBash?: GitBashAvailability;
};

async function loadShellCatalog(): Promise<ShellCatalog> {
  const [shells, gitBash] = await Promise.allSettled([
    invoke<ShellOption[]>("list_shells"),
    getGitBashAvailability(),
  ]);
  return {
    shells: shells.status === "fulfilled" ? shells.value : undefined,
    gitBash: gitBash.status === "fulfilled" ? gitBash.value : undefined,
  };
}

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
  const [gitBash, setGitBash] = useState<GitBashAvailability | null>(null);
  const [gitBashConfirm, setGitBashConfirm] = useState(false);
  const [gitBashInstalling, setGitBashInstalling] = useState(false);
  const [gitBashChecking, setGitBashChecking] = useState(false);
  const [gitBashNotice, setGitBashNotice] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [historyIsolated, setHistoryIsolated] = useState(() =>
    loadTerminalHistoryIsolation(),
  );
  const [spawnMode, setSpawnMode] = useState<TerminalSpawnMode>(() =>
    loadTerminalSpawnMode(),
  );
  const fontSizeProgress =
    ((props.terminalFontSize - MIN_TERMINAL_FONT_SIZE) /
      (MAX_TERMINAL_FONT_SIZE - MIN_TERMINAL_FONT_SIZE)) *
    100;

  const applyShellCatalog = useCallback((catalog: ShellCatalog) => {
    if (catalog.shells) {
      setShells(catalog.shells);
    }
    if (catalog.gitBash) {
      setGitBash(catalog.gitBash);
    }
  }, []);

  const refreshShellCatalog = useCallback(async () => {
    setGitBashChecking(true);
    try {
      const catalog = await loadShellCatalog();
      applyShellCatalog(catalog);
      if (catalog.gitBash?.status === "installed") {
        setGitBashNotice({
          tone: "success",
          text: t("settings.gitBashDetected"),
        });
      }
    } finally {
      setGitBashChecking(false);
    }
  }, [applyShellCatalog, t]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let cancelled = false;
    void loadShellCatalog()
      .then((catalog) => {
        if (!cancelled) {
          applyShellCatalog(catalog);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [applyShellCatalog]);

  const confirmGitBashInstall = useCallback(async () => {
    if (gitBashInstalling) {
      return;
    }
    setGitBashInstalling(true);
    setGitBashNotice(null);
    try {
      const installed = await installGitBash();
      setShells((current) => [
        ...current.filter((entry) => entry.id !== installed.id),
        installed,
      ]);
      setGitBash({ status: "installed", shell: installed });
      setGitBashNotice({
        tone: "success",
        text: t("settings.gitBashInstalled"),
      });
    } catch (error) {
      setGitBashNotice({
        tone: "error",
        text: localizeBackendError(error),
      });
    } finally {
      setGitBashInstalling(false);
      setGitBashConfirm(false);
    }
  }, [gitBashInstalling, t]);

  const openGitBashWebsite = useCallback(async () => {
    setGitBashNotice(null);
    try {
      await openGitBashDownload();
    } catch {
      setGitBashNotice({
        tone: "error",
        text: t("settings.gitBashOpenFailed"),
      });
    }
  }, [t]);

  const showGitBashInstaller =
    gitBash?.status === "installable" || gitBash?.status === "manual";

  return (
    <>
      <SettingsPage
        section="terminal"
        title={t("settings.tabTerminal")}
        intro={t("settings.terminalIntro")}
      >
      {isTauri() && shells.length > 0 && (
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
          note={
            gitBash?.status === "installed" &&
            gitBashNotice && (
              <p
                className={`settings-note is-${gitBashNotice.tone}`}
                role={gitBashNotice.tone === "error" ? "alert" : "status"}
              >
                {gitBashNotice.text}
              </p>
            )
          }
        />
      )}

      {isTauri() && showGitBashInstaller && (
        <SettingRow
          title={t("settings.gitBash")}
          description={
            gitBash.status === "installable"
              ? t("settings.gitBashInstallNote")
              : t("settings.gitBashManualNote")
          }
          keywords="Git Bash Git for Windows winget bash"
          control={
            <div className="settings-control-pair">
              {gitBash.status === "installable" ? (
                <SettingsButton
                  label={
                    gitBashInstalling
                      ? t("settings.gitBashInstalling")
                      : t("settings.gitBashInstall")
                  }
                  disabled={gitBashInstalling}
                  onClick={() => setGitBashConfirm(true)}
                />
              ) : (
                <SettingsButton
                  label={t("settings.gitBashOpenDownload")}
                  onClick={() => void openGitBashWebsite()}
                />
              )}
              <SettingsButton
                label={
                  gitBashChecking
                    ? t("settings.gitBashChecking")
                    : t("settings.gitBashCheckAgain")
                }
                disabled={gitBashChecking || gitBashInstalling}
                onClick={() => void refreshShellCatalog()}
              />
            </div>
          }
          note={
            gitBashNotice && (
              <p
                className={`settings-note is-${gitBashNotice.tone}`}
                role={gitBashNotice.tone === "error" ? "alert" : "status"}
              >
                {gitBashNotice.text}
              </p>
            )
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
        title={t("settings.terminalSpawnMode")}
        description={t("settings.terminalSpawnModeNote")}
        badge={t("common.beta")}
        control={
          <SettingsSelect
            label={t("settings.terminalSpawnMode")}
            value={spawnMode}
            options={[
              {
                value: "balanced",
                label: t("settings.terminalSpawnBalanced"),
              },
              { value: "snake", label: t("settings.terminalSpawnSnake") },
              {
                value: "centerOut",
                label: t("settings.terminalSpawnCenterOut"),
              },
            ]}
            onChange={(value) => {
              setSpawnMode(value);
              saveTerminalSpawnMode(value);
            }}
          />
        }
      />
      </SettingsPage>

      {gitBashConfirm && (
        <ConfirmDialog
          text={t("settings.gitBashInstallConfirm")}
          confirmLabel={
            gitBashInstalling
              ? t("settings.gitBashInstalling")
              : t("settings.gitBashInstall")
          }
          busy={gitBashInstalling}
          tone="primary"
          onConfirm={() => void confirmGitBashInstall()}
          onCancel={() => setGitBashConfirm(false)}
        />
      )}
    </>
  );
}
