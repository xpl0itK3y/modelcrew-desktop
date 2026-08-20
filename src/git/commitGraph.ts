// Раскладка основана на открытой MIT-реализации SCM History Graph из
// VS Code 1.129.1. Важная часть модели: одинаковый будущий commit может
// одновременно находиться в нескольких swimlane. Такие дорожки нельзя
// объединять раньше строки этого commit — иначе ветвление выглядит неверно.
// Зафиксированный источник и лицензия перечислены в THIRD_PARTY_NOTICES.md.

import {
  GRAPH_LOCAL_REF_COLOR,
  GRAPH_PALETTE_SIZE,
  GRAPH_REMOTE_REF_COLOR,
} from "./graphGeometry";

export type GraphEdge = {
  fromCol: number;
  toCol: number;
  color: number;
  // Сквозная дорожка либо связь с точкой текущего коммита.
  kind: "through" | "commit";
  // Hash, к которому ведёт дорожка/ребро.
  targetHash: string;
  // Только для commit -> parent: 0 — первый родитель, 1+ — merge-parent.
  parentIndex?: number;
};

export type GraphLane = {
  col: number;
  color: number;
  targetHash: string;
};

export type GraphRow = {
  // Колонка точки коммита и её цвет (индекс в GRAPH_COLORS).
  col: number;
  color: number;
  // Число занятых колонок в этой строке. SVG добавляет ещё одну единицу
  // справа, как рендерер VS Code, чтобы текст не прижимался к крайней lane.
  width: number;
  // Неизменившиеся дорожки и их возможный сдвиг при схлопывании дублей.
  through: GraphEdge[];
  // Входы из одинаковых swimlane в точку текущего коммита.
  top: GraphEdge[];
  // Выходы из точки к первому и дополнительным родителям.
  bottom: GraphEdge[];
  // Ordered input/output swimlanes — полезны и рендереру деталей, и тестам.
  lanesAbove: GraphLane[];
  lanesBelow: GraphLane[];
};

/// Рёбра строки, лежащие на линии текущей ветки, — по индексу в своём массиве.
///
/// Больше одного ребра каждого рода на строке быть не может: дорожка либо
/// проходит мимо коммита, либо входит в его точку и выходит из неё к первому
/// родителю. Поэтому здесь индекс, а не список.
export type GraphTrailRow = {
  through: number | null;
  top: number | null;
  bottom: number | null;
};

export type GraphInput = {
  hash: string;
  parents: string[];
  refs?: string[];
  refDetails?: Array<{
    name: string;
    fullName?: string;
    kind: "local" | "remote" | "tag";
  }>;
  isHead?: boolean;
};

export type CommitGraphOptions = {
  currentBranch?: string;
  // null означает, что upstream точно отсутствует; undefined оставляет
  // эвристику только для старых/изолированных вызовов без Git summary.
  upstreamBranch?: string | null;
};

type Lane = {
  targetHash: string;
  color: number;
};

const cloneLane = (lane: Lane): Lane => ({ ...lane });

function inferUpstreamBranch(
  commits: readonly GraphInput[],
  currentBranch: string | undefined,
): string | undefined {
  if (!currentBranch) {
    return undefined;
  }

  const refs = new Set(
    commits.flatMap((commit) =>
      commit.refDetails
        ? commit.refDetails
            .filter((ref) => ref.kind === "remote")
            .map((ref) => ref.name)
        : (commit.refs ?? []),
    ),
  );
  const originRef = `origin/${currentBranch}`;
  if (refs.has(originRef)) {
    return originRef;
  }

  // Удалённый репозиторий может называться не origin. Локальная ветка с тем
  // же именем уже отсеяна точным сравнением.
  const suffix = `/${currentBranch}`;
  return [...refs].find((ref) => ref.endsWith(suffix));
}

