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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { localizeBackendError, useI18n } from "../i18n";
import {
  parentOf,
  readWorkspaceFile,
  watchWorkspaceTree,
  writeWorkspaceFile,
  type FileContent,
} from "../files/fileTree";
import {
  commentMarks,
  grammarOf,
  lineOffsets,
  paintLines,
} from "../files/highlight";
import { findAll, lineAt, nearest, NO_MATCHES } from "../files/search";
import {
  breakLine,
  deleteLines,
  duplicateLines,
  indent,
  indentUnitOf,
  moveLines,
  outdent,
  toggleComment,
  type Edit,
} from "../files/editing";
import { imageMimeOf, svgSource } from "../files/media";
import { useLineMarks } from "../git/useLineMarks";
import { MarkdownView } from "./MarkdownView";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  CodeIcon,
  EyeIcon,
  WrapIcon,
} from "../ui/Icons";
import { KEYS, readSetting, writeSetting } from "../settings/storage";
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
  /// Эту вкладку сейчас видно. Остальные смонтированы, но спрятаны — им незачем
  /// ходить на диск за каждой правкой агента: посмотрят, когда их откроют.
  visible?: boolean;
  /// Есть ли несохранённая правка: по ней вкладка ставит метку, а закрытие
  /// спрашивает подтверждение.
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const { workspaceId, path, onDirtyChange } = props;
  const visible = props.visible ?? true;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const name = path.split("/").pop() ?? path;
  // Язык от имени файла, а не от содержимого: имя мы знаем сразу, а угадывать
  // язык по тексту — отдельная задача с собственными ошибками.
  const language = grammarOf(name);

  // Разметку можно не только править, но и читать: заголовки заголовками,
  // списки списками. То же и с SVG: это текст, но текст, который нарисован.
  // Выбор запоминается на всё приложение — тот, кто открывает .md чтобы
  // прочитать, открывает так каждый раз, и щёлкать глазом на каждом файле ему
  // незачем.
  const markdown = language === "md";
  const vector = imageMimeOf(name) === "image/svg+xml";
  const [preview, setPreview] = useState(
    () => readSetting(KEYS.filePreview) === "1",
  );
  const showPreview = (markdown || vector) && preview;
  const togglePreview = () => {
    setPreview((current) => {
      writeSetting(KEYS.filePreview, current ? "0" : "1");
      return !current;
    });
  };

  const previewLabel = showPreview
    ? "files.source"
    : markdown
      ? "files.preview"
      : "files.previewImage";

  // Отступ берём у самого файла: чужой файл правят его отступом, каким бы он
  // ни был. Считаем по версии с диска, а не по каждому нажатию: она меняется
  // раз в сохранение, а нажатий между ними тысяча.
  const unit = useMemo(() => indentUnitOf(loaded?.text ?? ""), [loaded?.text]);
  const comment = useMemo(() => commentMarks(language), [language]);

  // Куда поставить выделение после того, как React перерисует поле. Раньше
  // ставить нельзя: значение поля задаёт React, и до его отрисовки в поле ещё
  // старый текст, а выделение считается по новому.
  const pending = useRef<{ from: number; to: number } | null>(null);
  useLayoutEffect(() => {
    const place = pending.current;
    const field = textRef.current;
    if (!place || !field) {
      return;
    }
    pending.current = null;
    field.setSelectionRange(place.from, place.to);
  }, [text]);

  /// Записать правку в поле руками браузера, а не в обход него: тогда у поля
  /// остаётся собственная отмена, и ⌘Z возвращает то, что было до Tab, а не
  /// откатывает всё до последней перерисовки.
  const apply = (edit: Edit | null) => {
    const field = textRef.current;
    if (!edit || !field || edit.text === text) {
      return;
    }
    // Заменяем не весь текст, а тот кусок, которым две версии отличаются:
    // браузер запомнит в отмене именно его.
    let head = 0;
    const before = field.value;
    const shortest = Math.min(before.length, edit.text.length);
    while (head < shortest && before[head] === edit.text[head]) {
      head += 1;
    }
    let tail = 0;
    while (
      tail < shortest - head &&
      before[before.length - 1 - tail] === edit.text[edit.text.length - 1 - tail]
    ) {
      tail += 1;
    }
    const inserted = edit.text.slice(head, edit.text.length - tail);
    field.setSelectionRange(head, before.length - tail);
    const written =
      inserted === ""
        ? document.execCommand?.("delete")
        : document.execCommand?.("insertText", false, inserted);
    if (!written) {
      // Движок без execCommand — пишем напрямую. Отмена в поле при этом теряет
      // эту правку, но потерять саму правку было бы хуже.
      field.value = edit.text;
    }
    pending.current = { from: edit.from, to: edit.to };
    setText(edit.text);
  };

  /// Сочетание клавиш по месту клавиши, а не по букве на ней: на русской
  /// раскладке ⌘S — это «ы», и проверка по букве молча перестаёт работать
  /// ровно тогда, когда человек переключил язык.
  const pressed = (event: KeyboardEvent | ReactKeyboardEvent, code: string, key: string) =>
    event.code === code || event.key.toLowerCase() === key;

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
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Пока вкладка была спрятана, файл на диске менялся.
  const missed = useRef(false);

  const recheck = useCallback(() => {
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
  }, [workspaceId, path]);

  useEffect(() => {
    setStale(null);
    setAsking(false);
    missed.current = false;
    if (!workspaceId || !path) {
      return;
    }
    const home = parentOf(path);
    return watchWorkspaceTree(workspaceId, (dirs, partial) => {
      if (!partial && !dirs.includes(home)) {
        return;
      }
      if (!visibleRef.current) {
        // Спрятанная вкладка ждёт своей очереди: держать по чтению файла на
        // каждую вкладку и на каждую правку агента — это работа, которой
        // никто не видит, и окно за ней не успевает.
        missed.current = true;
        return;
      }
      recheck();
    });
  }, [workspaceId, path, recheck]);

  // Вкладку открыли — догоняем всё, что пропустили, пока она была скрыта.
  useEffect(() => {
    if (visible && missed.current) {
      missed.current = false;
      recheck();
    }
  }, [visible, recheck]);

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

  // Какие строки git ещё не видел. Двоичный и слишком большой файл сравнивать
  // не с чем: у первого нет строк, у второго нет содержимого.
  const marks = useLineMarks(
    workspaceId,
    path,
    text,
    loaded !== null && loaded.blocked === null,
  );

  // Номера и полоска правок — один слой, а не два. Полоска обязана стоять
  // строка в строку с номером, и двум отдельным слоям разъехаться было бы куда
  // проще, чем сойтись. Текст в каждой строке один и тот же — номер и пробел, —
  // меняется только то, покрашен пробел или нет; поэтому слой остаётся ровно
  // такой же высоты, какой был.
  const numbers = useMemo(() => {
    const rows: ReactNode[] = [];
    for (let line = shown.from; line < shown.to; line += 1) {
      const mark = marks.get(line);
      rows.push(String(line + 1));
      rows.push(
        mark ? (
          <span key={line} className={`file-mark is-${mark}`}>
            {" "}
          </span>
        ) : (
          " "
        ),
      );
      rows.push("\n");
    }
    return rows;
  }, [shown.from, shown.to, marks]);

  // Открыли другой файл — окно начинается сверху.
  useEffect(() => setWindow({ from: 0, to: WHOLE }), [workspaceId, path]);

  const paintRef = useRef<HTMLPreElement | null>(null);
  const foundRef = useRef<HTMLPreElement | null>(null);
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
    if (foundRef.current) {
      foundRef.current.scrollTop = element.scrollTop;
      foundRef.current.scrollLeft = element.scrollLeft;
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

  // Поиск по файлу. Пока строка не открыта, ничего не считается и ничего не
  // рисуется: у закрытого поиска нет ни запроса, ни совпадений.
  const [query, setQuery] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const queryRef = useRef<HTMLInputElement | null>(null);
  const found = useMemo(
    () => (query ? findAll(text, query) : NO_MATCHES),
    [text, query],
  );

  const openFind = () => {
    const field = textRef.current;
    // Выделенное слово и есть то, что ищут: это первое, что делают руками.
    const picked =
      field && field.selectionEnd > field.selectionStart
        ? text.slice(field.selectionStart, field.selectionEnd)
        : null;
    setQuery((was) => (picked && !picked.includes("\n") ? picked : (was ?? "")));
    setCurrent(0);
    // Строка уже открыта — щелчок по ⌘F ставит курсор обратно в неё.
    globalThis.requestAnimationFrame(() => queryRef.current?.select());
  };

  const closeFind = () => {
    setQuery(null);
    textRef.current?.focus();
  };

  /// Перейти к совпадению по кругу: за последним идёт первое.
  const step = (delta: number) => {
    if (found.at.length === 0) {
      return;
    }
    setCurrent((was) => (was + delta + found.at.length) % found.at.length);
  };

  // Показать текущее совпадение: выделить его в поле и подвинуть прокрутку.
  // Прокрутка полем, а не элементом внутри слоя подсветки: слой рисует только
  // окно показа, и того, что за его краем, в нём просто нет.
  useEffect(() => {
    const field = textRef.current;
    const at = found.at[current];
    if (!field || at === undefined || !visible) {
      return;
    }
    field.setSelectionRange(at, at + found.length);
    const perLine = field.scrollHeight / Math.max(1, lineCount);
    if (perLine > 0) {
      const line = lineAt(offsets, at);
      const top = line * perLine;
      // Двигаемся, только если совпадение вне видимого: иначе каждая буква в
      // строке поиска дёргала бы файл под руками.
      if (top < field.scrollTop || top > field.scrollTop + field.clientHeight - perLine) {
        field.scrollTop = Math.max(0, top - field.clientHeight / 2);
        follow();
      }
    }
  }, [found, current, visible, lineCount, offsets, follow]);

  const countLabel =
    query === null || query === ""
      ? ""
      : found.at.length === 0
        ? t("files.findNone")
        : t(found.capped ? "files.findCapped" : "files.findCount", {
            index: String(current + 1),
            total: String(found.at.length),
          });

  // Запрос сменился — идём к тому совпадению, что ближе к прежнему месту.
  useEffect(() => {
    const field = textRef.current;
    setCurrent(nearest(found.at, field ? field.selectionStart : 0));
    // Только на смену набора совпадений: в остальном шагами двигает человек.
  }, [found]);

  // Перенос длинных строк. Длинный JSON и абзац в README уезжают вбок на
  // километр, и читать их можно только тягая полосу прокрутки.
  const [wrap, setWrap] = useState(() => readSetting(KEYS.wrapLines) === "1");
  const toggleWrap = () => {
    setWrap((current) => {
      writeSetting(KEYS.wrapLines, current ? "0" : "1");
      return !current;
    });
  };

  // Текст выше и ниже окна показа. Пока строки не переносятся, это ровно
  // столько переводов строки, сколько там строк: пустая строка в `pre` той же
  // высоты, что любая другая, и слои сходятся без единого вычисления.
  //
  // С переносом это неверно: перенесённая строка занимает два ряда, а перевод
  // строки — один, и слой подсветки уехал бы вверх на разницу. Поэтому при
  // переносе за окном лежит сам текст — он и переносится так же, как в поле.
  // Это один узел на всё, а не по элементу на строку, и стоит он не дороже
  // того, что поле рисует и так.
  const head = offsets[shown.from] ?? 0;
  const foot = shown.to >= lineCount ? text.length : offsets[shown.to] - 1;
  const above = wrap ? text.slice(0, head) : "\n".repeat(shown.from);
  const below =
    (wrap ? text.slice(foot) : "\n".repeat(Math.max(0, lineCount - shown.to))) +
    "\n";

  // Номера при переносе: каждый едет со своей строкой, а для этого лежит с ней
  // в одном потоке — вместе с самим текстом строки, невидимым, но переносящимся
  // точно так же. Сам номер ширины не занимает: его коробка отрицательным полем
  // сдвинута ровно на свою ширину влево, и перенос от неё не меняется ни на
  // знак.
  const wrappedNumbers = useMemo(() => {
    if (!wrap) {
      return null;
    }
    const rows: ReactNode[] = [];
    for (let line = shown.from; line < shown.to; line += 1) {
      const mark = marks.get(line);
      const start = offsets[line];
      const end = line + 1 < lineCount ? offsets[line + 1] - 1 : text.length;
      rows.push(
        <span key={line} className="file-no">
          {String(line + 1)}
          {mark ? (
            <span className={`file-mark is-${mark}`}> </span>
          ) : (
            " "
          )}
        </span>,
      );
      rows.push(text.slice(start, end));
      rows.push("\n");
    }
    return rows;
  }, [wrap, shown.from, shown.to, marks, offsets, text, lineCount]);

  /// Совпадения в окне показа, кусками текста и метками. Слой лежит между
  /// подсветкой и полем ввода, поэтому у меток только фон — цвет букв виден
  /// сквозь них, с нижнего слоя.
  const highlighted = useMemo(() => {
    if (!query || found.at.length === 0) {
      return null;
    }
    const start = offsets[shown.from] ?? 0;
    const end = shown.to >= lineCount ? text.length : offsets[shown.to] - 1;
    const parts: ReactNode[] = [];
    let at = start;
    for (let index = 0; index < found.at.length; index += 1) {
      const from = found.at[index];
      if (from + found.length <= start) {
        continue;
      }
      if (from >= end) {
        break;
      }
      // Совпадение, начавшееся выше окна, показываем с его края: слоя выше нет,
      // и лишние буквы сдвинули бы всё, что ниже.
      const left = Math.max(from, start);
      const right = Math.min(from + found.length, end);
      parts.push(text.slice(at, left));
      parts.push(
        <mark
          key={index}
          className={index === current ? "file-found is-current" : "file-found"}
        >
          {text.slice(left, right)}
        </mark>,
      );
      at = right;
    }
    parts.push(text.slice(at, end));
    return parts;
  }, [query, found, current, shown.from, shown.to, offsets, text, lineCount]);

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
        {(markdown || vector) && loaded !== null && loaded.blocked === null && (
          <button
            type="button"
            className="file-view-preview icon-button"
            title={t(previewLabel)}
            aria-label={t(previewLabel)}
            aria-pressed={showPreview}
            onClick={togglePreview}
          >
            {showPreview ? <CodeIcon /> : <EyeIcon />}
          </button>
        )}
        {loaded !== null && !showPreview && (
          <button
            type="button"
            className="file-view-preview icon-button"
            title={t(wrap ? "files.wrapOff" : "files.wrap")}
            aria-label={t(wrap ? "files.wrapOff" : "files.wrap")}
            aria-pressed={wrap}
            onClick={toggleWrap}
          >
            <WrapIcon />
          </button>
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
      ) : showPreview && markdown && loaded?.blocked === null ? (
        /* Показываем то, что в поле, а не то, что на диске: несохранённая
           правка обязана быть видна и здесь, иначе просмотр врёт про файл,
           который прямо сейчас правят. */
        <MarkdownView text={text} />
      ) : showPreview && loaded?.blocked === null ? (
        /* SVG уезжает в адрес картинки, а не в разметку страницы. Внутри
           `<img>` не выполняется ни скрипт, ни обработчик события — а SVG
           умеет и то и другое, и пишет его агент. */
        <div className="picture-sheet">
          <img className="picture-shown" src={svgSource(text)} alt={name} />
        </div>
      ) : (
        <div
          className={`file-view-code ${wrap ? "is-wrapped" : ""}`}
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
            {above}
            {painted.map((token, index) => (
              <span key={index} className={`tok-${token.kind}`}>
                {token.text}
              </span>
            ))}
            {/* Хвост и последняя строка без перевода: без них слой ниже поля
                кончается раньше, и подсветка отстаёт на строку. */}
            {below}
          </pre>
          {highlighted && (
            <pre ref={foundRef} className="file-view-found" aria-hidden="true">
              {above}
              {highlighted}
              {below}
            </pre>
          )}
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
              const meta = event.metaKey || event.ctrlKey;
              if (meta && pressed(event, "KeyS", "s")) {
                event.preventDefault();
                requestSave();
                return;
              }
              if (meta && pressed(event, "KeyF", "f")) {
                event.preventDefault();
                openFind();
                return;
              }
              if (event.key === "Escape" && query !== null) {
                event.preventDefault();
                closeFind();
                return;
              }
              // Правки — только там, где правят: у двоичного и слишком
              // большого файла поле только для чтения.
              if (loaded === null || loaded.blocked !== null) {
                return;
              }
              const field = event.currentTarget;
              const from = field.selectionStart;
              const to = field.selectionEnd;
              if (event.key === "Tab") {
                // Tab уводил фокус из поля — на этом спотыкаются первым делом:
                // в текстовом поле он должен ставить отступ.
                event.preventDefault();
                apply(
                  event.shiftKey
                    ? outdent(text, from, to, unit)
                    : indent(text, from, to, unit),
                );
                return;
              }
              if (event.key === "Enter" && !meta && !event.altKey) {
                event.preventDefault();
                apply(breakLine(text, from, to, unit));
                return;
              }
              if (meta && pressed(event, "Slash", "/")) {
                event.preventDefault();
                apply(toggleComment(text, from, to, comment));
                return;
              }
              if (meta && event.shiftKey && pressed(event, "KeyD", "d")) {
                event.preventDefault();
                apply(duplicateLines(text, from, to));
                return;
              }
              if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                event.preventDefault();
                apply(moveLines(text, from, to, event.key === "ArrowUp" ? -1 : 1));
                return;
              }
              if (meta && event.key === "Backspace") {
                event.preventDefault();
                apply(deleteLines(text, from, to));
              }
            }}
          />
          {/* Номера поверх обоих слоёв и с непрозрачной подложкой: длинная
              строка уезжает под них, а не поверх. Мышь их не видит — щелчок
              по номеру должен попадать в текст. */}
          <pre ref={gutterRef} className="file-view-lines" aria-hidden="true">
            {wrap ? text.slice(0, head) : "\n".repeat(shown.from)}
            {wrap ? wrappedNumbers : numbers}
            {/* Перевод строки у каждой строки уже свой, поэтому хвост здесь на
                один короче, чем у слоя подсветки: вместе они дают ту же высоту. */}
            {wrap
              ? text.slice(foot + 1)
              : "\n".repeat(Math.max(0, lineCount - shown.to))}
          </pre>
          {query !== null && (
            /* Строка поиска лежит поверх текста, а не над ним: появившись в
               потоке, она сдвинула бы файл под курсором на свою высоту. */
            <div className="file-find">
              <input
                ref={queryRef}
                className="file-find-query"
                value={query}
                placeholder={t("files.findQuery")}
                aria-label={t("files.find")}
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    step(event.shiftKey ? -1 : 1);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeFind();
                  }
                }}
              />
              <span className="file-find-count">{countLabel}</span>
              <button
                type="button"
                className="file-find-step icon-button"
                title={t("files.findPrevious")}
                aria-label={t("files.findPrevious")}
                disabled={found.at.length === 0}
                onClick={() => step(-1)}
              >
                <ChevronUpIcon />
              </button>
              <button
                type="button"
                className="file-find-step icon-button"
                title={t("files.findNext")}
                aria-label={t("files.findNext")}
                disabled={found.at.length === 0}
                onClick={() => step(1)}
              >
                <ChevronDownIcon />
              </button>
              <button
                type="button"
                className="file-find-step icon-button"
                title={t("files.findClose")}
                aria-label={t("files.findClose")}
                onClick={closeFind}
              >
                <CloseIcon />
              </button>
            </div>
          )}
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
