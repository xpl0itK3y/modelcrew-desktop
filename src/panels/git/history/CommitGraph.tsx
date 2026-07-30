// Граф коммитов: строки списка, линии между ними и метки ссылок.
// Геометрия вынесена в git/graphGeometry — здесь только отрисовка и поведение
// строки: выбор, раскрытие карточки, вызов меню действий.

import { Fragment, useMemo } from "react";
import { useI18n } from "../../../i18n";
import {
  formatRelativeTime,
  type GitCommitInfo,
  type GitRefKind,
} from "../../../git/gitChanges";
import { computeCommitGraph } from "../../../git/commitGraph";
import {
  GRAPH_COLORS,
  GRAPH_DOT_RADIUS,
  GRAPH_HEAD_INNER_RADIUS,
  GRAPH_HEAD_INNER_STROKE_WIDTH,
  GRAPH_HEAD_OUTER_RADIUS,
  GRAPH_LANE_WIDTH,
  GRAPH_MERGE_INNER_RADIUS,
  GRAPH_MERGE_OUTER_RADIUS,
  GRAPH_NODE_STROKE_WIDTH,
  GRAPH_ROW_HEIGHT,
  GRAPH_STROKE_WIDTH,
  graphIncomingPath,
  graphLaneCenter,
  graphParentPath,
  graphThroughPath,
} from "../../../git/graphGeometry";
import { AuthorAvatar } from "./AuthorAvatar";
import { CommitDetails, RevealHeight } from "./CommitDetails";

function laneColor(index: number): string {
  return GRAPH_COLORS[index % GRAPH_COLORS.length];
}

// Аватарка автора: реальная (GitHub/Gravatar) — только для вошедшего через
// GitHub пользователя и при включённой настройке «Из сети». Иначе (не вошёл,
// офлайн, нет аватара, опция «Инициалы») — цветной кружок с инициалами.

export function RefBadge(props: {
  refName: string;
  fullRefName: string;
  kind: GitRefKind;
  currentBranch?: string;
  onSwitch: (name: string, kind: GitRefKind) => void;
}) {
  const { t } = useI18n();
  const isTag = props.kind === "tag";
  const label = props.refName;
  const isRemote = props.kind === "remote";
  const isCurrent = !isTag && !isRemote && label === props.currentBranch;
  const kind = isTag ? "is-tag" : isRemote ? "is-remote" : "";
  const title = isCurrent
    ? t("git.refCurrentHint")
    : isTag
      ? t("git.checkoutTag", { name: label })
      : isRemote
        ? t("git.checkoutRefRemote", { name: label })
        : t("git.switchToRef", { name: label });
  return (
    <button
      type="button"
      className={`git-commit-ref ${kind} ${isCurrent ? "is-current" : ""}`}
      title={title}
      aria-current={isCurrent || undefined}
      disabled={isCurrent}
      onClick={(event) => {
        event.stopPropagation();
        if (!isCurrent) {
          props.onSwitch(
            isRemote ? props.fullRefName : label,
            isTag ? "tag" : isRemote ? "remote" : "local",
          );
        }
      }}
    >
      {label}
    </button>
  );
}

// Модальный редактор сообщения коммита: первая строка — заголовок, дальше —
// описание. Сохранение переписывает локальный коммит (бэкенд проверяет
// безопасность). Доступен только для собственных локальных коммитов.

