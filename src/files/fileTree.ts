// Дерево проекта: чтение одного каталога.
//
// Бэкенд отдаёт папку целиком, но только одну — раскрытие спрашивается
// отдельно. Здесь только вызов и типы; что раскрыто и что выбрано, помнит сам
// вид дерева.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../platform";

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

type TreeChangedEvent = {
  workspaceId: string;
  /// Каталоги, чьё содержимое изменилось, путями от корня.
  dirs: string[];
  /// Названы не все: перечитывать надо всё раскрытое.
  partial: boolean;
};

/// Слежение за деревом проекта.
///
/// Отдельно от git-вотчера нарочно: тот дедуплицирует по сводке `git status` и
/// молчит, когда изменился игнорируемый файл, а в папке без репозитория его
/// нет вовсе. Дереву же безразлично, под гитом файл или нет.
export function watchWorkspaceTree(
  workspaceId: string,
  onChanged: (dirs: string[], partial: boolean) => void,
): () => void {
  if (!isTauri) {
    return () => {};
  }
  let stopped = false;
  const unlisten = listen<TreeChangedEvent>("workspace-tree", (event) => {
    if (!stopped && event.payload.workspaceId === workspaceId) {
      onChanged(event.payload.dirs, event.payload.partial);
    }
  });
  void invoke("workspace_tree_watch", { workspaceId }).catch(() => {
    // Вотчер мог не подняться — упёрлись в лимит системы. Дерево от этого не
    // ломается: оно обновляется по раскрытию папки, как раньше.
  });
  return () => {
    stopped = true;
    void unlisten.then((stop) => stop()).catch(() => {});
    void invoke("workspace_tree_unwatch", { workspaceId }).catch(() => {});
  };
}
