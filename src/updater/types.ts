export type LinuxPackageKind = "deb" | "rpm" | "pacman";

export type InstallUpdateTarget =
  | { mode: "selfUpdate"; target?: string }
  | {
      mode: "nativePackage";
      packageKind: LinuxPackageKind;
      target: string;
    }
  | { mode: "manual" }
  | { mode: "development" };

export type UpdateInstallKind =
  | "selfUpdate"
  | "nativePackage"
  | "manual";

export type UpdateDetails = {
  version: string;
  title: string;
  summary: string;
  highlights: string[];
  releaseUrl: string;
};

export type NotificationSyncState =
  | "initial"
  | "checking"
  | "settled"
  | "retrying";

export type UpdateNotificationPhase =
  | "downloading"
  | "verifying"
  | "downloadRetry"
  | "ready"
  | "manual"
  | "authorizing"
  | "installing"
  | "restarting"
  | "authorizationCancelled"
  | "installFailed"
  | "restartFailed";

export type UpdateNotification = UpdateDetails & {
  id: `update:${string}`;
  kind: "update";
  installKind: UpdateInstallKind;
  phase: UpdateNotificationPhase;
  downloaded?: number;
  total?: number;
};

export type AnnouncementNotification = {
  id: `announcement:${string}`;
  kind: "announcement";
  title: string;
  summary: string;
  highlights: string[];
};

export type NotificationItem = UpdateNotification | AnnouncementNotification;

export type NotificationCenterState = {
  sync: NotificationSyncState;
  items: NotificationItem[];
};

export type AppUpdaterController = {
  enabled: boolean;
  center: NotificationCenterState;
  ensureChecked: () => Promise<void>;
  installUpdate: () => Promise<void>;
  openRelease: () => Promise<void>;
  // Скрывает уведомление по id. Карточки обновлений (kind "update")
  // защищены: ими управляет машина состояний апдейтера.
  dismissNotification: (id: string) => void;
};
