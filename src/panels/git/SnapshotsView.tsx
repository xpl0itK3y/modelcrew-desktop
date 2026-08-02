// Снимки работы панелей: что успел записать каждый агент и как вернуть файл,
// который затёр сосед.
//
// Снимок делается после каждого хода агента и живёт в своём пространстве
// ссылок git — в ветки и историю он не входит. Здесь он показывается человеку
// в единственном виде, в котором нужен: список файлов и кнопка «вернуть».

import { useCallback, useEffect, useState } from "react";
import { localizeBackendError, useI18n } from "../../i18n";
import { formatRelativeTime } from "../../git/relativeTime";
import { refreshGitChanges } from "../../git/gitChanges";
import {
  fetchPanelSnapshots,
  restorePanelSnapshot,
  type PanelSnapshot,
} from "../../git/panelSnapshots";
import { getAutoTitle } from "../../terminal/panelTitles";

export function SnapshotsView(props: { workspaceId: string }) {
  const { locale, t } = useI18n();
  const [snapshots, setSnapshots] = useState<PanelSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSnapshots(await fetchPanelSnapshots(props.workspaceId));
    } catch (failure) {
      setError(localizeBackendError(failure));
    }
  }, [props.workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const restore = async (snapshot: PanelSnapshot, path: string) => {
    const key = `${snapshot.panelId}:${path}`;
    setBusy(key);
    setError(null);
    try {
      await restorePanelSnapshot(props.workspaceId, snapshot.panelId, path);
      // Файл вернулся в рабочее дерево — сводка изменений устарела.
      void refreshGitChanges(props.workspaceId);
      await reload();
    } catch (failure) {
      setError(localizeBackendError(failure));
    } finally {
      setBusy(null);
    }
  };

  if (snapshots === null) {
    return <div className="git-empty">{t("git.loading")}</div>;
  }

  if (snapshots.length === 0) {
    return <div className="git-empty">{t("snapshots.empty")}</div>;
  }

  return (
    <div className="git-snapshots">
      {error && <div className="git-error">{error}</div>}
      {snapshots.map((snapshot) => (
        <section key={snapshot.commit} className="snapshot-card">
          <header className="snapshot-head">
            {/* Имя панели, а не её id: человек ищет «тот терминал с claude». */}
            <span className="snapshot-panel">
              {getAutoTitle(snapshot.panelId) ??
                t("snapshots.unknownPanel", {
                  id: snapshot.panelId.slice(0, 8),
                })}
            </span>
            <span className="snapshot-time">
              {formatRelativeTime(snapshot.epochMs, locale)}
            </span>
          </header>
          {snapshot.files.length === 0 ? (
            <div className="snapshot-note">{t("snapshots.noFiles")}</div>
          ) : (
            <ul className="snapshot-files">
              {snapshot.files.map((path) => (
                <li key={path} className="snapshot-file">
                  <span className="snapshot-path" title={path}>
                    {path}
                  </span>
                  <button
                    type="button"
                    className="snapshot-restore"
                    disabled={busy !== null}
                    title={t("snapshots.restoreHint", { path })}
                    onClick={() => void restore(snapshot, path)}
                  >
                    {busy === `${snapshot.panelId}:${path}`
                      ? t("snapshots.restoring")
                      : t("snapshots.restore")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
