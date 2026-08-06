// Дерево проекта: чтение одного каталога.
//
// Бэкенд отдаёт папку целиком, но только одну — раскрытие спрашивается
// отдельно. Здесь только вызов и типы; что раскрыто и что выбрано, помнит сам
// вид дерева.

import { invoke } from "@tauri-apps/api/core";

export type TreeEntry = {
  name: string;
  /// Путь от корня проекта, через `/` на всех платформах.
  path: string;
  isDir: boolean;
};

export type TreeListing = {
  entries: TreeEntry[];
  /// Каталог оказался больше, чем показываем: список обрезан.
  truncated: boolean;
};

export function readWorkspaceDir(
  workspaceId: string,
  path: string,
): Promise<TreeListing> {
  return invoke<TreeListing>("workspace_read_dir", { workspaceId, path });
}

/// Родительские каталоги пути, от ближнего к корню: `src/panels/Tree.tsx` даёт
/// `src` и `src/panels`. Нужны, чтобы раскрыть дерево до уже открытого файла.
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  const ancestors: string[] = [];
  let prefix = "";
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    ancestors.push(prefix);
  }
  return ancestors;
}

export type FileContent = {
  content: string;
  isBinary: boolean;
  tooLarge: boolean;
  exists: boolean;
};

/// Читает файл проекта мимо git: папка без репозитория остаётся папкой с
/// файлами, и открывать их в ней надо так же.
export function readWorkspaceFile(
  workspaceId: string,
  path: string,
): Promise<FileContent> {
  return invoke<FileContent>("workspace_read_file", { workspaceId, path });
}

export function writeWorkspaceFile(
  workspaceId: string,
  path: string,
  content: string,
): Promise<void> {
  return invoke("workspace_write_file", { workspaceId, path, content });
}
