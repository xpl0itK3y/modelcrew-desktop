import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useI18n } from "../i18n";
import { BellIcon, CloseIcon } from "../ui/Icons";
import type { AppUpdaterController, UpdateNotification } from "./types";

type NotificationCenterState = AppUpdaterController["center"];

type UpdatePopoverProps = {
  center: NotificationCenterState;
  // Поповер доигрывает exit-анимацию перед размонтированием.
  closing?: boolean;
  onInstall: () => void;
  onOpenRelease: () => void;
  // Скрыть уведомление (доступно только для анонсов, не для обновлений).
  onDismiss: (id: string) => void;
  onClose: () => void;
};

const POPOVER_HEIGHT_KEY = "modelcrew.notificationHeight";
const MIN_POPOVER_HEIGHT = 220;
// Bottom margin kept between the stretched popover and the window edge.
const POPOVER_BOTTOM_GAP = 12;
// Длительность схлопывания карточки (см. .update-card.is-dismissing).
const DISMISS_ANIMATION_MS = 220;
// Задержка между карточками при «Очистить» — волна вместо одного щелчка.
const DISMISS_STAGGER_MS = 45;

function loadPopoverHeight(): number | null {
  try {
    const raw = localStorage.getItem(POPOVER_HEIGHT_KEY);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= MIN_POPOVER_HEIGHT ? value : null;
  } catch {
    return null;
  }
}

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

function canConfirmInstall(item: UpdateNotification): boolean {
  return (
    item.installKind !== "manual" &&
    (item.phase === "ready" ||
      item.phase === "authorizationCancelled" ||
      item.phase === "installFailed" ||
      item.phase === "restartFailed")
  );
}


// Подсказка о ручной установке. Команду показываем только когда бэкенд назвал
// реальный путь к скачанному пакету: выдуманный путь бесполезен.
function ManualInstallHint(props: { command?: string }) {
  const { t } = useI18n();
  return (
    <>
      <p>{t("update.manualInstallHint")}</p>
      {props.command && (
        <code className="update-manual-command">{props.command}</code>
      )}
    </>
  );
}

