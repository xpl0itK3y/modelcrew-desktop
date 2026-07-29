import { useEffect, useRef, useState, type CSSProperties } from "react";
import { type MessageKey, useI18n } from "../../i18n";
import {
  MAX_NOTIFICATION_VOLUME,
  MIN_NOTIFICATION_VOLUME,
  NOTIFICATION_SOUNDS,
  isNotificationSoundSuppressed,
  loadNotificationSound,
  loadNotificationVolume,
  previewNotificationSound,
  saveNotificationSound,
  saveNotificationVolume,
  type NotificationSoundId,
} from "../../sound";
import {
  loadSystemNotificationsEnabled,
  saveSystemNotificationsEnabled,
  sendSystemNotification,
} from "../../notifications";
import {
  loadAgentAlertDetailMode,
  saveAgentAlertDetailMode,
  type AgentAlertDetailMode,
} from "../../terminal/preferences";
import { PlayIcon } from "../Icons";
import {
  SettingRow,
  SettingsButton,
  SettingsPage,
  SettingsSelect,
  SettingsSwitch,
} from "./SettingsControls";

const soundMessageKeys: Record<NotificationSoundId, MessageKey> = {
  off: "settings.soundOff",
  chime: "settings.soundChime",
  click: "settings.soundClick",
  pop: "settings.soundPop",
  reveal: "settings.soundReveal",
  flute: "settings.soundFlute",
};

