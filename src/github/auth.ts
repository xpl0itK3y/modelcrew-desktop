// Фронтенд-обёртка над GitHub Device Flow (Rust-команды).

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

const isTauri = "__TAURI_INTERNALS__" in window;

export type GithubUser = { login: string; avatarUrl: string };

export type DeviceStart = {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
};

export type PollStatus =
  | "pending"
  | "authorized"
  | "slowDown"
  | "denied"
  | "expired"
  | "error";

export function githubAuthAvailable(): Promise<boolean> {
  if (!isTauri) {
    return Promise.resolve(false);
  }
  return invoke<boolean>("github_auth_available").catch(() => false);
}

export function githubDeviceStart(): Promise<DeviceStart> {
  return invoke<DeviceStart>("github_device_start");
}

export function githubDevicePoll(
  deviceCode: string,
): Promise<{ status: PollStatus }> {
  return invoke<{ status: PollStatus }>("github_device_poll", { deviceCode });
}

export function githubCurrentUser(): Promise<GithubUser | null> {
  if (!isTauri) {
    return Promise.resolve(null);
  }
  return invoke<GithubUser | null>("github_current_user").catch(() => null);
}

export async function githubLogout(): Promise<void> {
  try {
    await invoke("github_logout");
  } catch {
    // Выход локальный (удаляем токен) — сетевой сбой не важен.
  }
}

export { openUrl };
