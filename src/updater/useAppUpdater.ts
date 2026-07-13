import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Locale } from "../i18n";
import { releaseDetails } from "./releaseNotes";
import type {
  AppUpdaterController,
  InstallUpdateMode,
  NotificationItem,
  NotificationCenterState,
  UpdateNotification,
  UpdateNotificationPhase,
} from "./types";

const INITIAL_CHECK_DELAY_MS = 8_000;
const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const FOCUS_CHECK_INTERVAL_MS = 30 * 60 * 1_000;
const DOWNLOAD_PROGRESS_THROTTLE_MS = 100;
const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
] as const;

const isTauri = "__TAURI_INTERNALS__" in window;

type ReleaseDetailsSource = Pick<Update, "version" | "body" | "rawJson">;
type CenterUpdate =
  | NotificationCenterState
  | ((current: NotificationCenterState) => NotificationCenterState);

type UseAppUpdaterOptions = {
  locale: Locale;
  beforeInstall: () => void | Promise<void>;
};

function isInstallMode(value: unknown): value is InstallUpdateMode {
  return (
    value === "selfUpdate" ||
    value === "packageManaged" ||
    value === "development"
  );
}

function releaseSource(update: Update): ReleaseDetailsSource {
  return {
    version: update.version,
    body: update.body,
    rawJson: update.rawJson,
  };
}

function notificationFrom(
  source: ReleaseDetailsSource,
  locale: Locale,
  phase: UpdateNotificationPhase,
  progress: Pick<UpdateNotification, "downloaded" | "total"> = {},
): UpdateNotification {
  const details = releaseDetails(source, locale);
  return {
    id: `update:${details.version}`,
    kind: "update",
    phase,
    ...details,
    ...progress,
  };
}

function findUpdateNotification(
  items: readonly NotificationItem[],
): UpdateNotification | undefined {
  return items.find(
    (item): item is UpdateNotification => item.kind === "update",
  );
}

function withUpdateNotification(
  items: readonly NotificationItem[],
  notification: UpdateNotification | null,
): NotificationItem[] {
  const otherItems = items.filter((item) => item.kind !== "update");
  return notification ? [...otherItems, notification] : otherItems;
}

function blocksBackgroundCheck(
  notification: UpdateNotification | undefined,
  restartPendingId: string | null,
) {
  return (
    notification?.phase === "downloading" ||
    notification?.phase === "installing" ||
    (notification?.phase === "installFailed" &&
      notification.id === restartPendingId)
  );
}

function isDurableNotification(notification: UpdateNotification | undefined) {
  return (
    notification?.phase === "ready" ||
    notification?.phase === "packageManaged" ||
    notification?.phase === "installFailed"
  );
}

