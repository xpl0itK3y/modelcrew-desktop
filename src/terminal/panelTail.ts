// Запасной текст для подробного уведомления. Звонок BEL и тишина после
// вывода никакого сообщения не несут, поэтому берём последние осмысленные
// строки самой панели. Рамки TUI, спиннеры и прочая графика выбрасываются:
// в баннере от них толку нет, а место они занимают.

// Рамки и блоки (2500-259F), геометрия (25A0-25FF), брайль-спиннеры
// (2800-28FF) и «шевроны» приглашения вроде ❯ (276C-2771).
const DECORATION = /[─-◿⠀-⣿❬-❱]/gu;

// Короче — это остатки разметки, а не сообщение.
const MIN_LINE_CHARS = 4;
// Двух строк хватает на последнее сообщение агента; с большим бюджетом в
// баннер начинает лезть шапка рамки, которая стоит прямо над ним.
const MAX_TAIL_LINES = 2;

export function extractPanelTail(
  rows: readonly string[],
  maxLines = MAX_TAIL_LINES,
): string | null {
  const picked: string[] = [];
  for (
    let index = rows.length - 1;
    index >= 0 && picked.length < maxLines;
    index -= 1
  ) {
    const line = rows[index]
      .replace(DECORATION, " ")
      .replace(/\s+/g, " ")
      .trim();
    // Строка должна нести буквы или цифры: рамка, стрелка или полоса
    // прогресса сообщением не являются.
    if (line.length < MIN_LINE_CHARS || !/[\p{L}\p{N}]/u.test(line)) {
      continue;
    }
    picked.push(line);
  }
  return picked.length > 0 ? picked.reverse().join(" ") : null;
}
