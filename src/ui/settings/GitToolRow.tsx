import { useCallback, useEffect, useState } from "react";
import { localizeBackendError, useI18n } from "../../i18n";
import {
  installGitTools,
  isGitAvailable,
  openGitLinuxInstructions,
} from "../../git/gitTools";
import { hasTauri, platform } from "../../platform";
import { SettingRow, SettingsButton } from "./SettingsControls";

type Notice = { tone: "success" | "error"; text: string };

// Строка «Git» для macOS и Linux. На Windows git ставится вместе с Git Bash —
// строкой выше. Показывается, только пока git нет: туда ведёт подсказка из
// панели изменений, а с найденным git тут делать нечего.
export function GitToolRow() {
  const { t } = useI18n();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const supported = hasTauri() && platform !== "windows";

  useEffect(() => {
    if (!supported) {
      return;
    }
    let cancelled = false;
    void isGitAvailable()
      .then((found) => {
        if (!cancelled) {
          setAvailable(found);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const checkAgain = useCallback(async () => {
    setChecking(true);
    try {
      const found = await isGitAvailable();
      // Строку не прячем сразу: человек должен увидеть, что проверка удалась.
      setNotice(
        found
          ? { tone: "success", text: t("settings.gitFound") }
          : { tone: "error", text: t("settings.gitStillMissing") },
      );
      if (!found) {
        setAvailable(false);
      }
    } catch (error) {
      setNotice({ tone: "error", text: localizeBackendError(error) });
    } finally {
      setChecking(false);
    }
  }, [t]);

  const install = useCallback(async () => {
    setInstalling(true);
    setNotice(null);
    try {
      await installGitTools();
      setNotice({ tone: "success", text: t("settings.gitInstallStarted") });
    } catch (error) {
      setNotice({ tone: "error", text: localizeBackendError(error) });
    } finally {
      setInstalling(false);
    }
  }, [t]);

  const openGuide = useCallback(async () => {
    setNotice(null);
    try {
      await openGitLinuxInstructions();
    } catch {
      setNotice({ tone: "error", text: t("settings.gitOpenGuideFailed") });
    }
  }, [t]);

  if (!supported || available !== false) {
    return null;
  }

  const mac = platform === "mac";
  return (
    <SettingRow
      title={t("settings.git")}
      description={mac ? t("settings.gitMacNote") : t("settings.gitLinuxNote")}
      keywords="git Command Line Tools xcode-select apt dnf pacman"
      control={
        <div className="settings-control-pair">
          {mac ? (
            <SettingsButton
              label={
                installing
                  ? t("settings.gitInstallOpening")
                  : t("settings.gitInstall")
              }
              disabled={installing}
              onClick={() => void install()}
            />
          ) : (
            <SettingsButton
              label={t("settings.gitOpenGuide")}
              onClick={() => void openGuide()}
            />
          )}
          <SettingsButton
            label={
              checking ? t("settings.gitChecking") : t("settings.gitCheckAgain")
            }
            disabled={checking || installing}
            onClick={() => void checkAgain()}
          />
        </div>
      }
      note={
        notice && (
          <p
            className={`settings-note is-${notice.tone}`}
            role={notice.tone === "error" ? "alert" : "status"}
          >
            {notice.text}
          </p>
        )
      }
    />
  );
}
