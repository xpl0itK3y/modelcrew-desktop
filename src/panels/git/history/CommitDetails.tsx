// Раскрытая карточка коммита: файлы хода и diff по выбранному файлу.
// RevealHeight здесь же — раскрытие с плавной высотой нужно и графу, и
// оболочке истории, а живёт оно вместе с тем, что раскрывает.

import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../../../i18n";
import { type GitFileDiff } from "../../../git/gitChanges";
import { commitFileDiff, fetchCommitFiles, type GitCommitFile, type GitCommitInfo } from "../../../git/gitLog";
import {
  DiffBody,
  DiffViewToggle,
  loadDiffView,
  saveDiffView,
  type DiffView,
} from "../DiffView";
import { AuthorAvatar } from "./AuthorAvatar";

// Раскрытие с плавной высотой: карточка растёт и сворачивается за один кадр,
// поэтому соседние карточки съезжают, а не скачут.
export function RevealHeight(props: { closing: boolean; children: ReactNode }) {
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

export function CommitDetails(props: {
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
