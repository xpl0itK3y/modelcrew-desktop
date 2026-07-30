import { useEffect, useRef, useState } from "react";
import { localizeBackendError, useI18n } from "../../i18n";
import {
  createBranch,
  deleteBranch,
  fetchBranches,
  gitPull,
  gitPullRebase,
  gitPush,
  gitResetToUpstream,
  mergeRef,
  publishBranch,
  rebaseOnto,
  refreshGitChanges,
  renameBranch,
  switchBranch,
  formatRelativeTime,
  type GitBranchInfo,
} from "../../git/gitChanges";
import { ConfirmDialog } from "../../ui/ConfirmDialog";

// Ветки и синхронизация с сервером: переключатель веток, публикация,
// состояние «впереди/позади», отметка ссылки и предупреждение об отделённом
// HEAD. Вертикаль отделена от истории и diff-а: здесь все действия меняют
// состояние репозитория, а не просто показывают его.

// Выпадающий переключатель веток: список отсортирован по свежести коммитов.
export function BranchSwitcher(props: {
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

// без явной подсказки состояние легко не заметить и потерять коммиты.
export function DetachedHeadBanner(props: {
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
export function PublishBranch(props: {
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
export function SyncStatus(props: {
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
