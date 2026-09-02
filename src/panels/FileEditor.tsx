// Колонка редактора: вкладки открытых файлов и сам файл под ними.
//
// Стоит между деревом и сеткой терминалов и раздвигает её. В сетку файл не
// кладётся нарочно: там живут терминалы, у них своя логика раскладки и
// сохранения, и файл среди них выглядит как ещё один терминал, которым он не
// является.

import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "../i18n";
import { CloseIcon, MaximizeIcon } from "../ui/Icons";
import { fileGlyph } from "../files/fileGlyph";
import { fileName } from "../crew/claimLabel";
import { FileView } from "./FileView";
import { useGitStatuses } from "../git/useGitStatuses";
import { ConfirmDialog } from "../ui/ConfirmDialog";

// Столько же живёт то же число в file-tree.css: по нему колонка возвращается
// на место, и разъехаться им нельзя.
const MAXIMIZE_MS = 200;

export function FileEditor(props: {
  workspaceId: string;
  /// Открытые файлы, в порядке открытия.
  files: string[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  /// Ширину задаёт раскладка: колонку тянут за разделитель справа.
  width: number;
  /// Ширина сетки терминалов: её редактор и накрывает, когда развёрнут.
  dockWidth: number;
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
      if (event.key === "Escape") {
        setMaximized(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [maximized]);

  // Последний файл закрыт — разворачивать нечего, и остаться развёрнутым
  // редактор не должен: вернётся он уже пустым и поверх всего. Анимацию
  // возврата здесь не играем: играть её не на чем, колонка уже уходит.
  useEffect(() => {
    if (files.length === 0) {
      setMaximized(false);
      setOverlay(false);
    }
  }, [files.length]);

  if (files.length === 0) {
    return null;
  }
  const current = activePath && files.includes(activePath) ? activePath : files[0];

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
        style={
          {
            "--column-width": `${props.width}px`,
            // Своя колонка плюс сетка плюс зазор между ними: правым краем
            // развёрнутый редактор встаёт туда же, где кончалась сетка, и
            // дальше влево не заходит — дерево и список проектов на месте.
            "--maximized-width": `calc(${
              props.width + props.dockWidth
            }px + var(--mc-gap))`,
            // Правый край колонки на своём месте, считая от правого края
            // сетки: из этой точки разворот растёт и в неё же возвращается,
            // так что левый край не дёргается ни туда, ни обратно.
            "--collapsed-right": `calc(var(--mc-gap) * 2 + ${props.dockWidth}px)`,
            ...(overlay ? {} : { width: "var(--column-width)" }),
          } as CSSProperties
        }
      >
      <div className="file-editor-tabs" role="tablist">
        {files.map((path) => {
          const glyph = fileGlyph(fileName(path));
          const active = path === current;
          const status = git.of(path);
          return (
            <div
              key={path}
              className={`file-tab ${active ? "is-active" : ""} ${
                status ? `is-git is-git-${status}` : ""
              }`}
              role="tab"
              aria-selected={active}
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
                onClick={() => {
                  if (dirty.has(path)) {
                    setAsking(path);
                    return;
                  }
                  props.onClose(path);
                }}
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
          className="file-view-slot"
          style={{ display: path === current ? "flex" : "none" }}
        >
          <FileView
            workspaceId={props.workspaceId}
            path={path}
            visible={path === current}
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