export function CommitGraph(props: {
  commits: GitCommitInfo[];
  workspaceId: string;
  selectedHash: string | null;
  onSelect: (commit: GitCommitInfo) => void;
  detailsPresence: { item: string; closing: boolean } | null;
  onMenu: (commit: GitCommitInfo, x: number, y: number) => void;
  onSwitchBranch: (name: string, kind: GitRefKind) => void;
  currentBranch?: string;
  upstreamBranch?: string;
  workingTreeCount: number;
  onOpenChanges: () => void;
}) {
  const { locale, t } = useI18n();
  const rows = useMemo(
    () =>
      computeCommitGraph(
        props.commits.map((commit) => ({
          hash: commit.hash,
          parents: commit.parents,
          refs: commit.refs,
          refDetails: commit.refDetails,
          isHead: commit.isHead,
        })),
        {
          currentBranch: props.currentBranch,
          upstreamBranch: props.upstreamBranch ?? null,
        },
      ),
    [props.commits, props.currentBranch, props.upstreamBranch],
  );
  const head = rows[0];
  const headWidth = ((head?.width ?? 1) + 1) * GRAPH_LANE_WIDTH;

  return (
    <div className="git-graph">
      {props.workingTreeCount > 0 && head && (
        <button
          type="button"
          className="git-graph-row is-worktree"
          title={t("git.workingTreeHint")}
          onClick={props.onOpenChanges}
        >
          <svg
            className="git-graph-lines"
            width={headWidth}
            height={GRAPH_ROW_HEIGHT}
            style={{ width: headWidth, minWidth: headWidth }}
            aria-hidden="true"
          >
            {/* Пунктирный поводок от рабочего дерева вниз к точке HEAD. Свой
                «отросток» вверх у свежего коммита граф не рисует, поэтому
                тянем линию в его строку (svg — overflow: visible). */}
            <line
              x1={graphLaneCenter(head.col)}
              y1={GRAPH_ROW_HEIGHT / 2}
              x2={graphLaneCenter(head.col)}
              y2={GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2}
              stroke={laneColor(head.color)}
              strokeWidth={GRAPH_STROKE_WIDTH}
              strokeDasharray="2 2"
            />
            <circle
              cx={graphLaneCenter(head.col)}
              cy={GRAPH_ROW_HEIGHT / 2}
              r={GRAPH_HEAD_OUTER_RADIUS}
              fill="var(--git-graph-node-bg, var(--mc-bg))"
              stroke={laneColor(head.color)}
              strokeWidth={GRAPH_NODE_STROKE_WIDTH}
            />
          </svg>
          <span className="git-graph-subject git-worktree-label">
            {t("git.workingTree", {
              count: String(props.workingTreeCount),
            })}
          </span>
        </button>
      )}
      {props.commits.map((commit, index) => {
        const row = rows[index];
        if (!row) {
          return null;
        }
        const isMerge = commit.parents.length > 1;
        const cx = graphLaneCenter(row.col);
        const rowWidth = (row.width + 1) * GRAPH_LANE_WIDTH;
        const selected = props.selectedHash === commit.hash;
        return (
          <Fragment key={commit.hash}>
            <div
              role="button"
              tabIndex={0}
              className={`git-graph-row ${selected ? "is-selected" : ""} ${
                commit.isHead ? "is-head" : ""
              }`}
              onClick={() => props.onSelect(commit)}
              onContextMenu={(event) => {
                event.preventDefault();
                props.onMenu(commit, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  props.onSelect(commit);
                }
              }}
            >
              <svg
                className="git-graph-lines"
                width={rowWidth}
                height={GRAPH_ROW_HEIGHT}
                style={{ width: rowWidth, minWidth: rowWidth }}
                aria-hidden="true"
              >
                {row.through.map((edge, k) => (
                  <path
                    key={`x-${edge.fromCol}-${edge.toCol}-${edge.targetHash}-${k}`}
                    d={graphThroughPath(edge.fromCol, edge.toCol)}
                    fill="none"
                    stroke={laneColor(edge.color)}
                    strokeWidth={GRAPH_STROKE_WIDTH}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                {row.top.map((edge, k) => (
                  <path
                    key={`t-${edge.fromCol}-${edge.toCol}-${k}`}
                    d={graphIncomingPath(edge.fromCol, edge.toCol)}
                    fill="none"
                    stroke={laneColor(edge.color)}
                    strokeWidth={GRAPH_STROKE_WIDTH}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                {row.bottom.map((edge, k) => (
                  <path
                    key={`b-${edge.fromCol}-${edge.toCol}-${edge.parentIndex}-${k}`}
                    d={graphParentPath(
                      edge.fromCol,
                      edge.toCol,
                      edge.parentIndex ?? 0,
                    )}
                    fill="none"
                    stroke={laneColor(edge.color)}
                    strokeWidth={GRAPH_STROKE_WIDTH}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                {commit.isHead ? (
                  <>
                    <circle
                      cx={cx}
                      cy={GRAPH_ROW_HEIGHT / 2}
                      r={GRAPH_HEAD_OUTER_RADIUS}
                      fill={laneColor(row.color)}
                      stroke="var(--git-graph-node-bg, var(--mc-bg))"
                      strokeWidth={GRAPH_NODE_STROKE_WIDTH}
                    />
                    <circle
                      cx={cx}
                      cy={GRAPH_ROW_HEIGHT / 2}
                      r={GRAPH_HEAD_INNER_RADIUS}
                      fill="var(--git-graph-node-bg, var(--mc-bg))"
                      stroke="var(--git-graph-node-bg, var(--mc-bg))"
                      strokeWidth={GRAPH_HEAD_INNER_STROKE_WIDTH}
                    />
                  </>
                ) : isMerge ? (
                  <>
                    <circle
                      cx={cx}
                      cy={GRAPH_ROW_HEIGHT / 2}
                      r={GRAPH_MERGE_OUTER_RADIUS}
                      fill={laneColor(row.color)}
                      stroke="var(--git-graph-node-bg, var(--mc-bg))"
                      strokeWidth={GRAPH_NODE_STROKE_WIDTH}
                    />
                    <circle
                      cx={cx}
                      cy={GRAPH_ROW_HEIGHT / 2}
                      r={GRAPH_MERGE_INNER_RADIUS}
                      fill="var(--git-graph-node-bg, var(--mc-bg))"
                      stroke="var(--git-graph-node-bg, var(--mc-bg))"
                      strokeWidth={GRAPH_NODE_STROKE_WIDTH}
                    />
                  </>
                ) : (
                  <circle
                    cx={cx}
                    cy={GRAPH_ROW_HEIGHT / 2}
                    r={GRAPH_DOT_RADIUS}
                    fill={laneColor(row.color)}
                    stroke="var(--git-graph-node-bg, var(--mc-bg))"
                    strokeWidth={GRAPH_NODE_STROKE_WIDTH}
                  />
                )}
              </svg>
              <span className="git-graph-subject" title={commit.subject}>
                {commit.subject}
              </span>
              {commit.refDetails.map((ref) => (
                <RefBadge
                  key={`${ref.kind}:${ref.name}`}
                  refName={ref.name}
                  fullRefName={ref.fullName}
                  kind={ref.kind}
                  currentBranch={props.currentBranch}
                  onSwitch={props.onSwitchBranch}
                />
              ))}
              <div className="git-graph-right">
                <span
                  className="git-graph-date"
                  title={new Intl.DateTimeFormat(locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(commit.epochMs))}
                >
                  {formatRelativeTime(commit.epochMs, locale)}
                </span>
                <span className="git-graph-who">
                  <AuthorAvatar
                    name={commit.author}
                    email={commit.authorEmail}
                  />
                  <span className="git-graph-author" title={commit.author}>
                    {commit.author}
                  </span>
                </span>
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
              </div>
            </div>
            {props.detailsPresence?.item === commit.hash && (
              <div
                className="git-graph-details"
                style={{ paddingLeft: rowWidth + 14 }}
              >
                {/* Продолжаем состояние дорожек с нижней границы строки,
                    чтобы граф не рвался на раскрытой карточке коммита. */}
                <span
                  className="git-graph-details-lanes"
                  style={{ width: rowWidth }}
                  aria-hidden="true"
                >
                  {row.lanesBelow.map((lane) => (
                    <span
                      key={lane.col}
                      className="git-graph-lane-through"
                      style={{
                        left: graphLaneCenter(lane.col),
                        background: laneColor(lane.color),
                      }}
                    />
                  ))}
                </span>
                <RevealHeight closing={props.detailsPresence.closing}>
                  <CommitDetails
                    workspaceId={props.workspaceId}
                    commit={commit}
                    closing={props.detailsPresence.closing}
                  />
                </RevealHeight>
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
