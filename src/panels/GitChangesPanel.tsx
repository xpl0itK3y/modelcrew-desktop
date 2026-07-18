import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IDockviewPanelProps } from "dockview";
import { localizeBackendError, useI18n } from "../i18n";
import {
  commitAll,
  fetchBranches,
  fetchCommitFiles,
  fetchFileDiff,
  fetchLog,
  formatRelativeTime,
  getGitSummary,
  parseUnifiedDiff,
  readRepoFile,
  refreshGitChanges,
  revertFile,
  subscribeGitChanges,
  switchBranch,
  writeRepoFile,
  type GitBranchInfo,
  type GitChangedFile,
  type GitChangesSummary,
  type GitCommitFile,
  type GitCommitInfo,
  type GitFileDiff,
} from "../git/gitChanges";
import { CopyIcon, UndoIcon } from "../ui/Icons";
import { computeCommitGraph } from "../git/commitGraph";
import { useAnimatedPresence } from "../ui/useAnimatedPresence";

// Палитра дорожек графа и геометрия строки.
const GRAPH_COLORS = [
  "#a78bfa",
  "#e0894c",
  "#4fb8a8",
  "#5c9de0",
  "#e05c9e",
  "#4fb864",
  "#d9a03f",
];
const LANE_W = 14;
const GRAPH_ROW_H = 26;
const GRAPH_DOT_R = 3.6;

function laneColor(index: number): string {
  return GRAPH_COLORS[index % GRAPH_COLORS.length];
}

function laneCenter(col: number): number {
  return col * LANE_W + LANE_W / 2;
}

// Прямая для вертикальной дорожки, плавная S-кривая для перехода в другую.
function graphEdgePath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) {
    return `M${x1} ${y1}L${x2} ${y2}`;
  }
  const mid = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
}

// Иконка-статус в списке: одна буква как в git status.
const STATUS_LETTER: Record<GitChangedFile["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
};

