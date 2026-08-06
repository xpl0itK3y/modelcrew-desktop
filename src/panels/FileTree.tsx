// Дерево проекта.
//
// Каталог спрашивается ровно тогда, когда его раскрыли, и остаётся в памяти:
// свернуть и снова развернуть папку не должно стоить обращения к диску. Список
// строится плоским — вложенность передаётся отступом, — иначе на глубоком
// дереве каждый уровень добавлял бы React своё поддерево, а прокрутка длинного
// списка становилась бы рваной.

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { localizeBackendError, useI18n } from "../i18n";
import { fileGlyph } from "../files/fileGlyph";
import {
  ancestorsOf,
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  parentOf,
  readWorkspaceDir,
  renameWorkspaceEntry,
  revealWorkspaceEntry,
  searchWorkspaceTree,
  watchWorkspaceTree,
  withName,
  type TreeEntry,
  type TreeListing,
} from "../files/fileTree";
import {
  FileTreeMenu,
  type MenuAction,
  type MenuTarget,
} from "./FileTreeMenu";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { treeKeyAction } from "../files/treeKeys";
import {
  ChevronRightIcon,
  CloseIcon,
  CollapseIcon,
  FolderIcon,
  NewFileIcon,
  NewFolderIcon,
} from "../ui/Icons";

/// Корень проекта в карте каталогов лежит под пустым путём — тем же, каким его
/// спрашивает бэкенд.
const ROOT = "";

type Row = TreeEntry & { depth: number };