function compareSemver(left: string, right: string): number {
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

export function useAppUpdater({
  locale,
  beforeInstall,
}: UseAppUpdaterOptions): AppUpdaterController {
  const enabled =
    isTauri && (!import.meta.env.DEV || import.meta.env.MODE === "test");
  const initialCenter: NotificationCenterState = {
    sync: enabled ? "initial" : "settled",
    items: [],
  };
  const [center, setReactCenter] =
    useState<NotificationCenterState>(initialCenter);
  const centerRef = useRef(center);
  const updateRef = useRef<Update | null>(null);
  const updateSourceRef = useRef<ReleaseDetailsSource | null>(null);
  const restartPendingIdRef = useRef<string | null>(null);
  const installModeRef = useRef<InstallUpdateMode | null>(null);
  const operationInProgressRef = useRef(false);
  const operationGenerationRef = useRef(0);
  const lastCheckAtRef = useRef<number | null>(null);
  const hasAttemptedCheckRef = useRef(false);
  const retryFailureCountRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const checkForUpdatesRef = useRef<() => Promise<void>>(async () => {});
  const localeRef = useRef(locale);
  const beforeInstallRef = useRef(beforeInstall);
  const mountedRef = useRef(true);

  localeRef.current = locale;
  beforeInstallRef.current = beforeInstall;

  const isCurrentGeneration = useCallback(
    (generation: number) =>
      mountedRef.current && operationGenerationRef.current === generation,
    [],
  );

  const setCenter = useCallback((next: CenterUpdate) => {
    const value = typeof next === "function" ? next(centerRef.current) : next;
    centerRef.current = value;
    if (mountedRef.current) {
      setReactCenter(value);
    }
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const resetRetrySchedule = useCallback(() => {
    clearRetryTimer();
    retryFailureCountRef.current = 0;
  }, [clearRetryTimer]);

  const scheduleRetry = useCallback(() => {
    clearRetryTimer();
    const index = Math.min(
      retryFailureCountRef.current,
      RETRY_DELAYS_MS.length - 1,
    );
    const delay = RETRY_DELAYS_MS[index];
    retryFailureCountRef.current += 1;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      void checkForUpdatesRef.current();
    }, delay);
  }, [clearRetryTimer]);

  const closeUpdateResource = useCallback(async (update: Update) => {
    if (updateRef.current === update) {
      updateRef.current = null;
    }
    await update.close().catch(() => {});
  }, []);

  const resolveInstallMode = useCallback(async (): Promise<InstallUpdateMode> => {
    if (installModeRef.current) {
      return installModeRef.current;
    }
    const mode = await invoke<unknown>("updater_install_mode");
    if (!isInstallMode(mode)) {
      throw new Error("The application returned an unsupported update mode");
    }
    installModeRef.current = mode;
    return mode;
  }, []);

  const checkForUpdates = useCallback(async () => {
    if (
      !enabled ||
      operationInProgressRef.current ||
      retryTimerRef.current !== null
    ) {
      return;
    }
    const currentNotification = findUpdateNotification(
      centerRef.current.items,
    );
    if (
      blocksBackgroundCheck(
        currentNotification,
        restartPendingIdRef.current,
      )
    ) {
      return;
    }

    operationInProgressRef.current = true;
    const generation = ++operationGenerationRef.current;
    const isInitialAttempt = !hasAttemptedCheckRef.current;
    hasAttemptedCheckRef.current = true;
    lastCheckAtRef.current = Date.now();
    setCenter((current) => ({
      ...current,
      sync: isInitialAttempt ? "initial" : "checking",
    }));

    let stage: "check" | "download" = "check";
    let operationUpdate: Update | null = null;
    let operationSource: ReleaseDetailsSource | null = null;
    let downloaded = 0;
    let total: number | undefined;

    try {
      const installMode = await resolveInstallMode();
      if (!isCurrentGeneration(generation)) {
        return;
      }
      if (installMode === "development") {
        const retainedUpdate = updateRef.current;
        updateRef.current = null;
        if (retainedUpdate) {
          await closeUpdateResource(retainedUpdate);
        }
        updateSourceRef.current = null;
        restartPendingIdRef.current = null;
        resetRetrySchedule();
        setCenter((current) => ({
          sync: "settled",
          items: withUpdateNotification(current.items, null),
        }));
        return;
      }

      const update = await check({ timeout: 30_000 });
      operationUpdate = update;
      if (!isCurrentGeneration(generation)) {
        if (update) {
          await closeUpdateResource(update);
        }
        return;
      }
      if (!update) {
        if (!isDurableNotification(currentNotification)) {
          updateSourceRef.current = null;
          restartPendingIdRef.current = null;
        }
        resetRetrySchedule();
        setCenter((current) => ({
          sync: "settled",
          items: isDurableNotification(currentNotification)
            ? current.items
            : withUpdateNotification(current.items, null),
        }));
        return;
      }

      if (
        currentNotification &&
        isDurableNotification(currentNotification) &&
        compareSemver(update.version, currentNotification.version) <= 0
      ) {
        await closeUpdateResource(update);
        operationUpdate = null;
        if (!isCurrentGeneration(generation)) {
          return;
        }
        resetRetrySchedule();
        setCenter((current) => ({ ...current, sync: "settled" }));
        return;
      }

      const source = releaseSource(update);
      operationSource = source;
      const retainedUpdate = updateRef.current;
      updateRef.current = null;
      if (retainedUpdate && retainedUpdate !== update) {
        await closeUpdateResource(retainedUpdate);
      }
      if (!isCurrentGeneration(generation)) {
        await closeUpdateResource(update);
        operationUpdate = null;
        return;
      }
      updateSourceRef.current = source;
      restartPendingIdRef.current = null;
      updateRef.current = update;

      if (installMode === "packageManaged") {
        await closeUpdateResource(update);
        operationUpdate = null;
        if (!isCurrentGeneration(generation)) {
          return;
        }
        resetRetrySchedule();
        setCenter((current) => ({
          sync: "settled",
          items: withUpdateNotification(
            current.items,
            notificationFrom(source, localeRef.current, "packageManaged"),
          ),
        }));
        return;
      }

      stage = "download";
      let lastPublishedAt = 0;
      setCenter((current) => ({
        sync: "settled",
        items: withUpdateNotification(
          current.items,
          notificationFrom(source, localeRef.current, "downloading", {
            downloaded,
          }),
        ),
      }));
      const publishProgress = (force = false) => {
        if (!isCurrentGeneration(generation)) {
          return;
        }
        const now = performance.now();
        if (!force && now - lastPublishedAt < DOWNLOAD_PROGRESS_THROTTLE_MS) {
          return;
        }
        lastPublishedAt = now;
        setCenter((current) => ({
          sync: "settled",
          items: withUpdateNotification(
            current.items,
            notificationFrom(source, localeRef.current, "downloading", {
              downloaded,
              ...(total === undefined ? {} : { total }),
            }),
          ),
        }));
      };
      const onDownload = (event: DownloadEvent) => {
        if (event.event === "Started") {
          total = event.data.contentLength;
          publishProgress(true);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          publishProgress();
        } else {
          publishProgress(true);
        }
      };
      await update.download(onDownload, { timeout: 10 * 60 * 1_000 });
      if (!isCurrentGeneration(generation)) {
        await closeUpdateResource(update);
        return;
      }

      resetRetrySchedule();
      setCenter((current) => ({
        sync: "settled",
        items: withUpdateNotification(
          current.items,
          notificationFrom(source, localeRef.current, "ready"),
        ),
      }));
    } catch (error) {
      if (!isCurrentGeneration(generation)) {
        if (operationUpdate) {
          await closeUpdateResource(operationUpdate);
        }
        return;
      }

      // Background transport failures are diagnostics, not notifications.
      console.error(`Updater ${stage} failed`, error);
      if (stage === "download" && operationSource) {
        const downloadSource = operationSource;
        updateSourceRef.current = downloadSource;
        setCenter((current) => ({
          sync: "retrying",
          items: withUpdateNotification(
            current.items,
            notificationFrom(
              downloadSource,
              localeRef.current,
              "downloadRetry",
              {
                downloaded,
                ...(total === undefined ? {} : { total }),
              },
            ),
          ),
        }));
      } else {
        setCenter((current) => ({
          sync: "retrying",
          items: current.items,
        }));
      }
      if (operationUpdate) {
        await closeUpdateResource(operationUpdate);
      }
      if (isCurrentGeneration(generation)) {
        scheduleRetry();
      }
    } finally {
      operationInProgressRef.current = false;
    }
  }, [
    closeUpdateResource,
    enabled,
    isCurrentGeneration,
    resetRetrySchedule,
    resolveInstallMode,
    scheduleRetry,
    setCenter,
  ]);

  checkForUpdatesRef.current = checkForUpdates;

  const ensureChecked = useCallback(async () => {
    if (!enabled || hasAttemptedCheckRef.current) {
      return;
    }
    await checkForUpdatesRef.current();
  }, [enabled]);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    const notification = findUpdateNotification(centerRef.current.items);
    const restartOnly =
      notification?.id === restartPendingIdRef.current;
    if (
      !enabled ||
      !notification ||
      (!update && !restartOnly) ||
      operationInProgressRef.current ||
      (notification.phase !== "ready" &&
        notification.phase !== "installFailed")
    ) {
      return;
    }

    operationInProgressRef.current = true;
    clearRetryTimer();
    const generation = ++operationGenerationRef.current;
    setCenter((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.kind === "update" && item.id === notification.id
          ? { ...item, phase: "installing" }
          : item,
      ),
    }));
    try {
      if (!restartOnly) {
        await beforeInstallRef.current();
        if (!isCurrentGeneration(generation)) {
          if (update) {
            await closeUpdateResource(update);
          }
          return;
        }
        await update!.install();
        updateRef.current = null;
        restartPendingIdRef.current = notification.id;
      }
      if (!isCurrentGeneration(generation)) {
        return;
      }
      await relaunch();
    } catch (error) {
      if (!isCurrentGeneration(generation)) {
        if (update && updateRef.current === update) {
          await closeUpdateResource(update);
        }
        return;
      }
      console.error("Updater install or relaunch failed", error);
      setCenter((current) => ({
        ...current,
        items: current.items.map((item) =>
          item.kind === "update" && item.id === notification.id
            ? { ...item, phase: "installFailed" }
            : item,
        ),
      }));
    } finally {
      operationInProgressRef.current = false;
    }
  }, [
    clearRetryTimer,
    closeUpdateResource,
    enabled,
    isCurrentGeneration,
    setCenter,
  ]);

  const openRelease = useCallback(async () => {
    const notification = findUpdateNotification(centerRef.current.items);
    if (!notification) {
      return;
    }
    try {
      await openUrl(notification.releaseUrl);
    } catch (error) {
      console.error("Could not open the update release page", error);
    }
  }, []);

  useEffect(() => {
    const source = updateSourceRef.current;
    if (!source) {
      return;
    }
    setCenter((current) => ({
      ...current,
      items: current.items.map((item) => {
        if (item.kind !== "update") {
          return item;
        }
        const localized = notificationFrom(source, locale, item.phase, {
          ...(item.downloaded === undefined
            ? {}
            : { downloaded: item.downloaded }),
          ...(item.total === undefined ? {} : { total: item.total }),
        });
        return item.id === localized.id ? localized : item;
      }),
    }));
  }, [locale, setCenter]);

  useEffect(() => {
    mountedRef.current = true;
    const invalidate = () => {
      mountedRef.current = false;
      operationGenerationRef.current += 1;
      clearRetryTimer();
      if (!operationInProgressRef.current) {
        const update = updateRef.current;
        updateRef.current = null;
        if (update) {
          void closeUpdateResource(update);
        }
      }
    };
    if (!enabled) {
      return invalidate;
    }

    const initialTimer = window.setTimeout(() => {
      if (!hasAttemptedCheckRef.current) {
        void checkForUpdatesRef.current();
      }
    }, INITIAL_CHECK_DELAY_MS);
    const periodicTimer = window.setInterval(() => {
      void checkForUpdatesRef.current();
    }, PERIODIC_CHECK_INTERVAL_MS);
    const onFocus = () => {
      const lastCheckAt = lastCheckAtRef.current;
      if (
        lastCheckAt !== null &&
        Date.now() - lastCheckAt >= FOCUS_CHECK_INTERVAL_MS
      ) {
        void checkForUpdatesRef.current();
      }
    };
    const onOnline = () => {
      if (centerRef.current.sync === "retrying") {
        clearRetryTimer();
        void checkForUpdatesRef.current();
      }
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);

    return () => {
      invalidate();
      window.clearTimeout(initialTimer);
      window.clearInterval(periodicTimer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [clearRetryTimer, closeUpdateResource, enabled]);

  return {
    enabled,
    center,
    ensureChecked,
    installUpdate,
    openRelease,
  };
}
