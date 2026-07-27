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

const isTauri = "__TAURI_INTERNALS__" in window;

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

// ---------- Ветки и история ----------

export type GitBranchInfo = {
  name: string;
  refName: string;
  // Ref tip observed when the branch list was loaded. Destructive actions
  // send it back so the backend can reject a stale confirmation.
  tipHash: string;
  isCurrent: boolean;
  // Есть только на сервере: переключение создаст локальную со слежением.
  isRemote: boolean;
  // Уже влита в текущую ветку — кандидат на удаление.
  isMerged: boolean;
  lastCommitAt?: number;
};

export type GitCommitRefInfo = {
  name: string;
  fullName: string;
  kind: GitRefKind;
};

export type GitCommitInfo = {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authorEmail: string;
  epochMs: number;
  // Коммит есть только на этом компьютере.
  unpushed: boolean;
  // Коммит не достижим ни из одной remote-tracking ветки.
  localOnly: boolean;
  // Можно безопасно переписать сообщение в текущей first-parent цепочке.
  editable: boolean;
  // На этот коммит указывает HEAD (текущий checkout).
  isHead: boolean;
  // Полные хеши родителей (для графа веток).
  parents: string[];
  refs: string[];
  refDetails: GitCommitRefInfo[];
  remoteRefs: string[];
  // Исходное полное сообщение, включая mixed trailer block.
  fullMessage: string;
  body?: string;
  coAuthors?: string[];
};

export function fetchBranches(workspaceId: string): Promise<GitBranchInfo[]> {
  return invoke<GitBranchInfo[]>("git_branches", { workspaceId });
}

export type GitRefKind = "local" | "remote" | "tag";

export function switchBranch(
  workspaceId: string,
  refName: string,
  kind: GitRefKind = "local",
): Promise<void> {
  return invoke("git_switch_branch", { workspaceId, branch: refName, kind });
}

export function createBranch(workspaceId: string, name: string): Promise<void> {
  return invoke("git_create_branch", { workspaceId, name });
}

export function renameBranch(
  workspaceId: string,
  branch: string,
  newName: string,
): Promise<void> {
  return invoke("git_rename_branch", { workspaceId, branch, newName });
}

export function deleteBranch(
  workspaceId: string,
  branch: string,
  force: boolean,
  expectedTip: string,
): Promise<void> {
  return invoke("git_delete_branch", {
    workspaceId,
    branch,
    force,
    expectedTip,
  });
}

// Фильтр применяет git, а не панель: иначе пришлось бы вычитывать всю историю,
// чтобы отобрать пару коммитов.
export type GitLogFilter = {
  text?: string;
  author?: string;
  path?: string;
};

export function fetchLog(
  workspaceId: string,
  limit = 100,
  all = false,
  filter?: GitLogFilter,
): Promise<GitCommitInfo[]> {
  return invoke<GitCommitInfo[]>("git_log", {
    workspaceId,
    limit,
    all,
    filter,
  });
}

// Действия над коммитом истории: checkout (отделить HEAD), branch (создать
// ветку от коммита), cherryPick (применить поверх текущей), revert (отменить
// коммит новым), uncommit (снять локальный HEAD, сохранив изменения). Ошибки
// git поднимаются наверх и показываются в панели.
export type CommitAction =
  | "checkout"
  | "branch"
  | "cherryPick"
  | "revert"
  | "uncommit";

export function commitAction(
  workspaceId: string,
  action: CommitAction,
  hash: string,
  name?: string,
): Promise<void> {
  return invoke("git_commit_action", {
    workspaceId,
    action,
    hash,
    ...(name === undefined ? {} : { name }),
  });
}

// Переписать сообщение локального коммита. Бэкенд разрешает только не
// запушенные свои не-merge коммиты; иначе — ошибка.
export function rewordCommit(
  workspaceId: string,
  hash: string,
  message: string,
): Promise<void> {
  return invoke("git_reword_commit", { workspaceId, hash, message });
}

// Правка локальной истории. Каждая команда получает вершину ветки, которую
// пользователь видел в панели: если её успели сдвинуть, бэкенд откажет вместо
// того, чтобы переписать чужой коммит.
export function amendCommit(
  workspaceId: string,
  expectedHead: string,
  message?: string,
): Promise<void> {
  return invoke("git_amend_commit", { workspaceId, expectedHead, message });
}

// soft — двигает только ветку, mixed — ещё и индекс, hard — и файлы на диске.
export type GitResetMode = "soft" | "mixed" | "hard";

export function resetToCommit(
  workspaceId: string,
  hash: string,
  mode: GitResetMode,
  expectedHead: string,
): Promise<void> {
  return invoke("git_reset_to_commit", {
    workspaceId,
    hash,
    mode,
    expectedHead,
  });
}

// squash объединяет оба сообщения, fixup оставляет сообщение родителя.
export type GitSquashMode = "squash" | "fixup";

export function squashCommit(
  workspaceId: string,
  hash: string,
  mode: GitSquashMode,
  expectedHead: string,
): Promise<void> {
  return invoke("git_squash_commit", {
    workspaceId,
    hash,
    mode,
    expectedHead,
  });
}

