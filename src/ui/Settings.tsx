import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type SVGProps,
} from "react";
import { type ThemeId } from "../theme";
import { type MessageKey, useI18n } from "../i18n";
import { APP_VERSION } from "../version";
import {
  AgentIcon,
  BellIcon,
  CloseIcon,
  PaletteIcon,
  SearchIcon,
  TerminalGlyphIcon,
  UserIcon,
} from "./Icons";
import { AppearanceTab } from "./settings/AppearanceTab";
import { TerminalTab } from "./settings/TerminalTab";
import { AgentsTab } from "./settings/AgentsTab";
import { NotificationsTab } from "./settings/NotificationsTab";
import { AccountTab } from "./settings/AccountTab";
import {
  SettingsSearchProvider,
  useSettingsSearch,
  type SettingsSectionId,
} from "./settings/SettingsSearch";

type SettingsTab = SettingsSectionId;

type SettingsTabEntry = {
  id: SettingsTab;
  label: MessageKey;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
};

// Навигация разбита на группы: у каждой свой заголовок и свой tablist, чтобы
// внутри списка вкладок не оказалось ничего, кроме самих вкладок.
const SETTINGS_GROUPS: {
  id: string;
  label: MessageKey;
  tabs: SettingsTabEntry[];
}[] = [
  {
    id: "settings",
    label: "settings.title",
    tabs: [
      { id: "appearance", label: "settings.tabAppearance", Icon: PaletteIcon },
      {
        id: "terminal",
        label: "settings.tabTerminal",
        Icon: TerminalGlyphIcon,
      },
      { id: "agents", label: "settings.tabAgents", Icon: AgentIcon },
      {
        id: "notifications",
        label: "settings.tabNotifications",
        Icon: BellIcon,
      },
    ],
  },
  {
    id: "account",
    label: "settings.groupAccount",
    tabs: [{ id: "account", label: "settings.tabAccount", Icon: UserIcon }],
  },
];

const SETTINGS_TABS = SETTINGS_GROUPS.flatMap((group) => group.tabs);

const settingsTabId = (tab: SettingsTab) => `settings-tab-${tab}`;
const settingsPanelId = (tab: SettingsTab) => `settings-panel-${tab}`;
const settingsGroupId = (group: string) => `settings-nav-group-${group}`;

type SettingsProps = {
  themeId: ThemeId;
  accent: string;
  shell: string | null;
  shellBusy: boolean;
  terminalFontSize: number;
  onSelectTheme: (themeId: ThemeId) => void;
  onSelectAccent: (color: string) => void;
  onSelectShell: (command: string | null, label: string) => void;
  onSelectTerminalFontSize: (size: number) => void;
  // Диалог доигрывает exit-анимацию перед размонтированием.
  closing?: boolean;
  onClose: () => void;
};

export function Settings(props: SettingsProps) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState("");

  // Запрос набран на прежнем языке, а ищем мы по переведённым строкам: после
  // смены языка он перестал бы совпадать с чем угодно и оставил бы диалог
  // пустым — вместе с той самой строкой, где язык и переключают.
  useLayoutEffect(() => {
    setQuery("");
  }, [locale]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Внутренняя настройка может открыть собственное подтверждение
        // (например установку Git Bash). Верхний alertdialog сам обработает
        // Escape; закрывать вместе с ним и весь экран настроек не надо.
        if (document.querySelector('[role="alertdialog"][aria-modal="true"]')) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [props]);

  return (
    <div
      className={`dialog-backdrop ${props.closing ? "is-closing" : ""}`}
      onClick={props.onClose}
    >
      <div
        className="dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {/* Поиск живёт над провайдером: строки настроек регистрируются в нём и
            сами решают, показываться ли по текущему запросу. */}
        <SettingsSearchProvider query={query}>
          <SettingsShell {...props} query={query} onQueryChange={setQuery} />
        </SettingsSearchProvider>
      </div>
    </div>
  );
}

type ShellProps = SettingsProps & {
  query: string;
  onQueryChange: (query: string) => void;
};