/// Линия текущей ветки: цепочка первых родителей вниз от HEAD.
///
/// Цвет дорожки на этот вопрос не отвечает: у ветки и её upstream он один и
/// тот же, а после перехода на другую ветку прежняя дорожка остаётся на месте
/// и того же цвета. Меняется только то, откуда идёт HEAD, — её и ведём.
///
/// Выше HEAD в графе лежат коммиты соседних веток: там подсвечивать нечего,
/// поэтому обход молчит, пока не встретит его строку. Если дорожка по пути
/// схлопнулась с соседней (сходятся к общему родителю), ведение прекращается —
/// лучше оборвать линию, чем увести её на чужую ветку.
export function traceCurrentBranch(
  rows: readonly GraphRow[],
  commits: readonly GraphInput[],
): GraphTrailRow[] {
  const trail: GraphTrailRow[] = rows.map(() => ({
    through: null,
    top: null,
    bottom: null,
  }));

  // Колонка дорожки, уносящей текущую ветку вниз из предыдущей строки.
  let col: number | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const mark = trail[index];
    const from = col;
    if (from === null) {
      if (!commits[index]?.isHead) {
        continue;
      }
    } else {
      const enters = row.top.findIndex((edge) => edge.fromCol === from);
      if (enters === -1) {
        const passes = row.through.findIndex((edge) => edge.fromCol === from);
        mark.through = passes === -1 ? null : passes;
        col = passes === -1 ? null : row.through[passes].toCol;
        continue;
      }
      mark.top = enters;
    }
    const leaves = row.bottom.findIndex((edge) => edge.parentIndex === 0);
    mark.bottom = leaves === -1 ? null : leaves;
    col = leaves === -1 ? null : row.bottom[leaves].toCol;
  }

  return trail;
}

