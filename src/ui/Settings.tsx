import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { type ThemeId } from "../theme";
import { type MessageKey, useI18n } from "../i18n";
import { APP_VERSION } from "../version";
import { AppearanceTab } from "./settings/AppearanceTab";
import { TerminalTab } from "./settings/TerminalTab";
import { NotificationsTab } from "./settings/NotificationsTab";

type SettingsTab = "appearance" | "terminal" | "notifications";

const SETTINGS_TABS: { id: SettingsTab; label: MessageKey }[] = [
  { id: "appearance", label: "settings.tabAppearance" },
  { id: "terminal", label: "settings.tabTerminal" },
  { id: "notifications", label: "settings.tabNotifications" },
];

const settingsTabId = (tab: SettingsTab) => `settings-tab-${tab}`;
const settingsPanelId = (tab: SettingsTab) => `settings-panel-${tab}`;

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
  const { t } = useI18n();
  const titleId = useId();
  const [tab, setTab] = useState<SettingsTab>("appearance");
  // The visible tab defines the body height; the rest are display:none. We track
  // the active panel's height so the container can glide between sizes instead of
  // snapping when the user switches tabs.
  const bodyTrackRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState<number>();

  // Keep the animated body height in sync with whatever the active tab needs —
  // tab switches, the async shell list arriving, locale reflow, window resizing.
  // A ResizeObserver covers them all uniformly; the CSS transition does the glide.
  useLayoutEffect(() => {
    const track = bodyTrackRef.current;
    if (!track || typeof ResizeObserver === "undefined") {
      return;
    }
    const sync = () => setBodyHeight(track.offsetHeight);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [props]);

  const onTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentTab: SettingsTab,
  ) => {
    const currentIndex = SETTINGS_TABS.findIndex(
      (entry) => entry.id === currentTab,
    );
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % SETTINGS_TABS.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex =
        (currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = SETTINGS_TABS.length - 1;
    }

    if (nextIndex === null) {
      return;
    }

    event.preventDefault();
    const nextTab = SETTINGS_TABS[nextIndex].id;
    setTab(nextTab);
    document.getElementById(settingsTabId(nextTab))?.focus();
  };

  return (
    <div
      className={`dialog-backdrop ${props.closing ? "is-closing" : ""}`}
      onClick={props.onClose}
    >
      <div
        className="dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="settings-header">
          <span id={titleId} className="settings-title">
            {t("settings.title")}
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={props.onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            ✕
          </button>
        </div>

        <div
          className="settings-tabs"
          role="tablist"
          aria-orientation="horizontal"
          aria-label={t("settings.title")}
        >
          {SETTINGS_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={settingsTabId(entry.id)}
              aria-controls={settingsPanelId(entry.id)}
              aria-selected={tab === entry.id}
              tabIndex={tab === entry.id ? 0 : -1}
              className={`settings-tab ${tab === entry.id ? "is-selected" : ""}`}
              onClick={() => setTab(entry.id)}
              onKeyDown={(event) => onTabKeyDown(event, entry.id)}
            >
              {t(entry.label)}
            </button>
          ))}
        </div>

        <div
          className="settings-body"
          style={bodyHeight === undefined ? undefined : { height: bodyHeight }}
        >
          <div className="settings-body-track" ref={bodyTrackRef}>
            <div
              id={settingsPanelId("appearance")}
              role="tabpanel"
              aria-labelledby={settingsTabId("appearance")}
              hidden={tab !== "appearance"}
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
              role="tabpanel"
              aria-labelledby={settingsTabId("terminal")}
              hidden={tab !== "terminal"}
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
              id={settingsPanelId("notifications")}
              role="tabpanel"
              aria-labelledby={settingsTabId("notifications")}
              hidden={tab !== "notifications"}
              tabIndex={0}
            >
              <NotificationsTab />
            </div>
          </div>
        </div>

        <div className="settings-footer">
          ModelCrew · {t("settings.appVersion", { version: APP_VERSION })}
        </div>
      </div>
    </div>
  );
}
