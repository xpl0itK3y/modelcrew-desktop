// Notification sounds. The catalog is bundled under public/sounds/ and served
// from the app root, so the files resolve the same way in dev and in a Tauri
// build. Selection is persisted per-machine in localStorage, mirroring shell.ts.

import type { NotificationItem } from "./updater/types";

export type NotificationSoundId =
  | "off"
  | "chime"
  | "click"
  | "pop"
  | "reveal"
  | "flute";

export type NotificationSound = {
  id: NotificationSoundId;
  // Path relative to the app root, or null for the silent "off" option.
  file: string | null;
};

export const NOTIFICATION_SOUNDS: NotificationSound[] = [
  { id: "off", file: null },
  { id: "chime", file: "/sounds/chime.wav" },
  { id: "click", file: "/sounds/click.wav" },
  { id: "pop", file: "/sounds/pop.wav" },
  { id: "reveal", file: "/sounds/reveal.wav" },
  { id: "flute", file: "/sounds/flute.wav" },
];

const DEFAULT_SOUND: NotificationSoundId = "chime";
const STORAGE_KEY = "modelcrew.notificationSound";

function isSoundId(value: string): value is NotificationSoundId {
  return NOTIFICATION_SOUNDS.some((sound) => sound.id === value);
}

export function loadNotificationSound(): NotificationSoundId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isSoundId(stored)) return stored;
  } catch {
    // Ignore storage access failures and fall back to the default.
  }
  return DEFAULT_SOUND;
}

export function saveNotificationSound(id: NotificationSoundId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Non-fatal: the choice just won't persist across restarts.
  }
}

function fileFor(id: NotificationSoundId): string | null {
  return NOTIFICATION_SOUNDS.find((sound) => sound.id === id)?.file ?? null;
}

function needsSound(item: NotificationItem): boolean {
  return (
    item.kind === "announcement" ||
    item.phase === "ready" ||
    item.phase === "manual"
  );
}

// Returns every attention-worthy notification that has not already been
// handled. Keeping selection pure makes read-state and repeated-check behavior
// deterministic without coupling it to audio playback.
export function selectUnseenNotificationSoundIds(
  items: readonly NotificationItem[],
  handledIds: ReadonlySet<string>,
): string[] {
  return items
    .filter((item) => needsSound(item) && !handledIds.has(item.id))
    .map((item) => item.id);
}

// A single reused element keeps rapid notifications from stacking playback.
let element: HTMLAudioElement | null = null;

function play(file: string | null): void {
  if (!file) return;
  if (typeof Audio === "undefined") return;
  try {
    if (!element) element = new Audio();
    element.src = file;
    element.currentTime = 0;
    void element.play().catch(() => {
      // Autoplay can be blocked before the first user gesture; ignore.
    });
  } catch {
    // Never let a missing/blocked sound break the notification flow.
  }
}

// Plays the user's currently selected notification sound.
export function playNotificationSound(): void {
  play(fileFor(loadNotificationSound()));
}

// Plays a specific sound so the user can audition it from Settings.
export function previewNotificationSound(id: NotificationSoundId): void {
  play(fileFor(id));
}