export function computeCommitGraph(
  commits: GraphInput[],
  options: CommitGraphOptions = {},
): GraphRow[] {
  // Вход обязан быть обратным топологическим порядком: каждый загруженный
  // потомок расположен выше любого своего загруженного родителя. Backend
  // гарантирует это через `git log --topo-order`.
  let lanes: Lane[] = [];
  let colorIndex = -1;
  const nextPaletteColor = () => {
    colorIndex = (colorIndex + 1) % GRAPH_PALETTE_SIZE;
    return colorIndex;
  };

  const upstreamBranch =
    options.upstreamBranch === undefined
      ? inferUpstreamBranch(commits, options.currentBranch)
      : (options.upstreamBranch ?? undefined);
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const labelColor = (commit: GraphInput | undefined): number | undefined => {
    if (!commit) {
      return undefined;
    }
    const localRefs = commit.refDetails
      ? commit.refDetails
          .filter((ref) => ref.kind === "local")
          .map((ref) => ref.name)
      : (commit.refs ?? []);
    const remoteRefs = commit.refDetails
      ? commit.refDetails
          .filter((ref) => ref.kind === "remote")
          .map((ref) => ref.name)
      : (commit.refs ?? []);
    if (
      commit.isHead ||
      (options.currentBranch !== undefined &&
        localRefs.includes(options.currentBranch))
    ) {
      return GRAPH_LOCAL_REF_COLOR;
    }
    if (upstreamBranch !== undefined && remoteRefs.includes(upstreamBranch)) {
      return GRAPH_REMOTE_REF_COLOR;
    }
    return undefined;
  };

  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const before = lanes.map(cloneLane);
    const inputIndex = before.findIndex(
      (lane) => lane.targetHash === commit.hash,
    );
    // Если commit ещё не представлен lane (например, вершина другой ветки),
    // его точка появляется сразу справа от существующего input.
    const col = inputIndex === -1 ? before.length : inputIndex;
    const commitLabelColor = labelColor(commit);
    const after: Lane[] = [];
    let firstParentAdded = false;

    if (commit.parents.length > 0) {
      // Первый parent заменяет первое вхождение текущего commit. Остальные
      // вхождения того же hash удаляются только здесь — в точке сходимости.
      for (const lane of before) {
        if (lane.targetHash === commit.hash) {
          if (!firstParentAdded) {
            after.push({
              targetHash: commit.parents[0],
              color: commitLabelColor ?? lane.color,
            });
            firstParentAdded = true;
          }
          continue;
        }
        after.push(cloneLane(lane));
      }
    } else {
      // VS Code очищает output целиком у root-коммита. Для несвязанных Git
      // историй сохраняем чужие живые lanes: иначе один root оборвёт другой.
      after.push(
        ...before
          .filter((lane) => lane.targetHash !== commit.hash)
          .map(cloneLane),
      );
    }

    // Если commit не был в input, добавляется и первый parent. Все
    // дополнительные родители всегда добавляются справа — существующие
    // swimlane не сдвигаются ради новой merge-ветки.
    for (
      let parentIndex = firstParentAdded ? 1 : 0;
      parentIndex < commit.parents.length;
      parentIndex += 1
    ) {
      const parentHash = commit.parents[parentIndex];
      const semanticColor =
        parentIndex === 0
          ? commitLabelColor
          : labelColor(byHash.get(parentHash));
      after.push({
        targetHash: parentHash,
        color: semanticColor ?? nextPaletteColor(),
      });
    }

    // Повторяем последовательное сопоставление input/output из renderer VS
    // Code. Сравнение идёт по hash, а не по уникальному id lane: это и даёт
    // правильное позднее схлопывание одинаковых будущих родителей.
    const through: GraphEdge[] = [];
    const top: GraphEdge[] = [];
    let outputIndex = 0;
    for (let index = 0; index < before.length; index += 1) {
      const lane = before[index];
      if (lane.targetHash === commit.hash) {
        top.push({
          fromCol: index,
          toCol: col,
          color: lane.color,
          kind: "commit",
          targetHash: commit.hash,
        });
        if (index === col && commit.parents.length > 0) {
          outputIndex += 1;
        }
        continue;
      }

      if (
        outputIndex < after.length &&
        lane.targetHash === after[outputIndex].targetHash
      ) {
        through.push({
          fromCol: index,
          toCol: outputIndex,
          color: lane.color,
          kind: "through",
          targetHash: lane.targetHash,
        });
        outputIndex += 1;
      }
    }

    const bottom: GraphEdge[] = [];
    if (commit.parents.length > 0) {
      bottom.push({
        fromCol: col,
        toCol: col,
        color: after[col].color,
        kind: "commit",
        targetHash: commit.parents[0],
        parentIndex: 0,
      });
    }
    for (let parentIndex = 1; parentIndex < commit.parents.length; parentIndex += 1) {
      const targetHash = commit.parents[parentIndex];
      // Дополнительный parent был добавлен последним; при одинаковых hash
      // renderer намеренно соединяется с последним их вхождением.
      let parentCol = -1;
      for (let index = after.length - 1; index >= 0; index -= 1) {
        if (after[index].targetHash === targetHash) {
          parentCol = index;
          break;
        }
      }
      if (parentCol !== -1) {
        bottom.push({
          fromCol: col,
          toCol: parentCol,
          color: after[parentCol].color,
          kind: "commit",
          targetHash,
          parentIndex,
        });
      }
    }

    const circleColor =
      (commit.parents.length > 0 ? after[col]?.color : undefined) ??
      before[col]?.color ??
      commitLabelColor ??
      GRAPH_LOCAL_REF_COLOR;
    lanes = after;
    rows.push({
      col,
      color: circleColor,
      width: Math.max(before.length, after.length, 1),
      through,
      top,
      bottom,
      lanesAbove: before.map((lane, laneCol) => ({
        col: laneCol,
        color: lane.color,
        targetHash: lane.targetHash,
      })),
      lanesBelow: after.map((lane, laneCol) => ({
        col: laneCol,
        color: lane.color,
        targetHash: lane.targetHash,
      })),
    });
  }

  return rows;
}