export const UpdatePopover = forwardRef<HTMLDivElement, UpdatePopoverProps>(
  function UpdatePopover(props, ref) {
    const { locale, t } = useI18n();
    const { onDismiss } = props;
    const [confirmingInstall, setConfirmingInstall] = useState<string | null>(
      null,
    );
    const [height, setHeight] = useState<number | null>(() =>
      loadPopoverHeight(),
    );
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const confirmationCancelRef = useRef<HTMLButtonElement | null>(null);
    // Карточки, появившиеся уже при открытом поповере, въезжают с анимацией;
    // состав на момент открытия показывается сразу (поповер сам анимируется).
    const knownIdsRef = useRef<Set<string> | null>(null);
    const arrivedIdsRef = useRef(new Set<string>());
    const dismissingRef = useRef(new Set<string>());

    {
      const ids = props.center.items.map((item) => item.id);
      if (knownIdsRef.current === null) {
        knownIdsRef.current = new Set(ids);
      } else {
        for (const id of ids) {
          if (!knownIdsRef.current.has(id)) {
            knownIdsRef.current.add(id);
            arrivedIdsRef.current.add(id);
          }
        }
      }
    }

    // Скрытие с анимацией: карточка схлопывается по высоте и тает, состояние
    // обновляется после. Без реальной раскладки (тесты) или при
    // prefers-reduced-motion уведомление убирается сразу.
    const dismissAnimated = useCallback(
      (id: string, delay = 0) => {
        if (dismissingRef.current.has(id)) {
          return;
        }
        const card = dialogRef.current?.querySelector<HTMLElement>(
          `[data-notification-id="${CSS.escape(id)}"]`,
        );
        if (
          !card ||
          card.offsetHeight === 0 ||
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          onDismiss(id);
          return;
        }
        dismissingRef.current.add(id);
        const collapse = () => {
          card.style.height = `${card.offsetHeight}px`;
          // Стартовая высота должна лечь в раскладку до перехода к нулю.
          void card.offsetHeight;
          card.classList.add("is-dismissing");
          card.style.height = "0px";
          window.setTimeout(() => {
            dismissingRef.current.delete(id);
            onDismiss(id);
          }, DISMISS_ANIMATION_MS);
        };
        if (delay > 0) {
          window.setTimeout(collapse, delay);
        } else {
          collapse();
        }
      },
      [onDismiss],
    );

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

    // Grabbing the bottom handle drags the popover taller/shorter; the chosen
    // height persists so the notification center reopens at the same size.
    const startResize = useCallback((event: ReactPointerEvent) => {
      const popover = dialogRef.current;
      if (!popover || event.button !== 0) {
        return;
      }
      event.preventDefault();
      const rect = popover.getBoundingClientRect();
      const startY = event.clientY;
      const startHeight = rect.height;
      const maxHeight = window.innerHeight - rect.top - POPOVER_BOTTOM_GAP;
      let current = startHeight;
      const onMove = (moveEvent: PointerEvent) => {
        current = Math.min(
          maxHeight,
          Math.max(MIN_POPOVER_HEIGHT, startHeight + moveEvent.clientY - startY),
        );
        setHeight(current);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        try {
          localStorage.setItem(POPOVER_HEIGHT_KEY, String(Math.round(current)));
        } catch {
          // Non-fatal: the size just won't persist across restarts.
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    }, []);

    const confirmingItem = confirmingInstall
      ? props.center.items.find(
          (item): item is UpdateNotification =>
            item.kind === "update" && item.id === confirmingInstall,
        )
      : undefined;

    useEffect(() => {
      if (
        confirmingInstall &&
        (!confirmingItem || !canConfirmInstall(confirmingItem))
      ) {
        setConfirmingInstall(null);
      }
    }, [confirmingInstall, confirmingItem]);

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
    // «Очистить» скрывает все анонсы разом; обновления остаются.
    const dismissibleIds = props.center.items
      .filter((item) => item.kind === "announcement")
      .map((item) => item.id);

    return (
      <div
        id="notification-center"
        ref={setDialogRef}
        className={`update-popover ${props.closing ? "is-closing" : ""}`}
        data-tauri-drag-region="false"
        role="dialog"
        aria-modal="false"
        aria-labelledby="notification-center-title"
        tabIndex={-1}
        style={
          height === null ? undefined : { height, maxHeight: "none" }
        }
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
          <div className="update-popover-actions">
            {dismissibleIds.length > 0 && (
              <button
                type="button"
                className="update-popover-clear"
                onClick={() => {
                  // Волна: карточки уходят одна за другой сверху вниз.
                  dismissibleIds.forEach((id, index) => {
                    dismissAnimated(id, index * DISMISS_STAGGER_MS);
                  });
                }}
              >
                {t("update.clearAll")}
              </button>
            )}
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
                const arriving = arrivedIdsRef.current.has(item.id)
                  ? " is-arriving"
                  : "";
                if (item.kind === "announcement") {
                  return (
                    <article
                      key={item.id}
                      data-notification-id={item.id}
                      className={`update-card is-announcement${arriving}`}
                      aria-labelledby={titleId}
                    >
                      <button
                        type="button"
                        className="icon-button update-card-dismiss"
                        title={t("update.dismiss")}
                        aria-label={t("update.dismiss")}
                        onClick={() => dismissAnimated(item.id)}
                      >
                        <CloseIcon />
                      </button>
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
                const confirmable = canConfirmInstall(item);
                const installInteractionDisabled =
                  props.center.sync === "checking" ||
                  props.center.sync === "initial";
                const actionLabel =
                  item.phase === "restartFailed"
                    ? t("update.retryRestart")
                    : item.phase === "ready"
                      ? t("update.restartAndInstall")
                      : t("update.retryInstall");
                const showHighlights =
                  item.highlights.length > 0 &&
                  item.phase !== "downloading" &&
                  item.phase !== "verifying" &&
                  item.phase !== "downloadRetry";

                return (
                  <article
                    key={item.id}
                    data-notification-id={item.id}
                    className={`update-card is-${item.phase}${arriving}`}
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

                    {item.phase === "verifying" && (
                      <div className="update-status-block" role="status">
                        <span className="update-spinner" aria-hidden="true" />
                        <div>
                          <strong>{t("update.verifying")}</strong>
                          <p>{t("update.verifyingDescription")}</p>
                        </div>
                      </div>
                    )}

                    {item.phase === "manual" && (
                      <>
                        <p className="update-package-note">
                          {t("update.manualPackageHelp")}
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

                    {item.phase === "authorizing" && (
                      <div className="update-status-block" role="status">
                        <span className="update-spinner" aria-hidden="true" />
                        <div>
                          <strong>{t("update.authorizing")}</strong>
                          <p>{t("update.authorizingDescription")}</p>
                        </div>
                      </div>
                    )}

                    {item.phase === "authorizationCancelled" && (
                      <div className="update-notice" role="status">
                        <strong>{t("update.authorizationCancelledTitle")}</strong>
                        <p>{t("update.authorizationCancelledDescription")}</p>
                        {item.installKind === "nativePackage" && (
                          <ManualInstallHint command={item.manualCommand} />
                        )}
                      </div>
                    )}

                    {item.phase === "installing" && (
                      <div className="update-status-block" role="status">
                        <span className="update-spinner" aria-hidden="true" />
                        <div>
                          <strong>
                            {t("update.installing", { version: item.version })}
                          </strong>
                          <p>
                            {item.installKind === "nativePackage"
                              ? t("update.nativeInstallingDescription")
                              : t("update.installingDescription")}
                          </p>
                        </div>
                      </div>
                    )}

                    {item.phase === "restarting" && (
                      <div className="update-status-block" role="status">
                        <span className="update-spinner" aria-hidden="true" />
                        <div>
                          <strong>
                            {t("update.restarting", { version: item.version })}
                          </strong>
                          <p>{t("update.restartingDescription")}</p>
                        </div>
                      </div>
                    )}

                    {item.phase === "installFailed" && (
                      <div className="update-failure" role="alert">
                        <strong>{t("update.installFailedTitle")}</strong>
                        <p>{t("update.installFailedDescription")}</p>
                        {item.installKind === "nativePackage" && (
                          <ManualInstallHint command={item.manualCommand} />
                        )}
                      </div>
                    )}

                    {item.phase === "restartFailed" && (
                      <div className="update-failure" role="alert">
                        <strong>{t("update.restartFailedTitle")}</strong>
                        <p>{t("update.restartFailedDescription")}</p>
                      </div>
                    )}

                    {confirmable &&
                      (isConfirming ? (
                        <div className="update-confirmation">
                          <strong>{t("update.confirmTitle")}</strong>
                          <p>
                            {item.installKind === "nativePackage" &&
                            item.phase !== "restartFailed"
                              ? t("update.nativeConfirmWarning")
                              : t("update.confirmWarning")}
                          </p>
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
                              disabled={installInteractionDisabled}
                              onClick={props.onInstall}
                            >
                              {t("update.confirmRestart")}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {item.phase === "ready" && (
                            <button
                              type="button"
                              className="update-action update-action-link update-details-link"
                              onClick={props.onOpenRelease}
                            >
                              {t("update.details")}
                            </button>
                          )}
                          <button
                            type="button"
                            className="update-action update-action-primary update-action-full"
                            disabled={installInteractionDisabled}
                            onClick={() => setConfirmingInstall(item.id)}
                          >
                            {actionLabel}
                          </button>
                        </>
                      ))}
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <div
          className="update-popover-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("update.resize")}
          title={t("update.resize")}
          onPointerDown={startResize}
        />
      </div>
    );
  },
);
