import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { IDockviewPanelProps } from "dockview";
import { localizeBackendError, useI18n } from "../i18n";
import {
  authorAvatar,
  commitAction,
  commitAll,
  fetchBranches,
  fetchCommitFiles,
  fetchFileDiff,
  fetchLog,
  formatRelativeTime,
  getGitSummary,
  gitPull,
  gitPullRebase,
  gitPush,
  gitResetToUpstream,
  parseUnifiedDiff,
  readRepoFile,
  refreshGitChanges,
  resolveAvatarUrl,
  revertFile,
  rewordCommit,
  subscribeGitChanges,
  switchBranch,
  writeRepoFile,
  type CommitAction,
  type GitBranchInfo,
  type GitChangedFile,
  type GitChangesSummary,
  type GitCommitFile,
  type GitCommitInfo,
  type GitFileDiff,
} from "../git/gitChanges";
import { CopyIcon, UndoIcon } from "../ui/Icons";
import { computeCommitGraph } from "../git/commitGraph";
import {
  GRAPH_COLORS,
  GRAPH_DOT_RADIUS,
  GRAPH_HEAD_INNER_RADIUS,
  GRAPH_HEAD_INNER_STROKE_WIDTH,
  GRAPH_HEAD_OUTER_RADIUS,
  GRAPH_LANE_WIDTH,
  GRAPH_MERGE_INNER_RADIUS,
  GRAPH_MERGE_OUTER_RADIUS,
  GRAPH_NODE_STROKE_WIDTH,
  GRAPH_ROW_HEIGHT,
  GRAPH_STROKE_WIDTH,
  graphIncomingPath,
  graphLaneCenter,
  graphParentPath,
  graphThroughPath,
} from "../git/graphGeometry";
import {
  githubAvatarForEmail,
  loadGithubCommitAvatars,
  subscribeGithubAvatars,
} from "../git/githubAvatars";
import { isGithubSignedIn, subscribeGithubAuth } from "../github/authState";
import { loadNetworkAvatars } from "../terminal/preferences";
import { useAnimatedPresence } from "../ui/useAnimatedPresence";

function laneColor(index: number): string {
  return GRAPH_COLORS[index % GRAPH_COLORS.length];
}

// Аватарка автора: реальная (GitHub/Gravatar) — только для вошедшего через
// GitHub пользователя и при включённой настройке «Из сети». Иначе (не вошёл,
// офлайн, нет аватара, опция «Инициалы») — цветной кружок с инициалами.
function AuthorAvatar(props: { name: string; email?: string }) {
  const { initials, hue } = authorAvatar(props.name);
  const [enabled, setEnabled] = useState(() => loadNetworkAvatars());
  const [signedIn, setSignedIn] = useState(() => isGithubSignedIn());
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Сетевые аватарки доступны только после входа через GitHub.
  const networkOn = enabled && signedIn;

  useEffect(() => {
    const onChange = () => setEnabled(loadNetworkAvatars());
    window.addEventListener("modelcrew:network-avatars", onChange);
    return () =>
      window.removeEventListener("modelcrew:network-avatars", onChange);
  }, []);

  useEffect(
    () => subscribeGithubAuth(() => setSignedIn(isGithubSignedIn())),
    [],
  );

  useEffect(() => {
    if (!networkOn || !props.email) {
      setUrl(null);
      return;
    }
    const email = props.email;
    let cancelled = false;
    // Приоритет: реальный GitHub-аватар из карты коммиттеров, иначе Gravatar
    // по почте. Перечитываем и когда карта догрузилась (событие).
    const resolve = () => {
      const github = githubAvatarForEmail(email);
      if (github) {
        if (!cancelled) {
          setFailed(false);
          setUrl(github);
        }
        return;
      }
      setFailed(false);
      resolveAvatarUrl(email)
        .then((resolved) => {
          if (!cancelled) {
            setUrl(resolved);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setUrl(null);
          }
        });
    };
    resolve();
    const unsubscribe = subscribeGithubAvatars(resolve);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [networkOn, props.email]);

  const showImage = networkOn && url !== null && !failed;
  return (
    <span
      className="git-avatar"
      style={{
        background: showImage ? "transparent" : `hsl(${hue} 50% 42%)`,
      }}
      title={props.name}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          className="git-avatar-img"
          src={url}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        initials
      )}
    </span>
  );
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
      {(commit.coAuthors ?? []).map((coAuthor) => {
        // Соавтор в виде «Имя <почта>»: имя — для инициалов, почта — для авы.
        const emailMatch = coAuthor.match(/<([^>]+)>\s*$/);
        const name =
          coAuthor.replace(/\s*<[^>]*>\s*$/, "").trim() || coAuthor;
        return (
          <div key={coAuthor} className="git-commit-person">
            <span className="git-commit-person-label">
              {t("git.commitCoAuthor")}
            </span>
            <AuthorAvatar name={name} email={emailMatch?.[1]} />
            {coAuthor}
          </div>
        );
      })}
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

