// Файл, открытый из дерева, — вкладкой рядом с терминалами.
//
// Содержимое читается и пишется теми же командами, что и правка файла в панели
// изменений: путь один, проверки одни, и второй способ добраться до диска
// заводить незачем.

import { useCallback, useEffect, useRef, useState } from "react";
import { IDockviewPanelProps } from "dockview";
import { localizeBackendError, useI18n } from "../i18n";
import { readRepoFile, writeRepoFile } from "../git/gitChanges";

type Params = { workspaceId?: string; path?: string };

type Loaded = {
  text: string;
  /// Двоичный или слишком большой файл показывать нечем, и править тем более.
  readOnly: boolean;
  /// Почему он только для чтения — иначе пустое поле выглядит как пустой файл.
  note: string;
};

export function FilePanel(props: IDockviewPanelProps<Params>) {
  const { t } = useI18n();
  const workspaceId = props.params?.workspaceId ?? "";
  const path = props.params?.path ?? "";
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Заголовок вкладки помечается звёздочкой, пока правка не сохранена: иначе
  // закрытая панель уносит её молча.
  const dirty = loaded !== null && text !== loaded.text;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    if (!workspaceId || !path) {
      return;
    }
    void readRepoFile(workspaceId, path)
      .then((file) => {
        if (cancelled) {
          return;
        }
        const note = !file.exists
          ? t("files.missing")
          : file.isBinary
            ? t("files.binary")
            : file.tooLarge
              ? t("files.tooLarge")
              : "";
        setLoaded({ text: file.content, readOnly: note !== "", note });
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
  }, [workspaceId, path, t]);

  const save = useCallback(async () => {
    if (!dirtyRef.current || saving) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await writeRepoFile(workspaceId, path, text);
      setLoaded((current) => (current ? { ...current, text } : current));
    } catch (cause) {
      setError(localizeBackendError(cause));
    } finally {
      setSaving(false);
    }
  }, [workspaceId, path, text, saving]);

  const title = path.split("/").pop() ?? path;
  useEffect(() => {
    props.api.setTitle(dirty ? `${title} •` : title);
  }, [props.api, title, dirty]);

  return (
    <div className="file-panel">
      <div className="file-panel-header">
        <span className="file-panel-path" title={path}>
          {path}
        </span>
        {loaded?.note && (
          <span className="file-panel-note">{loaded.note}</span>
        )}
        {!loaded?.readOnly && (
          <button
            type="button"
            className="file-panel-save"
            disabled={!dirty || saving}
            title={t("files.saveShortcut")}
            onClick={() => void save()}
          >
            {t("files.save")}
          </button>
        )}
      </div>
      {error && (
        <div className="file-panel-error" role="alert">
          {error}
        </div>
      )}
      {loaded === null && !error ? (
        <div className="file-panel-empty">{t("files.loading")}</div>
      ) : (
        <textarea
          className="file-panel-text"
          aria-label={path}
          spellCheck={false}
          readOnly={loaded?.readOnly ?? true}
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