function FileDiff(props: {
  workspaceId: string;
  file: GitChangedFile;
}) {
  const { t } = useI18n();
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [failed, setFailed] = useState(false);
  // Правка строки на месте: номер редактируемой строки (в новой версии
  // файла) и её текущий текст в поле ввода.
  const [editingLine, setEditingLine] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  // Принудительный перечит diff после правки строки: счётчики +/− могут не
  // измениться, и тогда countsKey бы не сработал.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Живое обновление: когда счётчики файла меняются (агент дописал код),
  // раскрытый diff перечитывается и свежие строки подсвечиваются.
  const countsKey = `${props.file.additions ?? "b"}:${props.file.deletions ?? "b"}`;
  const previousTexts = useRef<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchFileDiff(props.workspaceId, props.file.path)
      .then((next) => {
        if (!cancelled) {
          setFailed(false);
          setDiff(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.workspaceId, props.file.path, countsKey, reloadNonce]);

  const startEditing = (newLine: number, text: string) => {
    setEditingLine(newLine);
    setEditValue(text);
  };

  // Сохраняет одну строку: перечитывает файл, заменяет строку с этим номером
  // и пишет обратно. Номер новой версии = номер строки в текущем файле.
  const saveLine = async (newLine: number, text: string) => {
    setSaving(true);
    try {
      const file = await readRepoFile(props.workspaceId, props.file.path);
      if (!file.isBinary && !file.tooLarge && file.exists) {
        const parts = file.content.split("\n");
        if (newLine >= 1 && newLine <= parts.length) {
          parts[newLine - 1] = text;
          await writeRepoFile(
            props.workspaceId,
            props.file.path,
            parts.join("\n"),
          );
          // Перечит diff сразу: правка текста могла не тронуть счётчики,
          // тогда обновление по countsKey бы не пришло.
          setReloadNonce((value) => value + 1);
          void refreshGitChanges(props.workspaceId);
        }
      }
    } catch {
      // Ошибка записи вернёт исходную строку при следующем обновлении diff.
    } finally {
      setSaving(false);
      setEditingLine(null);
    }
  };

  const lines = useMemo(
    () => (diff ? parseUnifiedDiff(diff.diff) : []),
    [diff],
  );

  // Строки, которых не было в прошлом рендере, получают вспышку фона.
  const freshTexts = useMemo(() => {
    const current = new Set(
      lines
        .filter((line) => line.kind === "add")
        .map((line) => `${line.newLine}\0${line.text}`),
    );
    const previous = previousTexts.current;
    previousTexts.current = current;
    if (!previous) {
      return new Set<string>();
    }
    const fresh = new Set<string>();
    for (const key of current) {
      if (!previous.has(key)) {
        fresh.add(key);
      }
    }
    return fresh;
  }, [lines]);

  if (failed) {
    return <div className="git-diff-note">{t("git.diffUnavailable")}</div>;
  }
  if (!diff) {
    return <div className="git-diff-note">{t("git.diffLoading")}</div>;
  }
  if (diff.isBinary) {
    return <div className="git-diff-note">{t("git.binaryFile")}</div>;
  }
  return (
    <div className="git-diff" role="table">
      {/* Обёртка шириной с самую длинную строку: фон коротких строк
          тянется до неё, а не обрывается на своём тексте. */}
      <div className="git-diff-body">
      {lines.map((line, index) =>
        line.kind === "hunk" ? (
          // Служебную шапку @@ … @@ не показываем; между ханками — разрыв.
          index === 0 ? null : (
            <div key={index} className="git-diff-gap" aria-hidden="true" />
          )
        ) : (
          (() => {
            // Редактировать можно строки, которые есть в текущем файле:
            // добавленные и контекстные (у удалённых нет новой версии).
            const editable = line.kind === "add" || line.kind === "context";
            const isEditing =
              editable && editingLine === line.newLine;
            const sign =
              line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
            return (
              <div
                key={index}
                className={`git-diff-line is-${line.kind} ${
                  editable ? "is-editable" : ""
                } ${
                  line.kind === "add" &&
                  freshTexts.has(`${line.newLine}\0${line.text}`)
                    ? "is-fresh"
                    : ""
                }`}
                onClick={
                  editable && !isEditing
                    ? () => startEditing(line.newLine!, line.text)
                    : undefined
                }
              >
                <span className="git-diff-gutter">
                  {line.kind === "del" ? line.oldLine : line.newLine}
                </span>
                {isEditing ? (
                  <span className="git-diff-text">
                    <span className="git-diff-sign">{sign}</span>
                    <input
                      className="git-diff-input"
                      value={editValue}
                      spellCheck={false}
                      disabled={saving}
                      autoFocus
                      size={Math.max(editValue.length + 2, 12)}
                      onChange={(event) => setEditValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void saveLine(line.newLine!, editValue);
                        } else if (event.key === "Escape") {
                          setEditingLine(null);
                        }
                      }}
                      onBlur={() => {
                        if (editValue !== line.text) {
                          void saveLine(line.newLine!, editValue);
                        } else {
                          setEditingLine(null);
                        }
                      }}
                    />
                  </span>
                ) : (
                  <span className="git-diff-text">
                    {sign}
                    {line.text}
                  </span>
                )}
              </div>
            );
          })()
        ),
      )}
      </div>
      {diff.truncated && (
        <div className="git-diff-note">{t("git.diffTruncated")}</div>
      )}
    </div>
  );
}

