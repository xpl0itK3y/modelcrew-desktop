// Кто именно ждёт ответа, в виде, пригодном для показа. Системный баннер
// нажатие не отдаёт — на десктопе плагин уведомлений обработчиков не имеет, —
// зато щелчок по нему поднимает окно, и дальше довести до панели должны мы.

import { AGENTS, getAgentRecord } from "../agents";
import { sessionDisplayName, type Workspace } from "../persist";
import { getWaitingPanelIds } from "./agentAlerts";
import { getAutoTitle, getTerminalWorkspaceId } from "./registry";

export type WaitingPanel = {
  panelId: string;
  // Подпись агента, если панель успели опознать.
  agent: string | null;
  // Заголовок панели: имя процесса или то, что задал пользователь.
  title: string | null;
  project: string | null;
  session: string | null;
};

export function describeWaitingPanels(
  workspaces: readonly Workspace[],
  formatDefaultSession: (index: number) => string,
): WaitingPanel[] {
  return getWaitingPanelIds().map((panelId) => {
    const workspaceId = getTerminalWorkspaceId(panelId);
    const workspace = workspaces.find((item) => item.id === workspaceId);
    // Сессию ищем по сохранённой раскладке — панель может быть в скрытой.
    const session = workspace?.sessions.find(
      (item) => item.layout?.panels?.[panelId],
    );
    const agentId = getAgentRecord(panelId)?.agentId;
    return {
      panelId,
      agent: agentId
        ? (AGENTS.find((entry) => entry.id === agentId)?.label ?? agentId)
        : null,
      title: getAutoTitle(panelId) ?? null,
      project: workspace?.displayName ?? null,
      session: session
        ? sessionDisplayName(session, formatDefaultSession)
        : null,
    };
  });
}
