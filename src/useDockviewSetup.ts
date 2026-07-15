import {
  useCallback,
  useEffect,
  useRef,
  type MutableRefObject,
} from "react";
import { DockviewApi, DockviewReadyEvent } from "dockview";
import { listen } from "@tauri-apps/api/event";
import {
  destroyTerminal,
  isManualTitle,
  rememberAutoTitle,
} from "./terminal/registry";
import { rememberAgentProcess } from "./agents";
import { addPanel, localizeDefaultPanelTitles } from "./layoutOps";
import {
  activeSession,
  type FolderRuntimeStatus,
  type WorkspacesState,
} from "./persist";

type UseDockviewSetupOptions = {
  apiRef: MutableRefObject<DockviewApi | null>;
  suppressCleanupRef: MutableRefObject<boolean>;
  workspacesRef: MutableRefObject<WorkspacesState>;
  rootErrorsRef: MutableRefObject<Record<string, FolderRuntimeStatus>>;
  applyAutoTitles: (api: DockviewApi) => void;
  schedulePersist: () => void;
  setTerminalCount: (count: number) => void;
  setZoomed: (zoomed: boolean) => void;
};

// Жизненный цикл dockview: onReady вешает слушатели, восстанавливает layout
// активной сессии и подписывается на pty-title; размонтирование всё снимает.
export function useDockviewSetup({
  apiRef,
  suppressCleanupRef,
  workspacesRef,
  rootErrorsRef,
  applyAutoTitles,
  schedulePersist,
  setTerminalCount,
  setZoomed,
}: UseDockviewSetupOptions) {
  const dockviewDisposablesRef = useRef<Array<{ dispose(): void }>>([]);
  const ptyTitleUnlistenRef = useRef<(() => void) | null>(null);
  const dockviewDisposedRef = useRef(false);

  useEffect(() => {
    dockviewDisposedRef.current = false;
    return () => {
      dockviewDisposedRef.current = true;
      ptyTitleUnlistenRef.current?.();
      ptyTitleUnlistenRef.current = null;
      for (const disposable of dockviewDisposablesRef.current) {
        disposable.dispose();
      }
      dockviewDisposablesRef.current = [];
      apiRef.current = null;
    };
  }, [apiRef]);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      for (const disposable of dockviewDisposablesRef.current) {
        disposable.dispose();
      }
      dockviewDisposablesRef.current = [];
      ptyTitleUnlistenRef.current?.();
      ptyTitleUnlistenRef.current = null;
      apiRef.current = event.api;
      const keep = (disposable: { dispose(): void }) => {
        dockviewDisposablesRef.current.push(disposable);
      };

      // Закрытие панели любым путём (крестик, группа, хоткей) должно
      // убивать процесс — кроме временного swap между сессиями.
      keep(
        event.api.onDidRemovePanel((panel) => {
          if (!suppressCleanupRef.current) {
            void destroyTerminal(panel.id);
          }
          setTerminalCount(event.api.panels.length);
        }),
      );
      keep(
        event.api.onDidAddPanel(() => {
          setTerminalCount(event.api.panels.length);
        }),
      );
      // Вкладок нет: перетаскивание может целиться только в сплиты,
      // дроп в центр/таббар чужой группы запрещён.
      keep(
        event.api.onWillShowOverlay((overlay) => {
          if (
            overlay.kind === "tab" ||
            overlay.kind === "header_space" ||
            (overlay.kind === "content" && overlay.position === "center")
          ) {
            overlay.preventDefault();
          }
        }),
      );

      if ("__TAURI_INTERNALS__" in window) {
        void listen<{ id: string; title: string }>(
          "pty-title",
          (titleEvent) => {
            rememberAutoTitle(titleEvent.payload.id, titleEvent.payload.title);
            // Агент в фокусе панели — кандидат на авто-возобновление после
            // полного перезапуска приложения.
            rememberAgentProcess(titleEvent.payload.id, titleEvent.payload.title);
            const panel = event.api.getPanel(titleEvent.payload.id);
            const titleKind = panel?.api.getParameters<{
              titleKind?: string;
            }>().titleKind;
            if (
              panel &&
              titleKind !== "manual" &&
              !isManualTitle(titleEvent.payload.id)
            ) {
              panel.api.setTitle(titleEvent.payload.title);
              panel.api.updateParameters({
                ...panel.api.getParameters(),
                titleKind: "process",
              });
            }
          },
        )
          .then((unlisten) => {
            if (
              dockviewDisposedRef.current ||
              apiRef.current !== event.api
            ) {
              unlisten();
              return;
            }
            ptyTitleUnlistenRef.current?.();
            ptyTitleUnlistenRef.current = unlisten;
          })
          .catch(() => {});
      }

      // Восстанавливаем только последнюю активную сессию проекта.
      const { list, activeId } = workspacesRef.current;
      const workspace = list.find((item) => item.id === activeId);
      const session = workspace ? activeSession(workspace) : undefined;
      if (
        workspace?.folder &&
        session &&
        !rootErrorsRef.current[workspace.id] &&
        session.layout
      ) {
        try {
          event.api.fromJSON(localizeDefaultPanelTitles(session.layout)!);
        } catch {
          event.api.closeAllGroups();
          addPanel(event.api, workspace.id, session.id);
        }
      } else if (
        workspace?.folder &&
        session &&
        !rootErrorsRef.current[workspace.id]
      ) {
        addPanel(event.api, workspace.id, session.id);
      }
      applyAutoTitles(event.api);
      setTerminalCount(event.api.panels.length);

      keep(event.api.onDidLayoutChange(schedulePersist));
      keep(
        event.api.onDidMaximizedGroupChange(() => {
          setZoomed(event.api.hasMaximizedGroup());
        }),
      );
    },
    [
      apiRef,
      applyAutoTitles,
      rootErrorsRef,
      schedulePersist,
      setTerminalCount,
      setZoomed,
      suppressCleanupRef,
      workspacesRef,
    ],
  );

  return onReady;
}
