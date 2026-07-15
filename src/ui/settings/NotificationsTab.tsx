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

  // Selecting a sound also auditions it so the choice is audible immediately.
  // Selecting "off" clears the hang-protection verdict (see sound.ts), so the
  // suppression note is re-read after every pick.
  const selectSound = (id: NotificationSoundId) => {
    setSound(id);
    saveNotificationSound(id);
    previewNotificationSound(id);
    setSoundSuppressed(isNotificationSoundSuppressed());
  };

  return (
    <div className="settings-section">
      <div className="settings-label">{t("settings.notificationSound")}</div>
      <div
        className="sound-options"
        role="group"
        aria-label={t("settings.notificationSound")}
      >
        {NOTIFICATION_SOUNDS.map((option) => {
          const name = t(soundMessageKeys[option.id]);
          const isOff = option.id === "off";
          const label = isOff ? name : t("settings.previewSound", { name });
          return (
            <button
              key={option.id}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={sound === option.id}
              className={`sound-option ${
                sound === option.id ? "is-selected" : ""
              }`}
              onClick={() => selectSound(option.id)}
            >
              <span className="sound-option-icon" aria-hidden="true">
                {isOff ? "🔇" : "▶"}
              </span>
              <span>{name}</span>
            </button>
          );
        })}
      </div>
      <p className="settings-note">{t("settings.notificationSoundNote")}</p>
      {soundSuppressed && (
        <p className="settings-note is-warning" role="alert">
          {t("settings.notificationSoundSuppressed")}
        </p>
      )}
    </div>
  );
}
