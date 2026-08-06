// Дерево проекта.
//
// Каталог спрашивается ровно тогда, когда его раскрыли, и остаётся в памяти:
// свернуть и снова развернуть папку не должно стоить обращения к диску. Список
// строится плоским — вложенность передаётся отступом, — иначе на глубоком
// дереве каждый уровень добавлял бы React своё поддерево, а прокрутка длинного
// списка становилась бы рваной.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { localizeBackendError, useI18n } from "../i18n";
import { fileGlyph } from "../files/fileGlyph";
import {
  ancestorsOf,
  readWorkspaceDir,
  type TreeEntry,
  type TreeListing,
} from "../files/fileTree";
import { ChevronRightIcon, FolderIcon } from "../ui/Icons";

/// Корень проекта в карте каталогов лежит под пустым путём — тем же, каким его
/// спрашивает бэкенд.
const ROOT = "";

type Row = TreeEntry & { depth: number };

export function FileTree(props: {
  workspaceId: string;
  /// Открытый сейчас файл: подсвечивается и раскрывается по пути до него.
  activePath?: string | null;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useI18n();
  const { workspaceId } = props;
  const [listings, setListings] = useState<Map<string, TreeListing>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (path: string) => {
      setLoading((current) => new Set(current).add(path));
      try {
        const listing = await readWorkspaceDir(workspaceId, path);
        setListings((current) => new Map(current).set(path, listing));
        setError(null);
      } catch (cause) {
        setError(localizeBackendError(cause));
      } finally {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    },
    [workspaceId],
  );

  // Смена проекта — это другое дерево целиком: и раскрытое, и прочитанное
  // относится к прежнему, и показывать его хоть один кадр нельзя.
  useEffect(() => {
    setListings(new Map());
    setExpanded(new Set());
    setError(null);
    if (workspaceId) {
      void load(ROOT);
    }
  }, [workspaceId, load]);

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
        return next;
      }
      next.add(path);
      return next;
    });
    if (!listings.has(path)) {
      void load(path);
    }
  };

  // Открытый файл виден в дереве, даже если его папки свёрнуты: иначе подсветка
  // «где я» показывает пустоту, а искать файл руками приходится каждый раз.
  const activePath = props.activePath ?? null;
  useEffect(() => {
    if (!activePath) {
      return;
    }
    const needed = ancestorsOf(activePath);
    if (needed.length === 0) {
      return;
    }
    setExpanded((current) => {
      if (needed.every((path) => current.has(path))) {
        return current;
      }
      const next = new Set(current);
      for (const path of needed) {
        next.add(path);
      }
      return next;
    });
  }, [activePath]);

  // Каталоги, которые раскрыли, но ещё не читали, — докладываем.
  useEffect(() => {
    for (const path of expanded) {
      if (!listings.has(path) && !loading.has(path)) {
        void load(path);
      }
    }
  }, [expanded, listings, loading, load]);

  const rows = flatten(listings, expanded);
  const rootListing = listings.get(ROOT);

  if (error) {
    return (
      <div className="file-tree-empty" role="alert">
        {error}
      </div>
    );
  }
  if (!rootListing) {
    return <div className="file-tree-empty">{t("files.loading")}</div>;
  }
  if (rootListing.entries.length === 0) {
    return <div className="file-tree-empty">{t("files.empty")}</div>;
  }

  return (
    <div className="file-tree" role="tree" aria-label={t("files.panelTitle")}>
      {rows.map((row) => {
        const open = expanded.has(row.path);
        const glyph = fileGlyph(row.name);
        return (
          <button
            key={row.path}
            type="button"
            role="treeitem"
            aria-expanded={row.isDir ? open : undefined}
            aria-selected={row.path === activePath}
            className={`file-row ${row.isDir ? "is-dir" : "is-file"} ${
              row.path === activePath ? "is-active" : ""
            }`}
            style={{ "--file-depth": row.depth } as CSSProperties}
            title={row.path}
            onClick={() =>
              row.isDir ? toggle(row.path) : props.onOpenFile(row.path)
            }
          >
            <span className={`file-chevron ${open ? "is-open" : ""}`}>
              {row.isDir && <ChevronRightIcon />}
            </span>
            <span className={`file-glyph is-${glyph.kind}`} aria-hidden="true">
              {row.isDir ? <FolderIcon /> : glyph.label || <FileSheet />}
            </span>
            <span className="file-name">{row.name}</span>
          </button>
        );
      })}
      {rows.some((row) => listings.get(row.path)?.truncated) ||
      rootListing.truncated ? (
        <div className="file-tree-note">{t("files.truncated")}</div>
      ) : null}
    </div>
  );
}

/// Лист бумаги для файла без своего значка. Отдельной иконкой в общем наборе он
/// не нужен: за пределами дерева его негде показать.
function FileSheet() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M4 1.5h5L12.5 5v9.5h-9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M9 1.5V5h3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/// Раскрытые каталоги разворачиваются в один плоский список в том же порядке,
/// в каком они стоят на экране. Глубина едет отдельным числом: по ней рисуется
/// отступ, и она же отличает одноимённые файлы разных уровней.
export function flatten(
  listings: Map<string, TreeListing>,
  expanded: Set<string>,
): Row[] {
  const rows: Row[] = [];
  const walk = (path: string, depth: number) => {
    const listing = listings.get(path);
    if (!listing) {
      return;
    }
    for (const entry of listing.entries) {
      rows.push({ ...entry, depth });
      if (entry.isDir && expanded.has(entry.path)) {
        walk(entry.path, depth + 1);
      }
    }
  };
  walk(ROOT, 0);
  return rows;
}
