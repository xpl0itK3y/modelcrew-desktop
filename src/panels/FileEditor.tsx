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
import { ConfirmDialog } from "../ui/ConfirmDialog";

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
  // Несохранённое помечается на вкладке: иначе закрытая вкладка уносит правку
  // молча. Держим по всем открытым, а не только по видимому: переключился —
  // метка соседа не должна пропасть.
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  // Какую вкладку закрывают с несохранённой правкой. Спрашиваем: закрытая
  // вкладка уносит работу, а вернуть её неоткуда.
  const [asking, setAsking] = useState<string | null>(null);
  // Развёрнутый редактор ложится поверх всего, как развёрнутая панель
  // терминала. Колонка ограничена ради сетки — и правильно ограничена, — но
  // читать длинную строку в ней всё равно тесно, а тянуть разделитель туда и
  // обратно ради одного файла утомительно.
  const [maximized, setMaximized] = useState(false);

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
  // редактор не должен: вернётся он уже пустым и поверх всего.
  useEffect(() => {
    if (files.length === 0) {
      setMaximized(false);
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
      {maximized && (
        <div
          className="file-editor-placeholder"
          aria-hidden="true"
          style={{ width: props.width }}
        />
      )}
      <section
        className={`file-editor ${props.leaving ? "is-leaving" : ""} ${
          maximized ? "is-maximized" : ""
        }`}
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
            ...(maximized ? {} : { width: "var(--column-width)" }),
          } as CSSProperties
        }
      >
      <div className="file-editor-tabs" role="tablist">
        {files.map((path) => {
          const glyph = fileGlyph(fileName(path));
          const active = path === current;
          return (
            <div
              key={path}
              className={`file-tab ${active ? "is-active" : ""}`}
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
          onClick={() => setMaximized((on) => !on)}
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
