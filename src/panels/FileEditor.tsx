// Колонка редактора: вкладки открытых файлов и сам файл под ними.
//
// Стоит между деревом и сеткой терминалов и раздвигает её. В сетку файл не
// кладётся нарочно: там живут терминалы, у них своя логика раскладки и
// сохранения, и файл среди них выглядит как ещё один терминал, которым он не
// является.

import { useState, type CSSProperties } from "react";
import { useI18n } from "../i18n";
import { CloseIcon } from "../ui/Icons";
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

  if (files.length === 0) {
    return null;
  }
  const current = activePath && files.includes(activePath) ? activePath : files[0];

  return (
    <section
      className={`file-editor ${props.leaving ? "is-leaving" : ""}`}
      aria-label={t("files.editorTitle")}
      style={
        {
          "--column-width": `${props.width}px`,
          width: "var(--column-width)",
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
  );
}
