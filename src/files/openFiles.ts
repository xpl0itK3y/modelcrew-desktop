// Какие вкладки остаются открытыми после того, как что-то удалили.
//
// Отдельно от React: правил немного, но они про границы — удалили папку,
// значит ушли и все файлы под ней, — и проверять их на списке проще, чем через
// отрисованные вкладки.

export type OpenFiles = {
  files: string[];
  /// Видимая вкладка; `null` — открытых файлов не осталось.
  active: string | null;
};

/// Путь исчез с диска: сам файл или папка целиком.
function isUnder(file: string, removed: string): boolean {
  return file === removed || file.startsWith(`${removed}/`);
}

/// Закрывает вкладки удалённого пути и всего, что лежало внутри него.
///
/// Видимую заменяет та, что встала на её место, — а если закрыли последнюю, то
/// предыдущая. Так же ведут себя вкладки везде: взгляд остаётся там же, где
/// был, и искать новое содержимое не приходится.
export function closeUnder(state: OpenFiles, removed: string): OpenFiles {
  const files = state.files.filter((file) => !isUnder(file, removed));
  if (files.length === state.files.length) {
    // Ничего не закрылось — состояние не трогаем, иначе перерисуется всё
    // впустую на каждое удаление в дереве.
    return state;
  }
  if (state.active !== null && !isUnder(state.active, removed)) {
    return { files, active: state.active };
  }
  const at = state.files.findIndex((file) => isUnder(file, removed));
  return { files, active: files[Math.min(at, files.length - 1)] ?? null };
}

/// Обычное закрытие одной вкладки.
export function closeOne(state: OpenFiles, path: string): OpenFiles {
  return closeUnder({ ...state }, path);
}

/// Путь переехал: файл переименовали или переименовали папку над ним.
///
/// Вкладка едет следом. Закрыть её было бы проще, но переименование — не
/// удаление: файл на месте, человек его только что назвал по-новому, и терять
/// его из виду за это неправильно.
export function moveUnder(
  state: OpenFiles,
  from: string,
  to: string,
): OpenFiles {
  const moved = (file: string) =>
    file === from ? to : file.startsWith(`${from}/`)
      ? `${to}${file.slice(from.length)}`
      : file;
  const files = state.files.map(moved);
  if (files.every((file, at) => file === state.files[at])) {
    return state;
  }
  return {
    files,
    active: state.active === null ? null : moved(state.active),
  };
}

/// Вкладка в полосе: открытая или закрытая, но ещё доигрывающая уход.
export type ShownTab = {
  path: string;
  closing: boolean;
};

/// Какие вкладки рисовать после того, как список открытых сменился.
///
/// Закрытая остаётся там, где стояла, пока не сожмётся: исчезни она сразу,
/// соседи справа прыгнули бы на её место за один кадр, и глаз потерял бы, что
/// именно закрылось. Вкладок стало не меньше — это открытие или
/// переименование: переименованная стоит на прежнем месте под новым именем, и
/// закрывать там нечего. Открыли снова ту, что ещё уходит, — уходящая
/// пропадает, а файл встаёт в конец, как любой открытый.
export function shownTabs(
  previous: readonly ShownTab[],
  files: readonly string[],
): ShownTab[] {
  const open = new Set(files);
  const was = previous.filter((tab) => !tab.closing);
  const closed = new Set(
    files.length < was.length
      ? was.map((tab) => tab.path).filter((path) => !open.has(path))
      : [],
  );
  const shown: ShownTab[] = [];
  // Открытые встают по порядку списка: он только дописывается в конец и
  // теряет вкладки, но не переставляет их, так что прежнее место каждой
  // открытой — её же место в новом списке.
  let next = 0;
  for (const tab of previous) {
    if (tab.closing || closed.has(tab.path)) {
      if (!open.has(tab.path)) {
        shown.push({ path: tab.path, closing: true });
      }
      continue;
    }
    if (next < files.length) {
      shown.push({ path: files[next], closing: false });
      next += 1;
    }
  }
  for (; next < files.length; next += 1) {
    shown.push({ path: files[next], closing: false });
  }
  return shown;
}
