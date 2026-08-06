// Колонка редактора: вкладки открытых файлов и сам файл под ними.
//
// Стоит между деревом и сеткой терминалов и раздвигает её. В сетку файл не
// кладётся нарочно: там живут терминалы, у них своя логика раскладки и
// сохранения, и файл среди них выглядит как ещё один терминал, которым он не
// является.

import { useState } from "react";
import { useI18n } from "../i18n";
import { CloseIcon } from "../ui/Icons";
import { fileGlyph } from "../files/fileGlyph";
import { fileName } from "../crew/claimLabel";
import { FileView } from "./FileView";

export function FileEditor(props: {
  workspaceId: string;
  /// Открытые файлы, в порядке открытия.
  files: string[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const { t } = useI18n();
  const { files, activePath } = props;
  // Несохранённое помечается на вкладке: иначе закрытая вкладка уносит правку
  // молча. Держим по всем открытым, а не только по видимому: переключился —
  // метка соседа не должна пропасть.
  const [dirty, setDirty] = useState<Set<string>>(new Set());

  if (files.length === 0) {
    return null;
  }
  const current = activePath && files.includes(activePath) ? activePath : files[0];

  return (
    <section className="file-editor" aria-label={t("files.editorTitle")}>
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
                  setDirty((current) => {
                    const next = new Set(current);
                    next.delete(path);
                    return next;
                  });
                  props.onClose(path);
                }}
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
      </div>
      {/* key по пути перемонтирует вид: у другого файла своё содержимое и своя
          история правки, и переиспользовать состояние нельзя. */}
      <FileView
        key={current}
        workspaceId={props.workspaceId}
        path={current}
        onDirtyChange={(isDirty) =>
          setDirty((currentSet) => {
            const has = currentSet.has(current);
            if (has === isDirty) {
              return currentSet;
            }
            const next = new Set(currentSet);
            if (isDirty) {
              next.add(current);
            } else {
              next.delete(current);
            }
            return next;
          })
        }
      />
    </section>
  );
}
