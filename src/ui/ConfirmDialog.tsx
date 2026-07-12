import { useEffect, useId, useRef } from "react";
import { useI18n } from "../i18n";

type ConfirmDialogProps = {
  text: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog(props: ConfirmDialogProps) {
  const { t } = useI18n();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const textId = useId();

  useEffect(() => {
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        props.onCancel();
      } else if (event.key === "Enter") {
        event.preventDefault();
        props.onConfirm();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [props]);

  return (
    <div className="dialog-backdrop" onClick={props.onCancel}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={textId}
        onClick={(event) => event.stopPropagation()}
      >
        <p id={textId} className="dialog-text">
          {props.text}
        </p>
        <div className="dialog-actions">
          <button type="button" className="dialog-button" onClick={props.onCancel}>
            {t("common.cancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="dialog-button is-danger"
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
