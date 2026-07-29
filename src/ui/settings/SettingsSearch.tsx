import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";

export type SettingsSectionId =
  | "appearance"
  | "terminal"
  | "agents"
  | "mcp"
  | "plugins"
  | "hotkeys"
  | "notifications"
  | "account";

type Entry = { section: SettingsSectionId; text: string };

type SettingsSearchApi = {
  register: (id: string, section: SettingsSectionId, text: string) => void;
  unregister: (id: string) => void;
  matches: (text: string) => boolean;
  // Разделы, где нашлась хотя бы одна настройка: по ним фильтруется навигация.
  matchedSections: ReadonlySet<SettingsSectionId>;
};

// Раздел, внутри которого рендерятся строки, и попал ли он в поиск целиком:
// когда запрос совпал с названием раздела, показывать надо все его строки, а не
// пустую страницу с одним заголовком.
type SectionState = { id: SettingsSectionId; matched: boolean };

const SearchContext = createContext<SettingsSearchApi | null>(null);
const SectionContext = createContext<SectionState | null>(null);

// Ищем без регистра и без разницы между «ё» и «е»: пользователь набирает
// «уведомления», а в каталоге может стоять «ещё» — совпадение должно случиться.
function normalize(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е");
}

function splitQuery(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean);
}

type ProviderProps = {
  query: string;
  children: ReactNode;
};

/**
 * Строки настроек сами сообщают о себе провайдеру: он держит их тексты и знает,
 * в каких разделах есть совпадения. Единственный источник правды — сама строка,
 * поэтому отдельный список ключей для поиска не разъедется с интерфейсом.
 */
export function SettingsSearchProvider(props: ProviderProps) {
  const entries = useRef(new Map<string, Entry>());
  // Тексты живут в ref, а перерасчёт совпадений нужно запускать вручную:
  // счётчик — тот самый сигнал «список изменился».
  const [revision, bumpRevision] = useReducer((value: number) => value + 1, 0);

  const register = useCallback(
    (id: string, section: SettingsSectionId, text: string) => {
      entries.current.set(id, { section, text });
      bumpRevision();
    },
    [],
  );

  const unregister = useCallback((id: string) => {
    entries.current.delete(id);
    bumpRevision();
  }, []);

  const terms = useMemo(() => splitQuery(props.query), [props.query]);

  const matches = useCallback(
    (text: string) => {
      if (terms.length === 0) {
        return true;
      }
      const haystack = normalize(text);
      return terms.every((term) => haystack.includes(term));
    },
    [terms],
  );

  const matchedSections = useMemo(() => {
    void revision;
    const found = new Set<SettingsSectionId>();
    for (const entry of entries.current.values()) {
      if (matches(entry.text)) {
        found.add(entry.section);
      }
    }
    return found;
  }, [matches, revision]);

  const api = useMemo(
    () => ({ register, unregister, matches, matchedSections }),
    [register, unregister, matches, matchedSections],
  );

  return (
    <SearchContext.Provider value={api}>{props.children}</SearchContext.Provider>
  );
}

export function useSettingsSearch(): SettingsSearchApi | null {
  return useContext(SearchContext);
}

export function SettingsSectionProvider(props: {
  section: SettingsSectionId;
  matched: boolean;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ id: props.section, matched: props.matched }),
    [props.section, props.matched],
  );
  return (
    <SectionContext.Provider value={value}>
      {props.children}
    </SectionContext.Provider>
  );
}

function useRegistration(
  section: SettingsSectionId | null,
  text: string,
): SettingsSearchApi | null {
  const search = useContext(SearchContext);
  const id = useId();
  const register = search?.register;
  const unregister = search?.unregister;

  useEffect(() => {
    if (!register || !unregister || !section) {
      return;
    }
    register(id, section, text);
    return () => unregister(id);
  }, [id, section, text, register, unregister]);

  return search;
}

/**
 * Регистрирует название и описание раздела и отвечает, совпал ли раздел целиком.
 * Без этого набранное в поиске название раздела — то самое, что напечатано
 * слева в навигации, — не находило бы ничего.
 */
export function useSettingsPageEntry(
  section: SettingsSectionId,
  text: string,
): boolean {
  const search = useRegistration(section, text);
  return search ? search.matches(text) : true;
}

/**
 * Регистрирует текст строки в поиске и отвечает, показывать ли её сейчас.
 * Вызывается до любых ранних возвратов: скрытая строка обязана остаться в
 * индексе, иначе поиск перестанет её находить.
 */
export function useSettingsSearchEntry(text: string): boolean {
  const section = useContext(SectionContext);
  const search = useRegistration(section?.id ?? null, text);

  if (!search) {
    return true;
  }
  return section?.matched === true || search.matches(text);
}
