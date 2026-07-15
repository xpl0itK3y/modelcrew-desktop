// Helpers that build and select update notifications, plus the semver
// ordering used to keep durable notifications from being downgraded.

import type { Update } from "@tauri-apps/plugin-updater";
import type { Locale } from "../i18n";
import { releaseDetails } from "./releaseNotes";
import type {
  NotificationItem,
  UpdateInstallKind,
  UpdateNotification,
  UpdateNotificationPhase,
} from "./types";

export type ReleaseDetailsSource = Pick<Update, "version" | "body" | "rawJson">;

export function releaseSource(update: Update): ReleaseDetailsSource {
  return {
    version: update.version,
    body: update.body,
    rawJson: update.rawJson,
  };
}

export function notificationFrom(
  source: ReleaseDetailsSource,
  locale: Locale,
  installKind: UpdateInstallKind,
  phase: UpdateNotificationPhase,
  progress: Pick<UpdateNotification, "downloaded" | "total"> = {},
): UpdateNotification {
  const details = releaseDetails(source, locale);
  return {
    id: `update:${details.version}`,
    kind: "update",
    installKind,
    phase,
    ...details,
    ...progress,
  };
}

export function findUpdateNotification(
  items: readonly NotificationItem[],
): UpdateNotification | undefined {
  return items.find(
    (item): item is UpdateNotification => item.kind === "update",
  );
}

export function withUpdateNotification(
  items: readonly NotificationItem[],
  notification: UpdateNotification | null,
): NotificationItem[] {
  const otherItems = items.filter((item) => item.kind !== "update");
  return notification ? [...otherItems, notification] : otherItems;
}

export function blocksBackgroundCheck(
  notification: UpdateNotification | undefined,
  restartPendingId: string | null,
) {
  return (
    notification?.phase === "downloading" ||
    notification?.phase === "verifying" ||
    notification?.phase === "authorizing" ||
    notification?.phase === "installing" ||
    notification?.phase === "restarting" ||
    (notification?.phase === "restartFailed" &&
      notification.id === restartPendingId)
  );
}

export function isDurableNotification(notification: UpdateNotification | undefined) {
  return (
    notification?.phase === "ready" ||
    notification?.phase === "manual" ||
    notification?.phase === "authorizationCancelled" ||
    notification?.phase === "installFailed" ||
    notification?.phase === "restartFailed"
  );
}

export function compareSemver(left: string, right: string): number {
  const parse = (value: string) => {
    const match = value.match(
      /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
    );
    if (!match) {
      return null;
    }
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])] as const,
      prerelease: match[4]?.split(".") ?? [],
    };
  };
  const leftVersion = parse(left);
  const rightVersion = parse(right);
  if (!leftVersion || !rightVersion) {
    return left === right ? 0 : -1;
  }
  for (let index = 0; index < leftVersion.core.length; index += 1) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index] > rightVersion.core[index] ? 1 : -1;
    }
  }
  if (leftVersion.prerelease.length === 0) {
    return rightVersion.prerelease.length === 0 ? 0 : 1;
  }
  if (rightVersion.prerelease.length === 0) {
    return -1;
  }
  const length = Math.max(
    leftVersion.prerelease.length,
    rightVersion.prerelease.length,
  );
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) {
      return leftNumber > rightNumber ? 1 : -1;
    }
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}
