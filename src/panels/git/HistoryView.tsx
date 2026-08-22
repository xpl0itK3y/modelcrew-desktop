import { useEffect, useRef, useState } from "react";
import { describeBackendError, useI18n, type BackendFailure } from "../../i18n";
import { refreshGitChanges, subscribeGitChanges } from "../../git/gitChanges";
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
import { RewordEditor } from "./history/RewordEditor";
import { GitErrorDialog } from "./GitErrorDialog";

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
  const { locale, t } = useI18n();
  const [commits, setCommits] = useState<GitCommitInfo[] | null>(null);
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
  const [limit, setLimit] = useState(100);
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
  const openMenu = (commit: GitCommitInfo, x: number, y: number) =>
    setMenu({ commit, x, y });
  // Коммиты, появившиеся при открытой вкладке, въезжают с анимацией;
  // первоначальный список и догруженные «Показать ещё» (они старше уже
  // виденных) показываются сразу.
  const knownHashesRef = useRef<Set<string> | null>(null);
  const arrivedHashesRef = useRef(new Set<string>());
  const newestEpochRef = useRef(0);
  if (commits !== null) {
    if (knownHashesRef.current === null) {
      knownHashesRef.current = new Set(commits.map((commit) => commit.hash));
      newestEpochRef.current = commits[0]?.epochMs ?? 0;
    } else {
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
  }

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const request = ++logRequestRef.current;
      fetchLog(
        props.workspaceId,
        limit,
        allBranches,
        filtering ? { [searchField]: search } : undefined,
      )
        .then((log) => {
          if (!cancelled && logRequestRef.current === request) {
            setCommits(log);
            setLoadingMore(false);
          }
        })
        .catch(() => {
          if (!cancelled && logRequestRef.current === request) {
            setCommits([]);
            setLoadingMore(false);
          }
        });
    };
    load();
    // Новый коммит (из панели или терминала) сразу появляется в истории.
    const unsubscribe = subscribeGitChanges(props.workspaceId, load);
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

  const copyHash = async (commit: GitCommitInfo) => {
    try {
      await navigator.clipboard.writeText(commit.hash);
      setCopiedHash(commit.hash);
      window.setTimeout(() => setCopiedHash(null), 1_500);
    } catch {
      // Буфер обмена недоступен — молча.
    }
  };

  // Переключение на ветку/тег по клику на бейдж; ошибка (грязное дерево и т.п.)
  // показывается баннером.
  const switchTo = async (name: string, kind: GitRefKind) => {
    try {
      await switchBranch(props.workspaceId, name, kind);
      void refreshGitChanges(props.workspaceId);
      setReloadNonce((value) => value + 1);
    } catch (error) {
      setActionError(describeBackendError(error));
    }
  };

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
            setLimit(100);
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
            setLimit(100);
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
            onSelect={(commit) =>
              setExpandedHash(expandedHash === commit.hash ? null : commit.hash)
            }
            detailsPresence={detailsPresence}
            onMenu={openMenu}
            onSwitchBranch={(name, kind) => void switchTo(name, kind)}
            currentBranch={props.currentBranch}
            upstreamBranch={props.upstreamBranch}
            workingTreeCount={workingTreeCount}
            onOpenChanges={props.onOpenChanges}
          />
        ) : (
          <div className="git-commit-list">
            {workingTreeCount > 0 && (
              <button
                type="button"
                className="git-worktree-card"
                title={t("git.workingTreeHint")}
                onClick={props.onOpenChanges}
              >
                <span className="git-worktree-dot" aria-hidden="true" />
                <span className="git-worktree-text">
                  {t("git.workingTree", { count: String(workingTreeCount) })}
                </span>
              </button>
            )}
            {commits.map((commit) => {
              const expanded = expandedHash === commit.hash;
              return (
                <div
                  key={commit.hash}
                  className={`git-commit ${expanded ? "is-expanded" : ""} ${
                    arrivedHashesRef.current.has(commit.hash)
                      ? "is-arriving"
                      : ""
                  }`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openMenu(commit, event.clientX, event.clientY);
                  }}
                >
                  {/* Клик по карточке раскрывает описание, автора и соавторов. */}
                  <button
                    type="button"
                    className="git-commit-toggle"
                    aria-expanded={expanded}
                    onClick={() =>
                      setExpandedHash(expanded ? null : commit.hash)
                    }
                  >
                    <div className="git-commit-subject" title={commit.subject}>
                      {commit.subject}
                    </div>
                  </button>
                  <div className="git-commit-meta">
                    <button
                      type="button"
                      className={`git-commit-hash ${
                        copiedHash === commit.hash ? "is-done" : ""
                      }`}
                      title={t("git.copyHash")}
                      onClick={() => void copyHash(commit)}
                    >
                      {copiedHash === commit.hash
                        ? t("git.copied")
                        : commit.shortHash}
                    </button>
                    <span
                      className="git-commit-author"
                      title={`${commit.author} <${commit.authorEmail}>`}
                    >
                      {/* В раскрытой карточке имя дополняется почтой прямо здесь,
                    отдельной строки «Автор» нет — без дублей. */}
                      <AuthorAvatar
                        name={commit.author}
                        email={commit.authorEmail}
                      />
                      {commit.author}
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
                      <span
                        className="git-commit-unpushed"
                        title={t("git.unpushedHint")}
                      >
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
                        onSwitch={(name, kind) => void switchTo(name, kind)}
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
                      openMenu(commit, rect.right, rect.bottom);
                    }}
                  >
                    ⋯
                  </button>
                  {detailsPresence?.item === commit.hash && (
                    <RevealHeight closing={detailsPresence.closing}>
                      <CommitDetails
                        workspaceId={props.workspaceId}
                        commit={commit}
                        closing={detailsPresence.closing}
                      />
                    </RevealHeight>
                  )}
                </div>
              );
            })}
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
