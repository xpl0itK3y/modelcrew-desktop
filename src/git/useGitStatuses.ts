// Статус git по файлам проекта: что в дереве и на вкладках ещё не закоммичено.
//
// Панель «Изменения» знает это давно, но она отдельная колонка, и открыта она
// далеко не всегда. Файл, который правит агент, человек видит в дереве — и
// именно там до сих пор не было ни следа того, что файл изменён.

import { useEffect, useMemo, useState } from "react";
import {
  projectPathOf,
  subscribeGitChanges,
  type GitChangesSummary,
  type GitFileStatus,
} from "./gitChanges";

export type GitStatuses = {
  /// Статус файла по пути внутри проекта. `undefined` — файл не менялся, это
  /// не репозиторий или сводка ещё не пришла.
  of: (path: string) => GitFileStatus | undefined;
  /// Внутри этой папки есть изменённое. Свёрнутая папка иначе прячет всё, что
  /// в ней тронули, и дерево молчит о целой ветке проекта.
  inside: (path: string) => boolean;
};

/// Ответ, когда отвечать нечего. Один на всех: новый объект на каждый рендер
/// заставлял бы перерисовываться каждую строку дерева.
const NOTHING: GitStatuses = {
  of: () => undefined,
  inside: () => false,
};

export function useGitStatuses(workspaceId: string): GitStatuses {
  const [summary, setSummary] = useState<GitChangesSummary | null>(null);

  useEffect(() => {
    setSummary(null);
    if (!workspaceId) {
      return;
    }
    return subscribeGitChanges(workspaceId, setSummary);
  }, [workspaceId]);

  return useMemo(() => {
    if (!summary?.isRepo || summary.files.length === 0) {
      return NOTHING;
    }
    const byPath = new Map<string, GitFileStatus>();
    const dirs = new Set<string>();
    for (const file of summary.files) {
      const path = projectPathOf(summary, file.path);
      if (path === null) {
        // Файл репозитория за пределами открытого проекта: показать его негде.
        continue;
      }
      byPath.set(path, file.status);
      let at = path.lastIndexOf("/");
      while (at > 0) {
        const dir = path.slice(0, at);
        if (dirs.has(dir)) {
          // Эту папку уже отметили, а значит и всех её родителей.
          break;
        }
        dirs.add(dir);
        at = dir.lastIndexOf("/");
      }
    }
    return {
      of: (path: string) => byPath.get(path),
      inside: (path: string) => dirs.has(path),
    };
  }, [summary]);
}
