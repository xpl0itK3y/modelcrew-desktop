import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { describeBackendError, useI18n, type BackendFailure } from "../../i18n";
import {
  refreshGitChanges,
  subscribeGitChanges,
  type GitChangesSummary,
} from "../../git/gitChanges";
import { switchBranch, type GitRefKind } from "../../git/gitBranches";
import { fetchLog, type GitCommitInfo } from "../../git/gitLog";
import { formatRelativeTime } from "../../git/relativeTime";
import { useAnimatedPresence } from "../../ui/useAnimatedPresence";

// История коммитов: список и граф, раскрытая карточка коммита, меню действий
// над коммитом и редактор сообщения.
//
// Вертикаль отделена от списка изменений и от показа diff-а: здесь всё про
// прошлое репозитория, и почти каждое действие переписывает историю, поэтому
// сначала спрашивает подтверждение.

import { AuthorAvatar } from "./history/AuthorAvatar";
import { CommitActionsMenu } from "./history/CommitActionsMenu";
import { CommitDetails, RevealHeight } from "./history/CommitDetails";
import { CommitGraph, RefBadge } from "./history/CommitGraph";
import {
  HISTORY_PAGE,
  fetchHistory,
  recentHistory,
} from "./history/historyCache";
import { RewordEditor } from "./history/RewordEditor";
import { GitErrorDialog } from "./GitErrorDialog";

// Что из сводки видно в самом журнале. Сводка меняется и от каждой правки
// файла: пока агент пишет код, она обновлялась непрерывно, и вкладка всякий
// раз заново просила у git историю и перерисовывала все строки. Журнал от
// правок не меняется — перечитываем его, только когда сдвинулся HEAD, ветка
// или её расхождение с сервером.
function historyKey(summary: GitChangesSummary): string {
  return JSON.stringify([
    summary.isRepo,
    summary.branch,
    summary.headHash,
    summary.upstreamRef,
    summary.ahead,
    summary.behind,
  ]);
}

// Git вернул то же, что уже на экране, — перерисовывать нечего.
function sameLog(shown: GitCommitInfo[], next: GitCommitInfo[]): boolean {
  return (
    shown.length === next.length &&
    JSON.stringify(shown) === JSON.stringify(next)
  );
}

