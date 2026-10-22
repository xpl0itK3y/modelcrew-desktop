import { useEffect, useState } from "react";
import { describeBackendError, useI18n, type BackendFailure } from "../../i18n";
import { initRepository, refreshGitChanges } from "../../git/gitChanges";
import { useAppActions } from "../../ui/AppActions";
import { GitErrorDialog } from "./GitErrorDialog";

// Подсказки вместо пустой панели: что не так и что с этим сделать прямо здесь.
// Простая надпись «не под управлением git» оставляла человека без выхода —
// идти в терминал и вспоминать команды.

// Папка без репозитория. После создания файлы проекта сразу появятся в списке,
// и первый коммит делается отсюда же.
export function NotARepoNotice(props: { workspaceId: string }) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<BackendFailure | null>(null);

  const create = async () => {
    if (creating) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await initRepository(props.workspaceId);
      await refreshGitChanges(props.workspaceId);
    } catch (failure) {
      setError(describeBackendError(failure));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="git-empty git-onboarding">
      <strong className="git-onboarding-title">{t("git.initTitle")}</strong>
      <p className="git-onboarding-text">{t("git.initText")}</p>
      <div className="git-onboarding-actions">
        <button
          type="button"
          className="git-onboarding-primary"
          disabled={creating}
          onClick={() => void create()}
        >
          {creating ? t("git.initBusy") : t("git.initButton")}
        </button>
      </div>
      {error && !error.details && (
        <p className="git-commit-error" role="alert">
          {error.message}
        </p>
      )}
      {error?.details && (
        <GitErrorDialog failure={error} onClose={() => setError(null)} />
      )}
    </div>
  );
}

// git не найден. Ставится он в настройках, и панель ведёт прямо туда.
export function GitMissingNotice(props: { workspaceId: string }) {
  const { t } = useI18n();
  const { requestOpenSettings } = useAppActions();
  const [checking, setChecking] = useState(false);

  // Установщик живёт в своём окне. Вернувшись из него, человек ждёт, что
  // панель уже видит git, а не опроса через минуту.
  useEffect(() => {
    const onFocus = () => void refreshGitChanges(props.workspaceId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [props.workspaceId]);

  const check = async () => {
    setChecking(true);
    try {
      await refreshGitChanges(props.workspaceId);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="git-empty git-onboarding">
      <strong className="git-onboarding-title">{t("git.missingTitle")}</strong>
      <p className="git-onboarding-text">{t("git.missingText")}</p>
      <div className="git-onboarding-actions">
        <button
          type="button"
          className="git-onboarding-primary"
          onClick={() => requestOpenSettings("terminal")}
        >
          {t("git.missingOpenSettings")}
        </button>
        <button
          type="button"
          className="git-onboarding-secondary"
          disabled={checking}
          onClick={() => void check()}
        >
          {checking ? t("git.missingChecking") : t("git.missingCheckAgain")}
        </button>
      </div>
    </div>
  );
}