function FileCard(props: {
  workspaceId: string;
  file: GitChangedFile;
  arriving: boolean;
}) {
  const { t } = useI18n();
  // Пользователь открыл панель посмотреть изменения — diff сразу развёрнут.
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const [confirmingRevert, setConfirmingRevert] = useState(false);
  const [busy, setBusy] = useState(false);
  const { file, workspaceId } = props;

  // Живое обновление уже видимого файла: счётчики изменились — карточка
  // коротко вспыхивает, чтобы движение было заметно глазу.
  const countsKey = `${file.additions ?? "b"}:${file.deletions ?? "b"}`;
  const previousCounts = useRef(countsKey);
  const [updatedFlash, setUpdatedFlash] = useState(false);
  useEffect(() => {
    if (previousCounts.current === countsKey) {
      return;
    }
    previousCounts.current = countsKey;
    setUpdatedFlash(true);
    const timer = window.setTimeout(() => setUpdatedFlash(false), 650);
    return () => window.clearTimeout(timer);
  }, [countsKey]);

  // Незакреплённое подтверждение отката гаснет само.
  useEffect(() => {
    if (!confirmingRevert) {
      return;
    }
    const timer = window.setTimeout(() => setConfirmingRevert(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [confirmingRevert]);

  const copyDiff = async () => {
    try {
      const diff = await fetchFileDiff(workspaceId, file.path);
      await navigator.clipboard.writeText(diff.diff);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Diff недоступен (файл удалён и т.п.) — просто без фидбека.
    }
  };

  const revert = async () => {
    setBusy(true);
    try {
      await revertFile(workspaceId, file.path, file.origPath);
      void refreshGitChanges(workspaceId);
    } catch {
      // Ошибка вернёт файл в списке при следующем обновлении.
    } finally {
      setBusy(false);
      setConfirmingRevert(false);
    }
  };

  return (
    <div
      className={`git-file is-${file.status} ${
        props.arriving ? "is-arriving" : ""
      }`}
    >
      <div
        className={`git-file-header ${updatedFlash ? "is-updated" : ""}`}
      >
        <button
          type="button"
          className="git-file-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span
            className={`git-file-status is-${file.status}`}
            title={t(`git.status.${file.status}`)}
          >
            {STATUS_LETTER[file.status]}
          </span>
          <span className="git-file-path" title={file.path}>
            {file.origPath ? `${file.origPath} → ${file.path}` : file.path}
          </span>
        </button>
        <span className="git-file-actions">
          {confirmingRevert ? (
            <button
              type="button"
              className="git-revert-confirm"
              disabled={busy}
              onClick={() => void revert()}
            >
              {t("git.revertConfirm")}
            </button>
          ) : (
            <>
              <button
                type="button"
                className={`icon-button git-file-action ${copied ? "is-done" : ""}`}
                title={copied ? t("git.copied") : t("git.copyDiff")}
                aria-label={t("git.copyDiff")}
                onClick={() => void copyDiff()}
              >
                <CopyIcon />
              </button>
              <button
                type="button"
                className="icon-button git-file-action"
                title={t("git.revert")}
                aria-label={t("git.revert")}
                onClick={() => setConfirmingRevert(true)}
              >
                <UndoIcon />
              </button>
            </>
          )}
        </span>
        <span className="git-file-counts">
          {file.additions === undefined && file.deletions === undefined ? (
            <span className="git-count-binary">{t("git.binaryShort")}</span>
          ) : (
            <>
              <span className="git-count-add">+{file.additions ?? 0}</span>
              <span className="git-count-del">−{file.deletions ?? 0}</span>
            </>
          )}
        </span>
      </div>
      {expanded && file.status !== "deleted" && (
        <FileDiff workspaceId={workspaceId} file={file} />
      )}
      {expanded && file.status === "deleted" && (
        <div className="git-diff-note">{t("git.fileDeleted")}</div>
      )}
    </div>
  );
}

// Выпадающий переключатель веток: список отсортирован по свежести коммитов.
function BranchSwitcher(props: {
  workspaceId: string;
  currentBranch?: string;
  onError: (message: string) => void;
}) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    fetchBranches(props.workspaceId)
      .then(setBranches)
      .catch(() => setBranches([]));
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open, props.workspaceId]);

  const pick = async (branch: GitBranchInfo) => {
    setOpen(false);
    if (branch.isCurrent || busy) {
      return;
    }
    setBusy(true);
    try {
      await switchBranch(props.workspaceId, branch.name, branch.isRemote);
      void refreshGitChanges(props.workspaceId);
    } catch (error) {
      // Типично: незакоммиченные изменения конфликтуют с целевой веткой.
      props.onError(localizeBackendError(error));
    } finally {
      setBusy(false);
    }
  };

  const localBranches = branches.filter((branch) => !branch.isRemote);
  const remoteBranches = branches.filter((branch) => branch.isRemote);
  const branchRow = (branch: GitBranchInfo) => (
    <button
      key={branch.name}
      type="button"
      role="option"
      aria-selected={branch.isCurrent}
      className={`git-branch-item ${branch.isCurrent ? "is-current" : ""} ${
        branch.isRemote ? "is-remote" : ""
      }`}
      title={branch.isRemote ? t("git.remoteBranchHint") : undefined}
      onClick={() => void pick(branch)}
    >
      <span className="git-branch-name">{branch.name}</span>
      {branch.isMerged && (
        <span className="git-branch-merged" title={t("git.mergedHint")}>
          {t("git.mergedBadge")}
        </span>
      )}
      {branch.lastCommitAt !== undefined && (
        <span className="git-branch-date">
          {formatRelativeTime(branch.lastCommitAt, locale)}
        </span>
      )}
    </button>
  );

  return (
    <div className="git-branch-switcher" ref={rootRef}>
      <button
        type="button"
        className="git-branch-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t("git.switchBranch")}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        ⎇ {props.currentBranch ?? t("git.detachedHead")}
        <span className="git-branch-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="git-branch-menu" role="listbox">
          {localBranches.map(branchRow)}
          {remoteBranches.length > 0 && (
            <div className="git-branch-section">
              {t("git.remoteBranches")}
            </div>
          )}
          {remoteBranches.map(branchRow)}
          {branches.length === 0 && (
            <div className="git-branch-empty">{t("git.loading")}</div>
          )}
        </div>
      )}
    </div>
  );
}

