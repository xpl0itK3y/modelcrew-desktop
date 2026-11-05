// Колонка редактора: вкладки открытых файлов и сам файл под ними.
//
// Стоит между деревом и сеткой терминалов и раздвигает её. В сетку файл не
// кладётся нарочно: там живут терминалы, у них своя логика раскладки и
// сохранения, и файл среди них выглядит как ещё один терминал, которым он не
// является.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useI18n } from "../i18n";
import { isMac } from "../platform";
import { isCoveredByModal } from "../hotkeys/modalGuard";
import { OWN_CLOSE_KEY } from "../hotkeys/ownCloseKey";
import { CloseIcon, MaximizeIcon } from "../ui/Icons";
import { fileGlyph } from "../files/fileGlyph";
import { fileName } from "../crew/claimLabel";
import { FileView } from "./FileView";
import { ImageView } from "./ImageView";
import { drawnAsImage } from "../files/media";
import { useGitStatuses } from "../git/useGitStatuses";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { reducedMotion } from "../animations";
import { shownTabs, type ShownTab } from "../files/openFiles";

// Столько же живёт то же число в file-tree.css: по нему колонка возвращается
// на место, и разъехаться им нельзя.
const MAXIMIZE_MS = 200;

// Сколько вкладка уходит и сколько проявляется файл, вставший на место
// закрытого или только что открытый. Короче колонки: та уезжает целиком, а
// здесь меняется одна вкладка.
const TAB_MS = 160;

// Сколько разворачивается вкладка и поднимается на место открытый файл.
// Дольше закрытия: уходящее не разглядывают, а появившееся — да, и глазу
// нужно время понять, откуда оно взялось.
const OPEN_MS = 220;

// Открытое быстро выходит и мягко садится на место.
const SETTLE = "cubic-bezier(0.2, 0, 0, 1)";

// Сколько открытый файл ждёт своего текста невидимым. Обычно текст приходит
// за пару десятков миллисекунд; большой файл читается дольше, и пустая
// колонка всё это время выглядела бы зависшей — тогда проявляем что есть.
const READY_WAIT_MS = 250;

/// Двигать есть чем и можно: движок умеет Web Animations, а человек не просил
/// обходиться без движения. Без этого закрытие остаётся мгновенным, как было.
function moving(): boolean {
  return typeof Element.prototype.animate === "function" && !reducedMotion();
}

/// Вкладка во всю свою ширину и она же схлопнутая. От настоящей ширины, а не
/// от предела в 200px: короткая вкладка иначе половину времени стояла бы на
/// месте. Отступ и рамка меняются вместе с ней, а зазор до соседа съедает
/// отрицательное поле — когда вкладку снимут или отпустят, ничего не дёрнется.
///
/// Содержимое замирает в своей ширине: меняется вкладка, а имя в ней уходит
/// за край или выходит из-за него. Иначе имя таяло бы многоточием, буква за
/// буквой. `release` отпускает его обратно.
function tabFrames(element: HTMLElement): {
  full: Keyframe;
  gone: Keyframe;
  release: () => void;
} {
  const children = [...element.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  );
  const widths = children.map((child) => child.getBoundingClientRect().width);
  children.forEach((child, at) => {
    child.style.flex = `0 0 ${widths[at]}px`;
  });
  const style = getComputedStyle(element);
  const inner =
    element.getBoundingClientRect().width -
    parseFloat(style.paddingLeft) -
    parseFloat(style.paddingRight) -
    parseFloat(style.borderLeftWidth) -
    parseFloat(style.borderRightWidth);
  return {
    full: {
      maxWidth: `${Math.max(0, inner)}px`,
      paddingRight: style.paddingRight,
      borderRightWidth: style.borderRightWidth,
      marginRight: "0px",
      opacity: 1,
    },
    gone: {
      maxWidth: "0px",
      paddingRight: "0px",
      borderRightWidth: "0px",
      marginRight: "-1px",
      opacity: 0,
    },
    release: () => {
      for (const child of children) {
        child.style.flex = "";
      }
    },
  };
}

