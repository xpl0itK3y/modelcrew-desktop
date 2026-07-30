import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IDockviewPanelProps } from "dockview";
import { localizeBackendError, useI18n } from "../i18n";
import {
  commitAll,
  fetchFileDiff,
  getGitSummary,
  parseUnifiedDiff,
  readRepoFile,
  refreshGitChanges,
  revertFile,
  subscribeGitChanges,
  writeRepoFile,
  type GitChangedFile,
  type GitChangesSummary,
  type GitFileDiff,
} from "../git/gitChanges";
import { CopyIcon, UndoIcon } from "../ui/Icons";
import {
  BranchSwitcher,
  DetachedHeadBanner,
  SyncStatus,
} from "./git/BranchBar";
import { HistoryView } from "./git/HistoryView";
import {
  loadGithubCommitAvatars,
} from "../git/githubAvatars";

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
            {/* Работа с гитом ещё обкатывается — честно предупреждаем. */}
            <span className="beta-badge" title={t("git.betaHint")}>
              {t("common.beta")}
            </span>
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
