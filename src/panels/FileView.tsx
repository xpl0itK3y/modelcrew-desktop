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
import { grammarOf, tokenize } from "../files/highlight";

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
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  // Язык от имени файла, а не от содержимого: имя мы знаем сразу, а угадывать
  // язык по тексту — отдельная задача с собственными ошибками.
  const language = grammarOf(path.split("/").pop() ?? path);

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
    // Уходя, снимаем метку за собой: без этого закрытая вкладка оставляла бы
    // за собой обещание несохранённой правки, которой уже нет.
    return () => notify.current?.(false);
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
        <div className="file-view-code">
          {/* Подсветка лежит под полем ввода, а не заменяет его: правка
              остаётся обычным текстовым полем со своим курсором, выделением и
              отменой, а красит только фон. Оба слоя обязаны совпадать до
              пикселя — отсюда общий шрифт, отступы и межстрочный интервал. */}
          <pre className="file-view-paint" aria-hidden="true">
            {tokenize(text, language).map((token, index) => (
              <span key={index} className={`tok-${token.kind}`}>
                {token.text}
              </span>
            ))}
            {/* Последняя строка без перевода иначе не даёт слою высоты, и
                поле прокручивается на строку дальше подсветки. */}
            {"\n"}
          </pre>
          <textarea
            ref={textRef}
            className="file-view-text"
            aria-label={path}
            spellCheck={false}
            readOnly={loaded === null || loaded.blocked !== null}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onScroll={(event) => {
              const paint = event.currentTarget
                .previousElementSibling as HTMLElement | null;
              if (paint) {
                paint.scrollTop = event.currentTarget.scrollTop;
                paint.scrollLeft = event.currentTarget.scrollLeft;
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void save();
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
