import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

// Системные уведомления ОС (Notification Center / toast / libnotify):
// дублируют колокольчик, когда окно приложения не в фокусе. Отправка —
// best-effort: любой сбой (нет разрешения, нет демона на Linux) молча
// игнорируется и не мешает внутренним уведомлениям.

const isTauri = "__TAURI_INTERNALS__" in window;
const STORAGE_KEY = "modelcrew.systemNotifications";

export function loadSystemNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveSystemNotificationsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Non-fatal: выбор не переживёт перезапуск.
  }
}

// Разрешение запрашивается лениво — при первой реальной отправке, а не на
// старте приложения. Ответ кэшируется на время сессии.
let permissionGranted: boolean | null = null;

async function ensurePermission(): Promise<boolean> {
  if (permissionGranted !== null) {
    return permissionGranted;
  }
  try {
    if (await isPermissionGranted()) {
      permissionGranted = true;
    } else {
      permissionGranted = (await requestPermission()) === "granted";
    }
  } catch {
    permissionGranted = false;
  }
  return permissionGranted;
}

export async function sendSystemNotification(
  title: string,
  body: string,
): Promise<void> {
  if (!isTauri || !loadSystemNotificationsEnabled()) {
    return;
  }
  try {
    if (!(await ensurePermission())) {
      return;
    }
    sendNotification(body ? { title, body } : { title });
  } catch {
    // Баннер — дополнение; его сбой не должен ломать поток уведомлений.
  }
}