// Плавающее меню действий над коммитом: копирование, ветка отсюда, checkout,
// cherry-pick, revert. Открывается по ⋯ или правому клику; опасные действия
// требуют подтверждения прямо в меню, ветка — ввода имени.
function CommitActionsMenu(props: {
  workspaceId: string;
  commit: GitCommitInfo;
  x: number;
  y: number;
  onClose: () => void;
  onError: (message: string) => void;
  onDone: () => void;
  onReword: (commit: GitCommitInfo) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  // Редактировать сообщение можно только вошедшему и только свой не запушенный.
  const canReword = props.commit.editable && isGithubSignedIn();
  const [confirm, setConfirm] = useState<
    null | "checkout" | "cherryPick" | "revert"
  >(null);
  const [branching, setBranching] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [copied, setCopied] = useState<null | "hash" | "message">(null);

  // Закрытие по клику вне и по Esc.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        props.onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [props]);

  const run = async (action: CommitAction, name?: string) => {
    setBusy(true);
    try {
      await commitAction(props.workspaceId, action, props.commit.hash, name);
      props.onDone();
      props.onClose();
    } catch (error) {
      props.onError(localizeBackendError(error));
      props.onClose();
    } finally {
      setBusy(false);
    }
  };

  const copy = async (kind: "hash" | "message") => {
    const text =
      kind === "hash"
        ? props.commit.hash
        : props.commit.subject +
          (props.commit.body ? `\n\n${props.commit.body}` : "");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => props.onClose(), 650);
    } catch {
      props.onClose();
    }
  };

  // Фиксированное позиционирование у курсора/кнопки, прижатое к краям экрана.
  const style: CSSProperties = {
    position: "fixed",
    top: Math.max(8, Math.min(props.y, window.innerHeight - 240)),
    left: Math.max(8, Math.min(props.x, window.innerWidth - 236)),
  };

  return (
    <div ref={ref} className="git-actions-menu" role="menu" style={style}>
      {branching ? (
        <div className="git-actions-branch">
          <input
            autoFocus
            className="git-actions-input"
            placeholder={t("git.actionBranchName")}
            value={branchName}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setBranchName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && branchName.trim()) {
                void run("branch", branchName.trim());
              } else if (event.key === "Escape") {
                setBranching(false);
              }
            }}
          />
          <button
            type="button"
            className="git-actions-go"
            disabled={busy || !branchName.trim()}
            onClick={() => void run("branch", branchName.trim())}
          >
            {t("git.actionBranchCreate")}
          </button>
        </div>
      ) : confirm ? (
        <div className="git-actions-confirm">
          <span className="git-actions-confirm-text">
            {confirm === "checkout"
              ? t("git.actionCheckoutConfirm")
              : confirm === "cherryPick"
                ? t("git.actionCherryConfirm")
                : t("git.actionRevertConfirm")}
          </span>
          <div className="git-actions-confirm-row">
            <button
              type="button"
              className="git-actions-cancel"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="git-actions-danger"
              disabled={busy}
              onClick={() => void run(confirm)}
            >
              {t("git.actionConfirm")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            className="git-actions-item"
            onClick={() => void copy("hash")}
          >
            {copied === "hash" ? t("git.copied") : t("git.actionCopyHash")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="git-actions-item"
            onClick={() => void copy("message")}
          >
            {copied === "message"
              ? t("git.copied")
              : t("git.actionCopyMessage")}
          </button>
          {canReword && (
            <button
              type="button"
              role="menuitem"
              className="git-actions-item"
              onClick={() => {
                props.onReword(props.commit);
                props.onClose();
              }}
            >
              {t("git.actionReword")}
            </button>
          )}
          <div className="git-actions-sep" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            className="git-actions-item"
            disabled={busy}
            onClick={() => setBranching(true)}
          >
            {t("git.actionBranch")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="git-actions-item"
            disabled={busy}
            onClick={() => setConfirm("checkout")}
          >
            {t("git.actionCheckout")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="git-actions-item"
            disabled={busy}
            onClick={() => setConfirm("cherryPick")}
          >
            {t("git.actionCherryPick")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="git-actions-item is-danger"
            disabled={busy}
            onClick={() => setConfirm("revert")}
          >
            {t("git.actionRevert")}
          </button>
        </>
      )}
    </div>
  );
}

// Индикатор расхождения с сервером в шапке: ↓ забрать (ff-only), ↑ отправить.
// Клик разворачивает подтверждение, повторный — выполняет. Без upstream (не с
// чем сравнивать) не показывается; при совпадении — тихая галочка.
function SyncStatus(props: {
  workspaceId: string;
  ahead?: number;
  behind?: number;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const { ahead, behind } = props;
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | "pull" | "push">(null);
  // Разошедшаяся ветка: ↓ открывает меню (rebase / сброс к серверу).
  const [pullMenu, setPullMenu] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Незакреплённое подтверждение гаснет само.
  useEffect(() => {
    if (!confirm) {
      return;
    }
    const timer = window.setTimeout(() => setConfirm(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [confirm]);

  // Меню pull закрывается по клику вне и по Esc.
  useEffect(() => {
    if (!pullMenu) {
      return;
    }
    const close = () => {
      setPullMenu(false);
      setResetConfirm(false);
    };
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pullMenu]);

  if (ahead === undefined && behind === undefined) {
    return null; // нет upstream — сравнивать не с чем
  }

  // Ветка разошлась: есть и свои коммиты, и серверные — простой ff невозможен.
  const diverged = (ahead ?? 0) > 0 && (behind ?? 0) > 0;

  const run = async (action: "pull" | "push" | "rebase" | "reset") => {
    setBusy(true);
    setConfirm(null);
    setPullMenu(false);
    setResetConfirm(false);
    try {
      if (action === "pull") {
        await gitPull(props.workspaceId);
      } else if (action === "push") {
        await gitPush(props.workspaceId);
      } else if (action === "rebase") {
        await gitPullRebase(props.workspaceId);
      } else {
        await gitResetToUpstream(props.workspaceId);
      }
      void refreshGitChanges(props.workspaceId);
    } catch (error) {
      props.onError(localizeBackendError(error));
    } finally {
      setBusy(false);
    }
  };

  if ((ahead ?? 0) === 0 && (behind ?? 0) === 0) {
    return (
      <span className="git-sync is-synced" title={t("git.syncUpToDate")}>
        ✓
      </span>
    );
  }

  return (
    <div className="git-sync" ref={rootRef}>
      {(behind ?? 0) > 0 && (
        <button
          type="button"
          className={`git-sync-btn ${
            confirm === "pull" || pullMenu ? "is-confirm" : ""
          }`}
          disabled={busy}
          title={diverged ? t("git.pullDivergedTitle") : t("git.pullTitle")}
          onClick={() => {
            if (diverged) {
              setPullMenu((value) => !value);
              setResetConfirm(false);
            } else if (confirm === "pull") {
              void run("pull");
            } else {
              setConfirm("pull");
            }
          }}
        >
          {!diverged && confirm === "pull" ? t("git.pullConfirm") : `↓${behind}`}
        </button>
      )}
      {(ahead ?? 0) > 0 && (
        <button
          type="button"
          className={`git-sync-btn ${confirm === "push" ? "is-confirm" : ""}`}
          disabled={busy}
          title={t("git.pushTitle")}
          onClick={() =>
            confirm === "push" ? void run("push") : setConfirm("push")
          }
        >
          {confirm === "push" ? t("git.pushConfirm") : `↑${ahead}`}
        </button>
      )}
      {pullMenu && (
        <div className="git-sync-menu" role="menu">
          <div className="git-sync-menu-note">{t("git.divergedNote")}</div>
          <button
            type="button"
            role="menuitem"
            className="git-sync-menu-item"
            disabled={busy}
            title={t("git.pullRebaseHint")}
            onClick={() => void run("rebase")}
          >
            {t("git.pullRebase")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="git-sync-menu-item is-danger"
            disabled={busy}
            title={t("git.resetToServerHint")}
            onClick={() =>
              resetConfirm ? void run("reset") : setResetConfirm(true)
            }
          >
            {resetConfirm ? t("git.resetConfirm") : t("git.resetToServer")}
          </button>
        </div>
      )}
    </div>
  );
}

// Бейдж ветки/тега: клик переключает на неё, не всплывая до выбора коммита.
// Серверная (origin/…) создаёт локальную со слежением, тег — переход с
// отделением HEAD. Текущая ветка — некликабельная отметка.
function RefBadge(props: {
  refName: string;
  currentBranch?: string;
  onSwitch: (name: string, remote: boolean) => void;
}) {
  const { t } = useI18n();
  const isTag = props.refName.startsWith("tag: ");
  const label = isTag ? props.refName.slice(5) : props.refName;
  const isRemote = !isTag && props.refName.startsWith("origin/");
  const isCurrent = !isTag && !isRemote && label === props.currentBranch;
  const kind = isTag ? "is-tag" : isRemote ? "is-remote" : "";
  const title = isCurrent
    ? t("git.refCurrentHint")
    : isTag
      ? t("git.checkoutTag", { name: label })
      : isRemote
        ? t("git.checkoutRefRemote", { name: label })
        : t("git.switchToRef", { name: label });
  return (
    <button
      type="button"
      className={`git-commit-ref ${kind} ${isCurrent ? "is-current" : ""}`}
      title={title}
      aria-current={isCurrent || undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (!isCurrent) {
          props.onSwitch(label, isRemote);
        }
      }}
    >
      {label}
    </button>
  );
}

// Модальный редактор сообщения коммита: первая строка — заголовок, дальше —
// описание. Сохранение переписывает локальный коммит (бэкенд проверяет
// безопасность). Доступен только для редактируемых коммитов вошедшего.
function RewordEditor(props: {
  workspaceId: string;
  commit: GitCommitInfo;
  onClose: () => void;
  onError: (message: string) => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(
    () =>
      props.commit.subject +
      (props.commit.body ? `\n\n${props.commit.body}` : ""),
  );
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    try {
      await rewordCommit(props.workspaceId, props.commit.hash, trimmed);
      props.onDone();
      props.onClose();
    } catch (error) {
      props.onError(localizeBackendError(error));
      props.onClose();
    }
  };

  return (
    <div className="git-reword-backdrop">
      <div className="git-reword" role="dialog" aria-modal="true">
        <div className="git-reword-title">
          {t("git.actionReword")}
          <span className="git-reword-hash">{props.commit.shortHash}</span>
        </div>
        <textarea
          className="git-reword-input"
          value={text}
          autoFocus
          spellCheck={false}
          disabled={busy}
          rows={7}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              props.onClose();
            } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void save();
            }
          }}
        />
        <div className="git-reword-hint">{t("git.rewordHint")}</div>
        <div className="git-reword-actions">
          <button
            type="button"
            className="git-actions-cancel"
            disabled={busy}
            onClick={props.onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="git-actions-go"
            disabled={busy || text.trim().length === 0}
            onClick={() => void save()}
          >
            {t("git.rewordSave")}
          </button>
        </div>
      </div>
    </div>
  );
}

// Вкладка «История»: граф веток — цветные дорожки, точки, ветвления и слияния.
// Клик по узлу выбирает коммит и раскрывает его детали; полое кольцо отмечает
// merge-коммиты и текущий HEAD.
function CommitGraph(props: {
  commits: GitCommitInfo[];
  workspaceId: string;
  selectedHash: string | null;
  onSelect: (commit: GitCommitInfo) => void;
  detailsPresence: { item: string; closing: boolean } | null;
  onMenu: (commit: GitCommitInfo, x: number, y: number) => void;
  onSwitchBranch: (name: string, remote: boolean) => void;
  currentBranch?: string;
  workingTreeCount: number;
  onOpenChanges: () => void;
}) {
  const { locale, t } = useI18n();
  const rows = useMemo(
    () =>
      computeCommitGraph(
        props.commits.map((commit) => ({
          hash: commit.hash,
          parents: commit.parents,
          refs: commit.refs,
          isHead: commit.isHead,
        })),
        { currentBranch: props.currentBranch },
      ),
    [props.commits, props.currentBranch],
  );
  const head = rows[0];
  const headWidth = ((head?.width ?? 1) + 1) * GRAPH_LANE_WIDTH;

  return (
    <div className="git-graph">
      {props.workingTreeCount > 0 && head && (
        <button
          type="button"
          className="git-graph-row is-worktree"
          title={t("git.workingTreeHint")}
          onClick={props.onOpenChanges}
        >
          <svg
            className="git-graph-lines"
            width={headWidth}
            height={GRAPH_ROW_HEIGHT}
            style={{ width: headWidth, minWidth: headWidth }}
            aria-hidden="true"
          >
            {/* Пунктирный поводок от рабочего дерева вниз к точке HEAD. Свой
                «отросток» вверх у свежего коммита граф не рисует, поэтому
                тянем линию в его строку (svg — overflow: visible). */}
            <line
              x1={graphLaneCenter(head.col)}
              y1={GRAPH_ROW_HEIGHT / 2}
              x2={graphLaneCenter(head.col)}
              y2={GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2}
              stroke={laneColor(head.color)}
              strokeWidth={GRAPH_STROKE_WIDTH}
              strokeDasharray="2 2"
            />
            <circle
              cx={graphLaneCenter(head.col)}
              cy={GRAPH_ROW_HEIGHT / 2}
              r={GRAPH_HEAD_OUTER_RADIUS}
              fill="var(--git-graph-node-bg, var(--mc-bg))"
              stroke={laneColor(head.color)}
              strokeWidth={GRAPH_NODE_STROKE_WIDTH}
            />
          </svg>
          <span className="git-graph-subject git-worktree-label">
            {t("git.workingTree", {
              count: String(props.workingTreeCount),
            })}
          </span>
        </button>
      )}
      {props.commits.map((commit, index) => {
        const row = rows[index];
        if (!row) {
          return null;
        }
        const isMerge = commit.parents.length > 1;
        const cx = graphLaneCenter(row.col);
        const rowWidth = (row.width + 1) * GRAPH_LANE_WIDTH;
        const selected = props.selectedHash === commit.hash;
        return (
          <Fragment key={commit.hash}>
            <div
              role="button"
              tabIndex={0}
              className={`git-graph-row ${selected ? "is-selected" : ""} ${
                commit.isHead ? "is-head" : ""
              }`}
              onClick={() => props.onSelect(commit)}
              onContextMenu={(event) => {
                event.preventDefault();
                props.onMenu(commit, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  props.onSelect(commit);
                }
              }}
            >
              <svg
                className="git-graph-lines"
                width={rowWidth}
                height={GRAPH_ROW_HEIGHT}
                style={{ width: rowWidth, minWidth: rowWidth }}
                aria-hidden="true"
              >
                {row.through.map((edge, k) => (
                  <path
                    key={`x-${edge.fromCol}-${edge.toCol}-${edge.targetHash}-${k}`}
                    d={graphThroughPath(edge.fromCol, edge.toCol)}
                    fill="none"
                    stroke={laneColor(edge.color)}
                    strokeWidth={GRAPH_STROKE_WIDTH}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                {row.top.map((edge, k) => (
                  <path
                    key={`t-${edge.fromCol}-${edge.toCol}-${k}`}
                    d={graphIncomingPath(edge.fromCol, edge.toCol)}
                    fill="none"
                    stroke={laneColor(edge.color)}
                    strokeWidth={GRAPH_STROKE_WIDTH}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                {row.bottom.map((edge, k) => (
                  <path
                    key={`b-${edge.fromCol}-${edge.toCol}-${edge.parentIndex}-${k}`}
                    d={graphParentPath(
                      edge.fromCol,
                      edge.toCol,
                      edge.parentIndex ?? 0,
                    )}
                    fill="none"
                    stroke={laneColor(edge.color)}
                    strokeWidth={GRAPH_STROKE_WIDTH}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                {commit.isHead ? (
                  <>
                    <circle
                      cx={cx}
                      cy={GRAPH_ROW_HEIGHT / 2}
                      r={GRAPH_HEAD_OUTER_RADIUS}
                      fill={laneColor(row.color)}
                      stroke="var(--git-graph-node-bg, var(--mc-bg))"
                      strokeWidth={GRAPH_NODE_STROKE_WIDTH}
                    />
                    <circle
                      cx={cx}
                      cy={GRAPH_ROW_HEIGHT / 2}
                      r={GRAPH_HEAD_INNER_RADIUS}
                      fill="var(--git-graph-node-bg, var(--mc-bg))"
                      stroke="var(--git-graph-node-bg, var(--mc-bg))"
                      strokeWidth={GRAPH_HEAD_INNER_STROKE_WIDTH}
                    />
                  </>
                ) : isMerge ? (
                  <>
                    <circle
                      cx={cx}
                      cy={GRAPH_ROW_HEIGHT / 2}
                      r={GRAPH_MERGE_OUTER_RADIUS}
                      fill={laneColor(row.color)}
                      stroke="var(--git-graph-node-bg, var(--mc-bg))"
                      strokeWidth={GRAPH_NODE_STROKE_WIDTH}
                    />
                    <circle
                      cx={cx}
                      cy={GRAPH_ROW_HEIGHT / 2}
                      r={GRAPH_MERGE_INNER_RADIUS}
                      fill="var(--git-graph-node-bg, var(--mc-bg))"
                      stroke="var(--git-graph-node-bg, var(--mc-bg))"
                      strokeWidth={GRAPH_NODE_STROKE_WIDTH}
                    />
                  </>
                ) : (
                  <circle
                    cx={cx}
                    cy={GRAPH_ROW_HEIGHT / 2}
                    r={GRAPH_DOT_RADIUS}
                    fill={laneColor(row.color)}
                    stroke="var(--git-graph-node-bg, var(--mc-bg))"
                    strokeWidth={GRAPH_NODE_STROKE_WIDTH}
                  />
                )}
              </svg>
              <span className="git-graph-subject" title={commit.subject}>
                {commit.subject}
              </span>
              {commit.refs.map((ref) => (
                <RefBadge
                  key={ref}
                  refName={ref}
                  currentBranch={props.currentBranch}
                  onSwitch={props.onSwitchBranch}
                />
              ))}
              <div className="git-graph-right">
                <span
                  className="git-graph-date"
                  title={new Intl.DateTimeFormat(locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(commit.epochMs))}
                >
                  {formatRelativeTime(commit.epochMs, locale)}
                </span>
                <span className="git-graph-who">
                  <AuthorAvatar
                    name={commit.author}
                    email={commit.authorEmail}
                  />
                  <span className="git-graph-author" title={commit.author}>
                    {commit.author}
                  </span>
                </span>
                <button
                  type="button"
                  className="git-commit-menu-btn"
                  title={t("git.commitActions")}
                  aria-label={t("git.commitActions")}
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    props.onMenu(commit, rect.right, rect.bottom);
                  }}
                >
                  ⋯
                </button>
              </div>
            </div>
            {props.detailsPresence?.item === commit.hash && (
              <div
                className="git-graph-details"
                style={{ paddingLeft: rowWidth + 14 }}
              >
                {/* Продолжаем состояние дорожек с нижней границы строки,
                    чтобы граф не рвался на раскрытой карточке коммита. */}
                <span
                  className="git-graph-details-lanes"
                  style={{ width: rowWidth }}
                  aria-hidden="true"
                >
                  {row.lanesBelow.map((lane) => (
                    <span
                      key={lane.col}
                      className="git-graph-lane-through"
                      style={{
                        left: graphLaneCenter(lane.col),
                        background: laneColor(lane.color),
                      }}
                    />
                  ))}
                </span>
                <RevealHeight closing={props.detailsPresence.closing}>
                  <CommitDetails
                    workspaceId={props.workspaceId}
                    commit={commit}
                    closing={props.detailsPresence.closing}
                  />
                </RevealHeight>
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function HistoryView(props: {
  workspaceId: string;
  // Незакоммиченных файлов (для узла рабочего дерева) и переход к «Изменениям».
  fileCount: number;
  onOpenChanges: () => void;
  // Текущая ветка — для выделения её бейджа и клика по чужим.
  currentBranch?: string;
}) {
  const { locale, t } = useI18n();
  const [commits, setCommits] = useState<GitCommitInfo[] | null>(null);
  const [graphMode, setGraphMode] = useState(true);
  // «Все ветки»: включает локальные и серверные ветки (без stash/tag-only
  // служебных историй), граф становится насыщенным, как в редакторах.
  const [allBranches, setAllBranches] = useState(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  // Сколько коммитов запрашивать; «Показать ещё» наращивает порциями.
  const [limit, setLimit] = useState(100);
  const [loadingMore, setLoadingMore] = useState(false);
  // Открытое меню действий над коммитом: коммит и точка привязки на экране.
  const [menu, setMenu] = useState<{
    commit: GitCommitInfo;
    x: number;
    y: number;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Открытый редактор сообщения коммита.
  const [rewording, setRewording] = useState<GitCommitInfo | null>(null);
  // Немедленная перезагрузка лога после действия (не дожидаясь вотчера).
  const [reloadNonce, setReloadNonce] = useState(0);
  // Детали остаются смонтированными на время exit-анимации при сворачивании.
  const detailsPresence = useAnimatedPresence(expandedHash, 240);
  const openMenu = (commit: GitCommitInfo, x: number, y: number) =>
    setMenu({ commit, x, y });
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
      fetchLog(props.workspaceId, limit, allBranches)
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
  }, [props.workspaceId, limit, allBranches, reloadNonce]);

  // Незакоммиченные изменения показываем узлом только в обычном виде: в режиме
  // «все ветки» верхний коммит — не обязательно HEAD, поводок был бы обманчив.
  const workingTreeCount = allBranches ? 0 : props.fileCount;

  // Ошибка действия гаснет сама.
  useEffect(() => {
    if (!actionError) {
      return;
    }
    const timer = window.setTimeout(() => setActionError(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [actionError]);

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

  // Переключение на ветку/тег по клику на бейдж; ошибка (грязное дерево и т.п.)
  // показывается баннером.
  const switchTo = async (name: string, remote: boolean) => {
    try {
      await switchBranch(props.workspaceId, name, remote);
      void refreshGitChanges(props.workspaceId);
      setReloadNonce((value) => value + 1);
    } catch (error) {
      setActionError(localizeBackendError(error));
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
      <div className="git-history-bar">
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
        <button
          type="button"
          className={`git-all-branches ${allBranches ? "is-active" : ""}`}
          aria-pressed={allBranches}
          title={t("git.allBranchesHint")}
          onClick={() => {
            setLimit(100);
            setAllBranches((value) => !value);
          }}
        >
          ⎇ {t("git.allBranches")}
        </button>
      </div>
      {actionError && (
        <div className="git-commit-error" role="alert">
          {actionError}
        </div>
      )}
      {/* key по режиму перемонтирует контент — короткая анимация появления
          при переключении «Граф ⇄ Список» в обе стороны. */}
      <div key={graphMode ? "graph" : "list"} className="git-history-swap">
      {graphMode ? (
        <CommitGraph
          commits={commits}
          workspaceId={props.workspaceId}
          selectedHash={expandedHash}
          onSelect={(commit) =>
            setExpandedHash(expandedHash === commit.hash ? null : commit.hash)
          }
          detailsPresence={detailsPresence}
          onMenu={openMenu}
          onSwitchBranch={(name, remote) => void switchTo(name, remote)}
          currentBranch={props.currentBranch}
          workingTreeCount={workingTreeCount}
          onOpenChanges={props.onOpenChanges}
        />
      ) : (
        <div className="git-commit-list">
          {workingTreeCount > 0 && (
            <button
              type="button"
              className="git-worktree-card"
              title={t("git.workingTreeHint")}
              onClick={props.onOpenChanges}
            >
              <span className="git-worktree-dot" aria-hidden="true" />
              <span className="git-worktree-text">
                {t("git.workingTree", { count: String(workingTreeCount) })}
              </span>
            </button>
          )}
          {commits.map((commit) => {
            const expanded = expandedHash === commit.hash;
            return (
          <div
            key={commit.hash}
            className={`git-commit ${expanded ? "is-expanded" : ""} ${
              arrivedHashesRef.current.has(commit.hash) ? "is-arriving" : ""
            }`}
            onContextMenu={(event) => {
              event.preventDefault();
              openMenu(commit, event.clientX, event.clientY);
            }}
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
                <AuthorAvatar name={commit.author} email={commit.authorEmail} />
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
              {commit.refs.map((ref) => (
                <RefBadge
                  key={ref}
                  refName={ref}
                  currentBranch={props.currentBranch}
                  onSwitch={(name, remote) => void switchTo(name, remote)}
                />
              ))}
            </div>
            <button
              type="button"
              className="git-commit-menu-btn"
              title={t("git.commitActions")}
              aria-label={t("git.commitActions")}
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                openMenu(commit, rect.right, rect.bottom);
              }}
            >
              ⋯
            </button>
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
      </div>
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
      {menu && (
        <CommitActionsMenu
          workspaceId={props.workspaceId}
          commit={menu.commit}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onError={setActionError}
          onDone={() => setReloadNonce((value) => value + 1)}
          onReword={setRewording}
        />
      )}
      {rewording && (
        <RewordEditor
          workspaceId={props.workspaceId}
          commit={rewording}
          onClose={() => setRewording(null)}
          onError={setActionError}
          onDone={() => {
            // Хеш изменился — снимаем выделение старого и перезагружаем лог.
            setExpandedHash(null);
            setReloadNonce((value) => value + 1);
          }}
        />
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

  // Реальные GitHub-аватарки коммиттеров: тянем карту почта→аватар один раз
  // при открытии панели (если выполнен вход). AuthorAvatar подхватит её.
  useEffect(() => {
    if (workspaceId) {
      loadGithubCommitAvatars(workspaceId);
    }
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
            <div className="git-toolbar-right">
              <SyncStatus
                workspaceId={workspaceId}
                ahead={summary.ahead}
                behind={summary.behind}
                onError={setBranchError}
              />
              <BranchSwitcher
                workspaceId={workspaceId}
                currentBranch={summary.branch}
                onError={setBranchError}
              />
            </div>
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
            <HistoryView
              workspaceId={workspaceId}
              fileCount={summary.files.length}
              onOpenChanges={() => setView("changes")}
              currentBranch={summary.branch}
            />
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
