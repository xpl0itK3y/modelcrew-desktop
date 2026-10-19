import { useEffect, useState } from "react";
import { localizeBackendError, useI18n } from "../../i18n";
import {
  refreshMcpStatus,
  setMcpEnabled,
  useMcpStatus,
  type McpStatus,
} from "../../mcp";
import { SettingRow, SettingsPage, SettingsSwitch } from "./SettingsControls";

/// Как часто переспрашивать состояние плагина, пока страница открыта. Реже —
/// и человек успевает решить, что число не живое; чаще — и это опрос ради
/// опроса: агент подключается раз за сессию.
const WATCH_EVERY = 2000;

export function PluginsTab() {
  const { t } = useI18n();
  const status = useMcpStatus();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Спрашиваем заново при каждом открытии настроек: сервер мог не подняться
  // уже после старта приложения. И потом переспрашиваем, пока страница
  // открыта: агенты приходят и уходят сами, без нашего участия, и застывшее
  // число врёт ровно тогда, когда на него смотрят.
  //
  // Молча при отказе: настройки открываются и без ответа бэкенда, а
  // переключатель остаётся недоступным — трогать то, о чём ничего не
  // известно, нельзя.
  useEffect(() => {
    const ask = () => {
      refreshMcpStatus().catch(() => {});
    };
    ask();
    const timer = setInterval(ask, WATCH_EVERY);
    return () => clearInterval(timer);
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    setFailure(null);
    try {
      await setMcpEnabled(next);
    } catch (error) {
      setFailure(localizeBackendError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsPage
      section="plugins"
      title={t("settings.tabPlugins")}
      intro={t("settings.pluginsIntro")}
      keywords="плагины расширения plugins extensions MCP браузер browser"
    >
      <SettingRow
        title={t("settings.pluginBrowser")}
        description={t("settings.pluginBrowserNote")}
        // Имена инструментов есть на странице только при включённом сервере,
        // а искать раздел по ним хочется в любом случае.
        keywords={(status?.tools ?? []).join(" ")}
        control={
          <SettingsSwitch
            label={t("settings.pluginBrowser")}
            checked={status?.enabled ?? false}
            disabled={busy || status === null}
            onChange={toggle}
          />
        }
        note={<Note status={status} failure={failure} />}
      />
    </SettingsPage>
  );
}

function Note(props: { status: McpStatus | null; failure: string | null }) {
  const { t } = useI18n();

  if (props.failure) {
    return (
      <p className="settings-note is-error" role="alert">
        {props.failure}
      </p>
    );
  }
  if (!props.status) {
    return null;
  }
  // Сервер выключен: инструментов нет ни одного, и агент не видит даже самого
  // сервера — обещать здесь список было бы обманом.
  if (!props.status.enabled) {
    return <p className="settings-note">{t("settings.pluginOff")}</p>;
  }
  // Включён, но слушателя нет: сокет или канал не открылся. Молчать нельзя —
  // иначе включённый переключатель обещает работу, которой нет.
  if (!props.status.listening) {
    return (
      <p className="settings-note is-warning" role="status">
        {t("settings.pluginUnavailable")}
      </p>
    );
  }
  return (
    <p className="settings-note">
      <span>
        {t("settings.pluginTools", { tools: props.status.tools.join(" · ") })}
      </span>
      <br />
      <span>{t("settings.pluginAgents", { agents: props.status.agents })}</span>
      {props.status.socket && (
        <>
          <br />
          <span className="settings-plugin-socket">{props.status.socket}</span>
        </>
      )}
    </p>
  );
}
