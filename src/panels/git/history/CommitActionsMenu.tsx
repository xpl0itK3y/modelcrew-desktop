// Плавающее меню действий над коммитом: копирование, ветка отсюда, checkout,
// revert и безопасная отмена последнего локального коммита. Открывается по ⋯
// или правому клику.
//
// Почти каждое действие переписывает историю, поэтому идёт через подтверждение
// с текстом о последствиях, а недоступные для запушенного или для отделённого
// HEAD не показываются вовсе.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { describeBackendError, useI18n, type BackendFailure } from "../../../i18n";
import { refreshGitChanges } from "../../../git/gitChanges";
import { githubCommitUrl, type GitCommitInfo } from "../../../git/gitLog";
import { commitAction, deleteTag, dropCommit, type CommitAction } from "../../../git/gitHistory";

export function fullCommitMessage(commit: GitCommitInfo): string {
  return commit.fullMessage;
}

// Предупреждение об отделённом HEAD. Из списка веток вернуться можно и так, но

type CommitMenuAction =
  | Exclude<CommitAction, "branch" | "cherryPick">
  | "drop";

const CONFIRM_TEXT = {
  checkout: "git.actionCheckoutConfirm",
  revert: "git.actionRevertConfirm",
  uncommit: "git.actionUncommitConfirm",
  drop: "git.actionDropConfirm",
} as const;

export function CommitActionsMenu(props: {
  workspaceId: string;
  commit: GitCommitInfo;
  currentBranch?: string;
  // Вершина ветки на момент отрисовки: уходит в бэкенд как подтверждение.
  headHash?: string;
  x: number;
  y: number;
  onClose: () => void;
  onError: (failure: BackendFailure) => void;
  onDone: () => void;
  onReword: (commit: GitCommitInfo) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  // GitHub-авторизация здесь не нужна: бэкенд сверяет автора с локальным
  // `git config user.email` и разрешает переписывать только локальную историю.
  //
  // Про localOnly сказано ещё раз и здесь, хотя бэкенд уже вложил его в
  // editable: правка и удаление коммита меняют хеш, а у ушедшего на сервер
  // коммита это ломает историю всем, кто его уже забрал. Такое правило лучше
  // видеть на месте, чем угадывать по флагу с другим именем.
  const isLocal = props.commit.localOnly === true;
  const canReword = props.commit.editable && isLocal;
  const onBranch = Boolean(props.currentBranch) && Boolean(props.headHash);
  const canUncommit =
    onBranch &&
    props.commit.isHead &&
    isLocal &&
    props.commit.parents.length === 1;
  // Переписывать историю можно только там, где это уже разрешил бэкенд:
  // непрерывный локальный first-parent суффикс собственных коммитов.
  const canRewrite = onBranch && canReword && props.commit.parents.length === 1;
  // Черта отделяет одну группу пунктов от другой, а не висит сама по себе. У
  // отправленного и у чужого коммита правки истории нет вовсе, и без этой
  // проверки две черты вставали подряд — читалось как пустая строка меню.
  const canRewriteHistory = canReword || canRewrite;
  const isMerge = props.commit.parents.length > 1;
  const [confirm, setConfirm] = useState<null | CommitMenuAction>(null);
  // Имя новой ветки вводят прямо в меню, не открывая отдельного окна.
  const [naming, setNaming] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const [copied, setCopied] = useState<null | "hash" | "message">(null);
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
    action: CommitMenuAction | "branch" | "deleteTag",
    name?: string,
  ) => {
    setBusy(true);
    const hash = props.commit.hash;
    const head = props.headHash ?? "";
    try {
      if (action === "drop") {
        await dropCommit(props.workspaceId, hash, head);
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
      props.onError(describeBackendError(error));
      props.onClose();
    } finally {
      setBusy(false);
    }
  };

  const copy = async (kind: "hash" | "message") => {
    try {
      const text =
        kind === "hash" ? props.commit.hash : fullCommitMessage(props.commit);
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => props.onClose(), 650);
    } catch (error) {
      props.onError(describeBackendError(error));
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
        props.onError({ message: t("git.actionOpenGithubMissing") });
      }
    } catch (error) {
      props.onError(describeBackendError(error));
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
            aria-label={t("git.actionBranchName")}
            placeholder={t("git.actionBranchName")}
            value={nameValue}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setNameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return;
              }
              if (event.key === "Enter" && nameValue.trim()) {
                void run("branch", nameValue.trim());
              } else if (event.key === "Escape") {
                setNaming(false);
              }
            }}
          />
          <button
            type="button"
            className="git-actions-go"
            disabled={busy || !nameValue.trim()}
            onClick={() => void run("branch", nameValue.trim())}
          >
            {t("git.actionBranchCreate")}
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
          {/* Ссылка на GitHub есть только у коммита, который там есть: у
              локального она вела бы на страницу «commit not found». */}
          {!isLocal && (
            <button
              type="button"
              role="menuitem"
              className="git-actions-item"
              disabled={busy}
              onClick={() => void openOnGithub()}
            >
              {t("git.actionOpenGithub")}
            </button>
          )}
          {canRewriteHistory && (
            <div className="git-actions-sep" aria-hidden="true" />
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
          <div className="git-actions-sep" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            className="git-actions-item"
            disabled={busy}
            onClick={() => {
              setNaming(true);
              setNameValue("");
            }}
          >
            {t("git.actionBranch")}
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
        </>
      )}
    </div>
  );
}
