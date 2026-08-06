// Один открытый файл: заголовок, текст, сохранение.
//
// Живёт в своей колонке рядом с деревом, а не вкладкой среди терминалов: файл
// к терминалу отношения не имеет, и делить с ним сетку значит мешать две
// разные работы в одном месте.
//
// Содержимое читается и пишется теми же командами, что и правка файла в панели
// изменений: путь один, проверки одни, и второй способ добраться до диска
// заводить незачем.

import { useCallback, useEffect, useRef, useState } from "react";
import { localizeBackendError, useI18n } from "../i18n";
import { readWorkspaceFile, writeWorkspaceFile } from "../files/fileTree";

type Loaded = {
  text: string;
  /// Почему файл нельзя править: двоичный, слишком большой или его уже нет.
  /// Храним признак, а не готовую строку — строку собирает отрисовка, и при
  /// смене языка она меняется вместе со всем остальным.
  blocked: "binary" | "tooLarge" | "missing" | null;
};

const BLOCKED_TEXT = {
  binary: "files.binary",
  tooLarge: "files.tooLarge",
  missing: "files.missing",
} as const;

export function FileView(props: {
  workspaceId: string;
  path: string;
  /// Есть ли несохранённая правка: по ней вкладка ставит метку, а закрытие
  /// спрашивает подтверждение.
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const { workspaceId, path, onDirtyChange } = props;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = loaded !== null && text !== loaded.text;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // Сообщаем наружу только о смене признака. Если вешать эффект и на сам
  // обратный вызов, любой его новый экземпляр — а он у родителя новый на каждом
  // рендере — снова дёргал бы родителя, и рендер зациклился бы насмерть:
  // синхронно, так что даже таймаут проверки не сработает.
  const notify = useRef(onDirtyChange);
  notify.current = onDirtyChange;
  useEffect(() => {
    notify.current?.(dirty);
  }, [dirty]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    if (!workspaceId || !path) {
      return;
    }
    void readWorkspaceFile(workspaceId, path)
      .then((file) => {
        if (cancelled) {
          return;
        }
        setLoaded({
          text: file.content,
          blocked: !file.exists
            ? "missing"
            : file.isBinary
              ? "binary"
              : file.tooLarge
                ? "tooLarge"
                : null,
        });
        setText(file.content);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(localizeBackendError(cause));
        }
      });
    return () => {
      cancelled = true;
    };
    // `t` сюда не входит нарочно: useI18n отдаёт новую функцию на каждом
    // рендере, и эффект, зависящий от неё, перечитывал бы файл без конца —
    // синхронным циклом, в котором окно просто перестаёт отвечать.
  }, [workspaceId, path]);

  const save = useCallback(async () => {
    if (!dirtyRef.current || saving) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await writeWorkspaceFile(workspaceId, path, text);
      setLoaded((current) => (current ? { ...current, text } : current));
    } catch (cause) {
      setError(localizeBackendError(cause));
    } finally {
      setSaving(false);
    }
  }, [workspaceId, path, text, saving]);

  return (
    <div className="file-view">
      <div className="file-view-header">
        <span className="file-view-path" title={path}>
          {path}
        </span>
        {loaded?.blocked && (
          <span className="file-view-note">{t(BLOCKED_TEXT[loaded.blocked])}</span>
        )}
        {loaded !== null && loaded.blocked === null && (
          <button
            type="button"
            className="file-view-save"
            disabled={!dirty || saving}
            title={t("files.saveShortcut")}
            onClick={() => void save()}
          >
            {t("files.save")}
          </button>
        )}
      </div>
      {error && (
        <div className="file-view-error" role="alert">
          {error}
        </div>
      )}
      {loaded === null && !error ? (
        <div className="file-view-empty">{t("files.loading")}</div>
      ) : (
        <textarea
          className="file-view-text"
          aria-label={path}
          spellCheck={false}
          readOnly={loaded === null || loaded.blocked !== null}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
        />
      )}
    </div>
  );
}