// Плавное раскрытие по высоте: grid-переход 0fr → 1fr, контент не прыгает,
// соседние карточки съезжают, а не скачут.
function RevealHeight(props: { closing: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div
      className={`git-reveal ${open && !props.closing ? "is-open" : ""}`}
    >
      <div className="git-reveal-inner">{props.children}</div>
    </div>
  );
}

// Раскрытая карточка коммита: описание, точная дата, соавторы и файлы.
function CommitDetails(props: {
  workspaceId: string;
  commit: GitCommitInfo;
  closing: boolean;
}) {
  const { locale, t } = useI18n();
  const { commit, workspaceId } = props;
  const [files, setFiles] = useState<GitCommitFile[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCommitFiles(workspaceId, commit.hash)
      .then((list) => {
        if (!cancelled) {
          setFiles(list);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFiles([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, commit.hash]);

  const exactDate = new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(commit.epochMs));

  return (
    <div
      className={`git-commit-details ${props.closing ? "is-closing" : ""}`}
    >
      {commit.body && <pre className="git-commit-body">{commit.body}</pre>}
      <div className="git-commit-person">
        <span className="git-commit-person-label">
          {t("git.commitDate")}
        </span>
        {exactDate}
      </div>
      {(commit.coAuthors ?? []).map((coAuthor) => (
        <div key={coAuthor} className="git-commit-person">
          <span className="git-commit-person-label">
            {t("git.commitCoAuthor")}
          </span>
          {coAuthor}
        </div>
      ))}
      {files === null ? (
        <div className="git-commit-person">{t("git.diffLoading")}</div>
      ) : files.length > 0 ? (
        <div className="git-commit-files">
          <div className="git-commit-person-label">
            {t("git.commitFiles", { count: String(files.length) })}
          </div>
          {files.map((file) => (
            <div key={file.path} className="git-commit-file">
              <span className="git-commit-file-path" title={file.path}>
                {file.path}
              </span>
              {file.additions === undefined &&
              file.deletions === undefined ? (
                <span className="git-count-binary">
                  {t("git.binaryShort")}
                </span>
              ) : (
                <span className="git-file-counts">
                  <span className="git-count-add">
                    +{file.additions ?? 0}
                  </span>
                  <span className="git-count-del">
                    −{file.deletions ?? 0}
                  </span>
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Вкладка «История»: последние коммиты с автором, давностью и ветками.
// Граф веток: цветные дорожки, точки коммитов, ветвления и слияния — как в
// редакторах. Клик по строке копирует хеш.
function CommitGraph(props: {
  commits: GitCommitInfo[];
  copiedHash: string | null;
  onCopy: (commit: GitCommitInfo) => void;
}) {
  const { t } = useI18n();
  const rows = useMemo(
    () =>
      computeCommitGraph(
        props.commits.map((commit) => ({
          hash: commit.hash,
          parents: commit.parents,
        })),
      ),
    [props.commits],
  );
  const width = (rows[0]?.width ?? 1) * LANE_W;

  return (
    <div className="git-graph">
      {props.commits.map((commit, index) => {
        const row = rows[index];
        if (!row) {
          return null;
        }
        const isMerge = commit.parents.length > 1;
        const cx = laneCenter(row.col);
        return (
          <button
            type="button"
            key={commit.hash}
            className={`git-graph-row ${
              props.copiedHash === commit.hash ? "is-copied" : ""
            }`}
            title={t("git.copyHash")}
            onClick={() => props.onCopy(commit)}
          >
            <svg
              className="git-graph-lines"
              width={width}
              height={GRAPH_ROW_H}
              style={{ width, minWidth: width }}
              aria-hidden="true"
            >
              {row.top.map((edge, k) => (
                <path
                  key={`t${k}`}
                  d={graphEdgePath(
                    laneCenter(edge.fromCol),
                    0,
                    laneCenter(edge.toCol),
                    GRAPH_ROW_H / 2,
                  )}
                  fill="none"
                  stroke={laneColor(edge.color)}
                  strokeWidth={1.6}
                />
              ))}
              {row.bottom.map((edge, k) => (
                <path
                  key={`b${k}`}
                  d={graphEdgePath(
                    laneCenter(edge.fromCol),
                    GRAPH_ROW_H / 2,
                    laneCenter(edge.toCol),
                    GRAPH_ROW_H,
                  )}
                  fill="none"
                  stroke={laneColor(edge.color)}
                  strokeWidth={1.6}
                />
              ))}
              <circle
                cx={cx}
                cy={GRAPH_ROW_H / 2}
                r={GRAPH_DOT_R}
                fill={isMerge ? "var(--mc-bg)" : laneColor(row.color)}
                stroke={laneColor(row.color)}
                strokeWidth={isMerge ? 2 : 0}
              />
            </svg>
            <span className="git-graph-subject" title={commit.subject}>
              {commit.subject}
            </span>
            {commit.refs.map((ref) => {
              const isTag = ref.startsWith("tag: ");
              const label = isTag ? ref.slice(5) : ref;
              const kind = isTag
                ? "is-tag"
                : ref.startsWith("origin/")
                  ? "is-remote"
                  : "";
              return (
                <span key={ref} className={`git-commit-ref ${kind}`}>
                  {label}
                </span>
              );
            })}
            <span className="git-graph-author" title={commit.author}>
              {commit.author}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function HistoryView(props: { workspaceId: string }) {
  const { locale, t } = useI18n();
  const [commits, setCommits] = useState<GitCommitInfo[] | null>(null);
  const [graphMode, setGraphMode] = useState(true);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  // Сколько коммитов запрашивать; «Показать ещё» наращивает порциями.
  const [limit, setLimit] = useState(100);
  const [loadingMore, setLoadingMore] = useState(false);
  // Детали остаются смонтированными на время exit-анимации при сворачивании.
  const detailsPresence = useAnimatedPresence(expandedHash, 240);
  // Коммиты, появившиеся при открытой вкладке, въезжают с анимацией;
  // первоначальный список и догруженные «Показать ещё» (они старше уже
  // виденных) показываются сразу.
  const knownHashesRef = useRef<Set<string> | null>(null);
  const arrivedHashesRef = useRef(new Set<string>());
  const newestEpochRef = useRef(0);
  if (commits !== null) {
    if (knownHashesRef.current === null) {
      knownHashesRef.current = new Set(commits.map((commit) => commit.hash));
      newestEpochRef.current = commits[0]?.epochMs ?? 0;
    } else {
      for (const commit of commits) {
        if (!knownHashesRef.current.has(commit.hash)) {
          knownHashesRef.current.add(commit.hash);
          if (commit.epochMs >= newestEpochRef.current) {
            arrivedHashesRef.current.add(commit.hash);
          }
        }
      }
      newestEpochRef.current = Math.max(
        newestEpochRef.current,
        commits[0]?.epochMs ?? 0,
      );
    }
  }

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchLog(props.workspaceId, limit)
        .then((log) => {
          if (!cancelled) {
            setCommits(log);
            setLoadingMore(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setCommits([]);
            setLoadingMore(false);
          }
        });
    };
    load();
    // Новый коммит (из панели или терминала) сразу появляется в истории.
    const unsubscribe = subscribeGitChanges(props.workspaceId, load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [props.workspaceId, limit]);

  // Бэкенд отдаёт максимум 500 за раз; если пришло меньше лимита — история
  // закончилась и кнопка не нужна.
  const canLoadMore =
    commits !== null && commits.length >= limit && limit < 500;

  const copyHash = async (commit: GitCommitInfo) => {
    try {
      await navigator.clipboard.writeText(commit.hash);
      setCopiedHash(commit.hash);
      window.setTimeout(() => setCopiedHash(null), 1_500);
    } catch {
      // Буфер обмена недоступен — молча.
    }
  };

  if (commits === null) {
    return <div className="git-empty">{t("git.loading")}</div>;
  }
  if (commits.length === 0) {
    return <div className="git-empty">{t("git.historyEmpty")}</div>;
  }
  return (
    <div className="git-history">
      <div className="git-history-modes" role="group">
        <button
          type="button"
          className={`git-mode ${graphMode ? "is-active" : ""}`}
          aria-pressed={graphMode}
          onClick={() => setGraphMode(true)}
        >
          {t("git.viewGraph")}
        </button>
        <button
          type="button"
          className={`git-mode ${!graphMode ? "is-active" : ""}`}
          aria-pressed={!graphMode}
          onClick={() => setGraphMode(false)}
        >
          {t("git.viewList")}
        </button>
      </div>
      {graphMode ? (
        <CommitGraph
          commits={commits}
          copiedHash={copiedHash}
          onCopy={(commit) => void copyHash(commit)}
        />
      ) : (
        <div className="git-commit-list">
          {commits.map((commit) => {
            const expanded = expandedHash === commit.hash;
            return (
          <div
            key={commit.hash}
            className={`git-commit ${expanded ? "is-expanded" : ""} ${
              arrivedHashesRef.current.has(commit.hash) ? "is-arriving" : ""
            }`}
          >
            {/* Клик по карточке раскрывает описание, автора и соавторов. */}
            <button
              type="button"
              className="git-commit-toggle"
              aria-expanded={expanded}
              onClick={() =>
                setExpandedHash(expanded ? null : commit.hash)
              }
            >
              <div className="git-commit-subject" title={commit.subject}>
                {commit.subject}
              </div>
            </button>
            <div className="git-commit-meta">
              <button
                type="button"
                className={`git-commit-hash ${
                  copiedHash === commit.hash ? "is-done" : ""
                }`}
                title={t("git.copyHash")}
                onClick={() => void copyHash(commit)}
              >
                {copiedHash === commit.hash
                  ? t("git.copied")
                  : commit.shortHash}
              </button>
              <span
                className="git-commit-author"
                title={`${commit.author} <${commit.authorEmail}>`}
              >
                {/* В раскрытой карточке имя дополняется почтой прямо здесь,
                    отдельной строки «Автор» нет — без дублей. */}
                {commit.author}
                {expanded && (
                  <span className="git-commit-email">
                    {" "}
                    &lt;{commit.authorEmail}&gt;
                  </span>
                )}
              </span>
              <span className="git-commit-date">
                {formatRelativeTime(commit.epochMs, locale)}
              </span>
              {commit.unpushed && (
                <span
                  className="git-commit-unpushed"
                  title={t("git.unpushedHint")}
                >
                  {t("git.unpushed")}
                </span>
              )}
              {commit.refs.map((ref) => {
                // Удалённые ветки и теги отличаются цветом от локальных.
                const isTag = ref.startsWith("tag: ");
                const label = isTag ? ref.slice(5) : ref;
                const kind = isTag
                  ? "is-tag"
                  : ref.startsWith("origin/")
                    ? "is-remote"
                    : "";
                return (
                  <span
                    key={ref}
                    className={`git-commit-ref ${kind}`}
                    title={
                      isTag
                        ? t("git.refTag", { name: label })
                        : ref.startsWith("origin/")
                          ? t("git.refRemote", { name: label })
                          : t("git.refLocal", { name: label })
                    }
                  >
                    {label}
                  </span>
                );
              })}
            </div>
            {detailsPresence?.item === commit.hash && (
              <RevealHeight closing={detailsPresence.closing}>
                <CommitDetails
                  workspaceId={props.workspaceId}
                  commit={commit}
                  closing={detailsPresence.closing}
                />
              </RevealHeight>
            )}
          </div>
            );
          })}
        </div>
      )}
      {canLoadMore && (
        <button
          type="button"
          className="git-history-more"
          disabled={loadingMore}
          onClick={() => {
            setLoadingMore(true);
            setLimit((value) => Math.min(value + 100, 500));
          }}
        >
          {loadingMore ? t("git.loading") : t("git.showMore")}
        </button>
      )}
    </div>
  );
}

// Содержимое панели изменений; живёт в оверлее-drawer поверх терминалов.
export function GitChangesView(props: { workspaceId: string }) {
  const { t } = useI18n();
  const { workspaceId } = props;
  const [summary, setSummary] = useState<GitChangesSummary | null>(() =>
    getGitSummary(workspaceId),
  );

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    return subscribeGitChanges(workspaceId, setSummary);
  }, [workspaceId]);

  const [view, setView] = useState<"changes" | "history">("changes");
  const [branchError, setBranchError] = useState<string | null>(null);

  // Файлы, появившиеся в списке уже при открытой панели, въезжают с
  // анимацией; исходный состав показывается сразу.
  const knownPathsRef = useRef<Set<string> | null>(null);
  const arrivedPathsRef = useRef(new Set<string>());
  if (summary?.isRepo) {
    if (knownPathsRef.current === null) {
      knownPathsRef.current = new Set(summary.files.map((file) => file.path));
    } else {
      for (const file of summary.files) {
        if (!knownPathsRef.current.has(file.path)) {
          knownPathsRef.current.add(file.path);
          arrivedPathsRef.current.add(file.path);
        }
      }
    }
  }

  // Ошибка переключения ветки гаснет сама.
  useEffect(() => {
    if (!branchError) {
      return;
    }
    const timer = window.setTimeout(() => setBranchError(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [branchError]);

  // Коммит всех изменений прямо из панели, как в Warp.
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const commit = async () => {
    const trimmed = message.trim();
    if (!trimmed || committing) {
      return;
    }
    setCommitting(true);
    setCommitError(null);
    try {
      await commitAll(workspaceId, trimmed);
      setMessage("");
      void refreshGitChanges(workspaceId);
    } catch (error) {
      setCommitError(localizeBackendError(error));
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="git-changes-panel">
      {summary === null ? (
        <div className="git-empty">{t("git.loading")}</div>
      ) : !summary.isRepo ? (
        <div className="git-empty">{t("git.notARepo")}</div>
      ) : (
        <>
          <div className="git-toolbar">
            <div className="git-tabs" role="tablist">
              {/* Пилюля-индикатор перетекает под активную вкладку. */}
              <span
                className={`git-tab-indicator ${
                  view === "history" ? "is-second" : ""
                }`}
                aria-hidden="true"
              />
              {(["changes", "history"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={view === tab}
                  className={`git-tab ${view === tab ? "is-active" : ""}`}
                  onClick={() => {
                    // Метки «свежих» карточек сбрасываются, чтобы въезд
                    // не переигрывался при каждом переключении вкладок.
                    arrivedPathsRef.current.clear();
                    setView(tab);
                  }}
                >
                  {t(tab === "changes" ? "git.tabChanges" : "git.tabHistory")}
                </button>
              ))}
            </div>
            <BranchSwitcher
              workspaceId={workspaceId}
              currentBranch={summary.branch}
              onError={setBranchError}
            />
          </div>
          {branchError && (
            <div className="git-commit-error" role="alert">
              {branchError}
            </div>
          )}
          {/* key по вкладке перемонтирует контент — короткий въезд при
              переключении «Изменения ⇄ История». */}
          <div key={view} className="git-view">
          {view === "history" ? (
            <HistoryView workspaceId={workspaceId} />
          ) : summary.files.length === 0 ? (
            <div className="git-empty">{t("git.clean")}</div>
          ) : (
            <>
              <div className="git-commit-row">
                <input
                  type="text"
                  className="git-commit-input"
                  placeholder={t("git.commitPlaceholder")}
                  value={message}
                  maxLength={4000}
                  disabled={committing}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void commit();
                    }
                  }}
                />
                <button
                  type="button"
                  className="git-commit-button"
                  disabled={committing || message.trim().length === 0}
                  onClick={() => void commit()}
                >
                  {t("git.commitButton")}
                </button>
              </div>
              {commitError && (
                <div className="git-commit-error" role="alert">
                  {commitError}
                </div>
              )}
              <div className="git-file-list">
                {summary.files.map((file) => (
                  <FileCard
                    key={file.path}
                    workspaceId={workspaceId}
                    file={file}
                    arriving={arrivedPathsRef.current.has(file.path)}
                  />
                ))}
              </div>
            </>
          )}
          </div>
        </>
      )}
    </div>
  );
}

// Обёртка для раскладок, сохранённых когда «Изменения» были dockview-панелью:
// такие панели продолжают работать, новые открываются оверлеем.
export function GitChangesPanel(
  props: IDockviewPanelProps<{ workspaceId?: string }>,
) {
  return <GitChangesView workspaceId={props.params?.workspaceId ?? ""} />;
}
