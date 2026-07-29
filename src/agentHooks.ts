import { invoke } from "@tauri-apps/api/core";
import { AGENTS } from "./agents";

// Подключение хука агента к его собственному конфигу. Точные сигналы («ход
// закончен», «нужно разрешение») приходят только так: разбор вывода панели
// остаётся запасным каналом и знает лишь то, что агент напечатал.

export type AgentHookState = {
  agent: string;
  // Умеем ли мы подключаться к этому агенту вообще.
  supported: boolean;
  // Подключён ли хук прямо сейчас.
  installed: boolean;
  // Файл, который правится: правка чужого конфига не должна быть вслепую.
  config: string;
};

const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function loadAgentHookStates(): Promise<AgentHookState[]> {
  if (!isTauri()) {
    return [];
  }
  return invoke<AgentHookState[]>("agent_hook_status", {
    agents: AGENTS.map((agent) => agent.id),
  });
}

export async function setAgentHook(
  agent: string,
  enabled: boolean,
): Promise<AgentHookState> {
  return invoke<AgentHookState>("agent_hook_set", { agent, enabled });
}
