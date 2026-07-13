import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { BellIcon, CloseIcon } from "../ui/Icons";
import type { AppUpdaterController, UpdateNotification } from "./types";

type NotificationCenterState = AppUpdaterController["center"];

type UpdatePopoverProps = {
  center: NotificationCenterState;
  onInstall: () => void;
  onOpenRelease: () => void;
  onClose: () => void;
};

function formatBytes(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 MB";
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    bytes / (1024 * 1024),
  )} MB`;
}

function itemTitle(item: UpdateNotification, fallback: string): string {
  return item.title.trim() || fallback;
}

export const UpdatePopover = forwardRef<HTMLDivElement, UpdatePopoverProps>(
  function UpdatePopover(props, ref) {
    const { locale, t } = useI18n();
    const [confirmingInstall, setConfirmingInstall] = useState<string | null>(
      null,
    );
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

    const confirmingItem = confirmingInstall
      ? props.center.items.find(
          (item): item is UpdateNotification =>
            item.kind === "update" && item.id === confirmingInstall,
        )
      : undefined;

    useEffect(() => {
      if (confirmingInstall && confirmingItem?.phase !== "ready") {
        setConfirmingInstall(null);
      }
    }, [confirmingInstall, confirmingItem?.phase]);

    useEffect(() => {
      const focusTimer = window.requestAnimationFrame(() => {
        if (confirmingInstall) {
          confirmationCancelRef.current?.focus();
        } else {
          dialogRef.current?.focus();
        }
      });
      return () => window.cancelAnimationFrame(focusTimer);
    }, [confirmingInstall]);

    const showInitialLoading =
      props.center.items.length === 0 && props.center.sync === "initial";

    return (
      <div
        id="notification-center"
        ref={setDialogRef}
        className="update-popover"
        data-tauri-drag-region="false"
        role="dialog"
        aria-modal="false"
        aria-labelledby="notification-center-title"
        tabIndex={-1}
      >
        <div className="update-popover-header">
          <div className="update-popover-title-row">
            <h2 id="notification-center-title" className="update-popover-title">
              {t("update.notificationsTitle")}
            </h2>
            {props.center.sync === "checking" && !showInitialLoading && (
              <span
                className="update-header-sync"
                title={t("update.refreshingNotifications")}
                aria-hidden="true"
              >
                <span className="update-header-spinner" />
              </span>
            )}
          </div>
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
          {showInitialLoading ? (
            <div className="update-empty-state" role="status" aria-live="polite">
              <span className="update-spinner" aria-hidden="true" />
              <span className="update-empty-title">
                {t("update.refreshingNotifications")}
              </span>
            </div>
          ) : props.center.items.length === 0 ? (
            <div className="update-empty-state" role="status">
              <span className="update-empty-icon" aria-hidden="true">
                <BellIcon />
              </span>
              <span className="update-empty-title">{t("update.empty")}</span>
            </div>
          ) : (
            <div className="update-notification-list">
              {props.center.items.map((item, index) => {
                const titleId = `update-notification-${index}-title`;
                if (item.kind === "announcement") {
                  return (
                    <article
                      key={item.id}
                      className="update-card is-announcement"
                      aria-labelledby={titleId}
                    >
                      <div className="update-card-header">
                        <span className="update-card-icon" aria-hidden="true">
                          <BellIcon />
                        </span>
                        <div className="update-card-heading">
                          <h3 id={titleId}>{item.title}</h3>
                        </div>
                      </div>
                      {item.summary && <p>{item.summary}</p>}
                      {item.highlights.length > 0 && (
                        <ul className="update-highlights">
                          {item.highlights
                            .slice(0, 5)
                            .map((highlight, highlightIndex) => (
                              <li key={`${highlightIndex}-${highlight}`}>
                                {highlight}
                              </li>
                            ))}
                        </ul>
                      )}
                    </article>
                  );
                }
                const downloaded = Math.max(0, item.downloaded ?? 0);
                const total =
                  item.total !== undefined && item.total > 0
                    ? item.total
                    : undefined;
                const progress = total
                  ? Math.min(100, (downloaded / total) * 100)
                  : null;
                const progressText = total
                  ? t("update.downloadedOf", {
                      downloaded: formatBytes(downloaded, locale),
                      total: formatBytes(total, locale),
                    })
                  : t("update.downloaded", {
                      downloaded: formatBytes(downloaded, locale),
                    });
                const isConfirming = confirmingInstall === item.id;
                const showHighlights =
                  item.highlights.length > 0 &&
                  item.phase !== "downloading" &&
                  item.phase !== "downloadRetry";

                return (
                  <article
                    key={item.id}
                    className={`update-card is-${item.phase}`}
                    aria-labelledby={titleId}
                  >
                    <div className="update-card-header">
                      <span className="update-card-icon" aria-hidden="true">
                        <BellIcon />
                      </span>
                      <div className="update-card-heading">
                        <span className="update-version">
                          {t("update.versionLabel", { version: item.version })}
                        </span>
                        <h3 id={titleId}>
                          {itemTitle(
                            item,
                            t("update.readyTitle", { version: item.version }),
                          )}
                        </h3>
                      </div>
                    </div>

                    {item.summary && <p>{item.summary}</p>}

                    {showHighlights && (
                      <ul className="update-highlights">
                        {item.highlights.slice(0, 5).map((highlight, highlightIndex) => (
                          <li key={`${highlightIndex}-${highlight}`}>{highlight}</li>
                        ))}
                      </ul>
                    )}

                    {item.phase === "downloading" && (
                      <div className="update-download-status">
                        <p className="update-status-copy">
                          {t("update.downloadingDescription")}
                        </p>
                        <div
                          className={`update-progress-track ${
                            progress === null ? "is-indeterminate" : ""
                          }`}
                          role="progressbar"
                          aria-label={t("update.downloadProgress")}
                          aria-valuetext={progressText}
                          {...(progress === null
                            ? {}
                            : {
                                "aria-valuemin": 0,
                                "aria-valuemax": 100,
                                "aria-valuenow": Math.round(progress),
                              })}
                        >
                          <span
                            style={
                              progress === null
                                ? undefined
                                : { width: `${progress}%` }
                            }
                          />
                        </div>
                        <div className="update-progress-copy">{progressText}</div>
                      </div>
                    )}

                    {item.phase === "downloadRetry" && (
                      <div className="update-status-note" role="status">
                        {t("update.downloadRetry")}
                      </div>
                    )}

                    {item.phase === "packageManaged" && (
                      <>
                        <p className="update-package-note">
                          {t("update.packageManagedHelp")}
                        </p>
                        <button
                          type="button"
                          className="update-action update-action-primary update-action-full"
                          onClick={props.onOpenRelease}
                        >
                          {t("update.openDownloads")}
                        </button>
                      </>
                    )}

                    {item.phase === "ready" &&
                      (isConfirming ? (
                        <div className="update-confirmation">
                          <strong>{t("update.confirmTitle")}</strong>
                          <p>{t("update.confirmWarning")}</p>
                          <div className="update-actions">
                            <button
                              ref={confirmationCancelRef}
                              type="button"
                              className="update-action update-action-secondary"
                              onClick={() => setConfirmingInstall(null)}
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
                          <button
                            type="button"
                            className="update-action update-action-link update-details-link"
                            onClick={props.onOpenRelease}
                          >
                            {t("update.details")}
                          </button>
                          <button
                            type="button"
                            className="update-action update-action-primary update-action-full"
                            onClick={() => setConfirmingInstall(item.id)}
                          >
                            {t("update.restartAndInstall")}
                          </button>
                        </>
                      ))}

                    {item.phase === "installing" && (
                      <div className="update-status-block" role="status">
                        <span className="update-spinner" aria-hidden="true" />
                        <div>
                          <strong>
                            {t("update.installing", { version: item.version })}
                          </strong>
                          <p>{t("update.installingDescription")}</p>
                        </div>
                      </div>
                    )}

                    {item.phase === "installFailed" && (
                      <>
                        <div className="update-failure" role="alert">
                          <strong>{t("update.installFailedTitle")}</strong>
                          <p>{t("update.installFailedDescription")}</p>
                        </div>
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
                            className="update-action update-action-primary"
                            onClick={props.onInstall}
                          >
                            {t("update.retryInstall")}
                          </button>
                        </div>
                      </>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  },
);
