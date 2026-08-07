// Один открытый файл: заголовок, текст, сохранение.
//
// Живёт в своей колонке рядом с деревом, а не вкладкой среди терминалов: файл
// к терминалу отношения не имеет, и делить с ним сетку значит мешать две
// разные работы в одном месте.
//
// Содержимое читается и пишется теми же командами, что и правка файла в панели
// изменений: путь один, проверки одни, и второй способ добраться до диска
// заводить незачем.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { localizeBackendError, useI18n } from "../i18n";
import {
  parentOf,
  readWorkspaceFile,
  watchWorkspaceTree,
  writeWorkspaceFile,
  type FileContent,
} from "../files/fileTree";
import { grammarOf, lineOffsets, paintLines } from "../files/highlight";
import { fileName } from "../crew/claimLabel";
import { ConfirmDialog } from "../ui/ConfirmDialog";

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

/// Окно показа: строки `[from, to)`.
type Span = { from: number; to: number };

/// До этого размера файл рисуем целиком. Несколько сотен строк — это тысячи
/// элементов в слое подсветки, с ними браузер справляется не глядя.
const WHOLE = 600;

/// Запас сверху и снизу от видимого. По нему же считается, когда окно пора
/// двигать: пока взгляд внутри запаса, перерисовывать нечего.
const MARGIN = 80;

