import { useEffect } from "react";
import { ACCENT_COLORS, APP_THEMES, type ThemeId } from "../theme";

type SettingsProps = {
  themeId: ThemeId;
  accent: string;
  onSelectTheme: (themeId: ThemeId) => void;
  onSelectAccent: (color: string) => void;
  onClose: () => void;
};

export function Settings(props: SettingsProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [props]);

  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div
        className="dialog settings-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-header">
          <span className="settings-title">Настройки</span>
          <button
            type="button"
            className="icon-button"
            onClick={props.onClose}
            title="Закрыть"
          >
            ✕
          </button>
        </div>

        <div className="settings-section">
          <div className="settings-label">Тема интерфейса</div>
          <div className="theme-grid">
            {APP_THEMES.map((theme) => (
              <button
                key={theme.id}
                type="button"
                aria-pressed={props.themeId === theme.id}
                className={`theme-card ${
                  props.themeId === theme.id ? "is-selected" : ""
                }`}
                onClick={() => props.onSelectTheme(theme.id)}
              >
                <span
                  className="theme-preview"
                  style={{ backgroundColor: theme.colors.bg }}
                >
                  <span
                    className="theme-preview-sidebar"
                    style={{ backgroundColor: theme.colors.sidebar }}
                  />
                  <span
                    className="theme-preview-panel"
                    style={{
                      backgroundColor: theme.colors.panel,
                      borderColor: theme.colors.panelBorder,
                    }}
                  >
                    <span
                      className="theme-preview-header"
                      style={{ backgroundColor: theme.colors.panelHeader }}
                    />
                    <span
                      className="theme-preview-line"
                      style={{ backgroundColor: theme.colors.textMuted }}
                    />
                  </span>
                  <span className="theme-preview-accent" />
                </span>
                <span className="theme-card-copy">
                  <strong>{theme.name}</strong>
                  <small>{theme.description}</small>
                </span>
                <span className="theme-card-check" aria-hidden="true">
                  {props.themeId === theme.id ? "✓" : ""}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-section settings-accent-section">
          <div className="settings-label">Цвет подсветки</div>
          <div className="accent-grid">
            {ACCENT_COLORS.map((color) => (
              <button
                key={color.value}
                type="button"
                title={color.name}
                className={`accent-swatch ${
                  props.accent.toLowerCase() === color.value.toLowerCase()
                    ? "is-selected"
                    : ""
                }`}
                style={{ backgroundColor: color.value }}
                onClick={() => props.onSelectAccent(color.value)}
              />
            ))}
          </div>
          <label className="accent-custom">
            Свой цвет
            <input
              type="color"
              value={props.accent}
              onChange={(event) => props.onSelectAccent(event.target.value)}
            />
          </label>
        </div>
      </div>
    </div>
  );
}
