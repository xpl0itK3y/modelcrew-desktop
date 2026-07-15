import { invoke } from "@tauri-apps/api/core";
import type { SerializeAddon } from "@xterm/addon-serialize";

// Снимки текста терминалов: сериализованный буфер xterm сохраняется на диск
// (Rust-команды) и восстанавливается при следующем запуске приложения.
// Запись — контрольными точками: пометка dirty при выводе PTY, флаш раз в
// интервал плюс немедленно при выходе процесса, перед обновлением и на
// beforeunload. Потеря ограничена последними секундами даже при kill -9.

const isTauri = "__TAURI_INTERNALS__" in window;

// Сколько строк скроллбэка попадает в снимок.
const SNAPSHOT_SCROLLBACK_ROWS = 2000;
// Страховочный предел на размер снимка (Rust отвергает > 2 МиБ).
const SNAPSHOT_MAX_BYTES = 1024 * 1024;
const FLUSH_INTERVAL_MS = 10_000;

type SnapshotSource = {
  id: string;
  serialize: SerializeAddon;
};

const sources = new Map<string, SnapshotSource>();
const dirty = new Set<string>();
let flushTimer: number | undefined;

function ensureFlushTimer(): void {
  if (!isTauri || flushTimer !== undefined) {
    return;
  }
  flushTimer = window.setInterval(() => {
    void flushDirtySnapshots();
  }, FLUSH_INTERVAL_MS);
}

export function registerSnapshotSource(
  id: string,
  serialize: SerializeAddon,
): void {
  sources.set(id, { id, serialize });
  ensureFlushTimer();
}

export function markSnapshotDirty(id: string): void {
  if (sources.has(id)) {
    dirty.add(id);
  }
}

function serializeSource(source: SnapshotSource): string | null {
  try {
    const data = source.serialize.serialize({
      scrollback: SNAPSHOT_SCROLLBACK_ROWS,
    });
    if (!data || data.length > SNAPSHOT_MAX_BYTES) {
      // Слишком большой кадр не пишем: прежний валидный снимок дороже.
      return data && data.length > SNAPSHOT_MAX_BYTES ? null : "";
    }
    return data;
  } catch {
    return null;
  }
}

async function saveSnapshot(source: SnapshotSource): Promise<void> {
  const data = serializeSource(source);
  if (data === null || data.length === 0) {
    return;
  }
  try {
    await invoke("terminal_snapshot_save", { id: source.id, data });
  } catch {
    // Снимки — best-effort: сбой записи не должен мешать работе терминала.
  }
}

export async function flushSnapshot(id: string): Promise<void> {
  if (!isTauri) {
    return;
  }
  const source = sources.get(id);
  if (!source) {
    return;
  }
  dirty.delete(id);
  await saveSnapshot(source);
}

export async function flushDirtySnapshots(): Promise<void> {
  if (!isTauri || dirty.size === 0) {
    return;
  }
  const ids = [...dirty];
  dirty.clear();
  await Promise.all(
    ids.map((id) => {
      const source = sources.get(id);
      return source ? saveSnapshot(source) : Promise.resolve();
    }),
  );
}

// Полный флаш всех источников — перед установкой обновления, когда важно
// сохранить даже панели без свежего вывода.
export async function flushAllSnapshots(): Promise<void> {
  if (!isTauri) {
    return;
  }
  dirty.clear();
  await Promise.all([...sources.values()].map((source) => saveSnapshot(source)));
}

export async function loadSnapshot(id: string): Promise<string | null> {
  if (!isTauri) {
    return null;
  }
  try {
    return await invoke<string | null>("terminal_snapshot_load", { id });
  } catch {
    return null;
  }
}

// Панель закрыта намеренно — её история больше не нужна.
export function discardSnapshot(id: string): void {
  sources.delete(id);
  dirty.delete(id);
  if (!isTauri) {
    return;
  }
  void invoke("terminal_snapshot_delete", { id }).catch(() => {});
}

// Сироты от удалённых панелей/сессий вычищаются один раз на старте.
export function pruneSnapshots(keepIds: string[]): void {
  if (!isTauri) {
    return;
  }
  void invoke("terminal_snapshots_prune", { keep: keepIds }).catch(() => {});
}

if (isTauri) {
  window.addEventListener("beforeunload", () => {
    // Лучшая попытка: invoke может не успеть до закрытия, но интервал выше
    // держит потерю в пределах последних секунд.
    void flushDirtySnapshots();
  });
}
