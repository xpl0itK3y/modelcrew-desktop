import { useState } from "react";
import { type MessageKey, useI18n } from "../../i18n";
import {
  NOTIFICATION_SOUNDS,
  isNotificationSoundSuppressed,
  loadNotificationSound,
  previewNotificationSound,
  saveNotificationSound,
  type NotificationSoundId,
} from "../../sound";
import {
  loadSystemNotificationsEnabled,
  saveSystemNotificationsEnabled,
} from "../../notifications";
import { PlayIcon } from "../Icons";
import {
  SettingRow,
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
  const [soundSuppressed, setSoundSuppressed] = useState(() =>
    isNotificationSoundSuppressed(),
  );
  const [systemEnabled, setSystemEnabled] = useState(() =>
    loadSystemNotificationsEnabled(),
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
    setSound(id);
    saveNotificationSound(id);
    playSound(id);
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
        title={t("settings.systemNotifications")}
        description={t("settings.systemNotificationsNote")}
        control={
          <SettingsSwitch
            label={t("settings.systemNotifications")}
            checked={systemEnabled}
            onChange={(enabled) => {
              setSystemEnabled(enabled);
              saveSystemNotificationsEnabled(enabled);
            }}
          />
        }
      />
    </SettingsPage>
  );
}
