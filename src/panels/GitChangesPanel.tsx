import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { IDockviewPanelProps } from "dockview";
import { localizeBackendError, useI18n } from "../i18n";
import {
  amendCommit,
  authorAvatar,
  changedRange,
  commitAction,
  commitAll,
  commitFileDiff,
  commitPatch,
  compareFileDiff,
  compareFiles,
  createBranch,
  createTag,
  deleteBranch,
  deleteTag,
  dropCommit,
  fetchBranches,
  fetchCommitFiles,
  fetchFileDiff,
  fetchLog,
  formatRelativeTime,
  getGitSummary,
  githubCommitUrl,
  gitPull,
  gitPullRebase,
  gitPush,
  gitResetToUpstream,
  mergeRef,
  pairDiffLines,
  parseUnifiedDiff,
  publishBranch,
  readRepoFile,
  rebaseOnto,
  refreshGitChanges,
  renameBranch,
  resetToCommit,
  resolveAvatarUrl,
  revertFile,
  rewordCommit,
  saveCommitPatch,
  squashCommit,
  subscribeGitChanges,
  switchBranch,
  writeRepoFile,
  type CommitAction,
  type GitBranchInfo,
  type GitChangedFile,
  type GitChangesSummary,
  type DiffLine,
  type GitCommitFile,
  type GitCommitInfo,
  type GitFileDiff,
  type GitRefKind,
  type GitResetMode,
} from "../git/gitChanges";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CopyIcon, UndoIcon } from "../ui/Icons";
import { ConfirmDialog } from "../ui/ConfirmDialog";
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
                        if (event.nativeEvent.isComposing) {
                          return;
                        }
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
  headHash?: string;
  onError: (message: string) => void;
}) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<
    | { kind: "create" }
    | { kind: "rename"; branch: GitBranchInfo }
    | null
  >(null);
  const [branchName, setBranchName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<GitBranchInfo | null>(null);
  // Слияние и перенос подтверждаются отдельно: обе операции меняют историю
  // текущей ветки и при конфликте оставляют репозиторий незавершённым.
  const [integrate, setIntegrate] = useState<{
    kind: "merge" | "rebase";
    branch: GitBranchInfo;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const branchesRequestRef = useRef(0);

  useEffect(() => {
    if (!open) {
      return;
    }
    const request = ++branchesRequestRef.current;
    setLoading(true);
    setLoadFailed(false);
    setBranches([]);
    fetchBranches(props.workspaceId)
      .then((next) => {
        if (branchesRequestRef.current === request) {
          setBranches(next);
        }
      })
      .catch(() => {
        if (branchesRequestRef.current === request) {
          setBranches([]);
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (branchesRequestRef.current === request) {
          setLoading(false);
        }
      });
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setEditor(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setEditor(null);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      if (branchesRequestRef.current === request) {
        branchesRequestRef.current += 1;
      }
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, props.workspaceId]);

  const reloadBranches = async () => {
    const request = ++branchesRequestRef.current;
    try {
      const next = await fetchBranches(props.workspaceId);
      if (branchesRequestRef.current === request) {
        setBranches(next);
        setLoadFailed(false);
      }
    } catch {
      if (branchesRequestRef.current === request) {
        setLoadFailed(true);
      }
    }
  };

  const pick = async (branch: GitBranchInfo) => {
    setOpen(false);
    setEditor(null);
    if (branch.isCurrent || busy) {
      return;
    }
    setBusy(true);
    try {
      await switchBranch(
        props.workspaceId,
        branch.isRemote ? branch.refName : branch.name,
        branch.isRemote ? "remote" : "local",
      );
      void refreshGitChanges(props.workspaceId);
    } catch (error) {
      // Типично: незакоммиченные изменения конфликтуют с целевой веткой.
      props.onError(localizeBackendError(error));
    } finally {
      setBusy(false);
    }
  };

  const beginCreate = () => {
    setEditor({ kind: "create" });
    setBranchName("");
  };

  const beginRename = (branch: GitBranchInfo) => {
    setEditor({ kind: "rename", branch });
    setBranchName(branch.name);
  };

  const saveEditor = async () => {
    const name = branchName.trim();
    if (
      !editor ||
      !name ||
      busy ||
      (editor.kind === "rename" && name === editor.branch.name)
    ) {
      return;
    }
    setBusy(true);
    try {
      if (editor.kind === "create") {
        await createBranch(props.workspaceId, name);
      } else {
        await renameBranch(props.workspaceId, editor.branch.name, name);
      }
      setEditor(null);
      setOpen(false);
      await reloadBranches();
      void refreshGitChanges(props.workspaceId);
    } catch (error) {
      await reloadBranches();
      void refreshGitChanges(props.workspaceId);
      props.onError(localizeBackendError(error));
    } finally {
      setBusy(false);
    }
  };

  const confirmIntegrate = async () => {
    if (!integrate || !props.currentBranch || !props.headHash || busy) {
      return;
    }
    const { kind, branch } = integrate;
    setBusy(true);
    try {
      const run = kind === "merge" ? mergeRef : rebaseOnto;
      await run(
        props.workspaceId,
        branch.refName,
        props.currentBranch,
        props.headHash,
      );
      setIntegrate(null);
      void refreshGitChanges(props.workspaceId);
    } catch (error) {
      setIntegrate(null);
      props.onError(localizeBackendError(error));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || busy) {
      return;
    }
    setBusy(true);
    try {
      // Невлитую ветку удаляем только после усиленного подтверждения. Backend
      // делает compare-and-swap по показанной вершине: если параллельный Git
      // успел сдвинуть ref, новая вершина останется нетронутой.
      await deleteBranch(
        props.workspaceId,
        deleteTarget.name,
        !deleteTarget.isMerged,
        deleteTarget.tipHash,
      );
      setDeleteTarget(null);
      await reloadBranches();
      void refreshGitChanges(props.workspaceId);
    } catch (error) {
      setDeleteTarget(null);
      props.onError(localizeBackendError(error));
    } finally {
      setBusy(false);
    }
  };

  const localBranches = branches.filter((branch) => !branch.isRemote);
  const remoteBranches = branches.filter((branch) => branch.isRemote);
  const branchRow = (branch: GitBranchInfo) => (
    <div
      key={`${branch.isRemote ? "remote" : "local"}:${branch.name}`}
      className="git-branch-row"
    >
      <button
        type="button"
        aria-current={branch.isCurrent || undefined}
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
      <span className="git-branch-actions">
        {!branch.isCurrent && props.currentBranch && props.headHash && (
          <>
            <button
              type="button"
              className="git-branch-action"
              title={t("git.branchMerge")}
              aria-label={t("git.branchMergeNamed", { name: branch.name })}
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setIntegrate({ kind: "merge", branch });
              }}
            >
              ⤵
            </button>
            <button
              type="button"
              className="git-branch-action"
              title={t("git.branchRebase")}
              aria-label={t("git.branchRebaseNamed", { name: branch.name })}
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setIntegrate({ kind: "rebase", branch });
              }}
            >
              ⤴
            </button>
          </>
        )}
      </span>
      {!branch.isRemote && (
        <span className="git-branch-actions">
          <button
            type="button"
            className="git-branch-action"
            title={t("git.branchRename")}
            aria-label={t("git.branchRenameNamed", { name: branch.name })}
            disabled={busy}
            onClick={() => beginRename(branch)}
          >
            ✎
          </button>
          {!branch.isCurrent && (
            <button
              type="button"
              className="git-branch-action is-danger"
              title={t("git.branchDelete")}
              aria-label={t("git.branchDeleteNamed", { name: branch.name })}
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setEditor(null);
                setDeleteTarget(branch);
              }}
            >
              ×
            </button>
          )}
        </span>
      )}
    </div>
  );

  return (
    <>
      <div className="git-branch-switcher" ref={rootRef}>
        <button
          type="button"
          className="git-branch-button"
          aria-haspopup="dialog"
          aria-expanded={open}
          title={t("git.switchBranch")}
          disabled={busy}
          onClick={() => {
            setEditor(null);
            setOpen((value) => !value);
          }}
        >
          ⎇ {props.currentBranch ?? t("git.detachedHead")}
          <span className="git-branch-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {open && (
          <div
            className="git-branch-menu"
            role="dialog"
            aria-label={t("git.switchBranch")}
          >
            {editor ? (
              <div className="git-branch-editor">
                <input
                  autoFocus
                  className="git-actions-input"
                  aria-label={
                    editor.kind === "create"
                      ? t("git.actionBranchName")
                      : t("git.branchNewName")
                  }
                  placeholder={
                    editor.kind === "create"
                      ? t("git.actionBranchName")
                      : t("git.branchNewName")
                  }
                  value={branchName}
                  spellCheck={false}
                  disabled={busy}
                  onChange={(event) => setBranchName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) {
                      return;
                    }
                    if (event.key === "Enter") {
                      void saveEditor();
                    } else if (event.key === "Escape") {
                      event.stopPropagation();
                      setEditor(null);
                    }
                  }}
                />
                <button
                  type="button"
                  className="git-actions-go"
                  disabled={
                    busy ||
                    !branchName.trim() ||
                    (editor.kind === "rename" &&
                      branchName.trim() === editor.branch.name)
                  }
                  onClick={() => void saveEditor()}
                >
                  {editor.kind === "create"
                    ? t("git.actionBranchCreate")
                    : t("git.branchRenameSave")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="git-branch-create"
                onClick={beginCreate}
              >
                <span aria-hidden="true">＋</span> {t("git.branchCreate")}
              </button>
            )}
            {localBranches.map(branchRow)}
            {remoteBranches.length > 0 && (
              <div className="git-branch-section">
                {t("git.remoteBranches")}
              </div>
            )}
            {remoteBranches.map(branchRow)}
            {loading && (
              <div className="git-branch-empty">{t("git.loading")}</div>
            )}
            {!loading && loadFailed && (
              <div className="git-branch-empty is-error">
                {t("git.branchesLoadFailed")}
              </div>
            )}
            {!loading && !loadFailed && branches.length === 0 && (
              <div className="git-branch-empty">{t("git.branchesEmpty")}</div>
            )}
          </div>
        )}
      </div>
      {integrate && props.currentBranch && (
        <ConfirmDialog
          text={t(
            integrate.kind === "merge"
              ? "git.branchMergeConfirm"
              : "git.branchRebaseConfirm",
            { name: integrate.branch.name, current: props.currentBranch },
          )}
          confirmLabel={t(
            integrate.kind === "merge" ? "git.branchMerge" : "git.branchRebase",
          )}
          busy={busy}
          onConfirm={() => void confirmIntegrate()}
          onCancel={() => setIntegrate(null)}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          text={t(
            deleteTarget.isMerged
              ? "git.branchDeleteConfirm"
              : "git.branchForceDeleteConfirm",
            { name: deleteTarget.name },
          )}
          confirmLabel={
            deleteTarget.isMerged
              ? t("git.branchDelete")
              : t("git.branchForceDelete")
          }
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
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
// ---------- Просмотр diff-а только для чтения ----------

// «Одна колонка» — привычный unified diff; «две» показывают было и стало рядом.
// Выбор общий для истории и сравнения и живёт между запусками, как остальные
// настройки.
type DiffView = "unified" | "split";

const DIFF_VIEW_KEY = "modelcrew.diffView";

function loadDiffView(): DiffView {
  try {
    return localStorage.getItem(DIFF_VIEW_KEY) === "unified"
      ? "unified"
      : "split";
  } catch {
    return "split";
  }
}

function saveDiffView(view: DiffView): void {
  try {
    localStorage.setItem(DIFF_VIEW_KEY, view);
  } catch {
    // Не сохранилось — выбор просто не доедет до следующего запуска.
  }
}

function DiffViewToggle(props: {
  view: DiffView;
  onChange: (view: DiffView) => void;
}) {
  const { t } = useI18n();
  const next: DiffView = props.view === "split" ? "unified" : "split";
  const label = t(next === "split" ? "git.diffSplit" : "git.diffUnified");
  return (
    <button
      type="button"
      className="git-diff-view-toggle"
      title={label}
      aria-label={label}
      onClick={() => props.onChange(next)}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <rect
          x="1.5"
          y="2.5"
          width="13"
          height="11"
          rx="2"
          fill="none"
          stroke="currentColor"
        />
        {next === "split" ? (
          <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="currentColor" />
        ) : (
          <>
            <line x1="4" y1="6.5" x2="12" y2="6.5" stroke="currentColor" />
            <line x1="4" y1="9.5" x2="12" y2="9.5" stroke="currentColor" />
          </>
        )}
      </svg>
    </button>
  );
}

// Текст строки с подсветкой изменившегося куска. Общее начало и хвост остаются
// обычными — глаз сразу находит, что именно поправили.
function DiffText(props: {
  text: string;
  pair: { before: string; after: string } | null;
  side: "left" | "right";
}) {
  const range = props.pair
    ? changedRange(props.pair.before, props.pair.after)
    : null;
  const end = range
    ? props.side === "left"
      ? range.beforeTail
      : range.afterTail
    : 0;
  // Пустая подсветка бывает у чистой вставки: на старой стороне выделять нечего.
  if (!range || end === range.head) {
    return <span className="git-diff-text">{props.text}</span>;
  }
  return (
    <span className="git-diff-text">
      {props.text.slice(0, range.head)}
      <mark className="git-diff-mark">{props.text.slice(range.head, end)}</mark>
      {props.text.slice(end)}
    </span>
  );
}

function SplitDiff(props: { lines: readonly DiffLine[] }) {
  const rows = useMemo(() => pairDiffLines(props.lines), [props.lines]);
  return (
    <div className="git-diff is-split" role="table">
      <div className="git-diff-body">
        {rows.map((row, index) => {
          if (row.isGap) {
            return <div key={index} className="git-diff-gap" aria-hidden="true" />;
          }
          // Подсвечиваем внутренности только там, где строку правили: у пары
          // «удалено/добавлено». Вставке и удалению сравнивать не с чем.
          const pair =
            row.left?.kind === "del" && row.right?.kind === "add"
              ? { before: row.left.text, after: row.right.text }
              : null;
          return (
            <div key={index} className="git-diff-row">
              <div
                className={`git-diff-half ${
                  row.left ? `is-${row.left.kind}` : "is-empty"
                }`}
              >
                <span className="git-diff-gutter">{row.left?.oldLine ?? ""}</span>
                {row.left && (
                  <DiffText text={row.left.text} pair={pair} side="left" />
                )}
              </div>
              <div
                className={`git-diff-half ${
                  row.right ? `is-${row.right.kind}` : "is-empty"
                }`}
              >
                <span className="git-diff-gutter">
                  {row.right?.newLine ?? ""}
                </span>
                {row.right && (
                  <DiffText text={row.right.text} pair={pair} side="right" />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UnifiedDiff(props: { lines: readonly DiffLine[] }) {
  return (
    <div className="git-diff" role="table">
      <div className="git-diff-body">
        {props.lines.map((line, index) =>
          line.kind === "hunk" ? (
            index === 0 ? null : (
              <div key={index} className="git-diff-gap" aria-hidden="true" />
            )
          ) : (
            <div key={index} className={`git-diff-line is-${line.kind}`}>
              <span className="git-diff-sign" aria-hidden="true">
                {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
              </span>
              <span className="git-diff-text">{line.text}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

// Общее тело для истории и сравнения: разные источники, одна отрисовка.
function DiffBody(props: {
  diff: GitFileDiff | null;
  failed: boolean;
  view: DiffView;
}) {
  const { t } = useI18n();
  const lines = useMemo(
    () => (props.diff ? parseUnifiedDiff(props.diff.diff) : []),
    [props.diff],
  );
  if (props.failed) {
    return <div className="git-diff-note">{t("git.diffUnavailable")}</div>;
  }
  if (!props.diff) {
    return <div className="git-diff-note">{t("git.diffLoading")}</div>;
  }
  if (props.diff.isBinary) {
    return <div className="git-diff-note">{t("git.binaryFile")}</div>;
  }
  return (
    <>
      {props.view === "split" ? (
        <SplitDiff lines={lines} />
      ) : (
        <UnifiedDiff lines={lines} />
      )}
      {props.diff.truncated && (
        <div className="git-diff-note">{t("git.diffTruncated")}</div>
      )}
    </>
  );
}

function CommitFileDiff(props: {
  workspaceId: string;
  hash: string;
  path: string;
  view: DiffView;
}) {
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    commitFileDiff(props.workspaceId, props.hash, props.path)
      .then((next) => {
        if (!cancelled) {
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
  }, [props.workspaceId, props.hash, props.path]);

  return <DiffBody diff={diff} failed={failed} view={props.view} />;
}

function CommitDetails(props: {
  workspaceId: string;
  commit: GitCommitInfo;
  closing: boolean;
}) {
  const { locale, t } = useI18n();
  const { commit, workspaceId } = props;
  const [files, setFiles] = useState<GitCommitFile[] | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [view, setView] = useState<DiffView>(loadDiffView);

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
          <div className="git-commit-files-head">
            <span className="git-commit-person-label">
              {t("git.commitFiles", { count: String(files.length) })}
            </span>
            <DiffViewToggle
              view={view}
              onChange={(next) => {
                setView(next);
                saveDiffView(next);
              }}
            />
          </div>
          {files.map((file) => {
            const isBinary =
              file.additions === undefined && file.deletions === undefined;
            const isOpen = openPath === file.path;
            return (
              <div key={file.path} className="git-commit-file">
                <button
                  type="button"
                  className="git-commit-file-row"
                  aria-expanded={isOpen}
                  onClick={() => setOpenPath(isOpen ? null : file.path)}
                >
                  <span className="git-commit-file-path" title={file.path}>
                    {file.path}
                  </span>
                  {isBinary ? (
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
                </button>
                {isOpen && (
                  <CommitFileDiff
                    workspaceId={workspaceId}
                    hash={commit.hash}
                    path={file.path}
                    view={view}
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// Плавающее меню действий над коммитом: копирование, ветка отсюда, checkout,
// cherry-pick, revert и безопасная отмена последнего локального коммита.
// Открывается по ⋯ или правому клику; опасные действия требуют подтверждения
// прямо в меню, ветка — ввода имени.

// Сравнение двух состояний: коммит с коммитом или коммит с рабочей папкой.
// Только чтение: править файлы историческим diff-ом было бы неоднозначно.
function CompareView(props: {
  workspaceId: string;
  from: GitCommitInfo;
  // null — текущая рабочая папка.
  to: GitCommitInfo | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [files, setFiles] = useState<GitCommitFile[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [view, setView] = useState<DiffView>(loadDiffView);

  useEffect(() => {
    let cancelled = false;
    compareFiles(props.workspaceId, props.from.hash, props.to?.hash)
      .then((next) => {
        if (!cancelled) {
          setFiles(next);
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
  }, [props.workspaceId, props.from.hash, props.to?.hash]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const target = props.to?.shortHash ?? t("git.compareWorkingTree");
  return (
    <div className="git-reword-backdrop" onPointerDown={props.onClose}>
      <div
        className="git-compare"
        role="dialog"
        aria-modal="true"
        aria-label={t("git.compareTitle")}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="git-reword-title">
          {t("git.compareTitle")}
          <span className="git-reword-hash">
            {props.from.shortHash} → {target}
          </span>
          <DiffViewToggle
            view={view}
            onChange={(next) => {
              setView(next);
              saveDiffView(next);
            }}
          />
        </div>
        {failed ? (
          <div className="git-diff-note">{t("git.diffUnavailable")}</div>
        ) : !files ? (
          <div className="git-diff-note">{t("git.diffLoading")}</div>
        ) : files.length === 0 ? (
          <div className="git-diff-note">{t("git.compareIdentical")}</div>
        ) : (
          <div className="git-compare-files">
            {files.map((file) => (
              <div key={file.path} className="git-compare-file">
                <button
                  type="button"
                  className="git-compare-row"
                  aria-expanded={openPath === file.path}
                  onClick={() =>
                    setOpenPath(openPath === file.path ? null : file.path)
                  }
                >
                  <span className="git-compare-path">{file.path}</span>
                  <span className="git-file-counts">
                    <span className="git-count-add">+{file.additions ?? 0}</span>
                    <span className="git-count-del">−{file.deletions ?? 0}</span>
                  </span>
                </button>
                {openPath === file.path && (
                  <CompareFileDiff
                    workspaceId={props.workspaceId}
                    from={props.from.hash}
                    to={props.to?.hash}
                    path={file.path}
                    view={view}
                  />
                )}
              </div>
            ))}
          </div>
        )}
        <div className="git-reword-row">
          <button
            type="button"
            className="git-actions-cancel"
            onClick={props.onClose}
          >
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

function CompareFileDiff(props: {
  workspaceId: string;
  from: string;
  to?: string;
  path: string;
  view: DiffView;
}) {
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    compareFileDiff(props.workspaceId, props.from, props.path, props.to)
      .then((next) => {
        if (!cancelled) {
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
  }, [props.workspaceId, props.from, props.to, props.path]);

  return <DiffBody diff={diff} failed={failed} view={props.view} />;
}

// Действия меню: часть уходит в общий commit_action, часть — в отдельные
// команды правки истории, которым нужна подтверждённая вершина ветки.
type CommitMenuAction =
  | Exclude<CommitAction, "branch">
  | "amend"
  | "squash"
  | "fixup"
  | "drop"
  | "resetSoft"
  | "resetMixed"
  | "resetHard";

const RESET_MODES: Record<string, GitResetMode> = {
  resetSoft: "soft",
  resetMixed: "mixed",
  resetHard: "hard",
};

const CONFIRM_TEXT = {
  checkout: "git.actionCheckoutConfirm",
  cherryPick: "git.actionCherryConfirm",
  revert: "git.actionRevertConfirm",
  uncommit: "git.actionUncommitConfirm",
  amend: "git.actionAmendConfirm",
  squash: "git.actionSquashConfirm",
  fixup: "git.actionFixupConfirm",
  drop: "git.actionDropConfirm",
  resetSoft: "git.actionResetSoftConfirm",
  resetMixed: "git.actionResetMixedConfirm",
  resetHard: "git.actionResetHardConfirm",
} as const;

function CommitActionsMenu(props: {
  workspaceId: string;
  commit: GitCommitInfo;
  currentBranch?: string;
  // Вершина ветки на момент отрисовки: уходит в бэкенд как подтверждение.
  headHash?: string;
  x: number;
  y: number;
  onClose: () => void;
  onError: (message: string) => void;
  onDone: () => void;
  onReword: (commit: GitCommitInfo) => void;
  // Отмеченный для сравнения коммит живёт в истории, а не в меню: меню
  // закрывается после каждого действия.
  marked: GitCommitInfo | null;
  onMark: (commit: GitCommitInfo | null) => void;
  onCompare: (from: GitCommitInfo, to: GitCommitInfo | null) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  // GitHub-авторизация здесь не нужна: бэкенд сверяет автора с локальным
  // `git config user.email` и разрешает переписывать только локальную историю.
  const canReword = props.commit.editable;
  const onBranch = Boolean(props.currentBranch) && Boolean(props.headHash);
  const canUncommit =
    onBranch &&
    props.commit.isHead &&
    props.commit.localOnly === true &&
    props.commit.parents.length === 1;
  // Переписывать историю можно только там, где это уже разрешил бэкенд:
  // непрерывный локальный first-parent суффикс собственных коммитов.
  const canAmend = onBranch && props.commit.isHead && canReword;
  const canRewrite = onBranch && canReword && props.commit.parents.length === 1;
  const canReset = onBranch && !props.commit.isHead;
  const isMerge = props.commit.parents.length > 1;
  const [confirm, setConfirm] = useState<null | CommitMenuAction>(null);
  // Ветка и тег вводят имя в одном и том же поле меню.
  const [naming, setNaming] = useState<null | "branch" | "tag">(null);
  const [nameValue, setNameValue] = useState("");
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const [copied, setCopied] = useState<null | "hash" | "message" | "patch">(
    null,
  );
  const tags = props.commit.refDetails.filter((ref) => ref.kind === "tag");

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

  const run = async (
    action: CommitMenuAction | "branch" | "tag" | "deleteTag",
    name?: string,
  ) => {
    setBusy(true);
    const hash = props.commit.hash;
    const head = props.headHash ?? "";
    try {
      if (action === "amend") {
        await amendCommit(props.workspaceId, head);
      } else if (action === "squash" || action === "fixup") {
        await squashCommit(props.workspaceId, hash, action, head);
      } else if (action === "drop") {
        await dropCommit(props.workspaceId, hash, head);
      } else if (action in RESET_MODES) {
        await resetToCommit(props.workspaceId, hash, RESET_MODES[action], head);
      } else if (action === "tag") {
        await createTag(props.workspaceId, name ?? "", hash);
      } else if (action === "deleteTag") {
        await deleteTag(props.workspaceId, name ?? "");
      } else {
        await commitAction(props.workspaceId, action as CommitAction, hash, name);
      }
      await refreshGitChanges(props.workspaceId);
      props.onDone();
      props.onClose();
    } catch (error) {
      props.onError(localizeBackendError(error));
      props.onClose();
    } finally {
      setBusy(false);
    }
  };

  const copy = async (kind: "hash" | "message" | "patch") => {
    try {
      const text =
        kind === "hash"
          ? props.commit.hash
          : kind === "message"
            ? fullCommitMessage(props.commit)
            : await commitPatch(props.workspaceId, props.commit.hash);
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => props.onClose(), 650);
    } catch (error) {
      props.onError(localizeBackendError(error));
      props.onClose();
    }
  };

  const savePatch = async () => {
    setBusy(true);
    try {
      await saveCommitPatch(
        props.workspaceId,
        props.commit.hash,
        `${props.commit.shortHash}.patch`,
      );
    } catch (error) {
      props.onError(localizeBackendError(error));
    } finally {
      setBusy(false);
      props.onClose();
    }
  };

  const openOnGithub = async () => {
    setBusy(true);
    try {
      const url = await githubCommitUrl(props.workspaceId, props.commit.hash);
      if (url) {
        await openUrl(url);
      } else {
        props.onError(t("git.actionOpenGithubMissing"));
      }
    } catch (error) {
      props.onError(localizeBackendError(error));
    } finally {
      setBusy(false);
      props.onClose();
    }
  };

  // Фиксированное позиционирование у курсора/кнопки, прижатое к краям экрана.
  // Высоту меню заранее не знаем: набор пунктов зависит от коммита. Поэтому
  // после отрисовки поднимаем его ровно настолько, чтобы низ поместился.
  const [menuHeight, setMenuHeight] = useState(0);
  useLayoutEffect(() => {
    setMenuHeight(ref.current?.offsetHeight ?? 0);
  }, [confirm, naming, deletingTag, copied]);
  const style: CSSProperties = {
    position: "fixed",
    top: Math.max(8, Math.min(props.y, window.innerHeight - menuHeight - 8)),
    left: Math.max(8, Math.min(props.x, window.innerWidth - 236)),
  };

  return (
    <div ref={ref} className="git-actions-menu" role="menu" style={style}>
      {naming ? (
        <div className="git-actions-branch">
          <input
            autoFocus
            className="git-actions-input"
            aria-label={
              naming === "branch" ? t("git.actionBranchName") : t("git.tagName")
            }
            placeholder={
              naming === "branch" ? t("git.actionBranchName") : t("git.tagName")
            }
            value={nameValue}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setNameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return;
              }
              if (event.key === "Enter" && nameValue.trim()) {
                void run(naming, nameValue.trim());
              } else if (event.key === "Escape") {
                setNaming(null);
              }
            }}
          />
          <button
            type="button"
            className="git-actions-go"
            disabled={busy || !nameValue.trim()}
            onClick={() => void run(naming, nameValue.trim())}
          >
            {naming === "branch"
              ? t("git.actionBranchCreate")
              : t("git.tagCreateGo")}
          </button>
        </div>
      ) : deletingTag ? (
        <div className="git-actions-confirm">
          <span className="git-actions-confirm-text">
            {t("git.tagDeleteConfirm", { name: deletingTag })}
          </span>
          <div className="git-actions-confirm-row">
            <button
              type="button"
              className="git-actions-cancel"
              disabled={busy}
              onClick={() => setDeletingTag(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="git-actions-danger"
              disabled={busy}
              onClick={() => void run("deleteTag", deletingTag)}
            >
              {t("git.actionConfirm")}
            </button>
          </div>
        </div>
      ) : confirm ? (
        <div className="git-actions-confirm">
          <span className="git-actions-confirm-text">
            {t(CONFIRM_TEXT[confirm])}
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
          <button
            type="button"
            role="menuitem"
            className="git-actions-item"
            disabled={busy}
            onClick={() => void copy("patch")}
          >
            {copied === "patch" ? t("git.copied") : t("git.actionCopyPatch")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="git-actions-item"
            disabled={busy}
            onClick={() => void savePatch()}
          >
            {t("git.actionSavePatch")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="git-actions-item"
            disabled={busy}
            onClick={() => void openOnGithub()}
          >
            {t("git.actionOpenGithub")}
          </button>
          <div className="git-actions-sep" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            className="git-actions-item"
            onClick={() => {
              props.onCompare(props.commit, null);
              props.onClose();
            }}
          >
            {t("git.compareWithWorkingTree")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="git-actions-item"
            onClick={() => {
              props.onMark(
                props.marked?.hash === props.commit.hash ? null : props.commit,
              );
              props.onClose();
            }}
          >
            {props.marked?.hash === props.commit.hash
              ? t("git.compareUnmark")
              : t("git.compareMark")}
          </button>
          {props.marked && props.marked.hash !== props.commit.hash && (
            <button
              type="button"
              role="menuitem"
              className="git-actions-item"
              onClick={() => {
                props.onCompare(props.marked!, props.commit);
                props.onClose();
              }}
            >
              {t("git.compareWithMarked", { name: props.marked.shortHash })}
            </button>
          )}
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
          {canAmend && (
            <button
              type="button"
              role="menuitem"
              className="git-actions-item"
              disabled={busy}
              onClick={() => setConfirm("amend")}
            >
              {t("git.actionAmend")}
            </button>
          )}
          {canRewrite && (
            <>
              <button
                type="button"
                role="menuitem"
                className="git-actions-item"
                disabled={busy}
                onClick={() => setConfirm("squash")}
              >
                {t("git.actionSquash")}
              </button>
              <button
                type="button"
                role="menuitem"
                className="git-actions-item"
                disabled={busy}
                onClick={() => setConfirm("fixup")}
              >
                {t("git.actionFixup")}
              </button>
            </>
          )}
          <div className="git-actions-sep" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            className="git-actions-item"
            disabled={busy}
            onClick={() => {
              setNaming("branch");
              setNameValue("");
            }}
          >
            {t("git.actionBranch")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="git-actions-item"
            disabled={busy}
            onClick={() => {
              setNaming("tag");
              setNameValue("");
            }}
          >
            {t("git.tagCreate")}
          </button>
          {tags.map((tag) => (
            <button
              key={tag.fullName}
              type="button"
              role="menuitem"
              className="git-actions-item is-danger"
              disabled={busy}
              onClick={() => setDeletingTag(tag.name)}
            >
              {t("git.tagDelete", { name: tag.name })}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="git-actions-item"
            disabled={busy}
            onClick={() => setConfirm("checkout")}
          >
            {t("git.actionCheckout")}
          </button>
          {!isMerge && (
            <button
              type="button"
              role="menuitem"
              className="git-actions-item"
              disabled={busy}
              onClick={() => setConfirm("cherryPick")}
            >
              {t("git.actionCherryPick")}
            </button>
          )}
          {!isMerge && (
            <button
              type="button"
              role="menuitem"
              className="git-actions-item is-danger"
              disabled={busy}
              onClick={() => setConfirm("revert")}
            >
              {t("git.actionRevert")}
            </button>
          )}
          {canUncommit && (
            <button
              type="button"
              role="menuitem"
              className="git-actions-item is-danger"
              disabled={busy}
              onClick={() => setConfirm("uncommit")}
            >
              {t("git.actionUncommit")}
            </button>
          )}
          {canRewrite && (
            <button
              type="button"
              role="menuitem"
              className="git-actions-item is-danger"
              disabled={busy}
              onClick={() => setConfirm("drop")}
            >
              {t("git.actionDrop")}
            </button>
          )}
          {canReset && (
            <>
              <div className="git-actions-sep" aria-hidden="true" />
              <div className="git-actions-label">{t("git.actionResetHere")}</div>
              <button
                type="button"
                role="menuitem"
                className="git-actions-item"
                disabled={busy}
                onClick={() => setConfirm("resetSoft")}
              >
                {t("git.actionResetSoft")}
              </button>
              <button
                type="button"
                role="menuitem"
                className="git-actions-item"
                disabled={busy}
                onClick={() => setConfirm("resetMixed")}
              >
                {t("git.actionResetMixed")}
              </button>
              <button
                type="button"
                role="menuitem"
                className="git-actions-item is-danger"
                disabled={busy}
                onClick={() => setConfirm("resetHard")}
              >
                {t("git.actionResetHard")}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

function fullCommitMessage(commit: GitCommitInfo): string {
  return commit.fullMessage;
}



// Предупреждение об отделённом HEAD. Из списка веток вернуться можно и так, но
// без явной подсказки состояние легко не заметить и потерять коммиты.
function DetachedHeadBanner(props: {
  workspaceId: string;
  headHash: string;
  previousBranch?: string;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const back = async (branch: string) => {
    setBusy(true);
    try {
      await switchBranch(props.workspaceId, branch, "local");
      void refreshGitChanges(props.workspaceId);
    } catch (error) {
      props.onError(localizeBackendError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="git-detached" role="status">
      <div className="git-detached-text">
        <strong className="git-detached-title">{t("git.detachedTitle")}</strong>
        <span>
          {t("git.detachedNote", { hash: props.headHash.slice(0, 7) })}
        </span>
      </div>
      {props.previousBranch && (
        <button
          type="button"
          className="git-detached-back"
          disabled={busy}
          onClick={() => void back(props.previousBranch!)}
        >
          {t("git.detachedReturn", { name: props.previousBranch })}
        </button>
      )}
    </div>
  );
}

// Первая отправка ветки на сервер. Показывается вместо ↑/↓, когда сравнивать
// ещё не с чем; после публикации ветка получает upstream и обычные счётчики.
function PublishBranch(props: {
  workspaceId: string;
  branch: string;
  headHash: string;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  // Подтверждение относится к увиденной вершине: сдвинулась — спрашиваем снова.
  useEffect(() => setConfirmed(null), [props.branch, props.headHash]);

  const publish = async () => {
    setBusy(true);
    setConfirmed(null);
    try {
      await publishBranch(props.workspaceId, props.branch, props.headHash);
      void refreshGitChanges(props.workspaceId);
    } catch (error) {
      props.onError(localizeBackendError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="git-sync">
      <button
        type="button"
        className={`git-sync-btn ${confirmed ? "is-confirm" : ""}`}
        title={t("git.branchPublishHint")}
        disabled={busy}
        onClick={() =>
          confirmed === props.headHash
            ? void publish()
            : setConfirmed(props.headHash)
        }
      >
        {confirmed === props.headHash
          ? t("git.branchPublishConfirm")
          : `↑ ${t("git.branchPublish")}`}
      </button>
    </span>
  );
}

// Индикатор расхождения с сервером в шапке: ↓ забрать (ff-only), ↑ отправить.
// Клик разворачивает подтверждение, повторный — выполняет. Без upstream (не с
// чем сравнивать) не показывается; при совпадении — тихая галочка.
function SyncStatus(props: {
  workspaceId: string;
  branch?: string;
  headHash?: string;
  ahead?: number;
  behind?: number;
  // Ветки ещё нет на сервере — можно предложить первую отправку.
  canPublish?: boolean;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const { ahead, behind } = props;
  const [busy, setBusy] = useState(false);
  type SyncSnapshot = {
    action: "pull" | "push";
    branch: string;
    headHash: string;
  };
  const [confirm, setConfirm] = useState<SyncSnapshot | null>(null);
  // Разошедшаяся ветка: ↓ открывает меню (rebase / сброс к серверу).
  const [pullMenu, setPullMenu] = useState(false);
  const [resetConfirm, setResetConfirm] = useState<{
    branch: string;
    headHash: string;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const snapshot = (action: SyncSnapshot["action"]): SyncSnapshot | null =>
    props.branch && props.headHash
      ? { action, branch: props.branch, headHash: props.headHash }
      : null;

  // Подтверждение относится к конкретному состоянию истории. Как только
  // watcher сообщает другую ветку/вершину или другие счётчики, старый клик
  // больше нельзя применить к новому состоянию.
  useEffect(() => {
    setConfirm(null);
    setPullMenu(false);
    setResetConfirm(null);
  }, [props.branch, props.headHash, ahead, behind]);

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
      setResetConfirm(null);
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
    // Upstream ещё нет: сравнивать не с чем, но ветку можно опубликовать.
    return props.canPublish && props.branch && props.headHash ? (
      <PublishBranch
        workspaceId={props.workspaceId}
        branch={props.branch}
        headHash={props.headHash}
        onError={props.onError}
      />
    ) : null;
  }

  // Ветка разошлась: есть и свои коммиты, и серверные — простой ff невозможен.
  const diverged = (ahead ?? 0) > 0 && (behind ?? 0) > 0;

  const run = async (
    action: "pull" | "push" | "rebase" | "reset",
    confirmed: { branch: string; headHash: string } | null,
  ) => {
    if (!confirmed) {
      return;
    }
    setBusy(true);
    setConfirm(null);
    setPullMenu(false);
    setResetConfirm(null);
    try {
      if (action === "pull") {
        await gitPull(
          props.workspaceId,
          confirmed.branch,
          confirmed.headHash,
        );
      } else if (action === "push") {
        await gitPush(
          props.workspaceId,
          confirmed.branch,
          confirmed.headHash,
        );
      } else if (action === "rebase") {
        await gitPullRebase(
          props.workspaceId,
          confirmed.branch,
          confirmed.headHash,
        );
      } else {
        await gitResetToUpstream(
          props.workspaceId,
          confirmed.branch,
          confirmed.headHash,
        );
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
            confirm?.action === "pull" || pullMenu ? "is-confirm" : ""
          }`}
          disabled={busy}
          title={diverged ? t("git.pullDivergedTitle") : t("git.pullTitle")}
          onClick={() => {
            if (diverged) {
              setPullMenu((value) => !value);
              setResetConfirm(null);
            } else if (confirm?.action === "pull") {
              void run("pull", confirm);
            } else {
              setConfirm(snapshot("pull"));
            }
          }}
        >
          {!diverged && confirm?.action === "pull"
            ? t("git.pullConfirm")
            : `↓${behind}`}
        </button>
      )}
      {(ahead ?? 0) > 0 && (
        <button
          type="button"
          className={`git-sync-btn ${
            confirm?.action === "push" ? "is-confirm" : ""
          }`}
          disabled={busy}
          title={t("git.pushTitle")}
          onClick={() =>
            confirm?.action === "push"
              ? void run("push", confirm)
              : setConfirm(snapshot("push"))
          }
        >
          {confirm?.action === "push" ? t("git.pushConfirm") : `↑${ahead}`}
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
            onClick={() =>
              void run(
                "rebase",
                props.branch && props.headHash
                  ? { branch: props.branch, headHash: props.headHash }
                  : null,
              )
            }
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
              resetConfirm
                ? void run("reset", resetConfirm)
                : props.branch && props.headHash
                  ? setResetConfirm({
                      branch: props.branch,
                      headHash: props.headHash,
                    })
                  : undefined
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
// Серверная ссылка определяется бэкендом по refs/remotes (remote может
// называться не только origin) и создаёт локальную tracking-ветку. Тег —
// переход с отделением HEAD. Текущая ветка — некликабельная отметка.
function RefBadge(props: {
  refName: string;
  fullRefName: string;
  kind: GitRefKind;
  currentBranch?: string;
  onSwitch: (name: string, kind: GitRefKind) => void;
}) {
  const { t } = useI18n();
  const isTag = props.kind === "tag";
  const label = props.refName;
  const isRemote = props.kind === "remote";
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
      disabled={isCurrent}
      onClick={(event) => {
        event.stopPropagation();
        if (!isCurrent) {
          props.onSwitch(
            isRemote ? props.fullRefName : label,
            isTag ? "tag" : isRemote ? "remote" : "local",
          );
        }
      }}
    >
      {label}
    </button>
  );
}

// Модальный редактор сообщения коммита: первая строка — заголовок, дальше —
// описание. Сохранение переписывает локальный коммит (бэкенд проверяет
// безопасность). Доступен только для собственных локальных коммитов.
function RewordEditor(props: {
  workspaceId: string;
  commit: GitCommitInfo;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(() => fullCommitMessage(props.commit));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textLength = Array.from(text).length;

  const save = async () => {
    if (!text.trim() || textLength > 4000 || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rewordCommit(props.workspaceId, props.commit.hash, text);
      props.onDone();
      props.onClose();
    } catch (error) {
      setError(localizeBackendError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="git-reword-backdrop">
      <div
        className="git-reword"
        role="dialog"
        aria-modal="true"
        aria-label={t("git.actionReword")}
      >
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
          maxLength={4000}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return;
            }
            if (event.key === "Escape") {
              props.onClose();
            } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void save();
            }
          }}
        />
        <div className="git-reword-hint">{t("git.rewordHint")}</div>
        {error && (
          <div className="git-commit-error" role="alert">
            {error}
          </div>
        )}
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
            disabled={busy || text.trim().length === 0 || textLength > 4000}
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
  onSwitchBranch: (name: string, kind: GitRefKind) => void;
  currentBranch?: string;
  upstreamBranch?: string;
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
          refDetails: commit.refDetails,
          isHead: commit.isHead,
        })),
        {
          currentBranch: props.currentBranch,
          upstreamBranch: props.upstreamBranch ?? null,
        },
      ),
    [props.commits, props.currentBranch, props.upstreamBranch],
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
              {commit.refDetails.map((ref) => (
                <RefBadge
                  key={`${ref.kind}:${ref.name}`}
                  refName={ref.name}
                  fullRefName={ref.fullName}
                  kind={ref.kind}
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
  // Вершина текущей ветки: правка истории подтверждается именно ею.
  headHash?: string;
  upstreamBranch?: string;
}) {
  const { locale, t } = useI18n();
  const [commits, setCommits] = useState<GitCommitInfo[] | null>(null);
  const [graphMode, setGraphMode] = useState(true);
  // «Все ветки»: включает локальные и серверные ветки (без stash/tag-only
  // служебных историй), граф становится насыщенным, как в редакторах.
  const [allBranches, setAllBranches] = useState(false);
  // Поиск по истории: поле ввода и то, что именно ищем.
  const [searchField, setSearchField] = useState<"text" | "author" | "path">(
    "text",
  );
  const [marked, setMarked] = useState<GitCommitInfo | null>(null);
  const [comparing, setComparing] = useState<{
    from: GitCommitInfo;
    to: GitCommitInfo | null;
  } | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    // Печатать быстрее, чем git успевает отвечать, — обычное дело.
    const timer = window.setTimeout(() => setSearch(searchDraft.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);
  const filtering = search.length > 0;
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
  const logRequestRef = useRef(0);
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
      const request = ++logRequestRef.current;
      fetchLog(
        props.workspaceId,
        limit,
        allBranches,
        filtering ? { [searchField]: search } : undefined,
      )
        .then((log) => {
          if (!cancelled && logRequestRef.current === request) {
            setCommits(log);
            setLoadingMore(false);
          }
        })
        .catch(() => {
          if (!cancelled && logRequestRef.current === request) {
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
      logRequestRef.current += 1;
      unsubscribe();
    };
  }, [
    props.workspaceId,
    limit,
    allBranches,
    reloadNonce,
    filtering,
    searchField,
    search,
  ]);

  // Незакоммиченные изменения показываем узлом только в обычном виде: в режиме
  // «все ветки» верхний коммит — не обязательно HEAD, поводок был бы обманчив.
  const workingTreeCount = allBranches || filtering ? 0 : props.fileCount;
  const showGraph = graphMode && !filtering;

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
  const switchTo = async (name: string, kind: GitRefKind) => {
    try {
      await switchBranch(props.workspaceId, name, kind);
      void refreshGitChanges(props.workspaceId);
      setReloadNonce((value) => value + 1);
    } catch (error) {
      setActionError(localizeBackendError(error));
    }
  };

  if (commits === null) {
    return <div className="git-empty">{t("git.loading")}</div>;
  }
  // При активном фильтре пустой результат не должен прятать саму строку
  // поиска — иначе запрос стало бы нечем очистить.
  if (commits.length === 0 && !filtering) {
    return <div className="git-empty">{t("git.historyEmpty")}</div>;
  }
  return (
    <div className="git-history">
      <div className="git-history-bar">
        <div className="git-history-modes" role="group">
          <button
            type="button"
            className={`git-mode ${showGraph ? "is-active" : ""}`}
            aria-pressed={showGraph}
            disabled={filtering}
            title={filtering ? t("git.graphNeedsNoFilter") : undefined}
            onClick={() => setGraphMode(true)}
          >
            {t("git.viewGraph")}
          </button>
          <button
            type="button"
            className={`git-mode ${!showGraph ? "is-active" : ""}`}
            aria-pressed={!showGraph}
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
      <div className="git-history-search">
        <select
          className="git-search-field"
          aria-label={t("git.searchField")}
          value={searchField}
          onChange={(event) =>
            setSearchField(event.target.value as typeof searchField)
          }
        >
          <option value="text">{t("git.searchByText")}</option>
          <option value="author">{t("git.searchByAuthor")}</option>
          <option value="path">{t("git.searchByPath")}</option>
        </select>
        <input
          type="search"
          className="git-search-input"
          aria-label={t("git.searchPlaceholder")}
          placeholder={t("git.searchPlaceholder")}
          value={searchDraft}
          spellCheck={false}
          onChange={(event) => {
            setLimit(100);
            setSearchDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setSearchDraft("");
            }
          }}
        />
      </div>
      {actionError && (
        <div className="git-commit-error" role="alert">
          {actionError}
        </div>
      )}
      {/* key по режиму перемонтирует контент — короткая анимация появления
          при переключении «Граф ⇄ Список» в обе стороны. */}
      <div key={showGraph ? "graph" : "list"} className="git-history-swap">
      {commits.length === 0 ? (
        <div className="git-empty">{t("git.searchEmpty")}</div>
      ) : showGraph ? (
        <CommitGraph
          commits={commits}
          workspaceId={props.workspaceId}
          selectedHash={expandedHash}
          onSelect={(commit) =>
            setExpandedHash(expandedHash === commit.hash ? null : commit.hash)
          }
          detailsPresence={detailsPresence}
          onMenu={openMenu}
          onSwitchBranch={(name, kind) => void switchTo(name, kind)}
          currentBranch={props.currentBranch}
          upstreamBranch={props.upstreamBranch}
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
              {commit.refDetails.map((ref) => (
                <RefBadge
                  key={`${ref.kind}:${ref.name}`}
                  refName={ref.name}
                  fullRefName={ref.fullName}
                  kind={ref.kind}
                  currentBranch={props.currentBranch}
                  onSwitch={(name, kind) => void switchTo(name, kind)}
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
          currentBranch={props.currentBranch}
          headHash={props.headHash}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onError={setActionError}
          onDone={() => setReloadNonce((value) => value + 1)}
          onReword={setRewording}
          marked={marked}
          onMark={setMarked}
          onCompare={(from, to) => setComparing({ from, to })}
        />
      )}
      {comparing && (
        <CompareView
          workspaceId={props.workspaceId}
          from={comparing.from}
          to={comparing.to}
          onClose={() => setComparing(null)}
        />
      )}
      {rewording && (
        <RewordEditor
          workspaceId={props.workspaceId}
          commit={rewording}
          onClose={() => setRewording(null)}
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

type GitPanelView = "changes" | "history";
type CommitDraft = { subject: string; description: string };

function joinCommitMessage(subject: string, description: string): string {
  const title = subject.trim();
  const body = description.trim();
  return title && body ? `${title}\n\n${body}` : title;
}

// Вкладку и черновики сохраняем при переходе между проектами, а остальное
// workspace-зависимое состояние перемонтируем по key. Так старые файлы, меню
// и выбранные коммиты не попадают в новый проект даже на один кадр.
export function GitChangesView(props: { workspaceId: string }) {
  const [view, setView] = useState<GitPanelView>("changes");
  const [drafts, setDrafts] = useState<Record<string, CommitDraft>>({});
  const draft = drafts[props.workspaceId] ?? { subject: "", description: "" };
  return (
    <GitChangesWorkspaceView
      key={props.workspaceId}
      workspaceId={props.workspaceId}
      view={view}
      onSelectView={setView}
      draft={draft}
      onDraftChange={(next) =>
        setDrafts((current) => ({ ...current, [props.workspaceId]: next }))
      }
    />
  );
}

// Содержимое одного проекта; живёт в оверлее-drawer поверх терминалов.
function GitChangesWorkspaceView(props: {
  workspaceId: string;
  view: GitPanelView;
  onSelectView: (view: GitPanelView) => void;
  draft: CommitDraft;
  onDraftChange: (draft: CommitDraft) => void;
}) {
  const { t } = useI18n();
  const { workspaceId, view } = props;
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
  const commitSubject = props.draft.subject;
  const commitDescription = props.draft.description;
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const commitMessage = joinCommitMessage(commitSubject, commitDescription);
  const commitMessageLength = Array.from(commitMessage).length;
  const updateCommitText = (
    nextSubject: string,
    nextDescription: string,
  ) => {
    if (
      Array.from(joinCommitMessage(nextSubject, nextDescription)).length <=
      4000
    ) {
      props.onDraftChange({
        subject: nextSubject,
        description: nextDescription,
      });
    }
  };
  const commit = async () => {
    if (!commitMessage || commitMessageLength > 4000 || committing) {
      return;
    }
    setCommitting(true);
    setCommitError(null);
    try {
      await commitAll(workspaceId, commitMessage);
      props.onDraftChange({ subject: "", description: "" });
      void refreshGitChanges(workspaceId);
    } catch (error) {
      setCommitError(localizeBackendError(error));
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="git-changes-panel git-project-transition">
      {summary === null ? (
        <div className="git-empty">{t("git.loading")}</div>
      ) : summary.gitMissing ? (
        <div className="git-empty">{t("error.gitUnavailable")}</div>
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
                    props.onSelectView(tab);
                  }}
                >
                  {t(tab === "changes" ? "git.tabChanges" : "git.tabHistory")}
                </button>
              ))}
            </div>
            <div className="git-toolbar-right">
              <SyncStatus
                workspaceId={workspaceId}
                branch={summary.branch}
                headHash={summary.headHash}
                ahead={summary.ahead}
                behind={summary.behind}
                canPublish={summary.upstreamRef === undefined}
                onError={setBranchError}
              />
              <BranchSwitcher
                workspaceId={workspaceId}
                currentBranch={summary.branch}
                headHash={summary.headHash}
                onError={setBranchError}
              />
            </div>
          </div>
          {branchError && (
            <div className="git-commit-error" role="alert">
              {branchError}
            </div>
          )}
          {summary.branch === undefined && summary.headHash && (
            <DetachedHeadBanner
              workspaceId={workspaceId}
              headHash={summary.headHash}
              previousBranch={summary.previousBranch}
              onError={setBranchError}
            />
          )}
          {/* key по вкладке перемонтирует контент — короткий въезд при
              переключении «Изменения ⇄ История». */}
          <div key={view} className="git-view">
          {view === "history" ? (
            <HistoryView
              workspaceId={workspaceId}
              fileCount={summary.files.length}
              onOpenChanges={() => props.onSelectView("changes")}
              currentBranch={summary.branch}
              headHash={summary.headHash}
              upstreamBranch={summary.upstreamRef}
            />
          ) : summary.files.length === 0 ? (
            <div className="git-empty">{t("git.clean")}</div>
          ) : (
            <>
              <div className="git-commit-row">
                <div className="git-commit-fields">
                  <input
                    type="text"
                    className="git-commit-input"
                    aria-label={t("git.commitPlaceholder")}
                    placeholder={t("git.commitPlaceholder")}
                    value={commitSubject}
                    maxLength={4000}
                    disabled={committing}
                    onChange={(event) =>
                      updateCommitText(event.target.value, commitDescription)
                    }
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) {
                        return;
                      }
                      if (event.key === "Enter") {
                        void commit();
                      }
                    }}
                  />
                  <textarea
                    className="git-commit-input git-commit-description"
                    aria-label={t("git.commitDescription")}
                    placeholder={t("git.commitDescription")}
                    value={commitDescription}
                    maxLength={4000}
                    rows={2}
                    disabled={committing}
                    onChange={(event) =>
                      updateCommitText(commitSubject, event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) {
                        return;
                      }
                      if (
                        event.key === "Enter" &&
                        (event.metaKey || event.ctrlKey)
                      ) {
                        event.preventDefault();
                        void commit();
                      }
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="git-commit-button"
                  title={t("git.commitShortcut")}
                  disabled={committing || commitMessage.length === 0}
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