export function dropCommit(
  workspaceId: string,
  hash: string,
  expectedHead: string,
): Promise<void> {
  return invoke("git_drop_commit", { workspaceId, hash, expectedHead });
}

// Слияние и перенос принимают полное имя ref: по короткому git мог бы выбрать
// одноимённую локальную ветку вместо серверной.
export function mergeRef(
  workspaceId: string,
  reference: string,
  expectedBranch: string,
  expectedHead: string,
  noFf = false,
): Promise<void> {
  return invoke("git_merge_ref", {
    workspaceId,
    reference,
    expectedBranch,
    expectedHead,
    noFf,
  });
}

export function rebaseOnto(
  workspaceId: string,
  reference: string,
  expectedBranch: string,
  expectedHead: string,
): Promise<void> {
  return invoke("git_rebase_onto", {
    workspaceId,
    reference,
    expectedBranch,
    expectedHead,
  });
}

// Первая отправка ветки на сервер: создаёт серверную и связывает с ней локальную.
export function publishBranch(
  workspaceId: string,
  expectedBranch: string,
  expectedHead: string,
  remote?: string,
): Promise<void> {
  return invoke("git_publish_branch", {
    workspaceId,
    expectedBranch,
    expectedHead,
    remote,
  });
}

// Сравнение двух состояний. `to` не задан — сравниваем с рабочей папкой.
export function compareFiles(
  workspaceId: string,
  from: string,
  to?: string,
): Promise<GitCommitFile[]> {
  return invoke<GitCommitFile[]>("git_compare_files", {
    workspaceId,
    from,
    to,
  });
}

// Diff файла внутри коммита — для просмотра истории по строкам.
export function commitFileDiff(
  workspaceId: string,
  hash: string,
  path: string,
): Promise<GitFileDiff> {
  return invoke<GitFileDiff>("git_commit_file_diff", {
    workspaceId,
    hash,
    path,
  });
}

export function compareFileDiff(
  workspaceId: string,
  from: string,
  path: string,
  to?: string,
): Promise<GitFileDiff> {
  return invoke<GitFileDiff>("git_compare_file_diff", {
    workspaceId,
    from,
    to,
    path,
  });
}

// Локальные теги. Тег на сервере не трогаем: это уже общий репозиторий.
export function createTag(
  workspaceId: string,
  name: string,
  hash: string,
  message?: string,
): Promise<void> {
  return invoke("git_create_tag", { workspaceId, name, hash, message });
}

export function deleteTag(workspaceId: string, name: string): Promise<void> {
  return invoke("git_delete_tag", { workspaceId, name });
}

// Патч коммита в формате `git format-patch` — его принимает `git am`.
export function commitPatch(
  workspaceId: string,
  hash: string,
): Promise<string> {
  return invoke<string>("git_commit_patch", { workspaceId, hash });
}

// false означает, что диалог сохранения закрыли без выбора файла.
export function saveCommitPatch(
  workspaceId: string,
  hash: string,
  fileName: string,
): Promise<boolean> {
  return invoke<boolean>("git_save_commit_patch", {
    workspaceId,
    hash,
    fileName,
  });
}

// Ссылка на коммит на GitHub; null — репозиторий не связан с GitHub. Команда
// живёт в модуле авторизации, но нужна именно панели истории.
export function githubCommitUrl(
  workspaceId: string,
  hash: string,
): Promise<string | null> {
  return invoke<string | null>("github_commit_url", { workspaceId, hash });
}

// Забрать с сервера (ff-only) и отправить локальные коммиты. Обе — сетевые,
// без интерактивного запроса пароля: при необходимости авторизации падают с
// ошибкой, а не виснут.
export function gitPull(
  workspaceId: string,
  expectedBranch: string,
  expectedHead: string,
): Promise<void> {
  return invoke("git_pull", { workspaceId, expectedBranch, expectedHead });
}

export function gitPush(
  workspaceId: string,
  expectedBranch: string,
  expectedHead: string,
): Promise<void> {
  return invoke("git_push", { workspaceId, expectedBranch, expectedHead });
}

// Забрать с rebase (для разошедшейся ветки): локальные коммиты кладутся поверх
// серверных. При конфликте Git оставляет стандартное незавершённое состояние,
// чтобы пользователь явно сделал continue/abort в терминале.
export function gitPullRebase(
  workspaceId: string,
  expectedBranch: string,
  expectedHead: string,
): Promise<void> {
  return invoke("git_pull_rebase", {
    workspaceId,
    expectedBranch,
    expectedHead,
  });
}

// Атомарно выровнять локальную ветку по серверной вершине. Локальные коммиты
// исчезают из истории, но их изменения, индекс и текущие правки сохраняются.
export function gitResetToUpstream(
  workspaceId: string,
  expectedBranch: string,
  expectedHead: string,
): Promise<void> {
  return invoke("git_reset_to_upstream", {
    workspaceId,
    expectedBranch,
    expectedHead,
  });
}

