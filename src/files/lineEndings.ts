// Переводы строк открытого файла.
//
// Текстовое поле браузера знает только LF: CRLF в своём значении оно молча
// превращает в LF, одиночный CR — тоже. Буфер, в котором остался CRLF,
// расходился с полем на знак на каждой строке выше курсора: Tab, ⌘/ и перенос
// строки, посчитанные по буферу, попадали в поле не туда, а первая же правка
// сохраняла весь файл в LF, и git видел изменённой каждую строку.
//
// Поэтому редактор держит текст в LF, а как переводы строк записаны у самого
// файла, помнит отдельно — и тем же видом пишет их обратно.

export type LineEnding = "\n" | "\r\n";

/// Каким переводом строки набран файл. Смешанный пишется тем, которого в нём
/// больше: обоими разом его не сохранить.
export function lineEndingOf(text: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
    if (at > 0 && text[at - 1] === "\r") {
      crlf += 1;
    } else {
      lf += 1;
    }
  }
  return crlf > lf ? "\r\n" : "\n";
}

/// Текст с переводами строк так, как их держит поле ввода.
export function toLf(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/// Текст из поля с переводами строк самого файла — то, что пишется на диск.
export function withEnding(text: string, ending: LineEnding): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}