export function NotificationsTab() {
  const { t } = useI18n();
  const [sound, setSound] = useState<NotificationSoundId>(() =>
    loadNotificationSound(),
  );
  const [volume, setVolume] = useState(() => loadNotificationVolume());
  const [soundSuppressed, setSoundSuppressed] = useState(() =>
    isNotificationSoundSuppressed(),
  );
  const [systemEnabled, setSystemEnabled] = useState(() =>
    loadSystemNotificationsEnabled(),
  );
  const [agentAlertDetail, setAgentAlertDetail] =
    useState<AgentAlertDetailMode>(() => loadAgentAlertDetailMode());
  const [systemTested, setSystemTested] = useState(false);
  const volumePreviewTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (volumePreviewTimer.current !== undefined) {
        window.clearTimeout(volumePreviewTimer.current);
      }
    },
    [],
  );

  // Вердикт защиты от зависаний (см. sound.ts) перечитывается после каждого
  // воспроизведения — и выбора, и повторного прослушивания. Иначе кнопка
  // однажды замолчала бы без объяснений, а «Без звука» снимает вердикт, и
  // предупреждение обязано исчезнуть.
  const playSound = (id: NotificationSoundId) => {
    previewNotificationSound(id);
    setSoundSuppressed(isNotificationSoundSuppressed());
  };

  // Выбор звука сразу его проигрывает — иначе выбирать пришлось бы вслепую.
  const selectSound = (id: NotificationSoundId) => {
    if (volumePreviewTimer.current !== undefined) {
      window.clearTimeout(volumePreviewTimer.current);
      volumePreviewTimer.current = undefined;
    }
    setSound(id);
    saveNotificationSound(id);
    playSound(id);
  };

  const selectVolume = (nextVolume: number) => {
    setVolume(nextVolume);
    saveNotificationVolume(nextVolume);
    if (volumePreviewTimer.current !== undefined) {
      window.clearTimeout(volumePreviewTimer.current);
    }
    if (sound === "off" || nextVolume === 0) {
      volumePreviewTimer.current = undefined;
      return;
    }
    // Во время перетаскивания ползунка не запускаем WAV на каждом пикселе:
    // короткая пауза даёт одно предпрослушивание с итоговой громкостью.
    volumePreviewTimer.current = window.setTimeout(() => {
      volumePreviewTimer.current = undefined;
      playSound(sound);
    }, 180);
  };

  // Единственный способ узнать, доходят ли баннеры: ни ОС, ни плагин об этом
  // не докладывают — отправка всегда «успешна». Поэтому кнопка не показывает
  // результат, а лишь даёт увидеть баннер своими глазами.
  const sendTestNotification = () => {
    setSystemTested(true);
    void sendSystemNotification(
      t("settings.systemNotificationsTestTitle"),
      t("settings.systemNotificationsTestBody"),
    );
  };

  const soundName = t(soundMessageKeys[sound]);

  return (
    <SettingsPage
      section="notifications"
      title={t("settings.tabNotifications")}
      intro={t("settings.notificationsIntro")}
    >
      <SettingRow
        title={t("settings.notificationSound")}
        description={t("settings.notificationSoundNote")}
        keywords={NOTIFICATION_SOUNDS.map((option) =>
          t(soundMessageKeys[option.id]),
        ).join(" ")}
        control={
          <div className="settings-control-pair">
            <SettingsSelect<NotificationSoundId>
              label={t("settings.notificationSound")}
              value={sound}
              options={NOTIFICATION_SOUNDS.map((option) => ({
                value: option.id,
                label: t(soundMessageKeys[option.id]),
              }))}
              onChange={selectSound}
            />
            <button
              type="button"
              className="icon-button"
              disabled={sound === "off"}
              title={t("settings.previewSound", { name: soundName })}
              aria-label={t("settings.previewSound", { name: soundName })}
              onClick={() => playSound(sound)}
            >
              <PlayIcon />
            </button>
          </div>
        }
        note={
          soundSuppressed ? (
            <p className="settings-note is-warning" role="alert">
              {t("settings.notificationSoundSuppressed")}
            </p>
          ) : undefined
        }
      />

      <SettingRow
        title={t("settings.notificationVolume")}
        description={t("settings.notificationVolumeNote")}
        control={
          <div className="notification-volume-control">
            <input
              type="range"
              className="notification-volume-slider"
              min={MIN_NOTIFICATION_VOLUME}
              max={MAX_NOTIFICATION_VOLUME}
              step={1}
              value={volume}
              disabled={sound === "off"}
              aria-label={t("settings.notificationVolume")}
              aria-valuetext={t("settings.notificationVolumeValue", {
                volume,
              })}
              style={
                {
                  "--notification-volume-progress": `${volume}%`,
                } as CSSProperties
              }
              onChange={(event) => selectVolume(Number(event.target.value))}
            />
            <output className="notification-volume-value" aria-live="polite">
              {t("settings.notificationVolumeValue", { volume })}
            </output>
          </div>
        }
      />

      <SettingRow
        title={t("settings.systemNotifications")}
        description={t("settings.systemNotificationsNote")}
        keywords={t("settings.systemNotificationsTest")}
        control={
          <div className="settings-control-pair">
            <SettingsSwitch
              label={t("settings.systemNotifications")}
              checked={systemEnabled}
              onChange={(enabled) => {
                setSystemEnabled(enabled);
                setSystemTested(false);
                saveSystemNotificationsEnabled(enabled);
              }}
            />
            <SettingsButton
              label={t("settings.systemNotificationsTest")}
              disabled={!systemEnabled}
              onClick={sendTestNotification}
            />
          </div>
        }
        note={
          systemTested ? (
            <p className="settings-note" role="status">
              {t("settings.systemNotificationsTestSent")}
            </p>
          ) : undefined
        }
      />

      <SettingRow
        title={t("settings.agentAlertDetail")}
        description={t("settings.agentAlertDetailNote")}
        badge={t("common.beta")}
        control={
          <SettingsSelect<AgentAlertDetailMode>
            label={t("settings.agentAlertDetail")}
            value={agentAlertDetail}
            options={[
              {
                value: "brief",
                label: t("settings.agentAlertDetailBrief"),
              },
              {
                value: "detailed",
                label: t("settings.agentAlertDetailDetailed"),
              },
            ]}
            onChange={(mode) => {
              setAgentAlertDetail(mode);
              saveAgentAlertDetailMode(mode);
            }}
          />
        }
      />
    </SettingsPage>
  );
}
