// Консоль страницы плагина: что страница пишет, пока её никто не читает.
//
// Своего DevTools у агента нет, а сама система отдаёт консоль только
// инспектору. Поэтому скрипт ставится в страницу раньше её собственных и
// записывает за ней: console.*, необработанные исключения и отказы промисов,
// незагрузившиеся картинки и скрипты. Приложение забирает записанное через
// `__modelcrewConsole()` — строкой JSON.
//
// Страница чужая и может подменить что угодно, что у неё в окне. Поэтому
// нужное берём сразу, до её скриптов, а читатель нельзя ни переписать, ни
// удалить. Подменить страница может только то, что пишет сама, — а это её
// право. Ломать ей консоль запись не должна ни при каких условиях: всё, что
// здесь бросает, глотается, а исходный console зовётся всегда.
(() => {
  // Только главная страница: у рамок свои окна и своя консоль, и агенту они
  // слились бы с консолью самой страницы.
  if (window.top !== window || typeof window.__modelcrewConsole === "function") {
    return;
  }

  // Сколько хранить. Старое вытесняется новым: агенту важнее то, что страница
  // сказала только что, а счётчик выпавшего говорит, что было и раньше.
  const LIMIT = 200;
  // Одно сообщение длиннее этого — уже не сообщение, а дамп.
  const LENGTH = 2000;

  const stringify = JSON.stringify;
  const toText = String;
  const entries = [];
  let dropped = 0;

  const cut = (text) =>
    text.length > LENGTH ? text.slice(0, LENGTH - 1) + "…" : text;

  // Значение — текстом, как его показал бы инспектор, только проще.
  const describe = (value) => {
    if (typeof value === "string") {
      return value;
    }
    if (value instanceof Error) {
      const head = `${value.name}: ${value.message}`;
      const stack = typeof value.stack === "string" ? value.stack : "";
      // Стек у WebKit — одни кадры, у Chromium — со строкой ошибки впереди.
      if (value.message && stack.includes(value.message)) {
        return stack;
      }
      return stack ? `${head}\n${stack}` : head;
    }
    if (value instanceof Node) {
      return `<${value.nodeName.toLowerCase()}>`;
    }
    if (typeof value === "object" && value !== null) {
      try {
        const json = stringify(value);
        if (typeof json === "string") {
          return json;
        }
      } catch (_) {
        // Кольцевые ссылки и прочее, что в JSON не ложится, — ниже, строкой.
      }
    }
    try {
      return toText(value);
    } catch (_) {
      return Object.prototype.toString.call(value);
    }
  };

  // Подстановки console.log("%s: %o", …) — как их понимает сам браузер.
  // Без этого из каждого цветного сообщения (%c) агенту доставался бы CSS.
  const format = (args) => {
    if (typeof args[0] !== "string") {
      return args.map(describe).join(" ");
    }
    const rest = args.slice(1);
    const head = args[0].replace(/%([sdifoOc%])/g, (match, kind) => {
      if (kind === "%") {
        return "%";
      }
      if (rest.length === 0) {
        return match;
      }
      const value = rest.shift();
      switch (kind) {
        case "c":
          return "";
        case "d":
        case "i":
          return toText(parseInt(value, 10));
        case "f":
          return toText(parseFloat(value));
        default:
          return describe(value);
      }
    });
    return [head, ...rest.map(describe)].join(" ");
  };

  const keep = (level, text) => {
    try {
      entries.push({ level, text: cut(text) });
      if (entries.length > LIMIT) {
        entries.shift();
        dropped += 1;
      }
    } catch (_) {
      // Запись — не повод ломать страницу.
    }
  };

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level];
    if (typeof original !== "function") {
      continue;
    }
    console[level] = function (...args) {
      try {
        keep(level, format(args));
      } catch (_) {
        // То же: страница не должна заметить, что её слушают.
      }
      return original.apply(this, args);
    };
  }

  const assert = console.assert;
  if (typeof assert === "function") {
    console.assert = function (condition, ...args) {
      try {
        if (!condition) {
          keep("error", format(["Assertion failed:", ...args]));
        }
      } catch (_) {
        // То же.
      }
      return assert.apply(this, [condition, ...args]);
    };
  }

  // Перехват на погружении: ошибка загрузки картинки или скрипта до окна не
  // всплывает, а поймать её можно только по пути вниз.
  window.addEventListener(
    "error",
    (event) => {
      try {
        if (event instanceof ErrorEvent) {
          // У настоящей ошибки место уже в стеке. Брошенная строка или ошибка
          // чужого скрипта стека не имеют — им место дописываем сами.
          if (event.error instanceof Error) {
            keep("exception", describe(event.error));
            return;
          }
          const where = event.filename
            ? ` (${event.filename}:${event.lineno}:${event.colno})`
            : "";
          keep("exception", `${event.message}${where}`);
          return;
        }
        const target = event.target;
        if (target && target !== window && target.nodeName) {
          const url = target.currentSrc || target.src || target.href || "";
          keep("resource", `${target.nodeName.toLowerCase()} ${url}`.trim());
        }
      } catch (_) {
        // То же.
      }
    },
    true,
  );

  window.addEventListener("unhandledrejection", (event) => {
    try {
      keep("rejection", describe(event.reason));
    } catch (_) {
      // То же.
    }
  });

  Object.defineProperty(window, "__modelcrewConsole", {
    value: () => stringify({ messages: entries, dropped }),
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();
