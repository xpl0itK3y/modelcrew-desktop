// Кто именно ждёт ответа, в виде, пригодном для показа. Системный баннер
// нажатие не отдаёт — на десктопе плагин уведомлений обработчиков не имеет, —
// зато щелчок по нему поднимает окно, и дальше довести до панели должны мы.

import { AGENTS, getAgentRecord } from "../agents";
import { sessionDisplayName, type Workspace } from "../persist";
import { getWaitingPanelIds } from "./attentionStore";
import { getAutoTitle } from "./panelTitles";
import { getTerminalWorkspaceId } from "./registry";

export type WaitingPanel = {
  panelId: string;
  // Подпись агента, если панель успели опознать.
  agent: string | null;
  // Заголовок панели: имя процесса или то, что задал пользователь.
  title: string | null;
  project: string | null;
  session: string | null;
};

export function describeWaitingPanel(
  panelId: string,
  workspaces: readonly Workspace[],
  formatDefaultSession: (index: number) => string,
): WaitingPanel {
  const workspaceId = getTerminalWorkspaceId(panelId);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  // Сессию ищем по сохранённой раскладке — панель может быть в скрытой.
  //
  // Не нашлась ни в одной — значит, это активная сессия: её раскладка в
  // persist пишется снимком (при переключении сессии, проекта, правках их
  // списка), а живые панели добавляются в dockview между снимками. Без этой
  // развилки имя пропадало ровно у тех панелей, ради различения которых оно
  // и появилось: у двух только что открытых в текущей сессии.
  const session =
    workspace?.sessions.find((item) => item.layout?.panels?.[panelId]) ??
    workspace?.sessions.find((item) => item.id === workspace.activeSessionId);
  const agentId = getAgentRecord(panelId)?.agentId;
  return {
    panelId,
    agent: agentId
      ? (AGENTS.find((entry) => entry.id === agentId)?.label ?? agentId)
      : null,
    title: getAutoTitle(panelId) ?? null,
    project: workspace?.displayName ?? null,
    session: session ? sessionDisplayName(session, formatDefaultSession) : null,
  };
}

export function describeWaitingPanels(
  workspaces: readonly Workspace[],
  formatDefaultSession: (index: number) => string,
): WaitingPanel[] {
  return getWaitingPanelIds().map((panelId) =>
    describeWaitingPanel(panelId, workspaces, formatDefaultSession),
  );
}
