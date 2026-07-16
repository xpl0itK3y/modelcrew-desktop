// Каталог CLI-агентов с возобновляемыми сессиями. После полного перезапуска
// приложения восстановленный терминал автоматически продолжает диалог: сам
// агент хранит историю чата в своих файлах, нам достаточно запустить его
// resume-команду в той же папке проекта.
//
// Безопасность: в localStorage хранится только идентификатор агента и имя
// бинаря; команда всегда собирается из этого каталога, так что подделанное
// хранилище не может подсунуть произвольную строку в оболочку.

import { invoke } from "@tauri-apps/api/core";

export type AgentDefinition = {
  id: string;
  // Человекочитаемое имя для настроек.
  label: string;
  // Имена foreground-процессов, по которым агент распознаётся (watcher
  // заголовков уже отдаёт их, например "codex" или "claude").
  processNames: string[];
  // Аргументы «продолжить последний диалог этой папки».
  resumeLast: string[];
  // Аргументы «показать список диалогов» — для второй и последующих панелей
  // того же агента в той же папке, чтобы не открыть везде один и тот же чат.
  resumePicker: string[];
  // Аргументы точного возобновления: id сессии добавляется последним.
  // Отсутствует у агентов без адресного resume.
  resumeSession?: string[];
};

// Флаги сверены с документацией CLI (июль 2026).
export const AGENTS: AgentDefinition[] = [
  {
    id: "claude",
    label: "Claude Code",
    processNames: ["claude"],
    resumeLast: ["--continue"],
    resumePicker: ["--resume"],
    resumeSession: ["--resume"],
  },
  {
    id: "codex",
    label: "Codex",
    processNames: ["codex"],
    resumeLast: ["resume", "--last"],
    resumePicker: ["resume"],
    resumeSession: ["resume"],
  },
  {
    id: "opencode",
    label: "OpenCode",
    processNames: ["opencode"],
    resumeLast: ["--continue"],
    resumePicker: ["--continue"],
    resumeSession: ["--session"],
  },
  {
    id: "kilocode",
    label: "Kilo Code",
    processNames: ["kilocode", "kilo"],
    resumeLast: ["--continue"],
    resumePicker: ["--continue"],
    resumeSession: ["--session"],
  },
  {
    id: "grok",
    label: "Grok Build",
    processNames: ["grok"],
    resumeLast: ["-c"],
    resumePicker: ["--resume"],
    resumeSession: ["--resume"],
  },
  {
    id: "cursor",
    label: "Cursor",
    processNames: ["cursor-agent"],
    resumeLast: ["--continue"],
    resumePicker: ["resume"],
    resumeSession: ["--resume"],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    processNames: ["gemini"],
    resumeLast: ["--resume"],
    resumePicker: ["--resume"],
    resumeSession: ["--resume"],
  },
  {
    id: "qwen",
    label: "Qwen Code",
    processNames: ["qwen"],
    resumeLast: ["--continue"],
    resumePicker: ["--resume"],
    resumeSession: ["--resume"],
  },
  {
    id: "aider",
    label: "Aider",
    processNames: ["aider"],
    // У aider одна история на репозиторий, адресных сессий нет.
    resumeLast: ["--restore-chat-history"],
    resumePicker: ["--restore-chat-history"],
  },
  {
    id: "amp",
    label: "Amp",
    processNames: ["amp"],
    resumeLast: ["threads", "continue"],
    resumePicker: ["threads", "continue"],
    resumeSession: ["threads", "continue"],
  },
  {
    id: "antigravity",
    label: "Antigravity",
    processNames: ["agy"],
    resumeLast: ["--continue"],
    resumePicker: ["--continue"],
    resumeSession: ["--conversation"],
  },
];

export type AgentResumeMode = "off" | "insert" | "auto";

const RESUME_MODE_STORAGE_KEY = "modelcrew.agentResumeMode";
const DEFAULT_RESUME_MODE: AgentResumeMode = "auto";

export function loadAgentResumeMode(): AgentResumeMode {
  try {
    const raw = localStorage.getItem(RESUME_MODE_STORAGE_KEY);
    if (raw === "off" || raw === "insert" || raw === "auto") {
      return raw;
    }
  } catch {
    // Падение хранилища — работаем с режимом по умолчанию.
  }
  return DEFAULT_RESUME_MODE;
}

