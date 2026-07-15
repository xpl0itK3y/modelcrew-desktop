// Каталог CLI-агентов с возобновляемыми сессиями. После полного перезапуска
// приложения восстановленный терминал автоматически продолжает диалог: сам
// агент хранит историю чата в своих файлах, нам достаточно запустить его
// resume-команду в той же папке проекта.
//
// Безопасность: в localStorage хранится только идентификатор агента и имя
// бинаря; команда всегда собирается из этого каталога, так что подделанное
// хранилище не может подсунуть произвольную строку в оболочку.

export type AgentDefinition = {
  id: string;
  // Имена foreground-процессов, по которым агент распознаётся (watcher
  // заголовков уже отдаёт их, например "codex" или "claude").
  processNames: string[];
  // Аргументы «продолжить последний диалог этой папки».
  resumeLast: string[];
  // Аргументы «показать список диалогов» — для второй и последующих панелей
  // того же агента в той же папке, чтобы не открыть везде один и тот же чат.
  resumePicker: string[];
};

// Флаги сверены с документацией CLI (июль 2026).
export const AGENTS: AgentDefinition[] = [
  {
    id: "claude",
    processNames: ["claude"],
    resumeLast: ["--continue"],
    resumePicker: ["--resume"],
  },
  {
    id: "codex",
    processNames: ["codex"],
    resumeLast: ["resume", "--last"],
    resumePicker: ["resume"],
  },
  {
    id: "opencode",
    processNames: ["opencode"],
    resumeLast: ["--continue"],
    resumePicker: ["--continue"],
  },
  {
    id: "kilocode",
    processNames: ["kilocode", "kilo"],
    resumeLast: ["--continue"],
    resumePicker: ["--continue"],
  },
  {
    id: "antigravity",
    processNames: ["agy"],
    resumeLast: ["--continue"],
    resumePicker: ["--continue"],
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
};

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
        records[id] = {
          agentId: (value as AgentRecord).agentId,
          command: (value as AgentRecord).command,
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

// Watcher заголовков зовёт это на каждое имя foreground-процесса: агент в
// фокусе — записываем, обычная команда/оболочка — запись снимается.
export function rememberAgentProcess(
  terminalId: string,
  processName: string,
): void {
  const records = loadRecords();
  const matched = matchAgent(processName);
  const existing = records[terminalId];
  if (matched) {
    if (
      existing?.agentId === matched.agent.id &&
      existing.command === matched.command
    ) {
      return;
    }
    records[terminalId] = { agentId: matched.agent.id, command: matched.command };
  } else {
    if (!existing) {
      return;
    }
    delete records[terminalId];
  }
  saveRecords(records);
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

export function getAgentRecord(
  terminalId: string,
): { agentId: string; command: string } | null {
  return loadRecords()[terminalId] ?? null;
}

// Собирает shell-строку возобновления. picker: в этой папке уже возобновлялась
// панель того же агента — вместо «последнего диалога» открываем список, чтобы
// не продолжить один и тот же чат дважды.
export function buildAgentResume(
  record: { agentId: string; command: string },
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
  const args = picker ? agent.resumePicker : agent.resumeLast;
  return [command, ...args].join(" ");
}
