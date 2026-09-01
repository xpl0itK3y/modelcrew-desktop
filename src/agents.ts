// Каталог CLI-агентов с возобновляемыми сессиями. После полного перезапуска
// приложения восстановленный терминал автоматически продолжает диалог: сам
// агент хранит историю чата в своих файлах, нам достаточно запустить его
// resume-команду в той же папке проекта.
//
// Безопасность: в localStorage хранится только идентификатор агента и имя
// бинаря; команда всегда собирается из этого каталога, так что подделанное
// хранилище не может подсунуть произвольную строку в оболочку.

import { invoke } from "@tauri-apps/api/core";
import { KEYS, readSetting, writeSetting } from "./settings/storage";
import { isTauri } from "./platform";

export type AgentDefinition = {
  id: string;
  // Человекочитаемое имя для настроек.
  label: string;
  // Имена foreground-процессов, по которым агент распознаётся (watcher
  // заголовков уже отдаёт их, например "codex" или "claude"). Первое из них —
  // команда запуска: из неё собирается resume.
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
    id: "copilot",
    label: "GitHub Copilot",
    processNames: ["copilot"],
    resumeLast: ["--continue"],
    resumePicker: ["--resume"],
    resumeSession: ["--resume"],
  },
  {
    id: "opencode",
    label: "OpenCode",
    processNames: ["opencode"],
    resumeLast: ["--continue"],
    resumePicker: ["--continue"],
    resumeSession: ["--session"],
  },
];

export type AgentResumeMode = "off" | "insert" | "auto";

const DEFAULT_RESUME_MODE: AgentResumeMode = "auto";

export function loadAgentResumeMode(): AgentResumeMode {
  try {
    const raw = readSetting(KEYS.agentResumeMode);
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
    writeSetting(KEYS.agentResumeMode, mode);
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

// Буквы/цифры/дефис/подчёркивание: uuid (claude, codex) и ses_… (opencode).
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// ---------------------------------------------------------------------------
// Последняя известная сессия панели. Отдельно от записи об агенте, потому что
// та живёт только пока агент — foreground-процесс: вышел в оболочку (Ctrl-D,
// /exit) — и запись стёрта вместе с найденным id. Здесь id остаётся до
// закрытия самой панели и служит запасным ответом на вопрос «какой диалог
// продолжать», когда свежей привязки нет.

type RememberedSession = {
  agentId: string;
  sessionId: string;
  // Проект, в котором живёт диалог. Нужен, чтобы «продолжить последний чат»
  // отменялось только из-за соседа по той же папке: чужая папка чужому чату
  // не конкурент. Записи прежних версий папку не помнят — такую сессию
  // считаем соседской, потому что лишний список диалогов безобиднее, чем две
  // панели в одном чате.
  workspaceId?: string;
};

function loadSessions(): Record<string, RememberedSession> {
  try {
    const raw = readSetting(KEYS.agentSessions);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const sessions: Record<string, RememberedSession> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (value === null || typeof value !== "object") {
        continue;
      }
      const candidate = value as RememberedSession;
      // Подделанное хранилище не должно попасть в команду оболочки.
      if (
        typeof candidate.agentId === "string" &&
        typeof candidate.sessionId === "string" &&
        SESSION_ID_PATTERN.test(candidate.sessionId)
      ) {
        sessions[id] = {
          agentId: candidate.agentId,
          sessionId: candidate.sessionId,
          ...(typeof candidate.workspaceId === "string"
            ? { workspaceId: candidate.workspaceId }
            : {}),
        };
      }
    }
    return sessions;
  } catch {
    return {};
  }
}

function saveSessions(sessions: Record<string, RememberedSession>): void {
  try {
    writeSetting(KEYS.agentSessions, JSON.stringify(sessions));
  } catch {
    // Non-fatal: останется прежний поиск сессии локатором.
  }
}

// Запасной id для панели: тот же агент, последняя известная его сессия. Если
// этот диалог уже занят другой панелью, запасной вариант отпадает — две панели
// в одном чате мешали бы друг другу.
export function rememberedSessionId(
  terminalId: string,
  agentId: string,
): string | undefined {
  const stored = loadSessions()[terminalId];
  if (stored?.agentId !== agentId) {
    return undefined;
  }
  return boundAgentSessionIds(agentId, terminalId).includes(stored.sessionId)
    ? undefined
    : stored.sessionId;
}

// «Продолжить последний диалог» — единственная команда возобновления, которой
// нельзя сказать «кроме этих». Она открывает самый свежий чат папки, а он
// запросто принадлежит соседней панели, которая возобновится по точному id:
// так две панели и оказываются в одном разговоре. Поэтому предлагаем её,
// только когда в этой папке нет другой панели с известным чатом того же
// агента, — иначе безопаснее показать список.
export function agentChatClaimedNearby(
  agentId: string,
  exceptTerminalId: string,
  workspaceId: string,
): boolean {
  for (const [terminalId, session] of Object.entries(loadSessions())) {
    if (terminalId === exceptTerminalId || session.agentId !== agentId) {
      continue;
    }
    if (
      session.workspaceId === undefined ||
      session.workspaceId === workspaceId
    ) {
      return true;
    }
  }
  return false;
}


function loadRecords(): Record<string, AgentRecord> {
  try {
    const raw = readSetting(KEYS.terminalAgents);
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
    writeSetting(KEYS.terminalAgents, JSON.stringify(records));
  } catch {
    // Non-fatal: возобновление просто не сработает после рестарта.
  }
}

// TUI-агенты (codex и др.) гоняют подпроцессы: foreground на тик-другой
// становится git/cargo/node, хотя агент жив. Для таких смен оставляем допуск.
// Возврат к явной оболочке — другой случай: watcher шлёт событие только
// при смене имени, поэтому ждать ещё два тика нельзя: их не будет.
const AGENT_MISS_TOLERANCE = 3;
const agentMisses = new Map<string, number>();

// friendly_name на backend уже снимает путь, login-prefix `-` и
// Windows-суффикс .exe. Но функция остаётся терпимой к старым/
// внешним вызовам, где может прийти полное имя или .exe.
const SHELL_PROCESS_NAMES = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ash",
  "ksh",
  "mksh",
  "csh",
  "tcsh",
  "nu",
  "xonsh",
  "elvish",
  "pwsh",
  "powershell",
  "cmd",
]);

