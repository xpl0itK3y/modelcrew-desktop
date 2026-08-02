// Последнее автоимя каждой панели — процесс переднего плана, которым она
// подписана на вкладке.
//
// Отдельно от реестра терминалов нарочно. Реестр при загрузке подписывается на
// события Tauri и поднимает xterm, а имя панели нужно и тем частям интерфейса,
// которые к терминалам отношения не имеют: список снимков, например, просто
// показывает, чья это работа. Тащить ради строки весь реестр — значит тянуть
// за собой и его окружение.
//
// Панели скрытых воркспейсов событий не получают: при переключении обратно имя
// доводится из этого кэша.

const autoTitles = new Map<string, string>();

export function rememberAutoTitle(id: string, title: string): void {
  autoTitles.set(id, title);
}

export function getAutoTitle(id: string): string | undefined {
  return autoTitles.get(id);
}

export function forgetAutoTitle(id: string): void {
  autoTitles.delete(id);
}
