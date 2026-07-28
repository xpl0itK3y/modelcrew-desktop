import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ShellOption } from "./shell";

export const GIT_BASH_DOWNLOAD_URL = "https://git-scm.com/install/windows.html";

export type GitBashAvailability =
  | { status: "unsupported" }
  | { status: "installed"; shell: ShellOption }
  | { status: "installable" }
  | { status: "manual" };

export function getGitBashAvailability(): Promise<GitBashAvailability> {
  return invoke<GitBashAvailability>("git_bash_status");
}

export function installGitBash(): Promise<ShellOption> {
  return invoke<ShellOption>("git_bash_install");
}

export function openGitBashDownload(): Promise<void> {
  return openUrl(GIT_BASH_DOWNLOAD_URL);
}