export function HistoryView(props: {
  workspaceId: string;
  // Незакоммиченных файлов (для узла рабочего дерева) и переход к «Изменениям».
  fileCount: number;
  onOpenChanges: () => void;
  // Текущая ветка — для выделения её бейджа и клика по чужим.
  currentBranch?: string;
  // Вершина текущей ветки: правка истории подтверждается именно ею.
  headHash?: string;
  upstreamBranch?: string;
}) {
  const { t } = useI18n();
  // Журнал с прошлого открытия рисуется сразу; свежий подменит его, если
  // за это время что-то изменилось.
  const [commits, setCommits] = useState<GitCommitInfo[] | null>(() =>
    recentHistory(props.workspaceId),
  );
  const [graphMode, setGraphMode] = useState(true);
  // «Все ветки»: включает локальные и серверные ветки (без stash/tag-only
  // служебных историй), граф становится насыщенным, как в редакторах.
  const [allBranches, setAllBranches] = useState(false);
  // Поиск по истории: поле ввода и то, что именно ищем.
  const [searchField, setSearchField] = useState<"text" | "author" | "path">(
    "text",
  );
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    // Печатать быстрее, чем git успевает отвечать, — обычное дело.
    const timer = window.setTimeout(() => setSearch(searchDraft.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);
  const filtering = search.length > 0;
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  // Сколько коммитов запрашивать; «Показать ещё» наращивает порциями.
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  // Открытое меню действий над коммитом: коммит и точка привязки на экране.
  const [menu, setMenu] = useState<{
    commit: GitCommitInfo;
    x: number;
    y: number;
  } | null>(null);
  const [actionError, setActionError] = useState<BackendFailure | null>(null);
  // Открытый редактор сообщения коммита.
  const [rewording, setRewording] = useState<GitCommitInfo | null>(null);
  // Немедленная перезагрузка лога после действия (не дожидаясь вотчера).
  const [reloadNonce, setReloadNonce] = useState(0);
  const logRequestRef = useRef(0);
  // Детали остаются смонтированными на время exit-анимации при сворачивании.
  const detailsPresence = useAnimatedPresence(expandedHash, 240);
  // Строки графа и списка не перерисовываются, пока не изменились они сами,
  // поэтому всё, что им передаётся, держим одними и теми же функциями.
  const openMenu = useCallback(
    (commit: GitCommitInfo, x: number, y: number) => setMenu({ commit, x, y }),
    [],
  );
  const toggleCommit = useCallback(
    (commit: GitCommitInfo) =>
      setExpandedHash((current) =>
        current === commit.hash ? null : commit.hash,
      ),
    [],
  );
  const openChangesRef = useRef(props.onOpenChanges);
  openChangesRef.current = props.onOpenChanges;
  const openChanges = useCallback(() => openChangesRef.current(), []);
  // Коммиты, появившиеся при открытой вкладке, въезжают с анимацией;
  // первоначальный список и догруженные «Показать ещё» (они старше уже
  // виденных) показываются сразу. Точку отсчёта задаёт первый ответ git, а
  // не журнал с прошлого открытия: коммит, сделанный, пока вкладка была
  // закрыта, — не новость этой минуты.
  const knownHashesRef = useRef<Set<string> | null>(null);
  const arrivedHashesRef = useRef(new Set<string>());
  const newestEpochRef = useRef(0);
  if (commits !== null && knownHashesRef.current !== null) {
    for (const commit of commits) {
      if (!knownHashesRef.current.has(commit.hash)) {
        knownHashesRef.current.add(commit.hash);
        if (commit.epochMs >= newestEpochRef.current) {
          arrivedHashesRef.current.add(commit.hash);
        }
      }
    }
    newestEpochRef.current = Math.max(
      newestEpochRef.current,
      commits[0]?.epochMs ?? 0,
    );
  }

  useEffect(() => {
    let cancelled = false;
    const usual = limit === HISTORY_PAGE && !allBranches && !filtering;
    const show = (request: number, log: GitCommitInfo[], answered = true) => {
      if (cancelled || logRequestRef.current !== request) {
        return;
      }
      // Пустой список от ошибки — не точка отсчёта: иначе вся история, когда
      // git ответит, въехала бы как только что сделанная.
      if (knownHashesRef.current === null && answered) {
        knownHashesRef.current = new Set(log.map((commit) => commit.hash));
        newestEpochRef.current = log[0]?.epochMs ?? 0;
      }
      // Сотня строк графа — заметная работа. В переходе React делает её
      // кусками между кадрами и не останавливает анимацию вкладки на
      // середине; тот же журнал оставляет на экране прежний массив, и
      // перерисовки нет вовсе.
      startTransition(() => {
        setCommits((current) =>
          current !== null && sameLog(current, log) ? current : log,
        );
        setLoadingMore(false);
      });
    };
    const load = () => {
      const request = ++logRequestRef.current;
      (usual
        ? fetchHistory(props.workspaceId)
        : fetchLog(
            props.workspaceId,
            limit,
            allBranches,
            filtering ? { [searchField]: search } : undefined,
          )
      ).then(
        (log) => show(request, log),
        () => show(request, [], false),
      );
    };
    load();
    // Новый коммит (из панели или терминала) сразу появляется в истории.
    // Сводку, что уже есть в памяти, подписка отдаёт тут же, не дожидаясь
    // git: журнал под неё только что запрошен строкой выше, и второй запрос
    // лишь отбросил бы первый ответ, продлив заглушку загрузки.
    let subscribing = true;
    let shownKey: string | null = null;
    const unsubscribe = subscribeGitChanges(props.workspaceId, (summary) => {
      const key = historyKey(summary);
      const changed = key !== shownKey;
      shownKey = key;
      if (changed && !subscribing) {
        load();
      }
    });
    subscribing = false;
    return () => {
      cancelled = true;
      logRequestRef.current += 1;
      unsubscribe();
    };
  }, [
    props.workspaceId,
    limit,
    allBranches,
    reloadNonce,
    filtering,
    searchField,
    search,
  ]);

  // Незакоммиченные изменения показываем узлом только в обычном виде: в режиме
  // «все ветки» верхний коммит — не обязательно HEAD, поводок был бы обманчив.
  const workingTreeCount = allBranches || filtering ? 0 : props.fileCount;
  const showGraph = graphMode && !filtering;

  // Ошибка действия гаснет сама — но только короткая. Ту, где git объяснился
  // сам, показывает окно, и закрывает его человек: гасить по таймеру текст,
  // который нужно прочитать, значит отобрать его на середине.
  useEffect(() => {
    if (!actionError || actionError.details) {
      return;
    }
    const timer = window.setTimeout(() => setActionError(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [actionError]);

  // Бэкенд отдаёт максимум 500 за раз; если пришло меньше лимита — история
  // закончилась и кнопка не нужна.
  const canLoadMore =
    commits !== null && commits.length >= limit && limit < 500;

  const copyHash = useCallback(async (commit: GitCommitInfo) => {
    try {
      await navigator.clipboard.writeText(commit.hash);
      setCopiedHash(commit.hash);
      window.setTimeout(() => setCopiedHash(null), 1_500);
    } catch {
      // Буфер обмена недоступен — молча.
    }
  }, []);

  // Переключение на ветку/тег по клику на бейдж; ошибка (грязное дерево и т.п.)
  // показывается баннером.
  const { workspaceId } = props;
  const switchTo = useCallback(
    (name: string, kind: GitRefKind) => {
      switchBranch(workspaceId, name, kind).then(
        () => {
          void refreshGitChanges(workspaceId);
          setReloadNonce((value) => value + 1);
        },
        (error: unknown) => setActionError(describeBackendError(error)),
      );
    },
    [workspaceId],
  );

  if (commits === null) {
    return <div className="git-empty">{t("git.loading")}</div>;
  }
  // При активном фильтре пустой результат не должен прятать саму строку
  // поиска — иначе запрос стало бы нечем очистить.
  if (commits.length === 0 && !filtering) {
    return <div className="git-empty">{t("git.historyEmpty")}</div>;
  }
  return (
    <div className="git-history">
      <div className="git-history-bar">
        <div className="git-history-modes" role="group">
          <button
            type="button"
            className={`git-mode ${showGraph ? "is-active" : ""}`}
            aria-pressed={showGraph}
            disabled={filtering}
            title={filtering ? t("git.graphNeedsNoFilter") : undefined}
            onClick={() => setGraphMode(true)}
          >
            {t("git.viewGraph")}
          </button>
          <button
            type="button"
            className={`git-mode ${!showGraph ? "is-active" : ""}`}
            aria-pressed={!showGraph}
            onClick={() => setGraphMode(false)}
          >
            {t("git.viewList")}
          </button>
        </div>
        <button
          type="button"
          className={`git-all-branches ${allBranches ? "is-active" : ""}`}
          aria-pressed={allBranches}
          title={t("git.allBranchesHint")}
          onClick={() => {
            setLimit(HISTORY_PAGE);
            setAllBranches((value) => !value);
          }}
        >
          ⎇ {t("git.allBranches")}
        </button>
      </div>
      <div className="git-history-search">
        <select
          className="git-search-field"
          aria-label={t("git.searchField")}
          value={searchField}
          onChange={(event) =>
            setSearchField(event.target.value as typeof searchField)
          }
        >
          <option value="text">{t("git.searchByText")}</option>
          <option value="author">{t("git.searchByAuthor")}</option>
          <option value="path">{t("git.searchByPath")}</option>
        </select>
        <input
          type="search"
          className="git-search-input"
          aria-label={t("git.searchPlaceholder")}
          placeholder={t("git.searchPlaceholder")}
          value={searchDraft}
          spellCheck={false}
          onChange={(event) => {
            setLimit(HISTORY_PAGE);
            setSearchDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setSearchDraft("");
            }
          }}
        />
      </div>
      {actionError && !actionError.details && (
        <div className="git-commit-error" role="alert">
          {actionError.message}
        </div>
      )}
      {/* key по режиму перемонтирует контент — короткая анимация появления
          при переключении «Граф ⇄ Список» в обе стороны. */}
      <div key={showGraph ? "graph" : "list"} className="git-history-swap">
        {commits.length === 0 ? (
          <div className="git-empty">{t("git.searchEmpty")}</div>
        ) : showGraph ? (
          <CommitGraph
            commits={commits}
            workspaceId={props.workspaceId}
            selectedHash={expandedHash}
            onSelect={toggleCommit}
            detailsPresence={detailsPresence}
            onMenu={openMenu}
            onSwitchBranch={switchTo}
            currentBranch={props.currentBranch}
            upstreamBranch={props.upstreamBranch}
            workingTreeCount={workingTreeCount}
            onOpenChanges={openChanges}
          />
        ) : (
          <div className="git-commit-list">
            {workingTreeCount > 0 && (
              <button
                type="button"
                className="git-worktree-card"
                title={t("git.workingTreeHint")}
                onClick={openChanges}
              >
                <span className="git-worktree-dot" aria-hidden="true" />
                <span className="git-worktree-text">
                  {t("git.workingTree", { count: String(workingTreeCount) })}
                </span>
              </button>
            )}
            {commits.map((commit) => (
              <CommitCard
                key={commit.hash}
                commit={commit}
                workspaceId={props.workspaceId}
                expanded={expandedHash === commit.hash}
                arriving={arrivedHashesRef.current.has(commit.hash)}
                copied={copiedHash === commit.hash}
                detailsClosing={
                  detailsPresence?.item === commit.hash
                    ? detailsPresence.closing
                    : null
                }
                currentBranch={props.currentBranch}
                onToggle={toggleCommit}
                onCopy={copyHash}
                onMenu={openMenu}
                onSwitch={switchTo}
              />
            ))}
          </div>
        )}
      </div>
      {canLoadMore && (
        <button
          type="button"
          className="git-history-more"
          disabled={loadingMore}
          onClick={() => {
            setLoadingMore(true);
            setLimit((value) => Math.min(value + 100, 500));
          }}
        >
          {loadingMore ? t("git.loading") : t("git.showMore")}
        </button>
      )}
      {menu && (
        <CommitActionsMenu
          workspaceId={props.workspaceId}
          commit={menu.commit}
          currentBranch={props.currentBranch}
          headHash={props.headHash}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onError={setActionError}
          onDone={() => setReloadNonce((value) => value + 1)}
          onReword={setRewording}
        />
      )}
      {actionError?.details && (
        <GitErrorDialog
          failure={actionError}
          onClose={() => setActionError(null)}
        />
      )}
      {rewording && (
        <RewordEditor
          workspaceId={props.workspaceId}
          commit={rewording}
          onClose={() => setRewording(null)}
          onDone={() => {
            // Хеш изменился — снимаем выделение старого и перезагружаем лог.
            setExpandedHash(null);
            setReloadNonce((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}

// Карточка коммита в виде «Список». Отдельный memo-компонент: печать в поиске,
// меню, «Скопировано» и раскрытие одной карточки не трогают остальные сотню.
const CommitCard = memo(function CommitCard(props: {
  commit: GitCommitInfo;
  workspaceId: string;
  expanded: boolean;
  arriving: boolean;
  copied: boolean;
  // null — детали не показаны; иначе — идёт ли их exit-анимация.
  detailsClosing: boolean | null;
  currentBranch?: string;
  onToggle: (commit: GitCommitInfo) => void;
  onCopy: (commit: GitCommitInfo) => Promise<void>;
  onMenu: (commit: GitCommitInfo, x: number, y: number) => void;
  onSwitch: (name: string, kind: GitRefKind) => void;
}) {
  const { locale, t } = useI18n();
  const { commit, expanded } = props;
  return (
    <div
      className={`git-commit ${expanded ? "is-expanded" : ""} ${
        props.arriving ? "is-arriving" : ""
      }`}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onMenu(commit, event.clientX, event.clientY);
      }}
    >
      {/* Клик по карточке раскрывает описание, автора и соавторов. */}
      <button
        type="button"
        className="git-commit-toggle"
        aria-expanded={expanded}
        onClick={() => props.onToggle(commit)}
      >
        <div className="git-commit-subject" title={commit.subject}>
          {commit.subject}
        </div>
      </button>
      <div className="git-commit-meta">
        <button
          type="button"
          className={`git-commit-hash ${props.copied ? "is-done" : ""}`}
          title={t("git.copyHash")}
          onClick={() => void props.onCopy(commit)}
        >
          {props.copied ? t("git.copied") : commit.shortHash}
        </button>
        <span
          className="git-commit-author"
          title={`${commit.displayAuthor ?? commit.author} <${commit.authorEmail}>`}
        >
          {/* В раскрытой карточке имя дополняется почтой прямо здесь,
              отдельной строки «Автор» нет — без дублей. */}
          <AuthorAvatar
            name={commit.displayAuthor ?? commit.author}
            email={commit.authorEmail}
          />
          {commit.displayAuthor ?? commit.author}
          {expanded && (
            <span className="git-commit-email">
              {" "}
              &lt;{commit.authorEmail}&gt;
            </span>
          )}
        </span>
        <span className="git-commit-date">
          {formatRelativeTime(commit.epochMs, locale)}
        </span>
        {commit.unpushed && (
          <span className="git-commit-unpushed" title={t("git.unpushedHint")}>
            {t("git.unpushed")}
          </span>
        )}
        {commit.refDetails.map((ref) => (
          <RefBadge
            key={`${ref.kind}:${ref.name}`}
            refName={ref.name}
            fullRefName={ref.fullName}
            kind={ref.kind}
            currentBranch={props.currentBranch}
            onSwitch={props.onSwitch}
          />
        ))}
      </div>
      <button
        type="button"
        className="git-commit-menu-btn"
        title={t("git.commitActions")}
        aria-label={t("git.commitActions")}
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          props.onMenu(commit, rect.right, rect.bottom);
        }}
      >
        ⋯
      </button>
      {props.detailsClosing !== null && (
        <RevealHeight closing={props.detailsClosing}>
          <CommitDetails
            workspaceId={props.workspaceId}
            commit={commit}
            closing={props.detailsClosing}
          />
        </RevealHeight>
      )}
    </div>
  );
});