export function saveAgentResumeMode(mode: AgentResumeMode): void {
  try {
    localStorage.setItem(RESUME_MODE_STORAGE_KEY, mode);
  } catch {
    // Non-fatal: выбор не переживёт перезапуск.
  }
}

export function matchAgent(
  processName: string,
): { agent: AgentDefinition; command: string } | null {
  const name = processName.trim().toLowerCase();
  for (const agent of AGENTS) {
    if (agent.processNames.includes(name)) {
      return { agent, command: name };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Реестр «в какой панели какой агент работал». Живёт в localStorage, чтобы
// пережить полный выход: при восстановлении панели по нему собирается
// resume-команда. Запись существует, только пока агент — foreground-процесс
// панели (watcher чистит её, когда агент завершился).

type AgentRecord = {
  agentId: string;
  command: string;
  // Момент обнаружения агента — окно поиска его файла сессии.
  detectedAt: number;
  // Точный id сессии агента (uuid), когда локатор его нашёл.
  sessionId?: string;
};

// Буквы/цифры/дефис/подчёркивание: uuid (claude, codex, agy) и ses_… (opencode).
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const RECORDS_STORAGE_KEY = "modelcrew.terminalAgents";

function loadRecords(): Record<string, AgentRecord> {
  try {
    const raw = localStorage.getItem(RECORDS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const records: Record<string, AgentRecord> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (
        value !== null &&
        typeof value === "object" &&
        typeof (value as AgentRecord).agentId === "string" &&
        typeof (value as AgentRecord).command === "string"
      ) {
        const candidate = value as AgentRecord;
        const sessionId =
          typeof candidate.sessionId === "string" &&
          SESSION_ID_PATTERN.test(candidate.sessionId)
            ? candidate.sessionId
            : undefined;
        records[id] = {
          agentId: candidate.agentId,
          command: candidate.command,
          detectedAt:
            typeof candidate.detectedAt === "number" &&
            Number.isFinite(candidate.detectedAt)
              ? candidate.detectedAt
              : 0,
          ...(sessionId ? { sessionId } : {}),
        };
      }
    }
    return records;
  } catch {
    return {};
  }
}

function saveRecords(records: Record<string, AgentRecord>): void {
  try {
    localStorage.setItem(RECORDS_STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Non-fatal: возобновление просто не сработает после рестарта.
  }
}

// TUI-агенты (codex и др.) гоняют подпроцессы: foreground на тик-другой
// становится не-агентом, хотя агент жив. Запись стирается только после
// устойчивой смены — короткая вспышка (или тик в момент Cmd+Q) её не убьёт.
const AGENT_MISS_TOLERANCE = 3;
const agentMisses = new Map<string, number>();

// Watcher заголовков зовёт это на каждое имя foreground-процесса: агент в
// фокусе — записываем, устойчивый не-агент — запись снимается.
// Возвращает true, когда в панели работает известный агент, — сигнал
// планировать привязку точной сессии.
export function rememberAgentProcess(
  terminalId: string,
  processName: string,
): boolean {
  const records = loadRecords();
  const matched = matchAgent(processName);
  const existing = records[terminalId];
  if (matched) {
    agentMisses.delete(terminalId);
    if (
      existing?.agentId === matched.agent.id &&
      existing.command === matched.command
    ) {
      return true;
    }
    records[terminalId] = {
      agentId: matched.agent.id,
      command: matched.command,
      detectedAt: Date.now(),
    };
    saveRecords(records);
    return true;
  }
  if (existing) {
    const misses = (agentMisses.get(terminalId) ?? 0) + 1;
    if (misses < AGENT_MISS_TOLERANCE) {
      agentMisses.set(terminalId, misses);
      return false;
    }
    agentMisses.delete(terminalId);
    delete records[terminalId];
    saveRecords(records);
  }
  return false;
}

export function discardAgentRecord(terminalId: string): void {
  const records = loadRecords();
  if (records[terminalId]) {
    delete records[terminalId];
    saveRecords(records);
  }
}

export function pruneAgentRecords(keepIds: string[]): void {
  const keep = new Set(keepIds);
  const records = loadRecords();
  let changed = false;
  for (const id of Object.keys(records)) {
    if (!keep.has(id)) {
      delete records[id];
      changed = true;
    }
  }
  if (changed) {
    saveRecords(records);
  }
}

export function getAgentRecord(terminalId: string): AgentRecord | null {
  return loadRecords()[terminalId] ?? null;
}

// Привязывает панели точный id сессии агента (результат работы локатора).
export function bindAgentSession(terminalId: string, sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return;
  }
  const records = loadRecords();
  const record = records[terminalId];
  if (!record || record.sessionId === sessionId) {
    return;
  }
  records[terminalId] = { ...record, sessionId };
  saveRecords(records);
}

// Сессии этого агента, уже занятые другими панелями: локатор их пропускает,
// чтобы шесть клаудов в одном проекте получили шесть разных чатов.
export function boundAgentSessionIds(
  agentId: string,
  exceptTerminalId: string,
): string[] {
  const ids: string[] = [];
  for (const [terminalId, record] of Object.entries(loadRecords())) {
    if (
      terminalId !== exceptTerminalId &&
      record.agentId === agentId &&
      record.sessionId
    ) {
      ids.push(record.sessionId);
    }
  }
  return ids;
}

// Собирает shell-строку возобновления. picker: в этой папке уже возобновлялась
// панель того же агента — вместо «последнего диалога» открываем список, чтобы
// не продолжить один и тот же чат дважды.
export function buildAgentResume(
  record: { agentId: string; command: string; sessionId?: string },
  picker: boolean,
): string | null {
  const agent = AGENTS.find((entry) => entry.id === record.agentId);
  if (!agent) {
    return null;
  }
  // Бинарь принимается только из каталога; чужое значение откатывается
  // к каноническому имени.
  const command = agent.processNames.includes(record.command)
    ? record.command
    : agent.processNames[0];
  // Точный id (перепроверенный по формату) — продолжаем ровно свой чат.
  if (
    record.sessionId &&
    SESSION_ID_PATTERN.test(record.sessionId) &&
    agent.resumeSession
  ) {
    return [command, ...agent.resumeSession, record.sessionId].join(" ");
  }
  const args = picker ? agent.resumePicker : agent.resumeLast;
  return [command, ...args].join(" ");
}

// ---------------------------------------------------------------------------
// Привязка сессии через Rust-локатор. Файл сессии может появиться с задержкой
// (после первого сообщения), поэтому несколько попыток с нарастающей паузой.

const isTauri = "__TAURI_INTERNALS__" in window;
const LOCATE_ATTEMPT_DELAYS_MS = [1_500, 6_000, 20_000];

const pendingBindings = new Set<string>();

async function locateOnce(terminalId: string, cwd: string): Promise<boolean> {
  const record = getAgentRecord(terminalId);
  if (!record || record.sessionId) {
    return true; // привязка не нужна или уже есть
  }
  const agent = AGENTS.find((entry) => entry.id === record.agentId);
  if (!agent?.resumeSession) {
    return true; // у агента нет адресного resume
  }
  try {
    const found = await invoke<string | null>("agent_session_locate", {
      agent: record.agentId,
      cwd,
      sinceEpochMs: Math.max(0, Math.round(record.detectedAt)),
      exclude: boundAgentSessionIds(record.agentId, terminalId),
    });
    if (found) {
      bindAgentSession(terminalId, found);
      return true;
    }
  } catch {
    // Локатор — best-effort: без id останется мягкий фолбэк на --continue.
  }
  return false;
}

// Зовётся watcher'ом при обнаружении агента в панели.
export function scheduleAgentSessionBinding(
  terminalId: string,
  cwd: string,
): void {
  if (!isTauri || pendingBindings.has(terminalId)) {
    return;
  }
  pendingBindings.add(terminalId);
  let attempt = 0;
  const tryLocate = () => {
    void locateOnce(terminalId, cwd).then((done) => {
      attempt += 1;
      if (done || attempt >= LOCATE_ATTEMPT_DELAYS_MS.length) {
        pendingBindings.delete(terminalId);
        return;
      }
      window.setTimeout(tryLocate, LOCATE_ATTEMPT_DELAYS_MS[attempt]);
    });
  };
  window.setTimeout(tryLocate, LOCATE_ATTEMPT_DELAYS_MS[0]);
}
