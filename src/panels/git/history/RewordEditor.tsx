// Редактор сообщения коммита. Меняет уже записанное, поэтому открывается
// отдельным окном поверх истории, а не правкой строки на месте.

import { useState } from "react";
import { localizeBackendError, useI18n } from "../../../i18n";
import { type GitCommitInfo } from "../../../git/gitLog";
import { rewordCommit } from "../../../git/gitHistory";
import { fullCommitMessage } from "./CommitActionsMenu";

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
