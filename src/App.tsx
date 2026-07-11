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
import { PlaceholderPanel } from "./panels/PlaceholderPanel";
import "./App.css";

// Минимальный размер панели по ТЗ: ~30 колонок × 7 строк терминала.
export const PANEL_MIN_WIDTH = 240;
export const PANEL_MIN_HEIGHT = 160;

const components = { placeholder: PlaceholderPanel };

let panelCounter = 0;

function addPanel(api: DockviewApi, group?: DockviewGroupPanel) {
  panelCounter += 1;
  api.addPanel({
    id: crypto.randomUUID(),
    component: "placeholder",
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
