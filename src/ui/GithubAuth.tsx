import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useAnimatedPresence } from "./useAnimatedPresence";
import {
  githubCurrentUser,
  githubDevicePoll,
  githubDeviceStart,
  githubLogout,
  openUrl,
  type DeviceStart,
  type GithubUser,
} from "../github/auth";

type FlowState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "code"; device: DeviceStart }
  | { kind: "denied" | "expired" | "error" | "unconfigured" };

const isTauri = "__TAURI_INTERNALS__" in window;

// Кнопка входа через GitHub и аватар вошедшего в правом углу титлбара.
export function GithubAuth() {
  const { t } = useI18n();
  const [user, setUser] = useState<GithubUser | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [flow, setFlow] = useState<FlowState>({ kind: "idle" });
  const rootRef = useRef<HTMLDivElement | null>(null);

  const modalPresence = useAnimatedPresence(
    flow.kind === "idle" ? null : flow,
    160,
  );

  useEffect(() => {
    let cancelled = false;
    void githubCurrentUser().then((current) => {
      if (!cancelled) {
        setUser(current);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Закрытие меню аватара по клику вне.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  const startLogin = async () => {
    setFlow({ kind: "starting" });
    try {
      const device = await githubDeviceStart();
      setFlow({ kind: "code", device });
      void openUrl(device.verificationUri).catch(() => {});
    } catch (error) {
      // Не настроен Client ID OAuth-приложения — сообщаем понятно.
      const code = (error as { code?: string })?.code;
      setFlow({
        kind: code === "github_not_configured" ? "unconfigured" : "error",
      });
    }
  };

  // Опрос подтверждения, пока открыт экран с кодом.
  useEffect(() => {
    if (flow.kind !== "code") {
      return;
    }
    const device = flow.device;
    let stopped = false;
    let delay = Math.max(device.interval, 5) * 1000;
    const deadline = Date.now() + device.expiresIn * 1000;
    let timer = 0;

    const tick = async () => {
      if (stopped) {
        return;
      }
      if (Date.now() > deadline) {
        setFlow({ kind: "expired" });
        return;
      }
      try {
        const { status } = await githubDevicePoll(device.deviceCode);
        if (stopped) {
          return;
        }
        if (status === "authorized") {
          const current = await githubCurrentUser();
          if (!stopped) {
            setUser(current);
            setFlow({ kind: "idle" });
          }
          return;
        }
        if (status === "denied") {
          setFlow({ kind: "denied" });
          return;
        }
        if (status === "expired") {
          setFlow({ kind: "expired" });
          return;
        }
        if (status === "slowDown") {
          delay += 5000;
        }
      } catch {
        // Сетевой сбой — пробуем ещё на следующем тике.
      }
      timer = window.setTimeout(() => void tick(), delay);
    };
    timer = window.setTimeout(() => void tick(), delay);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [flow]);

  const logout = async () => {
    setMenuOpen(false);
    await githubLogout();
    setUser(null);
  };

  if (!isTauri) {
    return null;
  }

  return (
    <div className="github-auth" ref={rootRef}>
      {user ? (
        <>
          <button
            type="button"
            className="github-avatar-button"
            title={user.login}
            aria-label={user.login}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <img
              className="github-avatar-img"
              src={user.avatarUrl}
              alt=""
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
          </button>
          {menuOpen && (
            <div className="github-menu" role="menu">
              <div className="github-menu-user">@{user.login}</div>
              <button
                type="button"
                className="github-menu-item"
                onClick={() => void logout()}
              >
                {t("github.logout")}
              </button>
            </div>
          )}
        </>
      ) : (
        <button
          type="button"
          className="github-login-button"
          title={t("github.loginTitle")}
          disabled={flow.kind === "starting"}
          onClick={() => void startLogin()}
        >
          {t("github.login")}
        </button>
      )}

      {modalPresence && (
        <div
          className={`github-modal-backdrop ${
            modalPresence.closing ? "is-closing" : ""
          }`}
        >
          <div className="github-modal" role="dialog" aria-modal="true">
            <GithubFlowBody
              flow={modalPresence.item}
              onClose={() => setFlow({ kind: "idle" })}
              onRetry={() => void startLogin()}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function GithubFlowBody(props: {
  flow: FlowState;
  onClose: () => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const { flow } = props;
  const [copied, setCopied] = useState(false);

  if (flow.kind === "starting") {
    return <div className="github-modal-status">{t("github.waiting")}</div>;
  }
  if (flow.kind === "unconfigured") {
    return (
      <>
        <div className="github-modal-status">{t("github.notConfigured")}</div>
        <p className="github-modal-hint">{t("github.notConfiguredHint")}</p>
        <div className="github-modal-actions">
          <button
            type="button"
            className="github-modal-secondary"
            onClick={props.onClose}
          >
            {t("github.close")}
          </button>
        </div>
      </>
    );
  }
  if (
    flow.kind === "denied" ||
    flow.kind === "expired" ||
    flow.kind === "error"
  ) {
    const key =
      flow.kind === "denied"
        ? "github.denied"
        : flow.kind === "expired"
          ? "github.expired"
          : "github.error";
    return (
      <>
        <div className="github-modal-status">{t(key)}</div>
        <div className="github-modal-actions">
          <button
            type="button"
            className="github-modal-secondary"
            onClick={props.onClose}
          >
            {t("github.close")}
          </button>
          <button
            type="button"
            className="github-modal-primary"
            onClick={props.onRetry}
          >
            {t("github.retry")}
          </button>
        </div>
      </>
    );
  }
  if (flow.kind === "code") {
    const { device } = flow;
    return (
      <>
        <div className="github-modal-title">{t("github.loginTitle")}</div>
        <p className="github-modal-hint">{t("github.deviceInstructions")}</p>
        <button
          type="button"
          className="github-code"
          title={t("github.copyCode")}
          onClick={() => {
            void navigator.clipboard
              .writeText(device.userCode)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {});
          }}
        >
          {copied ? t("git.copied") : device.userCode}
        </button>
        <div className="github-modal-actions">
          <button
            type="button"
            className="github-modal-secondary"
            onClick={props.onClose}
          >
            {t("github.close")}
          </button>
          <button
            type="button"
            className="github-modal-primary"
            onClick={() => void openUrl(device.verificationUri)}
          >
            {t("github.openGithub")}
          </button>
        </div>
        <div className="github-modal-waiting">{t("github.waiting")}</div>
      </>
    );
  }
  return null;
}
