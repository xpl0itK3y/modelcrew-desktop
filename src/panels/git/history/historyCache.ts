// Последний журнал, который показала «История», — по проекту.
//
// Вкладка перемонтируется при каждом переключении «Изменения ⇄ История». Без
// этой памяти она всякий раз начинала с заглушки загрузки, ждала git и потом разом
// вываливала сотню строк посреди анимации вкладки. Теперь вкладка сразу
// рисует то, что было, а свежий журнал подменяет его, только если что-то
// поменялось.
//
// Помнится лишь журнал «как вкладка открывается»: первая страница текущей
// ветки без фильтров. Поиск, «Все ветки» и догрузка — каждый раз заново.

import { fetchLog, type GitCommitInfo } from "../../../git/gitLog";

export const HISTORY_PAGE = 100;

type Remembered = { ticket: number; log: GitCommitInfo[] };

const remembered = new Map<string, Remembered>();
const warming = new Set<string>();
let tickets = 0;

export function recentHistory(workspaceId: string): GitCommitInfo[] | null {
  return remembered.get(workspaceId)?.log ?? null;
}

export function fetchHistory(workspaceId: string): Promise<GitCommitInfo[]> {
  const ticket = ++tickets;
  return fetchLog(workspaceId, HISTORY_PAGE).then((log) => {
    // Ответы git приходят не по порядку: старый не должен затереть новый.
    if (ticket > (remembered.get(workspaceId)?.ticket ?? 0)) {
      remembered.set(workspaceId, { ticket, log });
    }
    return log;
  });
}

// Курсор над вкладкой «История»: до клика git обычно успевает ответить, и
// первое за сессию открытие тоже обходится без заглушки. Сама вкладка
// всё равно спросит свежий журнал — подогретый нужен только чтобы было что
// показать сразу.
export function warmHistory(workspaceId: string): void {
  if (remembered.has(workspaceId) || warming.has(workspaceId)) {
    return;
  }
  warming.add(workspaceId);
  fetchHistory(workspaceId)
    .catch(() => {})
    .finally(() => warming.delete(workspaceId));
}

export function forgetHistory(): void {
  remembered.clear();
  warming.clear();
}
