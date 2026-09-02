// Метки правок для открытого файла: какие его строки git ещё не видел.

import { useEffect, useMemo, useState } from "react";
import { diffLines, type LineMark } from "./lineDiff";
import {
  readHeadFile,
  repoPathOf,
  subscribeGitChanges,
  type GitChangesSummary,
} from "./gitChanges";

/// Меток нет и не будет: папка не репозиторий, файл двоичный, git недоступен.
/// Отдельный объект, а не новая пустая карта на каждый вызов: она уходит в
/// зависимости отрисовки, и новая карта означала бы перерисовку на каждый
/// кадр.
const NONE: Map<number, LineMark> = new Map();

/// Версия файла из последнего коммита. `text: null` — файла в истории нет
/// вовсе, и тогда новое в нём всё.
type Committed = { text: string | null };

/**
 * Разряд каждой правленой строки открытого текста.
 *
 * Сравниваем с закоммиченной версией сами, а не спрашиваем `git diff`, потому
 * что текст в поле ввода живее диска: правку агента вкладка подхватывает сразу,
 * а свою человек до сохранения держит только у себя. Ответ git относился бы к
 * файлу на диске, и метки разъезжались бы с первой же набранной строкой.
 */
export function useLineMarks(
  workspaceId: string,
  path: string,
  text: string,
  enabled: boolean,
): Map<number, LineMark> {
  const [committed, setCommitted] = useState<Committed | null>(null);

  useEffect(() => {
    setCommitted(null);
    if (!enabled || !workspaceId || !path) {
      return;
    }
    let cancelled = false;
    // Закоммиченная версия меняется только вместе с HEAD: индекс её не трогает,
    // и правка на диске тем более. Без этой памяти каждая пришедшая сводка —
    // а они приходят на каждое движение в рабочем дереве — заново читала бы
    // файл из истории.
    let known: string | null = null;
    const look = (summary: GitChangesSummary) => {
      if (!summary.isRepo) {
        setCommitted(null);
        return;
      }
      const head = summary.headHash ?? "";
      if (head === known) {
        return;
      }
      known = head;
      void readHeadFile(workspaceId, repoPathOf(summary, path))
        .then((file) => {
          if (cancelled) {
            return;
          }
          // Двоичное и слишком большое сравнивать нечем: у первого нет строк,
          // у второго нет содержимого. И то, и другое — «меток нет», а не
          // «файл новый целиком».
          setCommitted(
            file.isBinary || file.tooLarge
              ? null
              : { text: file.exists ? file.content : null },
          );
        })
        .catch(() => {
          if (!cancelled) {
            setCommitted(null);
          }
        });
    };
    const stop = subscribeGitChanges(workspaceId, look);
    return () => {
      cancelled = true;
      stop();
    };
  }, [workspaceId, path, enabled]);

  return useMemo(
    () => (committed ? diffLines(committed.text, text) : NONE),
    [committed, text],
  );
}
