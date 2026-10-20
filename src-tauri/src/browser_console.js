// Консоль страницы плагина: что страница пишет, пока её никто не читает.
//
// Своего DevTools у агента нет, а сама система отдаёт консоль только
// инспектору. Поэтому скрипт ставится в страницу раньше её собственных и
// записывает за ней: console.*, необработанные исключения и отказы промисов,
// незагрузившиеся картинки и скрипты, ошибки фоновых потоков (Worker).
// Приложение забирает записанное через `__modelcrewConsole()` — строкой JSON.
//
// Скрипт ставится и во все рамки страницы — и в свои, и в рамки с других
// доменов. Своей записи рамка не держит: каждое сообщение она отправляет
// главной странице, а та кладёт его в общую запись с адресом рамки. Так
// ошибку встроенного виджета или оплаты видно там же, где ошибки самой
// страницы, и видно, чья она.
//
// Что поток пишет в console, отсюда не достать: у потока своя консоль, и
// поставить в него скрипт система не даёт. Видно, что поток упал или не
// загрузился.
//
// Страница чужая и может подменить что угодно, что у неё в окне. Поэтому
// нужное берём сразу, до её скриптов, а читатель нельзя ни переписать, ни
// удалить. Подменить страница может только то, что пишет сама, — а это её
// право. Ломать ей консоль запись не должна ни при каких условиях: всё, что
// здесь бросает, глотается, а исходный console зовётся всегда.
(() => {
  if (typeof window.__modelcrewConsole === "function") {
    return;
  }

  // Сколько хранить. Старое вытесняется новым: агенту важнее то, что страница
  // сказала только что, а счётчик выпавшего говорит, что было и раньше.
  const LIMIT = 200;
  // Одно сообщение длиннее этого — уже не сообщение, а дамп.
  const LENGTH = 2000;
  // Адрес рамки или потока — подпись, а не сообщение.
  const LABEL = 300;
  // Метка сообщений рамки. Без неё главная страница не отличила бы их от
  // своих postMessage, а со своими их перепутала бы сама страница.
  const MARK = "__modelcrewConsoleFrame";
  const LEVELS = [
    "log",
    "info",
    "warn",
    "error",
    "debug",
    "exception",
    "rejection",
    "resource",
  ];

  const stringify = JSON.stringify;
  const toText = String;
  const construct = Reflect.construct;
  const apply = Reflect.apply;
  const listen = EventTarget.prototype.addEventListener;
  const Wrapper = Proxy;
  const Address = URL;
  const Failure = ErrorEvent;
  const main = window.top;
  const framed = main !== window;
  const entries = [];
  let dropped = 0;
  // Когда началась запись. После перезагрузки счёт сообщений идёт заново, и
  // по этой метке панель отличает новую страницу от старой.
  const started = Date.now();

  const shorten = (text, most) =>
    text.length > most ? text.slice(0, most - 1) + "…" : text;
  const cut = (text) => shorten(text, LENGTH);

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

  // Где рамка сейчас: адрес без запроса и якоря — в них бывают ключи, а
  // подписи они ничего не дают.
  const here = () => {
    try {
      return shorten(location.href.split(/[?#]/)[0], LABEL);
    } catch (_) {
      return "";
    }
  };

  // Сообщение — в запись. В рамке — главной странице: запись одна на всех.
  // `from` — чьё оно, если не самой страницы: рамка (frame), поток (worker).
  const keep = (level, text, from) => {
    try {
      const entry = { level, text: cut(text) };
      if (from && from.frame) {
        entry.frame = from.frame;
      }
      if (from && from.worker) {
        entry.worker = from.worker;
      }
      if (framed) {
        // Рамка в рамке тоже шлёт прямо наверх: подписью будет её адрес.
        if (!entry.frame) {
          entry.frame = here();
        }
        main.postMessage({ [MARK]: entry }, "*");
        return;
      }
      entries.push(entry);
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

  // Ошибка без стека — с местом, где её бросили, если оно известно.
  const placed = (event) => {
    const where = event.filename
      ? ` (${event.filename}:${event.lineno}:${event.colno})`
      : "";
    return `${event.message}${where}`;
  };

  // Ошибку потока, которую страница не отменила, WebKit отдаёт следом и
  // окну — тем же текстом, но уже без адреса потока. Записанное от потока
  // помним, чтобы это эхо не легло в запись второй раз.
  const echoes = [];

  // Перехват на погружении: ошибка загрузки картинки или скрипта до окна не
  // всплывает, а поймать её можно только по пути вниз.
  window.addEventListener(
    "error",
    (event) => {
      try {
        if (event instanceof Failure) {
          const echo = echoes.indexOf(placed(event));
          if (echo !== -1) {
            echoes.splice(echo, 1);
            return;
          }
          // У настоящей ошибки место уже в стеке. Брошенная строка или ошибка
          // чужого скрипта стека не имеют — им место дописываем сами.
          if (event.error instanceof Error) {
            keep("exception", describe(event.error));
            return;
          }
          keep("exception", placed(event));
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

  // Фоновые потоки. Их console отсюда не видна, но то, что поток упал или
  // не загрузился, приходит событием error на сам Worker — его и слушаем.
  // Конструктор подменён прозрачно: прототип, имя, instanceof и наследование
  // остаются как были, а бросает он ровно то же, что исходный.
  const scriptOf = (url) => {
    try {
      return shorten(new Address(toText(url), document.baseURI).href, LABEL);
    } catch (_) {
      try {
        return shorten(toText(url), LABEL);
      } catch (_) {
        return "";
      }
    }
  };
  for (const name of ["Worker", "SharedWorker"]) {
    const Original = window[name];
    if (typeof Original !== "function") {
      continue;
    }
    const kind = name.toLowerCase();
    try {
      window[name] = new Wrapper(Original, {
        construct(target, args, newTarget) {
          const worker = construct(target, args, newTarget);
          try {
            const script = scriptOf(args[0]);
            apply(listen, worker, [
              "error",
              (event) => {
                try {
                  if (event instanceof Failure) {
                    const text = placed(event);
                    keep("exception", text, { worker: script });
                    echoes.push(text);
                    if (echoes.length > 20) {
                      echoes.shift();
                    }
                  } else {
                    keep("resource", `${kind} ${script}`.trim());
                  }
                } catch (_) {
                  // То же.
                }
              },
            ]);
          } catch (_) {
            // Поток создан — без записи о нём страница проживёт.
          }
          return worker;
        },
      });
    } catch (_) {
      // Не вышло подменить — потоки останутся как есть.
    }
  }

  // Главная страница принимает сообщения своих рамок. Слушатель ставится
  // раньше всех страничных и на погружении, поэтому сообщение с меткой
  // дальше не идёт: страница своих postMessage с ним не увидит.
  if (!framed) {
    window.addEventListener(
      "message",
      (event) => {
        try {
          const data = event.data;
          if (
            data === null ||
            typeof data !== "object" ||
            !(MARK in data) ||
            event.source === window
          ) {
            return;
          }
          event.stopImmediatePropagation();
          const entry = data[MARK];
          if (
            entry === null ||
            typeof entry !== "object" ||
            typeof entry.text !== "string"
          ) {
            return;
          }
          const level = LEVELS.includes(entry.level) ? entry.level : "log";
          // Адрес рамка называет сама, а соврать может. Отправителя же
          // называет браузер: подпись верим, только если она с его адреса.
          const origin = event.origin;
          const claimed =
            typeof entry.frame === "string" ? shorten(entry.frame, LABEL) : "";
          const frame =
            claimed &&
            (origin === "null" ||
              claimed === origin ||
              claimed.startsWith(`${origin}/`))
              ? claimed
              : origin;
          const worker =
            typeof entry.worker === "string"
              ? shorten(entry.worker, LABEL)
              : "";
          keep(level, entry.text, { frame, worker });
        } catch (_) {
          // То же.
        }
      },
      true,
    );
  }

  Object.defineProperty(window, "__modelcrewConsole", {
    value: () => stringify({ messages: entries, dropped, started }),
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();
