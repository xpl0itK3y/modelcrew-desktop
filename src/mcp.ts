import { invoke } from "@tauri-apps/api/core";

/// Что приложение знает о собственном MCP-сервере.
export type McpStatus = {
  // Положение выключателя.
  enabled: boolean;
  // Стоит ли слушатель на самом деле. Расходится с `enabled` там, где сервера
  // нет и быть не может: на Windows трубу ещё не проложили.
  listening: boolean;
  // Адрес сокета — им же человек проверяет, что сервер поднялся.
  socket: string | null;
  // Имена инструментов, как их видит агент.
  tools: string[];
};

export function getMcpStatus(): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_status");
}

export function setMcpEnabled(enabled: boolean): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_set_enabled", { enabled });
}
