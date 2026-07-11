import { useEffect } from "react";
import { ACCENT_COLORS } from "../theme";

type SettingsProps = {
  accent: string;
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
          <button type="button" className="icon-button" onClick={props.onClose} title="Закрыть">
            ✕
          </button>
        </div>

        <div className="settings-section">
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
