// Запасной текст для подробного уведомления: агент прислал только звонок или
// просто замолчал, а показать в баннере что-то надо. Берём с экрана панели
// последнюю законченную фразу, отбрасывая обвязку TUI — рамки, спиннеры,
// строку ввода и статусную строку.

// Рамки и блоки (2500-259F), геометрия (25A0-25FF), брайль-спиннеры
// (2800-28FF) и «шевроны» вроде ❯ (276C-2771).
const DECORATION = /[─-◿⠀-⣿❬-❱]/gu;

// Рамка и отступ слева: снимаются до проверки на приглашение, иначе
// «│ › текст» не опознать как ввод.
const LEADING_CHROME = /^[\s─-◿]+/u;

// Строка ввода: подсказка композера и то, что печатал пользователь. Это не
// сообщение агента, даже когда выглядит как обычный текст.
const PROMPT = /^[›‹❯❮>$%#]/u;

// Законченная фраза, а не статусная строка вида «gpt · high · 92% left».
const SENTENCE_END = /[.!?:…»)]$/u;

const MIN_LINE_CHARS = 4;
const MIN_SENTENCE_CHARS = 24;
// Дальше вглубь экрана не заходим: там уже прошлые реплики.
const MAX_CANDIDATES = 6;
// Столько текста всё равно влезает в баннер — дальше собирать абзац незачем.
const MAX_TAIL_CHARS = 200;

export type PanelRow = {
  text: string;
  // Строка — продолжение предыдущей: терминал перенёс её по ширине окна.
  wrapped: boolean;
};

// Склеивает перенесённые по ширине строки обратно в логические. Без этого в
// баннер попадает обрывок фразы с середины слова.
export function joinWrappedRows(rows: readonly PanelRow[]): string[] {
  const joined: string[] = [];
  for (const row of rows) {
    if (row.wrapped && joined.length > 0) {
      joined[joined.length - 1] += row.text;
    } else {
      joined.push(row.text);
    }
  }
  return joined;
}

// Строка без обвязки: рамка и приглашение уже сняты, пробелы схлопнуты.
// null — в строке не осталось ничего, кроме графики.
function meaningfulLine(row: string): string | null {
  const withoutChrome = row.replace(LEADING_CHROME, "");
  if (PROMPT.test(withoutChrome)) {
    return null;
  }
  const line = withoutChrome
    .replace(DECORATION, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Строка должна нести буквы или цифры: рамка, стрелка или полоса
  // прогресса сообщением не являются.
  return line.length >= MIN_LINE_CHARS && /[\p{L}\p{N}]/u.test(line)
    ? line
    : null;
}

// Абзац целиком: агент переносит текст сам, обычными переводами строк, так
// что последняя строка — это хвост фразы. Поднимаемся вверх до пустой строки,
// приглашения или конца бюджета.
function collectParagraph(rows: readonly string[], last: number): string {
  const block = [meaningfulLine(rows[last]) as string];
  let total = block[0].length;
  for (let index = last - 1; index >= 0; index -= 1) {
    const line = meaningfulLine(rows[index]);
    if (!line || total + line.length + 1 > MAX_TAIL_CHARS) {
      break;
    }
    block.unshift(line);
    total += line.length + 1;
  }
  return block.join(" ");
}

export function extractPanelTail(rows: readonly string[]): string | null {
  const candidates: string[] = [];
  for (
    let index = rows.length - 1;
    index >= 0 && candidates.length < MAX_CANDIDATES;
    index -= 1
  ) {
    const line = meaningfulLine(rows[index]);
    if (!line) {
      continue;
    }
    if (line.length >= MIN_SENTENCE_CHARS && SENTENCE_END.test(line)) {
      return collectParagraph(rows, index);
    }
    candidates.push(line);
  }
  // Ничего похожего на фразу — отдаём последнюю осмысленную строку.
  return candidates[0] ?? null;
}
