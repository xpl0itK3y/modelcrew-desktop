import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

// Сам git, а не репозиторий: есть ли он в системе и как его поставить там, где
// приложение может помочь. На Windows его приносит Git Bash (см. gitBash.ts).

export const GIT_LINUX_INSTALL_URL = "https://git-scm.com/install/linux.html";

export function isGitAvailable(): Promise<boolean> {
  return invoke<boolean>("git_available");
}

// Только macOS: открывает системную установку Command Line Tools, в которой
// git и приходит. Возвращается сразу — ставит уже окно самой системы.
export function installGitTools(): Promise<void> {
  return invoke("git_install_tools");
}

export function openGitLinuxInstructions(): Promise<void> {
  return openUrl(GIT_LINUX_INSTALL_URL);
}
