import { useEffect, useState } from "react";
import { localizeBackendError, useI18n } from "../../i18n";
import { getMcpStatus, setMcpEnabled, type McpStatus } from "../../mcp";
import { SettingRow, SettingsPage, SettingsSwitch } from "./SettingsControls";

export function McpTab() {
  const { t } = useI18n();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getMcpStatus()
      .then((next) => {
        if (alive) {
          setStatus(next);
        }
      })
      // Молча: настройки открываются и без ответа бэкенда, а переключатель
      // остаётся недоступным — трогать то, о чём ничего не известно, нельзя.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    setFailure(null);
    try {
      setStatus(await setMcpEnabled(next));
    } catch (error) {
      setFailure(localizeBackendError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsPage
      section="mcp"
      title={t("settings.tabMcp")}
      intro={t("settings.mcpIntro")}
      keywords="MCP CodeGraph CocoIndex сервер server"
    >
      <SettingRow
        title={t("settings.mcpBrowser")}
        description={t("settings.mcpBrowserNote")}
        // Имена инструментов есть на странице только при включённом сервере,
        // а искать раздел по ним хочется в любом случае.
        keywords={(status?.tools ?? []).join(" ")}
        control={
          <SettingsSwitch
            label={t("settings.mcpBrowser")}
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
    return <p className="settings-note">{t("settings.mcpOff")}</p>;
  }
  // Включён, но слушателя нет: платформа его не поддерживает (Windows) или
  // сокет не открылся. Молчать нельзя — иначе включённый переключатель
  // обещает работу, которой нет.
  if (!props.status.listening) {
    return (
      <p className="settings-note is-warning" role="status">
        {t("settings.mcpUnavailable")}
      </p>
    );
  }
  return (
    <p className="settings-note">
      {t("settings.mcpTools", { tools: props.status.tools.join(" · ") })}
      {props.status.socket && (
        <>
          <br />
          <span className="settings-mcp-socket">{props.status.socket}</span>
        </>
      )}
    </p>
  );
}
