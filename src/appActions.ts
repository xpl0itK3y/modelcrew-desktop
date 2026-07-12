import { DockviewGroupPanel } from "dockview";

// Мост между компонентами, которые dockview рендерит в шапках групп,
// и состоянием App (диалоги и т.п.) — без завязки на React-контекст.
export const appActions = {
  requestCloseGroup: (_group: DockviewGroupPanel): void => {},
  // Панели передают только владельца; cwd остаётся внутри Rust-реестра.
  getActiveWorkspaceId: (): string | null => null,
  hasActiveWorkspace: (): boolean => false,
  // Онбординг: создать воркспейс через выбор папки проекта.
  requestCreateWorkspace: (): void => {},
};