/// Ключ уходящей вкладки — не её путь: откроют файл снова, пока она уходит, и
/// новая вкладка должна быть новой, а не той же, уже погасшей. Ноля в пути не
/// бывает, так что с ключом открытой он не совпадёт.
function tabKey(tab: ShownTab): string {
  return tab.closing ? `\0${tab.path}` : tab.path;
}

export function FileEditor(props: {
  workspaceId: string;
  /// Открытые файлы, в порядке открытия.
  files: string[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  /// Ширину задаёт раскладка: колонку тянут за разделитель справа.
  width: number;
  /// Колонка уезжает: последний файл закрыт, но кадр исчезания ещё идёт.
  leaving?: boolean;
}) {
  const { t } = useI18n();
  const { files, activePath } = props;
  // Незакоммиченное видно и на вкладке: колонку открывают надолго, и вкладка
  // остаётся единственным следом файла, когда дерево прокручено в другое место.
  const git = useGitStatuses(props.workspaceId);
  // Несохранённое помечается на вкладке: иначе закрытая вкладка уносит правку
  // молча. Держим по всем открытым, а не только по видимому: переключился —
  // метка соседа не должна пропасть.
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  // Какую вкладку закрывают с несохранённой правкой. Спрашиваем: закрытая
  // вкладка уносит работу, а вернуть её неоткуда.
  const [asking, setAsking] = useState<string | null>(null);
  // Развёрнутый редактор ложится поверх сетки, как развёрнутая панель
  // терминала. Колонка ограничена ради этой сетки — и правильно ограничена, —
  // но читать длинную строку в ней всё равно тесно, а тянуть разделитель туда
  // и обратно ради одного файла утомительно.
  const [maximized, setMaximized] = useState(false);
  // Пока идёт разворот — и пока идёт возврат — колонка лежит поверх раскладки
  // и её место в ряду держит подставка. Состояние отдельное от maximized:
  // обратная анимация играет уже после того, как разворот отменён, и всё это
  // время элементу нужны и позиция поверх, и подставка под ним.
  const [overlay, setOverlay] = useState(false);
  const restoring = overlay && !maximized;

  // Возврат снимает подставку не сразу: сперва колонка должна доехать до
  // своего места, иначе она исчезнет из-под курсора и появится левее.
  useEffect(() => {
    if (!restoring) {
      return;
    }
    const timer = window.setTimeout(() => setOverlay(false), MAXIMIZE_MS);
    return () => window.clearTimeout(timer);
  }, [restoring]);

  const toggleMaximized = () => {
    if (maximized) {
      setMaximized(false);
      return;
    }
    // Оба разом, одним обновлением: сначала позиция поверх, и уже из неё
    // растём — иначе первый кадр рисует колонку на прежнем месте.
    setOverlay(true);
    setMaximized(true);
  };

  // Esc возвращает — это первое, что пробуют, когда что-то заняло весь экран.
  useEffect(() => {
    if (!maximized) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape, который уже разобрал кто-то внутри, — поиск по файлу, диалог, —
      // был про него: закрыв строку поиска, человек хочет остаться в
      // развёрнутом файле, а не съехать заодно в колонку.
      if (event.key === "Escape" && !event.defaultPrevented) {
        setMaximized(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [maximized]);

  // Закрыли вкладку с клавиатуры — курсор переходит в соседний файл, ставший
  // видимым. Иначе фокус пропадает вместе с закрытым полем, и второе нажатие
  // ⌘W, как и следующая набранная буква, уходит неизвестно куда.
  const sectionRef = useRef<HTMLElement | null>(null);
  const refocus = useRef(false);
  const current =
    activePath && files.includes(activePath) ? activePath : (files[0] ?? null);
  useEffect(() => {
    if (!refocus.current) {
      return;
    }
    refocus.current = false;
    sectionRef.current
      ?.querySelector<HTMLElement>(".file-view-slot.is-current textarea")
      ?.focus();
  }, [current]);

  /// Закрыть вкладку; с несохранённой правкой — сперва спросить.
  const requestClose = (path: string) => {
    if (dirty.has(path)) {
      setAsking(path);
      return;
    }
    props.onClose(path);
  };

  // Последний файл закрыт — разворачивать нечего, и остаться развёрнутым
  // редактор не должен: вернётся он уже пустым и поверх всего. Анимацию
  // возврата здесь не играем: играть её не на чем, колонка уже уходит.
  useEffect(() => {
    if (files.length === 0) {
      setMaximized(false);
      setOverlay(false);
    }
  }, [files.length]);

  // Полоса рисует не сам список открытых, а его же с уходящими вкладками:
  // закрытая сжимается на своём месте, и соседи подъезжают, а не прыгают.
  const [tabs, setTabs] = useState<ShownTab[]>(() =>
    files.map((path) => ({ path, closing: false })),
  );
  const [tabsOf, setTabsOf] = useState(files);
  if (tabsOf !== files) {
    setTabsOf(files);
    setTabs(
      moving()
        ? shownTabs(tabs, files)
        : files.map((path) => ({ path, closing: false })),
    );
  }

  // Ушедшие снимаем, когда сжатие доиграно. Закрыли ещё одну — ждём заново:
  // она только начала уходить, а сжатые раньше всё равно уже не видны.
  useEffect(() => {
    if (!tabs.some((tab) => tab.closing)) {
      return;
    }
    const timer = window.setTimeout(
      () => setTabs((shown) => shown.filter((tab) => !tab.closing)),
      TAB_MS,
    );
    return () => window.clearTimeout(timer);
  }, [tabs]);

  // Движение рисуется до первого кадра: иначе на кадр мелькнуло бы конечное
  // состояние — вкладка уже на новом месте, файл уже целиком.
  const tabElements = useRef(new Map<string, HTMLDivElement>());
  const slotElements = useRef(new Map<string, HTMLDivElement>());
  const drawn = useRef<{ tabs: ShownTab[]; current: string | null } | null>(
    null,
  );

  // Какие файлы уже показали своё. Открытый проявляется, когда прочитан: до
  // этого на его месте «Загрузка…», и проявлялась бы она, а текст выскакивал
  // бы потом рывком — по виду ничего и не проявлялось.
  const ready = useRef(new Set<string>());
  // Проявление, которое ждёт текста: стоит на первом кадре и держит файл
  // невидимым, пока его не прочли.
  const waiting = useRef<{
    path: string;
    animation: Animation;
    timer: number;
  } | null>(null);
  const release = () => {
    const pending = waiting.current;
    if (!pending) {
      return;
    }
    waiting.current = null;
    window.clearTimeout(pending.timer);
    pending.animation.play();
  };
  const markReady = (path: string) => {
    ready.current.add(path);
    if (waiting.current?.path === path) {
      release();
    }
  };
  useEffect(() => () => window.clearTimeout(waiting.current?.timer), []);

  useLayoutEffect(() => {
    const before = drawn.current;
    drawn.current = { tabs, current };
    const open = tabs.filter((tab) => !tab.closing);
    // Закрытый файл, открытый снова, читается заново: прежняя отметка о нём
    // уже ничего не значит.
    const kept = new Set(open.map((tab) => tab.path));
    for (const path of ready.current) {
      if (!kept.has(path)) {
        ready.current.delete(path);
      }
    }
    // Первый показ играет сама колонка: она выезжает вместе с вкладкой.
    if (!before || !moving()) {
      return;
    }
    const leftBefore = new Set(
      before.tabs.filter((tab) => tab.closing).map((tab) => tab.path),
    );
    const openBefore = new Set(
      before.tabs.filter((tab) => !tab.closing).map((tab) => tab.path),
    );
    let closed = false;
    for (const tab of tabs) {
      if (!tab.closing || leftBefore.has(tab.path)) {
        continue;
      }
      closed = true;
      const element = tabElements.current.get(tabKey(tab));
      if (!element) {
        continue;
      }
      const frames = tabFrames(element);
      element.animate([frames.full, frames.gone], {
        duration: TAB_MS,
        easing: "cubic-bezier(0.4, 0, 1, 1)",
        fill: "forwards",
      });
    }
    // Открытая вкладка разворачивается из ничего на своём месте — так же, как
    // закрытая там сжимается. По переименованию число вкладок то же, и
    // новое имя встаёт на место старого сразу: разворачивать там нечего.
    const opened = open.length > openBefore.size;
    if (opened) {
      for (const tab of open) {
        const element = tabElements.current.get(tabKey(tab));
        if (openBefore.has(tab.path) || !element) {
          continue;
        }
        const frames = tabFrames(element);
        element.style.overflow = "hidden";
        const growth = element.animate([frames.gone, frames.full], {
          duration: OPEN_MS,
          easing: SETTLE,
        });
        // Развернулась — отпускаем: замершее имя не дало бы вкладке вырасти,
        // когда на ней появится точка несохранённой правки. Отменили — тоже.
        const settle = () => {
          frames.release();
          element.style.overflow = "";
        };
        void growth.finished.then(settle, settle);
      }
    }
    // Видимым стал другой файл — тот, что ждал текста, больше не ждёт.
    if (current !== before.current) {
      release();
    }
    // Файл проявляется, когда его открыли или когда он встал на место
    // закрытого. Простое переключение вкладок остаётся мгновенным: по ним
    // ходят быстро, и ждать каждый раз, пока файл проявится, утомительно.
    const slot = current === null ? undefined : slotElements.current.get(current);
    if ((opened || closed) && slot && current !== before.current) {
      // Открытый поднимается на место. Вставший на место закрытого только
      // проявляется: он здесь уже был, его просто не было видно.
      const entrance = opened
        ? slot.animate(
            [
              { opacity: 0, transform: "translateY(8px)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: OPEN_MS, easing: SETTLE },
          )
        : slot.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: TAB_MS,
            easing: "ease-out",
          });
      if (current !== null && !ready.current.has(current)) {
        entrance.pause();
        waiting.current = {
          path: current,
          animation: entrance,
          timer: window.setTimeout(release, READY_WAIT_MS),
        };
      }
    }
  }, [tabs, current]);

  if (files.length === 0 || current === null) {
    return null;
  }

  return (
    <>
      {/* Развёрнутый редактор уходит из потока, и без подставки сетка
          разъехалась бы на его место — а вернувшись, схлопнулась бы обратно.
          Пять терминалов пережили бы два лишних SIGWINCH ни за чем. */}
      {overlay && (
        <div
          className="file-editor-placeholder"
          aria-hidden="true"
          style={{ width: props.width }}
        />
      )}
      <section
        className={`file-editor ${props.leaving ? "is-leaving" : ""} ${
          overlay ? "is-overlay" : ""
        } ${maximized ? "is-maximized" : ""} ${restoring ? "is-restoring" : ""}`}
        aria-label={t("files.editorTitle")}
        ref={sectionRef}
        // ⌘W здесь закрывает файл, а не терминал: сетка, увидев эту метку,
        // нажатие не трогает.
        {...{ [OWN_CLOSE_KEY]: "" }}
        onKeyDown={(event) => {
          const mod = isMac ? event.metaKey : event.ctrlKey;
          if (
            !mod ||
            event.shiftKey ||
            event.altKey ||
            (event.code !== "KeyW" && event.key.toLowerCase() !== "w")
          ) {
            return;
          }
          event.preventDefault();
          // Поверх уже спрашивают — про эту же вкладку или про сохранение
          // поверх чужой правки. Второе нажатие не должно закрыть файл в
          // обход вопроса.
          if (isCoveredByModal()) {
            return;
          }
          refocus.current = true;
          requestClose(current);
        }}
        style={
          {
            "--column-width": `${props.width}px`,
            // Своя колонка плюс сетка плюс зазор между ними: правым краем
            // развёрнутый редактор встаёт туда же, где кончалась сетка, и
            // дальше влево не заходит — дерево и список проектов на месте.
            // Ширину сетки (--dock-width) ставит раскладка прямо в стиль,
            // мимо React: она меняется каждый кадр, пока тянут край окна.
            "--maximized-width": `calc(${props.width}px + var(--dock-width, 0px) + var(--mc-gap))`,
            // Правый край колонки на своём месте, считая от правого края
            // сетки: из этой точки разворот растёт и в неё же возвращается,
            // так что левый край не дёргается ни туда, ни обратно.
            "--collapsed-right": "calc(var(--mc-gap) * 2 + var(--dock-width, 0px))",
            ...(overlay ? {} : { width: "var(--column-width)" }),
          } as CSSProperties
        }
      >
      <div className="file-editor-tabs" role="tablist">
        {tabs.map((tab) => {
          const { path, closing } = tab;
          const glyph = fileGlyph(fileName(path));
          const active = !closing && path === current;
          const status = git.of(path);
          const key = tabKey(tab);
          return (
            <div
              key={key}
              ref={(element) => {
                if (element) {
                  tabElements.current.set(key, element);
                } else {
                  tabElements.current.delete(key);
                }
              }}
              className={`file-tab ${active ? "is-active" : ""} ${
                closing ? "is-closing" : ""
              } ${status ? `is-git is-git-${status}` : ""}`}
              // Уходящая вкладка — уже не вкладка: ни нажать, ни дойти до неё
              // клавиатурой, ни услышать её в списке нельзя.
              {...(closing
                ? { "aria-hidden": true, inert: "" }
                : { role: "tab", "aria-selected": active })}
              // Средняя кнопка закрывает вкладку, как в браузере и в любом
              // редакторе с вкладками.
              onAuxClick={(event) => {
                if (event.button === 1 && !closing) {
                  event.preventDefault();
                  requestClose(path);
                }
              }}
            >
              <button
                type="button"
                className="file-tab-open"
                title={path}
                onClick={() => props.onSelect(path)}
              >
                <span
                  className={`file-glyph is-${glyph.kind}`}
                  aria-hidden="true"
                >
                  {glyph.label}
                </span>
                <span className="file-tab-name">{fileName(path)}</span>
                {dirty.has(path) && (
                  <span
                    className="file-tab-dirty"
                    title={t("files.unsaved")}
                    aria-label={t("files.unsaved")}
                  />
                )}
              </button>
              <button
                type="button"
                className="file-tab-close icon-button"
                title={t("files.close")}
                aria-label={`${t("files.close")}: ${fileName(path)}`}
                onClick={() => requestClose(path)}
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="file-editor-maximize icon-button"
          title={maximized ? t("files.restore") : t("files.maximize")}
          aria-label={maximized ? t("files.restore") : t("files.maximize")}
          aria-pressed={maximized}
          onClick={toggleMaximized}
        >
          <MaximizeIcon />
        </button>
      </div>
      {/* Каждый открытый файл остаётся смонтированным, а видно один. Раньше
          вид перемонтировался по пути, и переключение вкладок уносило
          несохранённую правку молча: текст исчезал, а точка на вкладке
          продолжала обещать, что он цел. */}
      {files.map((path) => (
        <div
          key={path}
          ref={(element) => {
            if (element) {
              slotElements.current.set(path, element);
            } else {
              slotElements.current.delete(path);
            }
          }}
          className={`file-view-slot ${path === current ? "is-current" : ""}`}
          style={{ display: path === current ? "flex" : "none" }}
        >
          {/* Картинку не правят — на неё смотрят, и текстовое поле ей ни к
              чему. Выбор здесь, а не внутри вида: это два разных набора
              состояний, и один компонент, умеющий и то и другое, звал бы
              половину своих хуков вхолостую. */}
          {drawnAsImage(path) ? (
            <ImageView
              workspaceId={props.workspaceId}
              path={path}
              visible={path === current}
              onReady={() => markReady(path)}
            />
          ) : (
            <FileView
              workspaceId={props.workspaceId}
              path={path}
              visible={path === current}
              onReady={() => markReady(path)}
              onDirtyChange={(isDirty) =>
                setDirty((marked) => {
                  if (marked.has(path) === isDirty) {
                    return marked;
                  }
                  const next = new Set(marked);
                  if (isDirty) {
                    next.add(path);
                  } else {
                    next.delete(path);
                  }
                  return next;
                })
              }
            />
          )}
        </div>
      ))}
      {asking && (
        <ConfirmDialog
          text={t("files.closeUnsaved", { name: fileName(asking) })}
          confirmLabel={t("files.closeAnyway")}
          tone="danger"
          onConfirm={() => {
            const path = asking;
            setAsking(null);
            props.onClose(path);
          }}
          onCancel={() => setAsking(null)}
        />
      )}
      </section>
    </>
  );
}
