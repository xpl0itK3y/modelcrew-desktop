import { createContext, useContext, type ReactNode } from "react";
import type { DockviewGroupPanel } from "dockview";

// Действия приложения для панелей, которые рисует dockview: ватермарк и шапка
// группы. Раньше это был изменяемый модульный объект, куда состояние
// дописывало функции из шестнадцати мест, и кто в итоге обработает нажатие,
// из кода было не видно.
//
// Контекст здесь работает: dockview рендерит части через ReactDOM.createPortal,
// то есть они остаются детьми того же дерева и провайдер до них доходит.

export type AppActions = {
  // Есть ли проект, в котором можно открыть терминал: без папки ватермарк
  // предлагает сначала выбрать её.
  hasActiveWorkspace: () => boolean;
  requestCreateWorkspace: () => void;
  requestNewTerminal: () => void;
  // Закрытие группы спрашивает подтверждение — диалог живёт в App.
  requestCloseGroup: (group: DockviewGroupPanel) => void;
};

const NOOP: AppActions = {
  hasActiveWorkspace: () => false,
  requestCreateWorkspace: () => {},
  requestNewTerminal: () => {},
  requestCloseGroup: () => {},
};

const AppActionsContext = createContext<AppActions>(NOOP);

export function AppActionsProvider(props: {
  actions: AppActions;
  children: ReactNode;
}) {
  return (
    <AppActionsContext.Provider value={props.actions}>
      {props.children}
    </AppActionsContext.Provider>
  );
}

export function useAppActions(): AppActions {
  return useContext(AppActionsContext);
}