export type GitCommitFile = {
  path: string;
  additions?: number;
  deletions?: number;
};

export function fetchCommitFiles(
  workspaceId: string,
  hash: string,
): Promise<GitCommitFile[]> {
  return invoke<GitCommitFile[]>("git_commit_files", { workspaceId, hash });
}

// Аватарка автора: инициалы + детерминированный оттенок из имени. Один автор
// всегда одного цвета — граф читается «в лицах», как в GitLens.
export function authorAvatar(name: string): { initials: string; hue: number } {
  const trimmed = name.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  let initials = "?";
  if (words.length >= 2) {
    initials =
      (Array.from(words[0])[0] ?? "") + (Array.from(words[1])[0] ?? "");
  } else if (words.length === 1) {
    initials = Array.from(words[0]).slice(0, 2).join("");
  }
  initials = initials.toUpperCase();

  let hash = 0;
  for (const char of trimmed) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return { initials, hue: hash % 360 };
}

// URL реальной аватарки по почте автора: GitHub-ноreply → аватар профиля
// GitHub, иначе Gravatar (d=404 — вернёт 404, если аватара нет, тогда откат
// на инициалы через onError). null — почты нет. Результат кешируется.
const avatarUrlCache = new Map<string, Promise<string | null>>();

async function computeAvatarUrl(email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return null;
  }
  // GitHub noreply с числовым id: 12345+user@users.noreply.github.com
  const withId = normalized.match(
    /^(\d+)\+[^@]+@users\.noreply\.github\.com$/,
  );
  if (withId) {
    return `https://avatars.githubusercontent.com/u/${withId[1]}?s=48&v=4`;
  }
  // GitHub noreply без id: user@users.noreply.github.com
  const plain = normalized.match(/^([^@]+)@users\.noreply\.github\.com$/);
  if (plain) {
    return `https://github.com/${encodeURIComponent(plain[1])}.png?size=48`;
  }
  // Gravatar по SHA-256 почты.
  try {
    const bytes = new TextEncoder().encode(normalized);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return `https://www.gravatar.com/avatar/${hex}?d=404&s=48`;
  } catch {
    return null;
  }
}

export function resolveAvatarUrl(email: string): Promise<string | null> {
  const key = email.trim().toLowerCase();
  let cached = avatarUrlCache.get(key);
  if (!cached) {
    cached = computeAvatarUrl(email);
    avatarUrlCache.set(key, cached);
  }
  return cached;
}

// «2 ч. назад» / «2h ago» — компактная подпись давности коммита.
export function formatRelativeTime(
  epochMs: number,
  locale: string,
  now = Date.now(),
): string {
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const seconds = Math.round((epochMs - now) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 60) {
    return formatter.format(Math.trunc(seconds / 1), "second");
  }
  if (absolute < 3600) {
    return formatter.format(Math.trunc(seconds / 60), "minute");
  }
  if (absolute < 86_400) {
    return formatter.format(Math.trunc(seconds / 3600), "hour");
  }
  if (absolute < 30 * 86_400) {
    return formatter.format(Math.trunc(seconds / 86_400), "day");
  }
  if (absolute < 365 * 86_400) {
    return formatter.format(Math.trunc(seconds / (30 * 86_400)), "month");
  }
  return formatter.format(Math.trunc(seconds / (365 * 86_400)), "year");
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

// ---------- Две колонки: было / стало ----------

export type DiffRow = {
  // Отсутствующая сторона — это вставка или удаление: там пусто.
  left?: DiffLine;
  right?: DiffLine;
  // Разрыв между ханками: строк нет ни слева, ни справа.
  isGap?: boolean;
};

// В unified diff изменение идёт блоком: сначала все удалённые строки, потом все
// добавленные. Для двух колонок их надо поставить друг напротив друга, а хвост
// более длинной стороны — напротив пустоты.
export function pairDiffLines(lines: readonly DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === "hunk") {
      // Первый @@ — это начало файла, а не разрыв в нём.
      if (rows.length > 0) {
        rows.push({ isGap: true });
      }
      index += 1;
      continue;
    }
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const removed: DiffLine[] = [];
    while (lines[index]?.kind === "del") {
      removed.push(lines[index]);
      index += 1;
    }
    const added: DiffLine[] = [];
    while (lines[index]?.kind === "add") {
      added.push(lines[index]);
      index += 1;
    }
    for (let step = 0; step < Math.max(removed.length, added.length); step += 1) {
      rows.push({ left: removed[step], right: added[step] });
    }
  }
  return rows;
}

// Изменившийся кусок внутри пары строк: общее начало и общий хвост остаются
// нетронутыми, подсвечивается только середина. Точного словарного сравнения
// это не заменяет, но покрывает обычную правку — переименование, другое число,
// добавленный аргумент.
export function changedRange(
  before: string,
  after: string,
): { head: number; beforeTail: number; afterTail: number } | null {
  if (before === after) {
    return null;
  }
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  return {
    head,
    beforeTail: before.length - tail,
    afterTail: after.length - tail,
  };
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
