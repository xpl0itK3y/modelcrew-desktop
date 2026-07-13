import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { CloseIcon } from "../ui/Icons";
import type { UpdateState } from "./types";

type UpdatePopoverProps = {
  state: UpdateState;
  onCheck: () => void;
  onInstall: () => void;
  onOpenRelease: () => void;
  onClose: () => void;
};

function formatBytes(bytes: number, locale: string): string {
  if (bytes <= 0) {
    return "0 MB";
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    bytes / (1024 * 1024),
  )} MB`;
}

export const UpdatePopover = forwardRef<HTMLDivElement, UpdatePopoverProps>(
  function UpdatePopover(props, ref) {
    const { locale, t } = useI18n();
    const [confirmingInstall, setConfirmingInstall] = useState(false);
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const confirmationCancelRef = useRef<HTMLButtonElement | null>(null);

    const setDialogRef = useCallback(
      (node: HTMLDivElement | null) => {
        dialogRef.current = node;
        if (typeof ref === "function") {
          ref(node);
        } else if (ref) {
          ref.current = node;
        }
      },
      [ref],
    );

    useEffect(() => {
      if (props.state.status !== "ready") {
        setConfirmingInstall(false);
      }
    }, [props.state.status]);

    useEffect(() => {
      const focusTimer = window.requestAnimationFrame(() => {
        if (confirmingInstall) {
          confirmationCancelRef.current?.focus();
        } else {
          dialogRef.current?.focus();
        }
      });
      return () => window.cancelAnimationFrame(focusTimer);
    }, [confirmingInstall, props.state.status]);

    const errorText =
      props.state.status === "error"
        ? props.state.stage === "check"
          ? t("update.errorCheck")
          : props.state.stage === "download"
            ? t("update.errorDownload")
            : t("update.errorInstall")
        : "";

    return (
      <div
        ref={setDialogRef}
        className="update-popover"
        data-tauri-drag-region="false"
        role="dialog"
        aria-modal="false"
        aria-labelledby="update-popover-title"
        tabIndex={-1}
      >
        <div className="update-popover-header">
          <span className="update-popover-eyebrow">MODELCREW</span>
          <button
            type="button"
            className="icon-button update-popover-close"
            aria-label={t("update.close")}
            title={t("update.close")}
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="update-popover-content">
          {props.state.status === "idle" && (
            <>
              <h2 id="update-popover-title">{t("update.title")}</h2>
              <p>{t("update.idleDescription")}</p>
              <button
                type="button"
                className="update-action update-action-primary"
                onClick={props.onCheck}
              >
                {t("update.checkNow")}
              </button>
            </>
          )}

          {props.state.status === "checking" && (
            <div className="update-status-block">
              <span className="update-spinner" aria-hidden="true" />
              <div>
                <h2 id="update-popover-title">{t("update.title")}</h2>
                <p>{t("update.checking")}</p>
              </div>
            </div>
          )}

          {props.state.status === "upToDate" && (
            <>
              <h2 id="update-popover-title">{t("update.upToDate")}</h2>
              <p>{t("update.upToDateDescription")}</p>
              <button
                type="button"
                className="update-action update-action-secondary"
                onClick={props.onCheck}
              >
                {t("update.checkAgain")}
              </button>
            </>
          )}

          {props.state.status === "downloading" && (
            <>
              <h2 id="update-popover-title">
                {t("update.downloading", { version: props.state.version })}
              </h2>
              <p>{t("update.downloadingDescription")}</p>
              <div
                className={`update-progress-track ${
                  props.state.total ? "" : "is-indeterminate"
                }`}
                role="progressbar"
                aria-label={t("update.downloadProgress")}
                {...(props.state.total
                  ? {
                      "aria-valuemin": 0,
                      "aria-valuemax": props.state.total,
                      "aria-valuenow": Math.min(
                        props.state.downloaded,
                        props.state.total,
                      ),
                    }
                  : {})}
              >
                <span
                  style={
                    props.state.total
                      ? {
                          width: `${Math.min(
                            100,
                            (props.state.downloaded / props.state.total) * 100,
                          )}%`,
                        }
                      : undefined
                  }
                />
              </div>
              <div className="update-progress-copy">
                {props.state.total
                  ? t("update.downloadedOf", {
                      downloaded: formatBytes(props.state.downloaded, locale),
                      total: formatBytes(props.state.total, locale),
                    })
                  : t("update.downloaded", {
                      downloaded: formatBytes(props.state.downloaded, locale),
                    })}
              </div>
            </>
          )}

          {(props.state.status === "ready" ||
            props.state.status === "packageManaged") && (
            <>
              <span className="update-version">
                {t("update.version", { version: props.state.version })}
              </span>
              <h2 id="update-popover-title">{props.state.title}</h2>
              <p>{props.state.summary}</p>
              {props.state.highlights.length > 0 && (
                <ul className="update-highlights">
                  {props.state.highlights.map((highlight, index) => (
                    <li key={`${index}-${highlight}`}>{highlight}</li>
                  ))}
                </ul>
              )}

              {props.state.status === "packageManaged" ? (
                <>
                  <p className="update-package-note">
                    {t("update.packageManagedHelp")}
                  </p>
                  <div className="update-actions">
                    <button
                      type="button"
                      className="update-action update-action-secondary"
                      onClick={props.onClose}
                    >
                      {t("update.later")}
                    </button>
                    <button
                      type="button"
                      className="update-action update-action-primary"
                      onClick={props.onOpenRelease}
                    >
                      {t("update.openDownloads")}
                    </button>
                  </div>
                </>
              ) : confirmingInstall ? (
                <div className="update-confirmation">
                  <strong>{t("update.confirmTitle")}</strong>
                  <p>{t("update.confirmWarning")}</p>
                  <div className="update-actions">
                    <button
                      ref={confirmationCancelRef}
                      type="button"
                      className="update-action update-action-secondary"
                      onClick={() => setConfirmingInstall(false)}
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      type="button"
                      className="update-action update-action-primary"
                      onClick={props.onInstall}
                    >
                      {t("update.confirmRestart")}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="update-actions update-actions-links">
                    <button
                      type="button"
                      className="update-action update-action-link"
                      onClick={props.onOpenRelease}
                    >
                      {t("update.details")}
                    </button>
                    <button
                      type="button"
                      className="update-action update-action-link"
                      onClick={props.onClose}
                    >
                      {t("update.later")}
                    </button>
                  </div>
                  <button
                    type="button"
                    className="update-action update-action-primary update-action-full"
                    onClick={() => setConfirmingInstall(true)}
                  >
                    {t("update.restartAndInstall")}
                  </button>
                </>
              )}
            </>
          )}

          {props.state.status === "installing" && (
            <div className="update-status-block">
              <span className="update-spinner" aria-hidden="true" />
              <div>
                <h2 id="update-popover-title">
                  {t("update.installing", { version: props.state.version })}
                </h2>
                <p>{t("update.installingDescription")}</p>
              </div>
            </div>
          )}

          {props.state.status === "error" && (
            <>
              <h2 id="update-popover-title">{t("update.errorTitle")}</h2>
              <p>{errorText}</p>
              <p className="update-error-detail" title={props.state.message}>
                {props.state.message}
              </p>
              <button
                type="button"
                className="update-action update-action-secondary"
                onClick={props.onCheck}
              >
                {t("update.retry")}
              </button>
            </>
          )}
        </div>
      </div>
    );
  },
);
