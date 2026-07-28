const MAX_DROPPED_PATHS = 16;
const MAX_PATH_LENGTH = 4_096;
const MAX_TOTAL_PASTE_LENGTH = 16_384;
export const MAX_CLIPBOARD_IMAGE_BYTES = 16 * 1024 * 1024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC_PATH = /^\\\\[^\\]/;

export type TerminalDropTarget = {
  container: HTMLElement;
  exited: boolean;
  inputReady: boolean;
  term: {
    focus(): void;
    paste(data: string): void;
  };
};

export type DropPoint = {
  x: number;
  y: number;
};

type ClipboardImageFile = {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

type ClipboardImageItem = {
  kind: string;
  type: string;
  getAsFile(): ClipboardImageFile | null;
};

export type ClipboardImagePasteEvent = {
  clipboardData: {
    items: ArrayLike<ClipboardImageItem>;
  } | null;
  preventDefault(): void;
};

export type SaveClipboardImage = (bytes: Uint8Array) => Promise<string>;

function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    WINDOWS_ABSOLUTE_PATH.test(path) ||
    WINDOWS_UNC_PATH.test(path)
  );
}

function quoteDroppedPath(path: string): string | null {
  if (
    path.length === 0 ||
    path.length > MAX_PATH_LENGTH ||
    CONTROL_CHARACTER.test(path) ||
    !isAbsolutePath(path)
  ) {
    return null;
  }

  if (WINDOWS_ABSOLUTE_PATH.test(path) || WINDOWS_UNC_PATH.test(path)) {
    return path.includes('"') ? null : `"${path}"`;
  }

  return `'${path.replace(/'/g, "'\\''")}'`;
}

export function droppedPathPastes(paths: readonly string[]): string[] {
  const pastes: string[] = [];
  const seen = new Set<string>();
  let totalLength = 0;

  for (const path of paths) {
    if (pastes.length >= MAX_DROPPED_PATHS || seen.has(path)) {
      continue;
    }

    const quoted = quoteDroppedPath(path);
    if (quoted === null) {
      continue;
    }

    const paste = `${quoted} `;
    if (totalLength + paste.length > MAX_TOTAL_PASTE_LENGTH) {
      break;
    }

    seen.add(path);
    pastes.push(paste);
    totalLength += paste.length;
  }

  return pastes;
}

export function findTerminalDropTargetAtPoint<T extends TerminalDropTarget>(
  entries: Iterable<T>,
  point: DropPoint,
): T | null {
  for (const entry of entries) {
    const rect = entry.container.getBoundingClientRect();
    if (
      entry.container.isConnected &&
      entry.inputReady &&
      !entry.exited &&
      rect.width > 0 &&
      rect.height > 0 &&
      point.x >= rect.left &&
      point.x < rect.right &&
      point.y >= rect.top &&
      point.y < rect.bottom
    ) {
      return entry;
    }
  }

  return null;
}

export function pasteDroppedPaths(
  target: TerminalDropTarget,
  paths: readonly string[],
): number {
  if (!target.container.isConnected || target.exited || !target.inputReady) {
    return 0;
  }
  const pastes = droppedPathPastes(paths);
  if (pastes.length === 0) {
    return 0;
  }

  target.term.focus();
  for (const paste of pastes) {
    target.term.paste(paste);
  }
  return pastes.length;
}

function clipboardImage(
  event: ClipboardImagePasteEvent,
): ClipboardImageFile | null {
  const items = event.clipboardData?.items;
  if (!items) {
    return null;
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind === "file" && item.type.startsWith("image/")) {
      return item.getAsFile();
    }
  }
  return null;
}

export async function pasteClipboardImage(
  target: TerminalDropTarget,
  event: ClipboardImagePasteEvent,
  saveImage: SaveClipboardImage,
): Promise<boolean> {
  const image = clipboardImage(event);
  if (image === null) {
    return false;
  }

  event.preventDefault();
  if (image.size === 0 || image.size > MAX_CLIPBOARD_IMAGE_BYTES) {
    return true;
  }

  const bytes = new Uint8Array(await image.arrayBuffer());
  const path = await saveImage(bytes);
  pasteDroppedPaths(target, [path]);
  return true;
}
