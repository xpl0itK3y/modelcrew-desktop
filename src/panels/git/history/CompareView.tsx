// Сравнение двух состояний — коммит с коммитом или коммит с рабочей папкой —
// и редактор сообщения коммита. Сравнение только читает: править файлы
// историческим diff-ом было бы неоднозначно, а редактор меняет уже записанное.

import { useEffect, useState } from "react";
import { localizeBackendError, useI18n } from "../../../i18n";
import { type GitFileDiff } from "../../../git/gitChanges";
import { type GitCommitFile, type GitCommitInfo } from "../../../git/gitLog";
import { compareFileDiff, compareFiles, rewordCommit } from "../../../git/gitHistory";
import {
  DiffBody,
  DiffViewToggle,
  loadDiffView,
  saveDiffView,
  type DiffView,
} from "../DiffView";
import { fullCommitMessage } from "./CommitActionsMenu";

export function CompareView(props: {
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

export function RewordEditor(props: {
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
