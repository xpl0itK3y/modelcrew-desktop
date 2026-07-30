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
import { localizeBackendError, useI18n } from "../../i18n";
import {
  amendCommit,
  authorAvatar,
  commitAction,
  formatRelativeTime,
  switchBranch,
  commitFileDiff,
  commitPatch,
  compareFileDiff,
  compareFiles,
  createTag,
  deleteTag,
  dropCommit,
  fetchCommitFiles,
  fetchLog,
  githubCommitUrl,
  refreshGitChanges,
  resetToCommit,
  resolveAvatarUrl,
  rewordCommit,
  saveCommitPatch,
  squashCommit,
  subscribeGitChanges,
  type CommitAction,
  type GitCommitFile,
  type GitCommitInfo,
  type GitFileDiff,
  type GitRefKind,
  type GitResetMode,
} from "../../git/gitChanges";
import { openUrl } from "@tauri-apps/plugin-opener";
import { computeCommitGraph } from "../../git/commitGraph";
import {
  DiffBody,
  DiffViewToggle,
  loadDiffView,
  saveDiffView,
  type DiffView,
} from "./DiffView";
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
} from "../../git/graphGeometry";
import {
  githubAvatarForEmail,
  subscribeGithubAvatars,
} from "../../git/githubAvatars";
import { isGithubSignedIn, subscribeGithubAuth } from "../../github/authState";
import { loadNetworkAvatars } from "../../terminal/preferences";
import { useAnimatedPresence } from "../../ui/useAnimatedPresence";

// История коммитов: список и граф, раскрытая карточка коммита, меню действий
// над коммитом, сравнение двух состояний и редактор сообщения.
//
// Вертикаль отделена от списка изменений и от показа diff-а: здесь всё про
// прошлое репозитория, и почти каждое действие переписывает историю, поэтому
// сначала спрашивает подтверждение.

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

// соседние карточки съезжают, а не скачут.
function RevealHeight(props: { closing: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className={`git-reveal ${open && !props.closing ? "is-open" : ""}`}>
      <div className="git-reveal-inner">{props.children}</div>
    </div>
  );
}

// Раскрытая карточка коммита: описание, точная дата, соавторы и файлы.

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
    <div className={`git-commit-details ${props.closing ? "is-closing" : ""}`}>
      {commit.body && <pre className="git-commit-body">{commit.body}</pre>}
      <div className="git-commit-person">
        <span className="git-commit-person-label">{t("git.commitDate")}</span>
        {exactDate}
      </div>
      {(commit.coAuthors ?? []).map((coAuthor) => {
        // Соавтор в виде «Имя <почта>»: имя — для инициалов, почта — для авы.
        const emailMatch = coAuthor.match(/<([^>]+)>\s*$/);
        const name = coAuthor.replace(/\s*<[^>]*>\s*$/, "").trim() || coAuthor;
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
                    <span className="git-count-add">
                      +{file.additions ?? 0}
                    </span>
                    <span className="git-count-del">
                      −{file.deletions ?? 0}
                    </span>
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
        await commitAction(
          props.workspaceId,
          action as CommitAction,
          hash,
          name,
        );
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
              <div className="git-actions-label">
                {t("git.actionResetHere")}
              </div>
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
            } else if (
              (event.metaKey || event.ctrlKey) &&
              event.key === "Enter"
            ) {
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

export function HistoryView(props: {
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
                    arrivedHashesRef.current.has(commit.hash)
                      ? "is-arriving"
                      : ""
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
                      <AuthorAvatar
                        name={commit.author}
                        email={commit.authorEmail}
                      />
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
