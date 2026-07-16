// Живая сводка git-изменений проекта: общий store с подпиской по workspaceId.
// Основной канал — push-события Rust-вотчера (notify на рабочем дереве);
// поллинг остаётся страховкой на случай, когда вотчер поднять не удалось.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

export type GitChangedFile = {
  path: string;
  status: GitFileStatus;
  origPath?: string;
  // undefined — бинарный файл.
  additions?: number;
  deletions?: number;
};

export type GitChangesSummary = {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  files: GitChangedFile[];
};

export type GitFileDiff = {
  path: string;
  isBinary: boolean;
  truncated: boolean;
  diff: string;
};

const POLL_INTERVAL_MS = 3_000;
// С работающим вотчером поллинг — лишь редкая страховка.
const WATCHED_POLL_INTERVAL_MS = 60_000;
// После ошибки (папка недоступна, git отсутствует) опрос замедляется.
const ERROR_POLL_INTERVAL_MS = 15_000;

const isTauri = "__TAURI_INTERNALS__" in window;

type Listener = (summary: GitChangesSummary) => void;

type WatchEntry = {
  listeners: Set<Listener>;
  timer: number | undefined;
  inFlight: boolean;
  lastKey: string | null;
  last: GitChangesSummary | null;
  failed: boolean;
  watched: boolean;
};

const watches = new Map<string, WatchEntry>();

// Один глобальный слушатель на все проекты: Rust шлёт workspaceId в payload.
let eventUnlisten: Promise<() => void> | null = null;

function publish(entry: WatchEntry, summary: GitChangesSummary): void {
  const key = JSON.stringify(summary);
  if (key === entry.lastKey) {
    return;
  }
  entry.lastKey = key;
  entry.last = summary;
  for (const listener of entry.listeners) {
    listener(summary);
  }
}

function ensureEventListener(): void {
  if (!isTauri || eventUnlisten) {
    return;
  }
  eventUnlisten = listen<{
    workspaceId: string;
    summary: GitChangesSummary;
  }>("git-changes", (event) => {
    const entry = watches.get(event.payload.workspaceId);
    if (entry && entry.listeners.size > 0) {
      publish(entry, event.payload.summary);
    }
  });
}

export function getGitSummary(workspaceId: string): GitChangesSummary | null {
  return watches.get(workspaceId)?.last ?? null;
}

async function refresh(workspaceId: string): Promise<void> {
  const entry = watches.get(workspaceId);
  if (!entry || entry.inFlight || !isTauri) {
    return;
  }
  entry.inFlight = true;
  try {
    const summary = await invoke<GitChangesSummary>("git_changes_summary", {
      workspaceId,
    });
    entry.failed = false;
    publish(entry, summary);
  } catch {
    // Корень недоступен или git отсутствует: не спамим, опрос замедлится.
    entry.failed = true;
  } finally {
    entry.inFlight = false;
    scheduleNext(workspaceId);
  }
}

function scheduleNext(workspaceId: string): void {
  const entry = watches.get(workspaceId);
  if (!entry || entry.listeners.size === 0) {
    return;
  }
  window.clearTimeout(entry.timer);
  entry.timer = window.setTimeout(
    () => void refresh(workspaceId),
    entry.failed
      ? ERROR_POLL_INTERVAL_MS
      : entry.watched
        ? WATCHED_POLL_INTERVAL_MS
        : POLL_INTERVAL_MS,
  );
}

export function subscribeGitChanges(
  workspaceId: string,
  listener: Listener,
): () => void {
  let entry = watches.get(workspaceId);
  if (!entry) {
    entry = {
      listeners: new Set(),
      timer: undefined,
      inFlight: false,
      lastKey: null,
      last: null,
      failed: false,
      watched: false,
    };
    watches.set(workspaceId, entry);
  }
  const firstSubscriber = entry.listeners.size === 0;
  entry.listeners.add(listener);
  if (entry.last) {
    listener(entry.last);
  }
  if (firstSubscriber && isTauri) {
    ensureEventListener();
    const target = entry;
    void invoke<boolean>("git_changes_watch", { workspaceId })
      .then((watching) => {
        target.watched = watching;
      })
      .catch(() => {
        target.watched = false; // остаёмся на поллинге
      });
  }
  void refresh(workspaceId);
  return () => {
    const current = watches.get(workspaceId);
    if (!current) {
      return;
    }
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      window.clearTimeout(current.timer);
      current.timer = undefined;
      current.watched = false;
      if (isTauri) {
        void invoke("git_changes_unwatch", { workspaceId }).catch(() => {});
      }
      // Кеш сводки оставляем: повторное открытие панели покажет её мгновенно.
    }
  };
}

export function fetchFileDiff(
  workspaceId: string,
  path: string,
): Promise<GitFileDiff> {
  return invoke<GitFileDiff>("git_file_diff", { workspaceId, path });
}

// Мгновенное обновление после действия из панели (commit/откат), не дожидаясь
// вотчера или очередного тика поллинга.
export function refreshGitChanges(workspaceId: string): Promise<void> {
  return refresh(workspaceId);
}

export function commitAll(
  workspaceId: string,
  message: string,
): Promise<void> {
  return invoke("git_commit", { workspaceId, message });
}

export function revertFile(workspaceId: string, path: string): Promise<void> {
  return invoke("git_revert_file", { workspaceId, path });
}

// ---------- Парсер unified diff для отрисовки ----------

export type DiffLine = {
  kind: "add" | "del" | "context" | "hunk";
  oldLine?: number;
  newLine?: number;
  text: string;
};

const HUNK_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    const hunk = HUNK_PATTERN.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      result.push({ kind: "hunk", text: raw });
      continue;
    }
    if (!inHunk) {
      continue; // заголовки diff --git / index / +++ / --- не рисуем
    }
    if (raw.startsWith("+")) {
      result.push({ kind: "add", newLine: newLine++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      result.push({ kind: "del", oldLine: oldLine++, text: raw.slice(1) });
    } else if (raw.startsWith(" ") || raw === "") {
      if (raw === "" && result.length === 0) {
        continue;
      }
      result.push({
        kind: "context",
        oldLine: oldLine++,
        newLine: newLine++,
        text: raw.slice(1),
      });
    }
    // "\ No newline at end of file" и прочую служебщину пропускаем.
  }
  // Хвостовая пустая строка от split("\n") — не строка контекста.
  const lastLine = result[result.length - 1];
  if (lastLine?.kind === "context" && lastLine.text === "") {
    result.pop();
  }
  return result;
}

// Суммарные счётчики для бейджа в титлбаре.
export function aggregateCounts(summary: GitChangesSummary | null): {
  additions: number;
  deletions: number;
  files: number;
} {
  if (!summary) {
    return { additions: 0, deletions: 0, files: 0 };
  }
  let additions = 0;
  let deletions = 0;
  for (const file of summary.files) {
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { additions, deletions, files: summary.files.length };
}
