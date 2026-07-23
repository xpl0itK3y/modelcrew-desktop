// Notification sounds. The catalog is bundled under public/sounds/ and served
// from the app root, so the files resolve the same way in dev and in a Tauri
// build. Selection is persisted per-machine in localStorage, mirroring shell.ts.

import type { NotificationItem } from "./updater/types";
import { APP_VERSION } from "./version";

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
  if (id === "off") {
    // Choosing "off" doubles as the manual reset for hang protection below:
    // the next sound the user picks gets a fresh playback attempt.
    clearAudioHealth();
  }
  prepareNotificationSound(id);
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

// ---------------------------------------------------------------------------
// Audio hang protection.
//
// On Linux, WebKitGTK routes HTMLAudioElement playback through GStreamer. On a
// system with a broken audio stack (e.g. a missing autoaudiosink) building the
// pipeline can block the web process indefinitely, freezing the whole UI, and
// JavaScript cannot interrupt that block. Instead we persist a "pending"
// marker right before touching the audio element and replace it with "ok" on
// the next event-loop tick. If the app is force-quit while the marker is set —
// or the tick arrives after a long stall — later launches see the marker and
// keep playback off instead of freezing again.
//
// The marker is versioned: an update may ship an audio fix (e.g. bundled
// GStreamer), so a different app version re-arms playback automatically.
// Selecting the "off" sound clears the marker as an explicit manual retry.

const HEALTH_KEY = "modelcrew.audioHealth";
const AUDIO_HANG_THRESHOLD_MS = 5_000;

// Заморозить процесс проигрыванием может только Linux/WebKitGTK через
// GStreamer. На macOS/Windows аудио никогда не блокирует поток, поэтому
// защита там — чистый минус (ложные срабатывания после жёстких завершений).
const AUDIO_HANG_PROTECTION =
  typeof navigator !== "undefined" && /Linux/i.test(navigator.userAgent);

// Distinguishes our own in-flight "pending" marker from one left behind by a
// process that never lived to confirm it.
const SESSION_ID = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
})();

type AudioHealth = {
  status: "pending" | "ok" | "broken";
  version: string;
  session?: string;
};

function readAudioHealth(): AudioHealth | null {
  try {
    const raw = localStorage.getItem(HEALTH_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AudioHealth> | null;
    if (
      value &&
      (value.status === "pending" ||
        value.status === "ok" ||
        value.status === "broken") &&
      typeof value.version === "string"
    ) {
      return {
        status: value.status,
        version: value.version,
        ...(typeof value.session === "string"
          ? { session: value.session }
          : {}),
      };
    }
  } catch {
    // Corrupt or inaccessible state is treated as absent.
  }
  return null;
}

function writeAudioHealth(status: AudioHealth["status"]): void {
  try {
    localStorage.setItem(
      HEALTH_KEY,
      JSON.stringify({ status, version: APP_VERSION, session: SESSION_ID }),
    );
  } catch {
    // Non-fatal: protection just won't persist across restarts.
  }
}

function clearAudioHealth(): void {
  try {
    localStorage.removeItem(HEALTH_KEY);
  } catch {
    // Non-fatal.
  }
}

// True when playback must stay off because a previous attempt appears to have
// hung the process. Stale "pending" markers from other sessions of the same
// version are promoted to "broken" so the verdict survives further restarts.
export function isNotificationSoundSuppressed(): boolean {
  // Не Linux — зависания не бывает, звук никогда не глушим.
  if (!AUDIO_HANG_PROTECTION) return false;
  const health = readAudioHealth();
  if (!health) return false;
  if (health.version !== APP_VERSION) {
    // A different build may have fixed audio — forget the verdict and retry.
    clearAudioHealth();
    return false;
  }
  if (health.status === "broken") return true;
  if (health.status === "pending" && health.session !== SESSION_ID) {
    writeAudioHealth("broken");
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Source of the audio data.
//
// WebKitGTK hands the media element's URL straight to GStreamer, which picks a
// source element by URL scheme. A packaged frontend does not live on http: it
// lives on the app's own scheme (tauri://localhost), and GStreamer has no
// handler for it — the pipeline falls apart before the file is ever parsed, so
// Linux stays silent as if the sounds were not shipped at all. macOS and
// Windows load such URLs inside the webview and never notice.
//
// So we fetch the bytes ourselves — the same path that already serves every
// script and stylesheet — and hand the element a blob: URL, which WebKit
// resolves through its own loader on every platform.

const sources = new Map<string, string>();
const loading = new Map<string, Promise<string>>();

function loadSource(file: string): Promise<string> {
  const started = loading.get(file);
  if (started) return started;
  const request = Promise.resolve()
    .then(() => fetch(file))
    .then((response) => {
      if (!response.ok) throw new Error(`${file}: ${response.status}`);
      return response.blob();
    })
    .then((blob) => URL.createObjectURL(blob))
    // Fetch or blob URLs unavailable: fall back to the plain path, which is
    // what every platform but Linux was playing happily all along.
    .catch(() => file);
  loading.set(file, request);
  void request.then((source) => sources.set(file, source));
  return request;
}

// Fetches the sound ahead of time so the first notification sounds at once
// instead of after a round trip inside the webview.
export function prepareNotificationSound(id: NotificationSoundId): void {
  const file = fileFor(id);
  if (file) void loadSource(file);
}

// A single reused element keeps rapid notifications from stacking playback,
// and reusing the loaded source avoids rebuilding the media pipeline (the
// risky operation on broken audio stacks) on every click.
let element: HTMLAudioElement | null = null;
let loadedSource: string | null = null;

function start(source: string): void {
  // Загрузка источника асинхронна, а за это время звук могли и заглушить.
  if (isNotificationSoundSuppressed()) return;
  // Метки здоровья ведём только там, где реально возможен зависон (Linux).
  if (AUDIO_HANG_PROTECTION) {
    writeAudioHealth("pending");
    const startedAt = performance.now();
    window.setTimeout(() => {
      // Тик отрабатывает, когда рискованные вызовы освободили поток; большая
      // задержка = проигрывание застопорило процесс — глушим.
      const blockedMs = performance.now() - startedAt;
      writeAudioHealth(blockedMs > AUDIO_HANG_THRESHOLD_MS ? "broken" : "ok");
    }, 0);
  }
  try {
    if (!element) {
      element = new Audio();
      element.preload = "auto";
    }
    if (loadedSource !== source) {
      element.src = source;
      loadedSource = source;
    }
    element.currentTime = 0;
    void element.play().catch(() => {
      // Autoplay can be blocked before the first user gesture; ignore.
    });
  } catch {
    // Never let a missing/blocked sound break the notification flow.
  }
}

function play(file: string | null): void {
  if (!file) {
    // "off" also stops whatever is currently sounding.
    try {
      element?.pause();
    } catch {
      // Ignore: stopping is best-effort.
    }
    return;
  }
  if (typeof Audio === "undefined") return;
  if (isNotificationSoundSuppressed()) return;
  const ready = sources.get(file);
  if (ready !== undefined) {
    start(ready);
    return;
  }
  void loadSource(file).then(start);
}

// Plays the user's currently selected notification sound.
export function playNotificationSound(): void {
  play(fileFor(loadNotificationSound()));
}

// Plays a specific sound so the user can audition it from Settings.
export function previewNotificationSound(id: NotificationSoundId): void {
  play(fileFor(id));
}
