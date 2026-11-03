import { useEffect, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "../Icons";
import {
  SettingsSectionProvider,
  useSettingsPageEntry,
  useSettingsSearchEntry,
  type SettingsSectionId,
} from "./SettingsSearch";

type PageProps = {
  section: SettingsSectionId;
  title: string;
  // У раздела-заглушки вступления нет: заголовка и одного слова достаточно.
  intro?: string;
  // Слова, которых нет на странице, но по которым раздел ищут (имена
  // серверов MCP).
  keywords?: string;
  children: ReactNode;
};

export function SettingsPage(props: PageProps) {
  const matched = useSettingsPageEntry(
    props.section,
    [props.title, props.intro, props.keywords].filter(Boolean).join(" "),
  );
  return (
    <SettingsSectionProvider section={props.section} matched={matched}>
      <div className="settings-page">
        <h2 className="settings-page-title">{props.title}</h2>
        {props.intro && <p className="settings-page-intro">{props.intro}</p>}
        <div className="settings-rows">{props.children}</div>
      </div>
    </SettingsSectionProvider>
  );
}

type RowProps = {
  title: string;
  description?: string;
  // Метка рядом с названием: настройка ещё обкатывается и может вести себя
  // не идеально. Попадает и в поиск — «бета» находит все такие строки.
  badge?: string;
  // Слова, которых нет в заголовке и пояснении, но по которым настройку ищут
  // (названия тем, имена звуков).
  keywords?: string;
  // Крупные элементы управления — сетка тем, палитра — не помещаются справа и
  // занимают всю ширину строки под заголовком.
  layout?: "inline" | "stacked";
  // Картинка слева от названия: пока это аватар вошедшего через GitHub.
  media?: ReactNode;
  control: ReactNode;
  note?: ReactNode;
};

export function SettingRow(props: RowProps) {
  const haystack = [props.title, props.description, props.keywords, props.badge]
    .filter(Boolean)
    .join(" ");
  const visible = useSettingsSearchEntry(haystack);
  if (!visible) {
    return null;
  }
  return (
    <div
      className={`settings-row ${props.layout === "stacked" ? "is-stacked" : ""} ${
        props.media ? "has-media" : ""
      }`}
    >
      {props.media}
      <div className="settings-row-copy">
        <span className="settings-row-title">
          {props.title}
          {props.badge && <span className="beta-badge">{props.badge}</span>}
        </span>
        {props.description && (
          <span className="settings-row-description">{props.description}</span>
        )}
      </div>
      <div className="settings-row-control">{props.control}</div>
      {props.note && <div className="settings-row-note">{props.note}</div>}
    </div>
  );
}

type ButtonProps = {
  label: string;
  disabled?: boolean;
  onClick: () => void;
};

export function SettingsButton(props: ButtonProps) {
  return (
    <button
      type="button"
      className="settings-button"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

type SwitchProps = {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
};

export function SettingsSwitch(props: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      className={`settings-switch ${props.checked ? "is-on" : ""}`}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="settings-switch-thumb" aria-hidden="true" />
    </button>
  );
}

type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
  lang?: string;
};

type SegmentedProps<T extends string> = {
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
};

export function SettingsSegmented<T extends string>(props: SegmentedProps<T>) {
  return (
    <div className="settings-segmented" role="group" aria-label={props.label}>
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          lang={option.lang}
          title={option.title}
          disabled={option.disabled}
          aria-pressed={props.value === option.value}
          className={`settings-segment ${
            props.value === option.value ? "is-selected" : ""
          }`}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type SelectProps<T extends string> = {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
  busy?: boolean;
  onChange: (value: T) => void;
};

export function SettingsSelect<T extends string>(props: SelectProps<T>) {
  return (
    <div className={`settings-select ${props.disabled ? "is-disabled" : ""}`}>
      <select
        className="settings-select-input"
        aria-label={props.label}
        aria-busy={props.busy}
        disabled={props.disabled}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value as T)}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronRightIcon className="settings-select-chevron" aria-hidden="true" />
    </div>
  );
}

type TextInputProps = {
  label: string;
  value: string;
  placeholder?: string;
  // Приводит набранное к сохраняемому виду. Поле показывает уже приведённое
  // значение, даже если сохранять нечего: «Menlo,» при сохранённом «Menlo».
  normalize?: (value: string) => string;
  onCommit: (value: string) => void;
};

// Сохраняет по Enter и при уходе фокуса, а не на каждую букву: настройка вроде
// шрифта иначе перерисовывала бы терминалы на полуслове. Esc возвращает
// сохранённое.
export function SettingsTextInput(props: TextInputProps) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);

  const commit = () => {
    const next = props.normalize ? props.normalize(draft) : draft;
    setDraft(next);
    if (next !== props.value) {
      props.onCommit(next);
    }
  };

  return (
    <input
      type="text"
      className="settings-text-input"
      aria-label={props.label}
      value={draft}
      placeholder={props.placeholder}
      spellCheck={false}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape" && draft !== props.value) {
          event.stopPropagation();
          setDraft(props.value);
        }
      }}
    />
  );
}