export function isShellProcess(processName: string): boolean {
  const base = processName
    .trim()
    .split(/[\\/]/)
    .pop()
    ?.replace(/^[-]+/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
  return base !== undefined && SHELL_PROCESS_NAMES.has(base);
}

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
    // agent → shell — это штатный возврат в prompt. Чистим сразу,
    // иначе запись останется навсегда: watcher не повторяет
    // события для неизменившегося foreground-имени.
    if (isShellProcess(processName)) {
      agentMisses.delete(terminalId);
      delete records[terminalId];
      saveRecords(records);
      return false;
    }
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
  agentMisses.delete(terminalId);
  bindingRoots.delete(terminalId);
  const sessions = loadSessions();
  if (sessions[terminalId]) {
    delete sessions[terminalId];
    saveSessions(sessions);
  }
  const records = loadRecords();
  if (records[terminalId]) {
    delete records[terminalId];
    saveRecords(records);
  }
}

export function pruneAgentRecords(keepIds: string[]): void {
  const keep = new Set(keepIds);
  // Долговечные сессии живут ровно столько же, сколько сами панели.
  const sessions = loadSessions();
  let sessionsChanged = false;
  for (const id of Object.keys(sessions)) {
    if (!keep.has(id)) {
      delete sessions[id];
      sessionsChanged = true;
    }
  }
  if (sessionsChanged) {
    saveSessions(sessions);
  }
  const records = loadRecords();
  let changed = false;
  for (const id of Object.keys(records)) {
    if (!keep.has(id)) {
      agentMisses.delete(id);
      delete records[id];
      changed = true;
    }
  }
  // Самолечение: один чат агента не может принадлежать двум панелям
  // (наследие гонки локаторов в старых версиях). У лишних панелей привязка
  // снимается — они возобновятся фолбэком и перепривяжутся к своим чатам.
  const seen = new Set<string>();
  for (const id of Object.keys(records).sort()) {
    const record = records[id];
    if (!record.sessionId) {
      continue;
    }
    const key = `${record.agentId}:${record.sessionId}`;
    if (seen.has(key)) {
      const { sessionId: _dup, ...rest } = record;
      records[id] = rest;
      changed = true;
    } else {
      seen.add(key);
    }
  }
  if (changed) {
    saveRecords(records);
  }
  // То же и для запомненных диалогов. Раньше чистили одни записи, а дубль
  // оставался здесь — и переживал перезапуск, потому что именно отсюда
  // панель берёт чат, когда свежей привязки нет.
  const claimed = new Set<string>();
  let duplicates = false;
  for (const id of Object.keys(sessions).sort()) {
    const session = sessions[id];
    const key = `${session.agentId}:${session.sessionId}`;
    if (claimed.has(key)) {
      delete sessions[id];
      duplicates = true;
    } else {
      claimed.add(key);
    }
  }
  if (duplicates) {
    saveSessions(sessions);
  }
}

export function getAgentRecord(terminalId: string): AgentRecord | null {
  return loadRecords()[terminalId] ?? null;
}