function SettingsShell(props: ShellProps) {
  const { t } = useI18n();
  const search = useSettingsSearch();
  const [tab, setTab] = useState<SettingsTab>("appearance");
  const contentRef = useRef<HTMLDivElement>(null);
  const searching = props.query.trim().length > 0;

  const visibleTabs = useMemo(() => {
    if (!searching || !search) {
      return SETTINGS_TABS;
    }
    return SETTINGS_TABS.filter((entry) =>
      search.matchedSections.has(entry.id),
    );
  }, [searching, search]);

  // Поиск может выбросить открытый раздел из списка — тогда показываем первый
  // из оставшихся, иначе пользователь смотрел бы в пустую панель.
  useEffect(() => {
    if (visibleTabs.length > 0 && !visibleTabs.some((e) => e.id === tab)) {
      setTab(visibleTabs[0].id);
    }
  }, [visibleTabs, tab]);

  // Новый раздел читают с начала, а не с прокрутки, оставшейся от прошлого.
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [tab]);

  const onTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentTab: SettingsTab,
  ) => {
    const currentIndex = visibleTabs.findIndex(
      (entry) => entry.id === currentTab,
    );
    if (currentIndex < 0) {
      return;
    }
    let nextIndex: number | null = null;

    if (event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % visibleTabs.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + visibleTabs.length) % visibleTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = visibleTabs.length - 1;
    }

    if (nextIndex === null) {
      return;
    }

    event.preventDefault();
    const nextTab = visibleTabs[nextIndex].id;
    setTab(nextTab);
    document.getElementById(settingsTabId(nextTab))?.focus();
  };

  const nothingFound = visibleTabs.length === 0;
  const isHidden = (section: SettingsTab) => nothingFound || tab !== section;

  return (
    <>
      <div className="settings-nav">
        <div className="settings-search">
          <SearchIcon className="settings-search-icon" aria-hidden="true" />
          <input
            type="search"
            className="settings-search-input"
            placeholder={t("settings.searchPlaceholder")}
            aria-label={t("settings.searchPlaceholder")}
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
          />
        </div>

        <div className="settings-nav-list">
          {SETTINGS_GROUPS.map((group) => {
            const tabs = group.tabs.filter((entry) =>
              visibleTabs.includes(entry),
            );
            if (tabs.length === 0) {
              return null;
            }
            return (
              <div className="settings-nav-group" key={group.id}>
                <div
                  className="settings-nav-label"
                  id={settingsGroupId(group.id)}
                >
                  {t(group.label)}
                </div>
                <div
                  className="settings-nav-tabs"
                  role="tablist"
                  aria-orientation="vertical"
                  aria-labelledby={settingsGroupId(group.id)}
                >
                  {tabs.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      role="tab"
                      id={settingsTabId(entry.id)}
                      aria-controls={settingsPanelId(entry.id)}
                      aria-selected={tab === entry.id}
                      tabIndex={tab === entry.id ? 0 : -1}
                      className={`settings-nav-item ${
                        tab === entry.id ? "is-selected" : ""
                      }`}
                      onClick={() => setTab(entry.id)}
                      onKeyDown={(event) => onTabKeyDown(event, entry.id)}
                    >
                      <entry.Icon
                        className="settings-nav-icon"
                        aria-hidden="true"
                      />
                      <span>{t(entry.label)}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {nothingFound && (
            <p className="settings-nav-empty">{t("settings.searchEmpty")}</p>
          )}
        </div>

        <div className="settings-nav-footer">
          ModelCrew · {t("settings.appVersion", { version: APP_VERSION })}
        </div>
      </div>

      <button
        type="button"
        className="icon-button settings-close"
        onClick={props.onClose}
        title={t("common.close")}
        aria-label={t("common.close")}
      >
        <CloseIcon />
      </button>

      <div className="settings-content" ref={contentRef}>
        <div
          id={settingsPanelId("appearance")}
          className="settings-panel"
          role="tabpanel"
          aria-labelledby={settingsTabId("appearance")}
          hidden={isHidden("appearance")}
          tabIndex={0}
        >
          <AppearanceTab
            themeId={props.themeId}
            accent={props.accent}
            onSelectTheme={props.onSelectTheme}
            onSelectAccent={props.onSelectAccent}
          />
        </div>

        <div
          id={settingsPanelId("terminal")}
          className="settings-panel"
          role="tabpanel"
          aria-labelledby={settingsTabId("terminal")}
          hidden={isHidden("terminal")}
          tabIndex={0}
        >
          <TerminalTab
            shell={props.shell}
            shellBusy={props.shellBusy}
            terminalFontSize={props.terminalFontSize}
            onSelectShell={props.onSelectShell}
            onSelectTerminalFontSize={props.onSelectTerminalFontSize}
          />
        </div>

        <div
          id={settingsPanelId("agents")}
          className="settings-panel"
          role="tabpanel"
          aria-labelledby={settingsTabId("agents")}
          hidden={isHidden("agents")}
          tabIndex={0}
        >
          <AgentsTab />
        </div>

        <div
          id={settingsPanelId("notifications")}
          className="settings-panel"
          role="tabpanel"
          aria-labelledby={settingsTabId("notifications")}
          hidden={isHidden("notifications")}
          tabIndex={0}
        >
          <NotificationsTab />
        </div>

        <div
          id={settingsPanelId("account")}
          className="settings-panel"
          role="tabpanel"
          aria-labelledby={settingsTabId("account")}
          hidden={isHidden("account")}
          tabIndex={0}
        >
          <AccountTab />
        </div>

        {nothingFound && (
          <p className="settings-content-empty">{t("settings.searchEmpty")}</p>
        )}
      </div>
    </>
  );
}
