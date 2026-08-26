import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

/// Что приложение знает о собственном MCP-сервере.
export type McpStatus = {
  // Положение выключателя плагина.
  enabled: boolean;
  // Стоит ли слушатель на самом деле. Расходится с `enabled` там, где сервера
  // нет и быть не может: на Windows трубу ещё не проложили.
  listening: boolean;
  // Адрес сокета — им же человек проверяет, что сервер поднялся.
  socket: string | null;
  // Имена инструментов, как их видит агент.
  tools: string[];
  // Сколько агентов сидит на сокете прямо сейчас.
  agents: number;
};

// Состояние держим в одном месте на всё приложение: выключатель живёт в
// настройках, а глобус в титлбаре — за три этажа оттуда, и узнать о щелчке он
// обязан сразу, без перезапуска.
let status: McpStatus | null = null;
const listeners = new Set<() => void>();

function publish(next: McpStatus): McpStatus {
  status = next;
  for (const listener of listeners) {
    listener();
  }
  return next;
}

export async function refreshMcpStatus(): Promise<McpStatus> {
  return publish(await invoke<McpStatus>("mcp_status"));
}

export async function setMcpEnabled(enabled: boolean): Promise<McpStatus> {
  return publish(await invoke<McpStatus>("mcp_set_enabled", { enabled }));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function read(): McpStatus | null {
  return status;
}

export function useMcpStatus(): McpStatus | null {
  return useSyncExternalStore(subscribe, read, read);
}

// Пока бэкенд не ответил — считаем плагин включённым. Это значение по
// умолчанию, и с ним глобус не мигает у тех, кто выключателя не трогал.
export function useBrowserPluginEnabled(): boolean {
  return useMcpStatus()?.enabled ?? true;
}

// Только для тестов: состояние переживает перерисовки, а значит и соседний
// тест, если его не сбросить.
export function forgetMcpStatus(): void {
  status = null;
}
