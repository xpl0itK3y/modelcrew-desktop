// Validation and migration of persisted workspaces state: each stored shape
// (v1..v3) is normalized into the current model without trusting the input.

import {
  DEFAULT_SESSION_DISPLAY_NAME,
  bindLayoutToSession,
  createDefaultSession,
  folderBaseName,
  isRecord,
  isSerializedDockview,
  normalizeDefaultIndex,
  normalizeTimestamp,
  randomSessionName,
  type FolderRef,
  type TerminalSession,
  type Workspace,
} from "./model";

function normalizeFolder(value: unknown): FolderRef | null {
  if (
    !isRecord(value) ||
    typeof value.selectedPath !== "string" ||
    typeof value.canonicalPath !== "string"
  ) {
    return null;
  }
  return {
    selectedPath: value.selectedPath,
    canonicalPath: value.canonicalPath,
    identityKey:
      typeof value.identityKey === "string" ? value.identityKey : null,
  };
}

function normalizeSession(
  value: unknown,
  workspaceId: string,
  fallbackIndex: number,
  now: number,
): TerminalSession | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }

  const customName =
    typeof value.displayName === "string" ? value.displayName : "";
  const nameMode =
    value.nameMode === "custom" && customName.trim().length > 0
      ? "custom"
      : "default";
  const defaultIndex = normalizeDefaultIndex(value.defaultIndex, fallbackIndex);
  const layout = isSerializedDockview(value.layout)
    ? bindLayoutToSession(value.layout, workspaceId, value.id)
    : null;

  return {
    id: value.id,
    displayName: nameMode === "custom" ? customName : DEFAULT_SESSION_DISPLAY_NAME,
    nameMode,
    // Старые сессии без кодового имени получают его один раз при загрузке.
    generatedName:
      typeof value.generatedName === "string" &&
      value.generatedName.trim().length > 0
        ? value.generatedName
        : randomSessionName(),
    defaultIndex,
    layout,
    createdAt: normalizeTimestamp(value.createdAt, now),
    lastOpenedAt: normalizeTimestamp(value.lastOpenedAt, now),
  };
}

export function normalizeWorkspaceV3(value: unknown, now: number): Workspace | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.displayName !== "string"
  ) {
    return null;
  }

  const workspaceId = value.id;
  const sessions: TerminalSession[] = [];
  const sessionIds = new Set<string>();
  const defaultIndices = new Set<number>();

  if (Array.isArray(value.sessions)) {
    value.sessions.forEach((candidate, index) => {
      const session = normalizeSession(candidate, workspaceId, index + 1, now);
      if (!session || sessionIds.has(session.id)) {
        return;
      }

      let uniqueDefaultIndex = session.defaultIndex;
      while (defaultIndices.has(uniqueDefaultIndex)) {
        uniqueDefaultIndex += 1;
      }
      session.defaultIndex = uniqueDefaultIndex;
      sessionIds.add(session.id);
      defaultIndices.add(uniqueDefaultIndex);
      sessions.push(session);
    });
  }

  if (sessions.length === 0) {
    sessions.push(createDefaultSession(workspaceId, null, now));
  }

  const requestedActiveSessionId =
    typeof value.activeSessionId === "string" ? value.activeSessionId : null;
  const activeSessionId = sessions.some(
    (session) => session.id === requestedActiveSessionId,
  )
    ? requestedActiveSessionId!
    : sessions[0].id;

  return {
    id: workspaceId,
    displayName: value.displayName,
    nameMode: value.nameMode === "folder" ? "folder" : "custom",
    folder: normalizeFolder(value.folder),
    sessions,
    activeSessionId,
    createdAt: normalizeTimestamp(value.createdAt, now),
    lastOpenedAt: normalizeTimestamp(value.lastOpenedAt, now),
  };
}

export function migrateWorkspaceV2(value: unknown, now: number): Workspace | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.displayName !== "string"
  ) {
    return null;
  }

  const createdAt = normalizeTimestamp(value.createdAt, now);
  const lastOpenedAt = normalizeTimestamp(value.lastOpenedAt, now);
  const session = {
    ...createDefaultSession(
      value.id,
      isSerializedDockview(value.layout) ? value.layout : null,
      createdAt,
    ),
    lastOpenedAt,
  };
  return {
    id: value.id,
    displayName: value.displayName,
    nameMode: value.nameMode === "folder" ? "folder" : "custom",
    folder: normalizeFolder(value.folder),
    sessions: [session],
    activeSessionId: session.id,
    createdAt,
    lastOpenedAt,
  };
}

export function migrateWorkspaceV1(value: unknown, now: number): Workspace | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string"
  ) {
    return null;
  }

  const folder = typeof value.folder === "string" ? value.folder : null;
  const session = createDefaultSession(
    value.id,
    isSerializedDockview(value.layout) ? value.layout : null,
    now,
  );
  return {
    id: value.id,
    displayName: value.name,
    nameMode:
      folder && folderBaseName(folder) === value.name ? "folder" : "custom",
    folder: folder
      ? {
          selectedPath: folder,
          canonicalPath: folder,
          identityKey: null,
        }
      : null,
    sessions: [session],
    activeSessionId: session.id,
    createdAt: now,
    lastOpenedAt: now,
  };
}

export function normalizeWorkspaceList(
  values: unknown[],
  normalize: (value: unknown) => Workspace | null,
): Workspace[] {
  const workspaceIds = new Set<string>();
  const result: Workspace[] = [];
  values.forEach((value) => {
    const workspace = normalize(value);
    if (!workspace || workspaceIds.has(workspace.id)) {
      return;
    }
    workspaceIds.add(workspace.id);
    result.push(workspace);
  });
  return result;
}

// Инвариант «одна папка — один проект». Дубликаты по одному пути
// (накапливались при откатах/восстановлении состояния) схлопываем в один —
// оставляем недавно открытый. Иначе backend-регистрация корня конфликтует и
// «Новый терминал» у проигравших дубликатов уводит на выбор папки.
export function dedupeWorkspacesByFolder(list: Workspace[]): Workspace[] {
  const indexByPath = new Map<string, number>();
  const result: Workspace[] = [];
  for (const workspace of list) {
    const key =
      workspace.folder?.canonicalPath || workspace.folder?.selectedPath;
    if (!key) {
      // Непривязанные проекты уникальны сами по себе.
      result.push(workspace);
      continue;
    }
    const existing = indexByPath.get(key);
    if (existing === undefined) {
      indexByPath.set(key, result.length);
      result.push(workspace);
    } else if (workspace.lastOpenedAt > result[existing].lastOpenedAt) {
      result[existing] = workspace;
    }
  }
  return result;
}
