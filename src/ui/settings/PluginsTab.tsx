import { useEffect, useId, useState, type CSSProperties } from "react";
import { localizeBackendError, useI18n, type MessageKey } from "../../i18n";
import {
  refreshMcpStatus,
  setMcpEnabled,
  useMcpStatus,
  type McpStatus,
} from "../../mcp";
import { ChevronRightIcon } from "../Icons";
import { SettingRow, SettingsPage, SettingsSwitch } from "./SettingsControls";

/// Как часто переспрашивать состояние плагина, пока страница открыта. Реже —
/// и человек успевает решить, что число не живое; чаще — и это опрос ради
/// опроса: агент подключается раз за сессию.
const WATCH_EVERY = 2000;

/// Что делает каждый инструмент — словами для человека. Описания, которые
/// получает агент, написаны для агента: длинные, с параметрами и запретами.
/// Имена по-прежнему приходят от сервера; инструмент без строки здесь
/// показывается одним именем, а PluginsTab.test.tsx сверяет этот список с
/// mcp.rs, чтобы такое не осталось незамеченным.
export const TOOL_DESCRIPTIONS: Record<string, MessageKey> = {
  crew_ping: "settings.pluginToolCrewPing",
  browser_open: "settings.pluginToolOpen",
  browser_navigate: "settings.pluginToolNavigate",
  browser_screenshot: "settings.pluginToolScreenshot",
  browser_console: "settings.pluginToolConsole",
  browser_reload: "settings.pluginToolReload",
  browser_back: "settings.pluginToolBack",
  browser_forward: "settings.pluginToolForward",
  browser_read: "settings.pluginToolRead",
  browser_click: "settings.pluginToolClick",
  browser_hover: "settings.pluginToolHover",
  browser_type: "settings.pluginToolType",
  browser_select: "settings.pluginToolSelect",
  browser_press: "settings.pluginToolPress",
  browser_scroll: "settings.pluginToolScroll",
  browser_upload: "settings.pluginToolUpload",
  browser_wait: "settings.pluginToolWait",
  browser_evaluate: "settings.pluginToolEvaluate",
};

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
        // Инструменты есть на странице только при включённом сервере, а искать
        // раздел по ним — по имени или по тому, что он делает, — хочется в
        // любом случае.
        keywords={(status?.tools ?? [])
          .flatMap((name) => {
            const description = TOOL_DESCRIPTIONS[name];
            return description ? [name, t(description)] : [name];
          })
          .join(" ")}
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
    <div className="settings-note">
      <ToolList tools={props.status.tools} />
      <p className="settings-plugin-status">
        <span>{t("settings.pluginAgents", { agents: props.status.agents })}</span>
        {props.status.socket && (
          <>
            <br />
            <span className="settings-plugin-socket">{props.status.socket}</span>
          </>
        )}
      </p>
    </div>
  );
}

// Свёрнут по умолчанию: восемнадцать строк описаний заслонили бы и
// выключатель, и число агентов, ради которых сюда обычно и заходят.
//
// Список в DOM всегда, свёрнутый — скрыт от чтения с экрана: так его
// закрытие анимируется так же, как раскрытие, а не обрывается.
function ToolList(props: { tools: string[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const listId = useId();

  return (
    <div className={`settings-plugin-tools ${open ? "is-expanded" : ""}`}>
      <button
        type="button"
        className="settings-plugin-tools-toggle"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={t("settings.pluginTools", { count: props.tools.length })}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon
          className="settings-plugin-tools-chevron"
          aria-hidden="true"
        />
        <span>{t("settings.pluginToolsTitle")}</span>
        <span className="settings-plugin-tools-count" aria-hidden="true">
          {props.tools.length}
        </span>
      </button>
      <div className="settings-plugin-tools-shell" aria-hidden={!open}>
        <div className="settings-plugin-tools-clip">
          <dl id={listId} className="settings-plugin-tool-list">
            {props.tools.map((name, index) => {
              const description = TOOL_DESCRIPTIONS[name];
              return (
                <div
                  key={name}
                  className="settings-plugin-tool"
                  style={{ "--tool-index": index } as CSSProperties}
                >
                  <dt>
                    <code>{name}</code>
                  </dt>
                  <dd>{description ? t(description) : null}</dd>
                </div>
              );
            })}
          </dl>
        </div>
      </div>
    </div>
  );
}