export function FileTree(props: {
  workspaceId: string;
  /// Открытый сейчас файл: подсвечивается и раскрывается по пути до него.
  activePath?: string | null;
  onOpenFile: (path: string) => void;
  /// Спрятать колонку целиком.
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const { workspaceId } = props;
  const [listings, setListings] = useState<Map<string, TreeListing>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  // Вспышка гаснет сама: она отмечает момент появления, а не состояние файла.
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (fresh.size === 0) {
      return;
    }
    const timer = window.setTimeout(() => setFresh(new Set()), 1_200);
    return () => window.clearTimeout(timer);
  }, [fresh]);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<TreeListing | null>(null);
  // Имя вводят прямо в дереве, на месте будущей строки: диалог посреди списка
  // отрывает от того места, куда файл кладут.
  const [draft, setDraft] = useState<{
    /// Каталог, в котором заводят имя; для переименования — путь строки.
    at: string;
    kind: "file" | "folder" | "rename";
    value: string;
  } | null>(null);
  const [doomed, setDoomed] = useState<{ path: string; name: string } | null>(
    null,
  );

  const load = useCallback(
    async (path: string) => {
      setLoading((current) => new Set(current).add(path));
      try {
        const listing = await readWorkspaceDir(workspaceId, path);
        setListings((current) => {
          // Появившееся в уже прочитанной папке пришло с диска, а не от
          // раскрытия: его показывают вспышкой, иначе файл, созданный агентом,
          // просто беззвучно возникает в списке.
          const before = current.get(path);
          if (before) {
            const had = new Set(before.entries.map((entry) => entry.path));
            const born = listing.entries
              .map((entry) => entry.path)
              .filter((child) => !had.has(child));
            if (born.length > 0) {
              setFresh((marked) => new Set([...marked, ...born]));
            }
          }
          return new Map(current).set(path, listing);
        });
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

  // Правки на диске: агент в соседней панели создаёт и удаляет файлы, и
  // дерево, застывшее на том, что было при раскрытии, врёт тем сильнее, чем
  // дольше на него смотрят. Перечитываем только то, что у нас загружено:
  // остальное прочтётся само при раскрытии.
  const knownRef = useRef<Set<string>>(new Set());
  knownRef.current = new Set(listings.keys());
  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    return watchWorkspaceTree(workspaceId, (dirs, partial) => {
      const stale = partial
        ? [...knownRef.current]
        : dirs.filter((dir) => knownRef.current.has(dir));
      for (const dir of stale) {
        void load(dir);
      }
    });
  }, [workspaceId, load]);

  // Каталоги, которые раскрыли, но ещё не читали, — докладываем.
  useEffect(() => {
    for (const path of expanded) {
      if (!listings.has(path) && !loading.has(path)) {
        void load(path);
      }
    }
  }, [expanded, listings, loading, load]);

  const runAction = (action: MenuAction, target: MenuTarget) => {
    setMenu(null);
    if (action === "reveal") {
      void revealWorkspaceEntry(workspaceId, target.path).catch((cause) =>
        setError(localizeBackendError(cause)),
      );
      return;
    }
    if (action === "delete") {
      setDoomed({ path: target.path, name: target.name });
      return;
    }
    if (action === "rename") {
      setDraft({ at: target.path, kind: "rename", value: target.name });
      return;
    }
    // Создаём рядом: у папки — внутрь неё, у файла — в его же каталоге.
    const parent = target.isDir ? target.path : parentOf(target.path);
    if (target.isDir) {
      setExpanded((current) => new Set(current).add(target.path));
    }
    setDraft({
      at: parent,
      kind: action === "newFolder" ? "folder" : "file",
      value: "",
    });
  };

  const commitDraft = async () => {
    if (!draft) {
      return;
    }
    const name = draft.value.trim();
    setDraft(null);
    if (!name) {
      return;
    }
    try {
      if (draft.kind === "rename") {
        const to = withName(draft.at, name);
        if (to !== draft.at) {
          await renameWorkspaceEntry(workspaceId, draft.at, to);
        }
      } else {
        const path = draft.at ? `${draft.at}/${name}` : name;
        await createWorkspaceEntry(workspaceId, path, draft.kind === "folder");
      }
    } catch (cause) {
      setError(localizeBackendError(cause));
    }
    // Вотчер догонит и сам, но ждать его тик после собственного действия —
    // это заметная глазу задержка там, где результат ожидают немедленно.
    void load(draft.kind === "rename" ? parentOf(draft.at) : draft.at);
  };

  // Поиск идёт на диск, а печатают быстро: без паузы каждый символ запускал бы
  // обход всего проекта, и отвечали бы они вразнобой.
  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setFound(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void searchWorkspaceTree(workspaceId, needle)
        .then(setFound)
        .catch((cause) => setError(localizeBackendError(cause)));
    }, 160);
    return () => window.clearTimeout(timer);
  }, [workspaceId, query]);

  const searching = query.trim().length > 0;
  const rows = searching
    ? (found?.entries ?? []).map((entry) => ({ ...entry, depth: 0 }))
    : flatten(listings, expanded);
  const rootListing = listings.get(ROOT);

  // Что было на экране прошлым кадром. Строка, которой там не было, въезжает;
  // остальные стоят на месте — иначе раскрытие одной папки дёргало бы всё
  // дерево целиком.
  const shownRef = useRef<Set<string> | null>(null);
  const previouslyShown = shownRef.current;
  const arriving = new Set(
    previouslyShown === null
      ? []
      : rows.map((row) => row.path).filter((path) => !previouslyShown.has(path)),
  );
  // Отсчёт начинается с первого кадра, где что-то есть: пустой кадр до
  // прочтения корня — это ещё не «дерево было пустым», и принимать его за
  // точку отсчёта значит объявить прибывшим весь проект.
  if (rows.length > 0 || previouslyShown !== null) {
    shownRef.current = new Set(rows.map((row) => row.path));
  }

  // Куда смотрит клавиатура. Отдельно от выбранного файла: ходить по дереву
  // стрелками, ничего не открывая, — обычное дело, и открытый файл при этом
  // подсвечен своим.
  const focusedPath =
    focused && rows.some((row) => row.path === focused)
      ? focused
      : (rows[0]?.path ?? null);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = treeKeyAction(event.key, rows, focusedPath, expanded);
    if (!action) {
      return;
    }
    event.preventDefault();
    if (action.kind === "expand" || action.kind === "collapse") {
      toggle(action.path);
      setFocused(action.path);
      return;
    }
    if (action.kind === "delete") {
      const row = rows.find((item) => item.path === action.path);
      if (row) {
        // Спрашиваем так же, как из меню: удаление необратимо, и клавиша рядом
        // со стрелками тем более не повод обходиться без вопроса.
        setDoomed({ path: row.path, name: row.name });
      }
      return;
    }
    if (action.kind === "open") {
      const row = rows.find((item) => item.path === action.path);
      if (row?.isDir) {
        toggle(action.path);
      } else if (row) {
        props.onOpenFile(action.path);
      }
      setFocused(action.path);
      return;
    }
    setFocused(action.path);
    // Фокус переносим сами: строки — кнопки, и без этого клавиатура осталась бы
    // на прежней, а Enter открыл бы не то, что подсвечено.
    treeRef.current
      ?.querySelector<HTMLElement>(`[data-path="${cssEscape(action.path)}"]`)
      ?.focus();
  };

  // Шапка и поиск остаются на месте при любом состоянии дерева: и создать
  // файл, и очистить запрос надо уметь тогда, когда показывать нечего.
  const header = (
    <div className="file-tree-header">
      <span className="file-tree-title">{t("files.panelTitle")}</span>
      <button
        type="button"
        className="icon-button"
        title={t("files.newFile")}
        aria-label={t("files.newFile")}
        onClick={() => setDraft({ at: ROOT, kind: "file", value: "" })}
      >
        <NewFileIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        title={t("files.newFolder")}
        aria-label={t("files.newFolder")}
        onClick={() => setDraft({ at: ROOT, kind: "folder", value: "" })}
      >
        <NewFolderIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        title={t("files.collapseAll")}
        aria-label={t("files.collapseAll")}
        disabled={expanded.size === 0}
        onClick={() => setExpanded(new Set())}
      >
        <CollapseIcon />
      </button>
      {props.onClose && (
        <button
          type="button"
          className="icon-button"
          title={t("files.hide")}
          aria-label={t("files.hide")}
          onClick={props.onClose}
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );

  const search = (
    <div className="file-search">
      <input
        type="search"
        className="file-search-input"
        aria-label={t("files.search")}
        placeholder={t("files.search")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            setQuery("");
          }
        }}
      />
    </div>
  );

  const message = error
    ? { text: error, alert: true }
    : searching && found === null
      ? { text: t("files.searching"), alert: false }
      : searching && rows.length === 0
        ? { text: t("files.nothingFound"), alert: false }
        : !rootListing
          ? { text: t("files.loading"), alert: false }
          : rootListing.entries.length === 0
            ? { text: t("files.empty"), alert: false }
            : null;

  if (message) {
    return (
      <>
        {header}
        {search}
        <div
          className="file-tree-empty"
          role={message.alert ? "alert" : undefined}
        >
          {message.text}
        </div>
      </>
    );
  }

  return (
    <>
    {header}
    {search}
    <div
      className="file-tree"
      role="tree"
      aria-label={t("files.panelTitle")}
      ref={treeRef}
      onKeyDown={onKeyDown}
    >
      {draft && draft.kind !== "rename" && draft.at === ROOT && (
        <NameInput
          depth={0}
          isDir={draft.kind === "folder"}
          value={draft.value}
          onChange={(value) => setDraft({ ...draft, value })}
          onCommit={() => void commitDraft()}
          onCancel={() => setDraft(null)}
          label={t("files.namePrompt")}
        />
      )}
      {rows.map((row) => {
        const open = expanded.has(row.path);
        if (draft?.kind === "rename" && draft.at === row.path) {
          return (
            <NameInput
              key={row.path}
              depth={row.depth}
              isDir={row.isDir}
              value={draft.value}
              onChange={(value) => setDraft({ ...draft, value })}
              onCommit={() => void commitDraft()}
              onCancel={() => setDraft(null)}
              label={t("files.namePrompt")}
            />
          );
        }
        const glyph = fileGlyph(row.name);
        // Создаём внутри этой папки — строка ввода встаёт под ней и с её
        // вложенностью. Сверху списка она сообщала бы не то место.
        const inside =
          draft && draft.kind !== "rename" && draft.at === row.path;
        const line = (
          <button
            key={row.path}
            type="button"
            role="treeitem"
            aria-expanded={row.isDir ? open : undefined}
            aria-selected={row.path === activePath}
            className={`file-row ${row.isDir ? "is-dir" : "is-file"} ${
              row.path === activePath ? "is-active" : ""
            } ${arriving.has(row.path) ? "is-arriving" : ""} ${
              fresh.has(row.path) ? "is-fresh" : ""
            }`}
            style={{ "--file-depth": row.depth } as CSSProperties}
            title={row.path}
            data-path={row.path}
            // Табом входят в дерево один раз и попадают туда, где были: два
            // десятка строк подряд в порядке обхода — это не навигация.
            tabIndex={row.path === focusedPath ? 0 : -1}
            onFocus={() => setFocused(row.path)}
            onClick={() =>
              row.isDir ? toggle(row.path) : props.onOpenFile(row.path)
            }
            onContextMenu={(event) => {
              event.preventDefault();
              setFocused(row.path);
              setMenu({
                path: row.path,
                name: row.name,
                isDir: row.isDir,
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            <span className={`file-chevron ${open ? "is-open" : ""}`}>
              {row.isDir && <ChevronRightIcon />}
            </span>
            <span className={`file-glyph is-${glyph.kind}`} aria-hidden="true">
              {row.isDir ? <FolderIcon /> : glyph.label || <FileSheet />}
            </span>
            <span className="file-name">{row.name}</span>
            {searching && parentOf(row.path) && (
              <span className="file-row-where">{parentOf(row.path)}</span>
            )}
          </button>
        );

        return inside && draft ? (
          <Fragment key={row.path}>
            {line}
            <NameInput
              depth={row.depth + 1}
              isDir={draft.kind === "folder"}
              value={draft.value}
              onChange={(value) => setDraft({ ...draft, value })}
              onCommit={() => void commitDraft()}
              onCancel={() => setDraft(null)}
              label={t("files.namePrompt")}
            />
          </Fragment>
        ) : (
          line
        );
      })}
      {found?.truncated ||
      rows.some((row) => listings.get(row.path)?.truncated) ||
      rootListing?.truncated ? (
        <div className="file-tree-note">{t("files.truncated")}</div>
      ) : null}
      {menu && (
        <FileTreeMenu
          target={menu}
          onPick={(action) => runAction(action, menu)}
          onClose={() => setMenu(null)}
        />
      )}
      {doomed && (
        <ConfirmDialog
          text={t("files.deleteConfirm", { name: doomed.name })}
          confirmLabel={t("files.delete")}
          tone="danger"
          onConfirm={() => {
            const target = doomed;
            setDoomed(null);
            // Фокус переезжает на соседа: строки под ним больше не будет, и
            // клавиатура иначе осталась бы ни на чём.
            const at = rows.findIndex((row) => row.path === target.path);
            const next = rows[at + 1] ?? rows[at - 1] ?? null;
            setFocused(next ? next.path : null);
            void deleteWorkspaceEntry(workspaceId, target.path)
              .catch((cause) => setError(localizeBackendError(cause)))
              .finally(() => void load(parentOf(target.path)));
          }}
          onCancel={() => setDoomed(null)}
        />
      )}
    </div>
    </>
  );
}

/// Ввод имени — строка дерева, а не коробка поверх списка: с тем же отступом,
/// с тем же значком, на том самом месте, где появится файл. Так видно, куда он
/// ляжет, ещё до того, как имя набрано.
function NameInput(props: {
  depth: number;
  /// Что создаётся: от этого значок слева. При переименовании — то же, что у
  /// самой строки, иначе файл на глазах превращался бы в папку.
  isDir: boolean;
  value: string;
  label: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="file-row file-draft"
      style={{ "--file-depth": props.depth } as CSSProperties}
    >
      <span className="file-chevron" />
      <span className="file-glyph" aria-hidden="true">
        {props.isDir ? <FolderIcon /> : <FileSheet />}
      </span>
      <input
        className="file-draft-input"
        aria-label={props.label}
        autoFocus
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        // Уход фокуса подтверждает, а не отменяет: набранное имя — это работа,
        // и терять её из-за случайного щелчка мимо неправильно.
        onBlur={props.onCommit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            props.onCommit();
          } else if (event.key === "Escape") {
            props.onCancel();
          }
        }}
      />
    </div>
  );
}

/// Путь внутри селектора: имена файлов содержат что угодно, включая кавычки и
/// скобки, а `CSS.escape` в jsdom есть не всегда.
function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
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
