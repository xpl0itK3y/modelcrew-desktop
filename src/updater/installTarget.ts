// Pure guards and classifiers for updater install targets and the Rust-side
// update download flow, extracted from useAppUpdater for readability.

import type {
  InstallUpdateTarget,
  UpdateInstallKind,
} from "./types";

export type UpdateDownloadProgress =
  | {
      phase: "downloading";
      downloaded: number;
      total?: number;
    }
  | { phase: "verifying" };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeTarget(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[0-9A-Za-z_-]+$/.test(value)
  );
}

export function isInstallTarget(value: unknown): value is InstallUpdateTarget {
  if (!isPlainObject(value) || typeof value.mode !== "string") {
    return false;
  }
  if (value.mode === "development" || value.mode === "manual") {
    return true;
  }
  if (value.mode === "selfUpdate") {
    return value.target === undefined || isSafeTarget(value.target);
  }
  return (
    value.mode === "nativePackage" &&
    (value.packageKind === "deb" ||
      value.packageKind === "rpm" ||
      value.packageKind === "pacman") &&
    isSafeTarget(value.target)
  );
}

export function installKindFrom(target: InstallUpdateTarget): UpdateInstallKind | null {
  switch (target.mode) {
    case "selfUpdate":
      return "selfUpdate";
    case "nativePackage":
      return "nativePackage";
    case "manual":
      return "manual";
    case "development":
      return null;
  }
}

export function isUpdateDownloadProgress(
  value: unknown,
): value is UpdateDownloadProgress {
  if (!isPlainObject(value) || typeof value.phase !== "string") {
    return false;
  }
  if (value.phase === "verifying") {
    return true;
  }
  return (
    value.phase === "downloading" &&
    typeof value.downloaded === "number" &&
    Number.isFinite(value.downloaded) &&
    value.downloaded >= 0 &&
    (value.total === undefined ||
      (typeof value.total === "number" &&
        Number.isFinite(value.total) &&
        value.total > 0))
  );
}

export function isAuthorizationCancelled(error: unknown): boolean {
  if (!isPlainObject(error) || typeof error.code !== "string") {
    return false;
  }
  return (
    error.code === "authorization_cancelled" ||
    error.code.endsWith("_authorization_cancelled") ||
    error.code.endsWith("_auth_cancelled")
  );
}

export function isRecoverableUpdateCacheError(error: unknown): boolean {
  if (!isPlainObject(error) || typeof error.code !== "string") {
    return false;
  }
  return (
    error.code === "updater_cache_missing" ||
    error.code === "updater_cache_invalid" ||
    error.code === "updater_install_target_changed"
  );
}
