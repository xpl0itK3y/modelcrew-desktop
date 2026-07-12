import { DockviewGroupPanel } from "dockview";

// Мост между компонентами, которые dockview рендерит в шапках групп,
// и состоянием App (диалоги и т.п.) — без завязки на React-контекст.
export const appActions = {
  requestCloseGroup: (_group: DockviewGroupPanel): void => {},
  // Папка активного воркспейса — стартовый cwd новых терминалов.
  getActiveFolder: (): string | null => null,
};
