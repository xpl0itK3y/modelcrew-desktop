import { useCallback } from "react";
import {
  DockviewApi,
  DockviewGroupPanel,
  DockviewReact,
  DockviewReadyEvent,
  IDockviewHeaderActionsProps,
  IWatermarkPanelProps,
  themeDark,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import { TerminalPanel } from "./panels/TerminalPanel";
import { destroyTerminal } from "./terminal/registry";
import "./App.css";

// Минимальный размер панели по ТЗ: ~30 колонок × 7 строк терминала.
export const PANEL_MIN_WIDTH = 240;
export const PANEL_MIN_HEIGHT = 160;

const components = { terminal: TerminalPanel };

let panelCounter = 0;

function addPanel(api: DockviewApi, group?: DockviewGroupPanel) {
  panelCounter += 1;
  api.addPanel({
    id: crypto.randomUUID(),
    component: "terminal",
    title: `Терминал ${panelCounter}`,
    minimumWidth: PANEL_MIN_WIDTH,
    minimumHeight: PANEL_MIN_HEIGHT,
    ...(group ? { position: { referenceGroup: group } } : {}),
  });
}

function GroupAddButton(props: IDockviewHeaderActionsProps) {
  return (
    <div className="group-actions">
      <button
        type="button"
        className="icon-button"
        title="Новый терминал"
        onClick={() => addPanel(props.containerApi, props.group)}
      >
        +
      </button>
    </div>
  );
}

function Watermark(props: IWatermarkPanelProps) {
  return (
    <div className="watermark">
      <button
        type="button"
        className="watermark-button"
        onClick={() => addPanel(props.containerApi)}
      >
        + Новый терминал
      </button>
    </div>
  );
}

export default function App() {
  const onReady = useCallback((event: DockviewReadyEvent) => {
    // Закрытие панели любым путём (крестик, группа, хоткей) должно
    // убивать процесс — единая точка уборки.
    event.api.onDidRemovePanel((panel) => {
      void destroyTerminal(panel.id);
    });
    addPanel(event.api);
  }, []);

  return (
    <div className="app-root">
      <DockviewReact
        components={components}
        watermarkComponent={Watermark}
        rightHeaderActionsComponent={GroupAddButton}
        onReady={onReady}
        theme={themeDark}
      />
    </div>
  );
}
