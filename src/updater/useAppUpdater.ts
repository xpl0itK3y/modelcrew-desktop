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
import { releaseDetails, sanitizeUpdateError } from "./releaseNotes";
import type {
  AppUpdaterController,
  InstallUpdateMode,
  UpdateState,
} from "./types";

const INITIAL_CHECK_DELAY_MS = 8_000;
const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const FOCUS_CHECK_INTERVAL_MS = 30 * 60 * 1_000;
const DOWNLOAD_PROGRESS_THROTTLE_MS = 100;

const isTauri = "__TAURI_INTERNALS__" in window;

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

export function useAppUpdater({
  locale,
  beforeInstall,
}: UseAppUpdaterOptions): AppUpdaterController {
  const enabled = isTauri && !import.meta.env.DEV;
  const [state, setReactState] = useState<UpdateState>({ status: "idle" });
  const stateRef = useRef<UpdateState>(state);
  const updateRef = useRef<Update | null>(null);
  const installModeRef = useRef<InstallUpdateMode | null>(null);
  const operationInProgressRef = useRef(false);
  const operationGenerationRef = useRef(0);
  // A focus event during startup must not bypass the deliberate 8s delay.
  const lastCheckAtRef = useRef(Date.now());
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

  const closeUpdateResource = useCallback(async (update: Update) => {
    if (updateRef.current === update) {
      updateRef.current = null;
    }
    await update.close().catch(() => {});
  }, []);

  const setState = useCallback((next: UpdateState) => {
    stateRef.current = next;
    if (mountedRef.current) {
      setReactState(next);
    }
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
    if (!enabled || operationInProgressRef.current) {
      return;
    }
    if (
      stateRef.current.status === "downloading" ||
      stateRef.current.status === "ready" ||
      stateRef.current.status === "packageManaged" ||
      stateRef.current.status === "installing"
    ) {
      return;
    }

    operationInProgressRef.current = true;
    const generation = ++operationGenerationRef.current;
    lastCheckAtRef.current = Date.now();
    setState({ status: "checking" });
    let stage: "check" | "download" = "check";
    let operationUpdate: Update | null = null;
    try {
      const staleUpdate = updateRef.current;
      updateRef.current = null;
      if (staleUpdate) {
        await closeUpdateResource(staleUpdate);
      }
      if (!isCurrentGeneration(generation)) {
        return;
      }
      const installMode = await resolveInstallMode();
      if (!isCurrentGeneration(generation)) {
        return;
      }
      if (installMode === "development") {
        setState({ status: "idle" });
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
        setState({ status: "upToDate" });
        return;
      }

      updateRef.current = update;

      const details = releaseDetails(update, localeRef.current);
      if (installMode === "packageManaged") {
        setState({ status: "packageManaged", ...details });
        return;
      }

      stage = "download";
      let downloaded = 0;
      let total: number | undefined;
      let lastPublishedAt = 0;
      setState({
        status: "downloading",
        version: update.version,
        downloaded,
      });
      const publishProgress = (force = false) => {
        if (!isCurrentGeneration(generation)) {
          return;
        }
        const now = performance.now();
        if (!force && now - lastPublishedAt < DOWNLOAD_PROGRESS_THROTTLE_MS) {
          return;
        }
        lastPublishedAt = now;
        setState({
          status: "downloading",
          version: update.version,
          downloaded,
          ...(total === undefined ? {} : { total }),
        });
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
      setState({
        status: "ready",
        ...releaseDetails(update, localeRef.current),
      });
    } catch (error) {
      if (!isCurrentGeneration(generation)) {
        if (operationUpdate) {
          await closeUpdateResource(operationUpdate);
        }
        return;
      }
      console.error(`Updater ${stage} failed`, error);
      setState({
        status: "error",
        stage,
        message: sanitizeUpdateError(error),
      });
      if (operationUpdate) {
        await closeUpdateResource(operationUpdate);
      }
    } finally {
      operationInProgressRef.current = false;
    }
  }, [
    closeUpdateResource,
    enabled,
    isCurrentGeneration,
    resolveInstallMode,
    setState,
  ]);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (
      !enabled ||
      !update ||
      operationInProgressRef.current ||
      stateRef.current.status !== "ready"
    ) {
      return;
    }

    operationInProgressRef.current = true;
    const generation = ++operationGenerationRef.current;
    setState({ status: "installing", version: update.version });
    try {
      await beforeInstallRef.current();
      if (!isCurrentGeneration(generation)) {
        await closeUpdateResource(update);
        return;
      }
      await update.install();
      if (!isCurrentGeneration(generation)) {
        await closeUpdateResource(update);
        return;
      }
      await relaunch();
    } catch (error) {
      if (!isCurrentGeneration(generation)) {
        await closeUpdateResource(update);
        return;
      }
      console.error("Updater install failed", error);
      setState({
        status: "error",
        stage: "install",
        message: sanitizeUpdateError(error),
      });
      await closeUpdateResource(update);
    } finally {
      operationInProgressRef.current = false;
    }
  }, [closeUpdateResource, enabled, isCurrentGeneration, setState]);

  const openRelease = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== "ready" && current.status !== "packageManaged") {
      return;
    }
    try {
      await openUrl(current.releaseUrl);
    } catch (error) {
      console.error("Could not open the update release page", error);
    }
  }, []);

  useEffect(() => {
    if (
      stateRef.current.status !== "ready" &&
      stateRef.current.status !== "packageManaged"
    ) {
      return;
    }
    const update = updateRef.current;
    if (!update) {
      return;
    }
    setState({
      status: stateRef.current.status,
      ...releaseDetails(update, locale),
    });
  }, [locale, setState]);

  useEffect(() => {
    mountedRef.current = true;
    const invalidate = () => {
      mountedRef.current = false;
      operationGenerationRef.current += 1;
      // Не закрываем Resource посреди download/install: соответствующий await
      // завершится (или отклонится), увидит устаревшее поколение и закроет его.
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
      void checkForUpdates();
    }, INITIAL_CHECK_DELAY_MS);
    const periodicTimer = window.setInterval(() => {
      void checkForUpdates();
    }, PERIODIC_CHECK_INTERVAL_MS);
    const onFocus = () => {
      if (Date.now() - lastCheckAtRef.current >= FOCUS_CHECK_INTERVAL_MS) {
        void checkForUpdates();
      }
    };
    window.addEventListener("focus", onFocus);

    return () => {
      invalidate();
      window.clearTimeout(initialTimer);
      window.clearInterval(periodicTimer);
      window.removeEventListener("focus", onFocus);
    };
  }, [checkForUpdates, closeUpdateResource, enabled]);

  return {
    enabled,
    state,
    checkForUpdates,
    installUpdate,
    openRelease,
  };
}
