// Живая сводка git-изменений проекта: общий store с подпиской по workspaceId.
// Основной канал — push-события Rust-вотчера (notify на рабочем дереве);
// поллинг остаётся страховкой на случай, когда вотчер поднять не удалось.

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../platform";
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

// Незавершённая операция репозитория. Приложение само умеет в неё завести
// («Забрать с rebase» намеренно оставляет rebase на явный continue/abort),
// поэтому состояние должно быть видно, а не угадываться по статусам файлов.
export type GitOperation = "merge" | "rebase" | "cherryPick" | "revert";

export type GitChangesSummary = {
  isRepo: boolean;
  // В системе нет самого git: панель есть, но показать ей нечего.
  gitMissing?: boolean;
  branch?: string;
  headHash?: string;
  // Точный short ref из `branch.upstream` (например fork/dev или
  // cache/review при пользовательском fetch refspec).
  upstreamRef?: string;
  // Куда вернуться с отделённого HEAD; есть только когда branch отсутствует.
  previousBranch?: string;
  ahead?: number;
  behind?: number;
  operation?: GitOperation;
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
// Фоновый git fetch: обновляет знание о сервере, чтобы ↓ («нужно спуллить»)
// показывалось без ручного fetch. Ошибки (офлайн, нет remote) — тихо.
const FETCH_INTERVAL_MS = 5 * 60_000;

type Listener = (summary: GitChangesSummary) => void;

type WatchEntry = {
  listeners: Set<Listener>;
  timer: number | undefined;
  fetchTimer: number | undefined;
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
      fetchTimer: undefined,
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
    // Знание о сервере: fetch сразу и далее по интервалу. Обновлённые
    // refs/remotes подхватит вотчер, и ↑/↓ пересчитаются сами.
    const fetchOnce = () =>
      void invoke("git_fetch_upstream", { workspaceId }).catch(() => {});
    fetchOnce();
    entry.fetchTimer = window.setInterval(fetchOnce, FETCH_INTERVAL_MS);
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
      window.clearInterval(current.fetchTimer);
      current.fetchTimer = undefined;
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

// Продолжение доступно у переноса, cherry-pick и отката: у них нет своего
// поля сообщения. Слияние завершается обычным коммитом из панели.
export function continueOperation(workspaceId: string): Promise<void> {
  return invoke("git_continue_operation", { workspaceId });
}

export function abortOperation(workspaceId: string): Promise<void> {
  return invoke("git_abort_operation", { workspaceId });
}

export function revertFile(
  workspaceId: string,
  path: string,
  origPath?: string,
): Promise<void> {
  return invoke("git_revert_file", {
    workspaceId,
    path,
    ...(origPath === undefined ? {} : { origPath }),
  });
}

export type GitFileContent = {
  content: string;
  isBinary: boolean;
  tooLarge: boolean;
  exists: boolean;
};

export function readRepoFile(
  workspaceId: string,
  path: string,
): Promise<GitFileContent> {
  return invoke<GitFileContent>("git_read_file", { workspaceId, path });
}

export function writeRepoFile(
  workspaceId: string,
  path: string,
  content: string,
): Promise<void> {
  return invoke("git_write_file", { workspaceId, path, content });
}
