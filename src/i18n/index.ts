import { useSyncExternalStore } from "react";
import { ru, type MessageKey } from "./ru";
import { en } from "./en";

export type { MessageKey } from "./ru";

export type Locale = "ru" | "en";

const LOCALE_STORAGE_KEY = "modelcrew.locale";
const DEFAULT_LOCALE: Locale = "ru";
const catalogs: Record<Locale, Record<MessageKey, string>> = { ru, en };

let currentLocale: Locale = loadLocale();
const listeners = new Set<() => void>();

function isLocale(value: unknown): value is Locale {
  return value === "ru" || value === "en";
}

export function loadLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function applyLocale(locale: Locale): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = "ltr";
}

export function initializeLocale(): Locale {
  currentLocale = loadLocale();
  applyLocale(currentLocale);
  return currentLocale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (!isLocale(locale)) {
    return;
  }
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Без localStorage язык применяется только до закрытия приложения.
  }
  const changed = currentLocale !== locale;
  currentLocale = locale;
  applyLocale(locale);
  if (changed) {
    for (const listener of listeners) {
      listener();
    }
  }
}

export function translate(
  key: MessageKey,
  params: Record<string, string | number> = {},
  locale: Locale = currentLocale,
): string {
  return catalogs[locale][key].replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`,
  );
}

export function formatTerminalCount(
  count: number,
  locale: Locale = currentLocale,
): string {
  if (locale === "en") {
    return `${count} ${count === 1 ? "terminal" : "terminals"}`;
  }
  const mod10 = count % 10;
  const mod100 = count % 100;
  const noun =
    mod10 === 1 && mod100 !== 11
      ? "терминал"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "терминала"
        : "терминалов";
  return `${count} ${noun}`;
}

export type BackendError = {
  code: string;
  context?: Record<string, string | number>;
  debug?: string;
};

function parseBackendError(error: unknown): BackendError | null {
  let value = error;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || !("code" in value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.code !== "string") {
    return null;
  }
  const context =
    candidate.context && typeof candidate.context === "object"
      ? (candidate.context as Record<string, string | number>)
      : undefined;
  return {
    code: candidate.code,
    context,
    debug: typeof candidate.debug === "string" ? candidate.debug : undefined,
  };
}

const backendErrorKeys: Record<string, MessageKey> = {
  git_unavailable: "error.gitUnavailable",
  git_not_a_repository: "error.gitNotARepository",
  git_command_failed: "error.gitCommandFailed",
  main_window_only: "error.mainWindowOnly",
  invalid_locale: "error.invalidLocale",
  app_menu_update_failed: "error.appMenuUpdateFailed",
  workspace_invalid_id: "error.workspaceInvalidId",
  workspace_root_conflict: "error.workspaceRootConflict",
  workspace_root_not_registered: "error.workspaceRootNotRegistered",
  workspace_root_identity_changed: "error.workspaceRootIdentityChanged",
  workspace_root_missing: "error.workspaceRootMissing",
  workspace_root_permission_denied: "error.workspaceRootPermissionDenied",
  workspace_root_not_directory: "error.workspaceRootNotDirectory",
  workspace_root_unavailable: "error.workspaceRootUnavailable",
  workspace_path_unsupported: "error.workspacePathUnsupported",
  workspace_picker_path_invalid: "error.workspacePickerPathInvalid",
  terminal_not_found: "error.terminalNotFound",
  terminal_pty_open_failed: "error.terminalPtyOpenFailed",
  terminal_shell_not_found: "error.terminalShellNotFound",
  terminal_cwd_unavailable: "error.terminalCwdUnavailable",
  terminal_spawn_failed: "error.terminalSpawnFailed",
  terminal_output_stream_failed: "error.terminalOutputStreamFailed",
  terminal_input_stream_failed: "error.terminalInputStreamFailed",
  terminal_write_failed: "error.terminalWriteFailed",
  terminal_resize_failed: "error.terminalResizeFailed",
  terminal_kill_failed: "error.terminalKillFailed",
};

const gitReasonKeys: Record<string, MessageKey> = {
  "branch-exists": "error.gitBranchExists",
  "branch-invalid": "error.gitBranchInvalid",
  "branch-missing": "error.gitBranchMissing",
  "branch-current": "error.gitBranchCurrent",
  "branch-unmerged": "error.gitBranchUnmerged",
  "branch-moved": "error.gitBranchMoved",
  "branch-worktree": "error.gitBranchWorktree",
  "branch-restore-failed": "error.gitBranchRestoreFailed",
  "branch-config-stale": "error.gitBranchConfigStale",
  "branch-delete-unverified": "error.gitBranchDeleteUnverified",
  "branch-backup-failed": "error.gitBranchBackupFailed",
  detached: "error.gitDetachedHead",
  "dirty-tree": "error.gitDirtyTree",
  "tag-invalid": "error.gitTagInvalid",
  "tag-exists": "error.gitTagExists",
  "tag-missing": "error.gitTagMissing",
  "replay-conflict": "error.gitReplayConflict",
  "git-too-old": "error.gitTooOld",
  "not-head": "error.gitCommitNotHead",
  "parent-count": "error.gitCommitCannotUncommit",
  pushed: "error.gitCommitPushed",
  "head-moved": "error.gitHistoryMoved",
  "upstream-invalid": "error.gitUpstreamInvalid",
  "operation-in-progress": "error.gitOperationInProgress",
  "not-on-branch": "error.gitCommitNotOnBranch",
  merge: "error.gitCommitMerge",
  "not-yours": "error.gitCommitNotYours",
  message: "error.gitCommitMessage",
};

export function localizeBackendError(error: unknown): string {
  const parsed = parseBackendError(error);
  if (!parsed) {
    console.error("Unstructured backend error", error);
    return translate("error.unknown");
  }
  const reason = parsed.context?.reason;
  const key =
    parsed.code === "git_command_failed" && typeof reason === "string"
      ? (gitReasonKeys[reason] ?? "error.gitCommandFailed")
      : (backendErrorKeys[parsed.code] ?? "error.unknown");
  if (parsed.debug) {
    console.error("Backend error", parsed);
  }
  return translate(key, parsed.context);
}

export function backendErrorReason(
  error: unknown,
): "missing" | "not_directory" | "permission_denied" | "identity_changed" | "unknown" {
  const code = parseBackendError(error)?.code;
  if (code === "workspace_root_missing") {
    return "missing";
  }
  if (code === "workspace_root_not_directory") {
    return "not_directory";
  }
  if (code === "workspace_root_permission_denied") {
    return "permission_denied";
  }
  if (code === "workspace_root_identity_changed") {
    return "identity_changed";
  }
  return "unknown";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  return {
    locale,
    setLocale,
    t: (key: MessageKey, params?: Record<string, string | number>) =>
      translate(key, params, locale),
  };
}
