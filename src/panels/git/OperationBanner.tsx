// Незавершённые слияние, перенос, cherry-pick и откат. Приложение само умеет
// оставить репозиторий в этом состоянии — «Забрать с rebase» делает это
// намеренно, — а рассказать о нём было некому: статус «Конфликт» стоял у
// отдельных файлов, и по нему нельзя было понять ни что идёт, ни как выйти.

import { useState } from "react";
import { describeBackendError, useI18n, type BackendFailure, type MessageKey } from "../../i18n";
import {
  abortOperation,
  continueOperation,
  refreshGitChanges,
  type GitOperation,
} from "../../git/gitChanges";
import { ConfirmDialog } from "../../ui/ConfirmDialog";

const OPERATION_TITLE: Record<GitOperation, MessageKey> = {
  merge: "git.operationMerge",
  rebase: "git.operationRebase",
  cherryPick: "git.operationCherryPick",
  revert: "git.operationRevert",
};

export function OperationBanner(props: {
  workspaceId: string;
  operation: GitOperation;
  // Сколько файлов git всё ещё считает несведёнными.
  conflicts: number;
  onError: (failure: BackendFailure) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [aborting, setAborting] = useState(false);

  const run = async (action: "continue" | "abort") => {
    setBusy(true);
    try {
      if (action === "abort") {
        await abortOperation(props.workspaceId);
      } else {
        await continueOperation(props.workspaceId);
      }
      setAborting(false);
      void refreshGitChanges(props.workspaceId);
    } catch (error) {
      setAborting(false);
      props.onError(describeBackendError(error));
    } finally {
      setBusy(false);
    }
  };

  // У слияния своя кнопка продолжения не нужна: его завершает обычный коммит,
  // а у того есть и поле сообщения, и правильный автор.
  const canContinue = props.operation !== "merge";

  return (
    <>
      <div className="git-operation" role="status">
        <div className="git-operation-text">
          <strong className="git-operation-title">
            {t(OPERATION_TITLE[props.operation])}
          </strong>
          <span>
            {props.conflicts > 0
              ? t("git.operationConflicts", { count: String(props.conflicts) })
              : canContinue
                ? t("git.operationReady")
                : t("git.operationCommitHint")}
          </span>
        </div>
        <div className="git-operation-actions">
          {canContinue && (
            // Кнопка живая и при неразведённых конфликтах: «конфликт» в
            // статусе файла держится до индексации, а маркеры из текста могли
            // уже убрать. Отказывает бэкенд, и он же говорит, в каком файле.
            <button
              type="button"
              className="git-operation-go"
              disabled={busy}
              onClick={() => void run("continue")}
            >
              {t("git.operationContinue")}
            </button>
          )}
          <button
            type="button"
            className="git-operation-drop"
            disabled={busy}
            onClick={() => setAborting(true)}
          >
            {t("git.operationAbort")}
          </button>
        </div>
      </div>
      {aborting && (
        <ConfirmDialog
          text={t("git.operationAbortConfirm")}
          confirmLabel={t("git.operationAbort")}
          busy={busy}
          onConfirm={() => void run("abort")}
          onCancel={() => setAborting(false)}
        />
      )}
    </>
  );
}
