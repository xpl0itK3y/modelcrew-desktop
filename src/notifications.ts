import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { KEYS, readSetting, writeSetting } from "./settings/storage";
import { isTauri, platform } from "./platform";

// Системные уведомления ОС (Notification Center / toast / libnotify):
// дублируют колокольчик, когда окно приложения не в фокусе. Отправка —
// best-effort: любой сбой (нет разрешения, нет демона на Linux) молча
// игнорируется и не мешает внутренним уведомлениям.


// На Linux демон уведомлений не связывает наш app-id с установленным ярлыком,
// поэтому баннер приходит без иконки приложения. Указываем её имя явно — оно
// одно и то же во всех Linux-пакетах (файлы hicolor/.../modelcrew-desktop.png,
// Icon=modelcrew-desktop в .desktop). На macOS/Windows это имя не путь к файлу,
// поэтому иконку там задаёт система, а не мы.
const LINUX_NOTIFICATION_ICON = "modelcrew-desktop";
const isLinux = platform === "linux";

export function loadSystemNotificationsEnabled(): boolean {
  try {
    return readSetting(KEYS.systemNotifications) !== "off";
  } catch {
    return true;
  }
}

export function saveSystemNotificationsEnabled(enabled: boolean): void {
  try {
    writeSetting(KEYS.systemNotifications, enabled ? "on" : "off");
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
    sendNotification({
      title,
      ...(body ? { body } : {}),
      ...(isLinux ? { icon: LINUX_NOTIFICATION_ICON } : {}),
    });
  } catch {
    // Баннер — дополнение; его сбой не должен ломать поток уведомлений.
  }
}
