// Картинки: какие из них вебвью нарисует сам и как их до него довезти.
//
// Файл уезжает в base64 и вставляется в страницу адресом `data:`. Через
// файловый протокол Tauri было бы не проще: ему нужна отдельная область
// разрешений на весь диск, открытая она ровно настолько же, а закрытая не
// откроет проект, который пользователь выбрал в этот запуск.

import { invoke } from "@tauri-apps/api/core";

export type FileMedia = {
  mime: string;
  /// Содержимое файла в base64.
  data: string;
  bytes: number;
  tooLarge: boolean;
  exists: boolean;
};

/// Тот же список, что в `file_tree.rs`. Здесь он нужен раньше: чем открыть
/// файл, решается до того, как о нём спросят бэкенд.
const MIME: Record<string, string> = {
  png: "image/png",
  apng: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  cur: "image/x-icon",
  svg: "image/svg+xml",
};

export function imageMimeOf(name: string): string | null {
  const at = name.lastIndexOf(".");
  // Точка в начале — это имя файла, а не расширение: `.png` картинкой делает
  // разве что совпадение.
  if (at <= 0) {
    return null;
  }
  return MIME[name.slice(at + 1).toLowerCase()] ?? null;
}

/// Картинка, которую можно только смотреть. SVG сюда не входит нарочно: он
/// текст, его правят как текст, и показывается он переключателем в самом
/// редакторе — как разметка.
export function drawnAsImage(path: string): boolean {
  const mime = imageMimeOf(path.split("/").pop() ?? path);
  return mime !== null && mime !== "image/svg+xml";
}

export function readWorkspaceMedia(
  workspaceId: string,
  path: string,
): Promise<FileMedia> {
  return invoke<FileMedia>("workspace_read_media", { workspaceId, path });
}

export function mediaSource(media: FileMedia): string {
  return `data:${media.mime};base64,${media.data}`;
}

/// Адрес для показа SVG, собранный прямо из текста в поле ввода.
///
/// Именно адресом и именно картинкой: вставить эту разметку в страницу нельзя
/// ни при каких условиях. SVG умеет и скрипт, и обработчик события, а файл
/// пишет агент — внутри `<img>` же не выполняется ничего.
export function svgSource(text: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
}
