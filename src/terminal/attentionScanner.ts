// Разбор потока PTY: точные уведомления агента (OSC 9 / 99 / 777) и звонок
// BEL. Чистый разбор байтов — ни звука, ни баннеров, ни настроек: что делать с
// найденным, решают alertPolicy и alertDelivery.

type AttentionScanMode = 0 | 1 | 2 | 3;

type KittyNotificationDraft = {
  title: string;
  body: string;
  types: string[];
};

// OSC может быть разорван на произвольной границе PTY-чанка. Храним только
// небольшой ограниченный payload и незавершённые части chunked OSC 99.
export type AttentionScanState = {
  mode: AttentionScanMode;
  osc: string;
  oscOverflow: boolean;
  kitty: Record<string, KittyNotificationDraft>;
  // PTY отдаёт сырые байты. Декодируем поток в UTF-8 до разбора, иначе текст
  // уведомления собирается по байту на символ и кириллица превращается в
  // «Ð°Ð½Ð°Ð»Ð¾Ð³». Декодер потоковый: многобайтовый символ переживает
  // границу чанка. Поле необязательное и создаётся лениво — состояние живёт
  // в панели дольше самого модуля (hot reload в dev), и обращение к
  // несуществующему декодеру глушило бы такой панели все сигналы разом.
  decoder?: TextDecoder;
};

export type TerminalAttentionNotification = {
  // "hook" — событие пришло от самого агента через его хук, а не из вывода.
  protocol: "osc9" | "osc99" | "osc777" | "hook";
  title: string;
  body: string;
  types: string[];
};

const MAX_OSC_CHARS = 16_384;
const MAX_KITTY_DRAFTS = 8;

export function createAttentionScanState(): AttentionScanState {
  return {
    mode: 0,
    osc: "",
    oscOverflow: false,
    kitty: {},
    decoder: new TextDecoder(),
  };
}

// Управляющие символы из текста агента: в баннере уровня ОС им не место.
export function cleanNotificationText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
}

function decodeBase64Utf8(value: string): string {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function parseOsc99(
  payload: string,
  state: AttentionScanState,
): TerminalAttentionNotification | null {
  const metadataEnd = payload.indexOf(";", 3);
  if (metadataEnd < 0) {
    return null;
  }
  const metadata = payload.slice(3, metadataEnd);
  const rawPayload = payload.slice(metadataEnd + 1);
  const fields = metadata.split(":").map((field) => {
    const separator = field.indexOf("=");
    return separator < 0
      ? ([field, ""] as const)
      : ([field.slice(0, separator), field.slice(separator + 1)] as const);
  });
  const valueOf = (key: string) =>
    fields.find(([fieldKey]) => fieldKey === key)?.[1];
  const encoded = valueOf("e") === "1";
  const part = valueOf("p") ?? "title";
  if (part !== "title" && part !== "body") {
    return null;
  }

  const id = valueOf("i") || "__anonymous";
  const existing = state.kitty[id] ?? { title: "", body: "", types: [] };
  const decodedPayload = cleanNotificationText(
    encoded ? decodeBase64Utf8(rawPayload) : rawPayload,
  );
  existing[part] = (existing[part] + decodedPayload).slice(0, MAX_OSC_CHARS);
  for (const [, rawType] of fields.filter(([key]) => key === "t")) {
    const decodedType = cleanNotificationText(decodeBase64Utf8(rawType));
    if (
      decodedType &&
      existing.types.length < MAX_KITTY_DRAFTS &&
      !existing.types.includes(decodedType)
    ) {
      existing.types.push(decodedType);
    }
  }
  state.kitty[id] = existing;

  const ids = Object.keys(state.kitty);
  if (ids.length > MAX_KITTY_DRAFTS) {
    delete state.kitty[ids[0]];
  }
  if (valueOf("d") === "0") {
    return null;
  }
  delete state.kitty[id];
  if (!existing.title && !existing.body) {
    return null;
  }
  return {
    protocol: "osc99",
    title: existing.title,
    body: existing.body,
    types: existing.types,
  };
}

function parseTerminalNotification(
  payload: string,
  state: AttentionScanState,
): TerminalAttentionNotification | null {
  if (payload.startsWith("9;") && !payload.startsWith("9;4;")) {
    const title = cleanNotificationText(payload.slice(2));
    return title ? { protocol: "osc9", title, body: "", types: [] } : null;
  }
  if (payload.startsWith("777;notify;")) {
    const parts = payload.slice("777;notify;".length).split(";");
    const title = cleanNotificationText(parts.shift() ?? "");
    const body = cleanNotificationText(parts.join(";"));
    return title || body
      ? { protocol: "osc777", title, body, types: [] }
      : null;
  }
  if (payload.startsWith("99;")) {
    return parseOsc99(payload, state);
  }
  return null;
}

function finishOsc(
  state: AttentionScanState,
): TerminalAttentionNotification | null {
  const notification = state.oscOverflow
    ? null
    : parseTerminalNotification(state.osc, state);
  state.mode = 0;
  state.osc = "";
  state.oscOverflow = false;
  return notification;
}

export function scanTerminalAttention(
  data: string | ArrayBuffer,
  state: AttentionScanState,
): {
  bells: number;
  notifications: TerminalAttentionNotification[];
  state: AttentionScanState;
} {
  const text =
    typeof data === "string"
      ? data
      : (state.decoder ??= new TextDecoder()).decode(new Uint8Array(data), {
          stream: true,
        });
  let bells = 0;
  const notifications: TerminalAttentionNotification[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    switch (state.mode) {
      case 0:
        if (code === 0x1b) {
          state.mode = 1;
        } else if (code === 0x07) {
          bells += 1;
        }
        break;
      case 1:
        if (code === 0x5d /* ] */) {
          state.mode = 2;
          state.osc = "";
          state.oscOverflow = false;
        } else {
          state.mode = 0;
        }
        break;
      case 2:
        if (code === 0x07) {
          const notification = finishOsc(state);
          if (notification) {
            notifications.push(notification);
          }
        } else if (code === 0x1b) {
          state.mode = 3;
        } else if (!state.oscOverflow) {
          if (state.osc.length < MAX_OSC_CHARS) {
            state.osc += String.fromCharCode(code);
          } else {
            state.oscOverflow = true;
            state.osc = "";
          }
        }
        break;
      case 3:
        if (code === 0x5c /* \\ */) {
          const notification = finishOsc(state);
          if (notification) {
            notifications.push(notification);
          }
        } else if (code === 0x5d /* ] */) {
          // Начался следующий OSC — предыдущий оборван, его текст уже не
          // склеить с новым.
          state.mode = 2;
          state.osc = "";
          state.oscOverflow = false;
        } else {
          // ESC начал другую последовательность (обычно CSI): OSC оборван.
          // Оставаться внутри него нельзя — тогда сканер съест следующий BEL
          // как терминатор, и звонок агента потеряется.
          state.mode = 0;
          state.osc = "";
          state.oscOverflow = false;
        }
        break;
    }
  }
  return { bells, notifications, state };
}