// Привязывает панели точный id сессии агента (результат работы локатора).
export function bindAgentSession(
  terminalId: string,
  sessionId: string,
  workspaceId?: string,
): boolean {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return false;
  }
  const records = loadRecords();
  const record = records[terminalId];
  if (!record) {
    return false;
  }
  if (record.sessionId === sessionId) {
    // Привязка уже есть, но папку могла не знать та версия, что её ставила.
    const sessions = loadSessions();
    const known = sessions[terminalId];
    if (workspaceId && known?.workspaceId === undefined) {
      sessions[terminalId] = { ...known, agentId: record.agentId, sessionId, workspaceId };
      saveSessions(sessions);
    }
    return true;
  }
  // Локаторы панелей бегут параллельно: пока эта панель ждала ответа, другая
  // могла занять тот же id (exclude его ещё не знал). Тогда привязку
  // отклоняем — вызывающий повторит поиск уже с обновлённым exclude.
  // Спрашиваем по обеим картам: у соседки, чей агент вышел в оболочку, id
  // остался только в запомненных диалогах, но чат всё равно её.
  if (boundAgentSessionIds(record.agentId, terminalId).includes(sessionId)) {
    return false;
  }
  records[terminalId] = { ...record, sessionId };
  saveRecords(records);
  const sessions = loadSessions();
  sessions[terminalId] = {
    agentId: record.agentId,
    sessionId,
    // Папку знает только тот, кто заводил привязку. Без неё сессия сойдёт за
    // соседскую — осторожная сторона этой развилки.
    ...(workspaceId ? { workspaceId } : {}),
  };
  saveSessions(sessions);
  return true;
}

// Сессии этого агента, уже занятые другими панелями: локатор их пропускает,
// чтобы шесть клаудов в одном проекте получили шесть разных чатов.
//
// Считаем по обеим картам. Запись живёт, только пока агент — foreground-
// процесс: вышел в оболочку — и id из неё пропал, хотя диалог остался за
// панелью и она возобновит именно его. Пока здесь смотрели в одни записи,
// такой чат становился ничьим: локатор соседа его не исключал, привязка не
// отклонялась, и две панели уходили в один разговор.
export function boundAgentSessionIds(
  agentId: string,
  exceptTerminalId: string,
): string[] {
  const ids = new Set<string>();
  for (const [terminalId, record] of Object.entries(loadRecords())) {
    if (
      terminalId !== exceptTerminalId &&
      record.agentId === agentId &&
      record.sessionId
    ) {
      ids.add(record.sessionId);
    }
  }
  for (const [terminalId, session] of Object.entries(loadSessions())) {
    if (terminalId !== exceptTerminalId && session.agentId === agentId) {
      ids.add(session.sessionId);
    }
  }
  return [...ids];
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

const LOCATE_ATTEMPT_DELAYS_MS = [1_500, 6_000, 20_000];

const pendingBindings = new Set<string>();

// Проект панели: папка нужна, чтобы повторить поиск сессии позже, когда
// пользователь наконец напишет агенту, а id рабочего пространства — чтобы
// найденный чат запомнился вместе с местом, где он живёт.
type BindingRoot = { cwd: string; workspaceId: string };

const bindingRoots = new Map<string, BindingRoot>();

async function locateOnce(
  terminalId: string,
  root: BindingRoot,
): Promise<boolean> {
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
      cwd: root.cwd,
      sinceEpochMs: Math.max(0, Math.round(record.detectedAt)),
      exclude: boundAgentSessionIds(record.agentId, terminalId),
    });
    if (found && bindAgentSession(terminalId, found, root.workspaceId)) {
      return true;
    }
  } catch {
    // Локатор — best-effort: без id останется мягкий фолбэк на --continue.
  }
  return false;
}

function startBinding(terminalId: string, root: BindingRoot): void {
  if (!isTauri || pendingBindings.has(terminalId)) {
    return;
  }
  pendingBindings.add(terminalId);
  bindingRoots.set(terminalId, root);
  let attempt = 0;
  const tryLocate = () => {
    void locateOnce(terminalId, root).then((done) => {
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

// Зовётся watcher'ом при обнаружении агента в панели.
export function scheduleAgentSessionBinding(
  terminalId: string,
  cwd: string,
  workspaceId: string,
): void {
  startBinding(terminalId, { cwd, workspaceId });
}

// Пользователь написал в панель с агентом. Файл сессии агент создаёт с первым
// сообщением, а попытки после запуска панели укладываются в полминуты: открыл
// панель, почитал код, написал через минуту — и привязки уже нет. Молча: без
// id панель после перезапуска откроет не свой диалог, а список диалогов, и
// найти в нём нужный сможет только сам пользователь.
//
// Поэтому каждый ввод — повод попробовать снова. Стоит это проверки записи: у
// привязанной панели и у панели без агента функция выходит сразу.
export function retryAgentSessionBinding(terminalId: string): void {
  if (pendingBindings.has(terminalId)) {
    return;
  }
  const record = getAgentRecord(terminalId);
  if (!record || record.sessionId) {
    return;
  }
  const root = bindingRoots.get(terminalId);
  if (root) {
    startBinding(terminalId, root);
  }
}