function blockedBy(file: FileContent): Loaded["blocked"] {
  if (!file.exists) {
    return "missing";
  }
  if (file.isBinary) {
    return "binary";
  }
  return file.tooLarge ? "tooLarge" : null;
}

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
        setLoaded({ text: file.content, blocked: blockedBy(file) });
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
      // Поверх писали осознанно: спрашивали, ответили.
      setStale(null);
    } catch (cause) {
      setError(localizeBackendError(cause));
    } finally {
      setSaving(false);
    }
  }, [workspaceId, path, text, saving]);

  // Тот же файл правит агент в соседней панели — ради этого приложение и
  // существует. Сохранение пишет буфер целиком, так что версия агента исчезала
  // бы от одного нашего нажатия, и узнать об этом было бы неоткуда.
  const [stale, setStale] = useState<FileContent | null>(null);
  const [asking, setAsking] = useState(false);
  const loadedRef = useRef<Loaded | null>(loaded);
  loadedRef.current = loaded;
  useEffect(() => {
    setStale(null);
    setAsking(false);
    if (!workspaceId || !path) {
      return;
    }
    const home = parentOf(path);
    return watchWorkspaceTree(workspaceId, (dirs, partial) => {
      if (!partial && !dirs.includes(home)) {
        return;
      }
      void readWorkspaceFile(workspaceId, path)
        .then((file) => {
          const base = loadedRef.current;
          if (!base || file.content === base.text) {
            // Ещё не прочитали или пришло наше же сохранение.
            return;
          }
          if (dirtyRef.current) {
            // Правки разошлись — решает человек, а не тот, кто нажал последним.
            setStale(file);
            return;
          }
          // Нетронутый буфер догоняет диск сам: это то же самое, что открыть
          // файл заново, только без щелчка.
          setLoaded({ text: file.content, blocked: blockedBy(file) });
          setText(file.content);
        })
        .catch(() => {
          // Перечитывание фоновое: не прочиталось — покажем прежнее.
        });
    });
  }, [workspaceId, path]);

  const adopt = () => {
    if (!stale) {
      return;
    }
    setLoaded({ text: stale.content, blocked: blockedBy(stale) });
    setText(stale.content);
    setStale(null);
  };

  const requestSave = () => {
    if (stale) {
      setAsking(true);
      return;
    }
    void save();
  };

  // Начала строк держим готовыми: по ним берётся окно показа и считаются
  // номера. Пересчёт — только когда текст сменился.
  const offsets = useMemo(() => lineOffsets(text), [text]);
  const lineCount = offsets.length;
  const [window, setWindow] = useState<Span>({ from: 0, to: WHOLE });
  // Файл в несколько сотен строк рисуем целиком: окно на нём — лишняя работа
  // и лишний повод разъехаться.
  const shown: Span =
    lineCount <= WHOLE ? { from: 0, to: lineCount } : window;

  // Разбор стоит десятки миллисекунд на большом файле, а рендер случается и от
  // того, что сменилась метка правки или подъехала полоска: пересчитывать его
  // там, где текст и окно те же, незачем.
  const painted = useMemo(
    () => paintLines(text, language, offsets, shown.from, shown.to),
    [text, language, offsets, shown.from, shown.to],
  );
  const numbers = useMemo(() => {
    const rows: string[] = [];
    for (let line = shown.from; line < shown.to; line += 1) {
      rows.push(String(line + 1));
    }
    return rows.join("\n");
  }, [shown.from, shown.to]);

  // Открыли другой файл — окно начинается сверху.
  useEffect(() => setWindow({ from: 0, to: WHOLE }), [workspaceId, path]);

  const paintRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLPreElement | null>(null);

  // Прокрутка ведёт за собой оба нижних слоя и, если ушла за край окна,
  // передвигает само окно.
  const follow = useCallback(() => {
    const element = textRef.current;
    if (!element) {
      return;
    }
    if (paintRef.current) {
      paintRef.current.scrollTop = element.scrollTop;
      paintRef.current.scrollLeft = element.scrollLeft;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = element.scrollTop;
    }
    const perLine = element.scrollHeight / Math.max(1, lineCount);
    if (!(perLine > 0)) {
      // Высоты нет — окно оставляем как есть. Так бывает у скрытой вкладки: она
      // смонтирована, но не показана, и мерить у неё нечего.
      return;
    }
    const first = Math.floor(element.scrollTop / perLine);
    const last = Math.ceil((element.scrollTop + element.clientHeight) / perLine);
    setWindow((current) =>
      first < current.from || last > current.to
        ? {
            from: Math.max(0, first - MARGIN),
            to: Math.min(lineCount, last + MARGIN),
          }
        : current,
    );
  }, [lineCount]);

  // Не только на прокрутку: колонку тянут за разделитель, окно приложения
  // меняет высоту — видно становится больше строк, чем нарисовано.
  useEffect(() => {
    follow();
    globalThis.addEventListener("resize", follow);
    return () => globalThis.removeEventListener("resize", follow);
  }, [follow, text]);

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
            onClick={requestSave}
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
      {stale && (
        <div className="file-view-stale" role="alert">
          <span className="file-view-stale-text">{t("files.changedOnDisk")}</span>
          <button type="button" className="file-view-reload" onClick={adopt}>
            {t("files.reload")}
          </button>
        </div>
      )}
      {loaded === null && !error ? (
        <div className="file-view-empty">{t("files.loading")}</div>
      ) : (
        <div
          className="file-view-code"
          style={
            { "--file-digits": `${String(lineCount).length}ch` } as CSSProperties
          }
        >
          {/* Подсветка лежит под полем ввода, а не заменяет его: правка
              остаётся обычным текстовым полем со своим курсором, выделением и
              отменой, а красит только фон. Оба слоя обязаны совпадать до
              пикселя — отсюда общий шрифт, отступы и межстрочный интервал.

              Строки до окна и после него — это ровно столько переводов строки,
              сколько их там на самом деле. Пустая строка в `pre` имеет ту же
              высоту, что и любая другая, поэтому окно встаёт на своё место без
              единого вычисления в пикселях: разъехаться тут нечему. */}
          <pre ref={paintRef} className="file-view-paint" aria-hidden="true">
            {"\n".repeat(shown.from)}
            {painted.map((token, index) => (
              <span key={index} className={`tok-${token.kind}`}>
                {token.text}
              </span>
            ))}
            {/* Хвост и последняя строка без перевода: без них слой ниже поля
                кончается раньше, и подсветка отстаёт на строку. */}
            {"\n".repeat(Math.max(0, lineCount - shown.to) + 1)}
          </pre>
          <textarea
            ref={textRef}
            className="file-view-text"
            aria-label={path}
            spellCheck={false}
            readOnly={loaded === null || loaded.blocked !== null}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onScroll={follow}
            onKeyDown={(event) => {
              if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                requestSave();
              }
            }}
          />
          {/* Номера поверх обоих слоёв и с непрозрачной подложкой: длинная
              строка уезжает под них, а не поверх. Мышь их не видит — щелчок
              по номеру должен попадать в текст. */}
          <pre ref={gutterRef} className="file-view-lines" aria-hidden="true">
            {"\n".repeat(shown.from)}
            {numbers}
            {"\n".repeat(Math.max(0, lineCount - shown.to) + 1)}
          </pre>
        </div>
      )}
      {asking && (
        <ConfirmDialog
          text={t("files.overwriteChanged", { name: fileName(path) })}
          confirmLabel={t("files.overwrite")}
          tone="danger"
          onConfirm={() => {
            setAsking(false);
            void save();
          }}
          onCancel={() => setAsking(false)}
        />
      )}
    </div>
  );
}
