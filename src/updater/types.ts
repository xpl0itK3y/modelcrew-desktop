export type InstallUpdateMode =
  | "selfUpdate"
  | "packageManaged"
  | "development";

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
  | "downloadRetry"
  | "ready"
  | "packageManaged"
  | "installing"
  | "installFailed";

export type UpdateNotification = UpdateDetails & {
  id: `update:${string}`;
  kind: "update";
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
};
