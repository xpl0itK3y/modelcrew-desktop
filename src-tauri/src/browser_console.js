// Консоль страницы плагина: что страница пишет, пока её никто не читает.
//
// Своего DevTools у агента нет, а сама система отдаёт консоль только
// инспектору. Поэтому скрипт ставится в страницу раньше её собственных и
// записывает за ней то же, что показал бы инспектор: console.* — все методы,
// от log до table и time, — необработанные исключения и отказы промисов,
// всё, что не загрузилось: картинки и скрипты, запросы fetch и XHR с ошибкой
// или без ответа, WebSocket, — нарушения политики безопасности (CSP),
// предупреждения браузера об устаревшем, ошибки фоновых потоков (Worker).
// У каждого сообщения — место в коде, откуда оно, а повтор подряд, как и в
// инспекторе, — одна запись со счётчиком. Приложение забирает записанное
// через `__modelcrewConsole()` — строкой JSON.
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
  // Адрес рамки, потока или места в коде — подпись, а не сообщение.
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
    "trace",
    "exception",
    "rejection",
    "resource",
    "csp",
  ];

  const stringify = JSON.stringify;
  const toText = String;
  const construct = Reflect.construct;
  const apply = Reflect.apply;
  const listen = EventTarget.prototype.addEventListener;
  const then = Promise.prototype.then;
  const Wrapper = Proxy;
  const Address = URL;
  const Failure = ErrorEvent;
  const Mistake = Error;
  const Asked = typeof Request === "function" ? Request : null;
  const remember = WeakMap.prototype.set;
  const recall = WeakMap.prototype.get;
  const knows = WeakMap.prototype.has;
  const clock = performance;
  const now = clock.now;
  const main = window.top;
  const framed = main !== window;
  const entries = [];
  let dropped = 0;
  // Когда началась запись. После перезагрузки счёт сообщений идёт заново, и
  // по этой метке панель отличает новую страницу от старой.
  const started = Date.now();
  // Запись уже идёт. Страница может писать в console изнутри того, что
  // запись у неё зовёт, — toString, toJSON, Error.prepareStackTrace, — и без
  // этой отметки запись звала бы себя без конца.
  let busy = false;

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

  // Место в коде из строки стека: «at f (адрес:1:2)» у Chromium, «f@адрес:1:2»
  // у WebKit. Адрес — со схемой: «<anonymous>:1:2» местом не считается.
  const PLACE = /([a-z][\w+.-]*:[^\s()@]*?):(\d+):(\d+)\)?\s*$/i;
  const placeOf = (line) => {
    const match = PLACE.exec(line);
    return match ? { url: match[1], line: match[2], column: match[3] } : null;
  };
  const stackOf = (error) => {
    try {
      return toText(error.stack || "").split("\n");
    } catch (_) {
      return [];
    }
  };
  // Длинный адрес режется сам, а строка и столбец остаются: без них место —
  // не место.
  const spot = (place) =>
    `${shorten(toText(place.url), LABEL - 24)}:${place.line}:${place.column}`;
  // Свои кадры стека — из этого скрипта. Адреса у них может не быть вовсе,
  // а может быть свой, — его узнаём сразу, пока стек ещё только наш.
  const own = (() => {
    for (const line of stackOf(new Mistake())) {
      const place = placeOf(line);
      if (place) {
        return place.url;
      }
    }
    return null;
  })();
  // Кадры стека, что не из этого скрипта: кто позвал console или fetch.
  const theirs = () => {
    const lines = [];
    for (const line of stackOf(new Mistake())) {
      const place = placeOf(line);
      if (place && place.url !== own) {
        lines.push(line.trim());
      }
    }
    return lines;
  };
  // Откуда позвали — как место справа у сообщения в инспекторе.
  const caller = () => {
    for (const line of stackOf(new Mistake())) {
      const place = placeOf(line);
      if (place && place.url !== own) {
        return spot(place);
      }
    }
    return "";
  };
  // Где брошена ошибка: первый кадр её стека.
  const thrownAt = (error) => {
    if (!(error instanceof Error)) {
      return "";
    }
    for (const line of stackOf(error)) {
      const place = placeOf(line);
      if (place) {
        return spot(place);
      }
    }
    return "";
  };
  // Место из события: файл, строка и столбец — как их назвал браузер.
  const placed = (event) =>
    event.filename
      ? spot({ url: event.filename, line: event.lineno, column: event.colno })
      : "";

  // Где рамка сейчас: адрес без запроса и якоря — в них бывают ключи, а
  // подписи они ничего не дают.
  const frameAddress = () => {
    try {
      return shorten(location.href.split(/[?#]/)[0], LABEL);
    } catch (_) {
      return "";
    }
  };

  // Сообщение — в запись. В рамке — главной странице: запись одна на всех.
  // `extra` — чьё оно, если не самой страницы (frame — рамка, worker —
  // поток), и откуда в коде (at).
  const keep = (level, text, extra) => {
    try {
      const entry = { level, text: cut(text) };
      if (extra) {
        for (const key of ["frame", "worker", "at"]) {
          if (extra[key]) {
            entry[key] = extra[key];
          }
        }
      }
      if (framed) {
        // Рамка в рамке тоже шлёт прямо наверх: подписью будет её адрес.
        if (!entry.frame) {
          entry.frame = frameAddress();
        }
        main.postMessage({ [MARK]: entry }, "*");
        return;
      }
      // Повтор подряд — как в инспекторе: одна запись со счётчиком. Иначе
      // ошибка в цикле вытеснила бы всё, что было до неё.
      const last = entries[entries.length - 1];
      if (
        last &&
        last.level === entry.level &&
        last.text === entry.text &&
        last.frame === entry.frame &&
        last.worker === entry.worker &&
        last.at === entry.at
      ) {
        last.count = (last.count || 1) + 1;
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

  // Метод console: страница зовёт исходный, а запись — следом за ним.
  const wrap = (name, record) => {
    const original = console[name];
    if (typeof original !== "function") {
      return;
    }
    console[name] = function (...args) {
      if (!busy) {
        busy = true;
        try {
          record(args);
        } catch (_) {
          // То же: страница не должна заметить, что её слушают.
        } finally {
          busy = false;
        }
      }
      return apply(original, this, args);
    };
  };

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    wrap(level, (args) => keep(level, format(args), { at: caller() }));
  }
  wrap("assert", ([condition, ...args]) => {
    if (!condition) {
      const said = args.length > 0 ? format(args) : "console.assert";
      keep("error", `Assertion failed: ${said}`, { at: caller() });
    }
  });
  for (const name of ["dir", "dirxml", "table"]) {
    wrap(name, (args) =>
      keep("log", args.map(describe).join(" "), { at: caller() }),
    );
  }
  for (const name of ["group", "groupCollapsed"]) {
    wrap(name, (args) =>
      keep("log", args.length > 0 ? format(args) : `console.${name}`, {
        at: caller(),
      }),
    );
  }
  wrap("trace", (args) => {
    const head = args.length > 0 ? format(args) : "console.trace";
    keep("trace", [head, ...theirs()].join("\n    "), { at: caller() });
  });

  // Счётчики и таймеры у каждого окна свои — как у самого console.
  const labelOf = (label) => (label === undefined ? "default" : toText(label));
  const counts = Object.create(null);
  const timers = Object.create(null);
  wrap("count", ([label]) => {
    const name = labelOf(label);
    counts[name] = (counts[name] || 0) + 1;
    keep("log", `${name}: ${counts[name]}`, { at: caller() });
  });
  wrap("countReset", ([label]) => {
    counts[labelOf(label)] = 0;
  });
  wrap("time", ([label]) => {
    timers[labelOf(label)] = apply(now, clock, []);
  });
  const lap = (label, rest, end) => {
    const name = labelOf(label);
    const since = timers[name];
    if (since === undefined) {
      keep("warn", `Timer '${name}' does not exist`, { at: caller() });
      return;
    }
    const spent = (apply(now, clock, []) - since).toFixed(3);
    const more = rest.length > 0 ? ` ${format(rest)}` : "";
    keep("log", `${name}: ${spent} ms${more}`, { at: caller() });
    if (end) {
      delete timers[name];
    }
  };
  wrap("timeLog", ([label, ...rest]) => lap(label, rest, false));
  wrap("timeEnd", ([label]) => lap(label, [], true));

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
          const echo = echoes.indexOf(`${event.message} ${placed(event)}`);
          if (echo !== -1) {
            echoes.splice(echo, 1);
            return;
          }
          // У настоящей ошибки и место, и стек свои. Брошенная строка или
          // ошибка чужого скрипта их не имеют — место назовёт событие.
          const at = placed(event) || thrownAt(event.error);
          if (event.error instanceof Error) {
            keep("exception", describe(event.error), { at });
            return;
          }
          keep("exception", event.message, { at });
          return;
        }
        const target = event.target;
        if (target && target !== window && target.nodeName) {
          const url = target.currentSrc || target.src || target.href || "";
          keep("resource", `${target.nodeName.toLowerCase()} ${url}`.trim(), {
            at: shorten(url, LABEL),
          });
        }
      } catch (_) {
        // То же.
      }
    },
    true,
  );

  window.addEventListener("unhandledrejection", (event) => {
    try {
      keep("rejection", describe(event.reason), {
        at: thrownAt(event.reason),
      });
    } catch (_) {
      // То же.
    }
  });

  // Политика безопасности страницы (CSP) что-то не пустила. Инспектор пишет
  // это ошибкой, а политика «только сообщать» — предупреждением.
  window.addEventListener(
    "securitypolicyviolation",
    (event) => {
      try {
        const directive = event.effectiveDirective || event.violatedDirective;
        const blocked = event.blockedURI || "inline";
        const level = event.disposition === "report" ? "warn" : "csp";
        const at = event.sourceFile
          ? spot({
              url: event.sourceFile,
              line: event.lineNumber,
              column: event.columnNumber,
            })
          : "";
        keep(level, `Content Security Policy (${directive}): ${blocked}`, {
          at,
        });
      } catch (_) {
        // То же.
      }
    },
    true,
  );

  // Предупреждения самого браузера: устаревшее и то, во что он вмешался.
  if (typeof ReportingObserver === "function") {
    try {
      new ReportingObserver(
        (reports) => {
          for (let index = 0; index < reports.length; index += 1) {
            try {
              const report = reports[index];
              const body = report.body || {};
              const at = body.sourceFile
                ? spot({
                    url: body.sourceFile,
                    line: body.lineNumber,
                    column: body.columnNumber,
                  })
                : "";
              const kind =
                report.type === "intervention" ? "Intervention" : "Deprecation";
              keep("warn", `${kind}: ${body.message || body.id || ""}`, { at });
            } catch (_) {
              // То же.
            }
          }
        },
        { types: ["deprecation", "intervention"], buffered: true },
      ).observe();
    } catch (_) {
      // Нет так нет: остальная запись от этого не зависит.
    }
  }

  // Полный адрес запроса: относительный — от адреса страницы.
  const resolve = (url) => {
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
  // Почему запрос не удался: имя и текст ошибки. Стек тут ничего не скажет —
  // он про сам запрос, а не про то, кто его сделал.
  const brief = (error) =>
    error instanceof Error ? `${error.name}: ${error.message}` : describe(error);
  // Запрос, который не удался, — как «Failed to load resource» в инспекторе.
  const failed = (kind, method, url, what, at) => {
    const verb = method && method !== "GET" ? ` ${method}` : "";
    keep("resource", `${kind}${verb} ${url} — ${what}`, { at });
  };

  // fetch: ответ с ошибкой (4xx, 5xx) или никакого — сеть, CORS. Странице
  // уходит тот же ответ и та же ошибка; отменённый запрос — не ошибка.
  if (typeof window.fetch === "function") {
    try {
      window.fetch = new Wrapper(window.fetch, {
        apply(target, self, args) {
          let asked = null;
          try {
            const [input, init] = args;
            const request = Asked && input instanceof Asked ? input : null;
            let method = request ? request.method : "GET";
            if (init && typeof init.method === "string") {
              method = init.method;
            }
            asked = {
              method: toText(method).toUpperCase(),
              url: request ? shorten(request.url, LABEL) : resolve(input),
              at: caller(),
            };
          } catch (_) {
            // Не разобрали запрос — уйдёт без записи.
          }
          const answer = apply(target, self, args);
          if (!asked) {
            return answer;
          }
          return apply(then, answer, [
            (response) => {
              try {
                if (response.status >= 400) {
                  const status = `${response.status} ${response.statusText}`;
                  failed("fetch", asked.method, asked.url, status.trim(), asked.at);
                }
              } catch (_) {
                // То же.
              }
              return response;
            },
            (error) => {
              try {
                if (!(error && error.name === "AbortError")) {
                  failed("fetch", asked.method, asked.url, brief(error), asked.at);
                }
              } catch (_) {
                // То же.
              }
              throw error;
            },
          ]);
        },
      });
    } catch (_) {
      // Не вышло подменить — запросы останутся как есть.
    }
  }

  // XMLHttpRequest: то же, но ответ узнаём по loadend. Слушатели ставим один
  // раз на запрос, а что спрашивали — помним с последнего open.
  const Xhr = window.XMLHttpRequest;
  if (typeof Xhr === "function") {
    try {
      const asked = new WeakMap();
      const open = Xhr.prototype.open;
      const send = Xhr.prototype.send;
      Xhr.prototype.open = new Wrapper(open, {
        apply(target, request, args) {
          try {
            const fresh = !apply(knows, asked, [request]);
            apply(remember, asked, [
              request,
              {
                method: toText(args[0]).toUpperCase(),
                url: resolve(args[1]),
                at: "",
                aborted: false,
              },
            ]);
            if (fresh) {
              apply(listen, request, [
                "abort",
                () => {
                  const state = apply(recall, asked, [request]);
                  if (state) {
                    state.aborted = true;
                  }
                },
              ]);
              apply(listen, request, [
                "loadend",
                () => {
                  try {
                    const state = apply(recall, asked, [request]);
                    if (!state || state.aborted) {
                      return;
                    }
                    const status = request.status;
                    if (status >= 400) {
                      const what = `${status} ${request.statusText}`.trim();
                      failed("xhr", state.method, state.url, what, state.at);
                    } else if (status === 0) {
                      failed("xhr", state.method, state.url, "network error", state.at);
                    }
                  } catch (_) {
                    // То же.
                  }
                },
              ]);
            }
          } catch (_) {
            // То же.
          }
          return apply(target, request, args);
        },
      });
      Xhr.prototype.send = new Wrapper(send, {
        apply(target, request, args) {
          try {
            const state = apply(recall, asked, [request]);
            if (state) {
              state.at = caller();
              state.aborted = false;
            }
          } catch (_) {
            // То же.
          }
          return apply(target, request, args);
        },
      });
    } catch (_) {
      // Не вышло подменить — запросы останутся как есть.
    }
  }

  // Фоновые потоки и WebSocket. Их console отсюда не видна, но то, что поток
  // упал или не загрузился, а соединение оборвалось, приходит событием error
  // на сам объект — его и слушаем. Конструктор подменён прозрачно: прототип,
  // имя, instanceof и наследование остаются как были, а бросает он ровно то
  // же, что исходный.
  for (const name of ["Worker", "SharedWorker", "WebSocket"]) {
    const Original = window[name];
    if (typeof Original !== "function") {
      continue;
    }
    const kind = name.toLowerCase();
    try {
      window[name] = new Wrapper(Original, {
        construct(target, args, newTarget) {
          const made = construct(target, args, newTarget);
          try {
            const script = resolve(args[0]);
            const at = caller();
            apply(listen, made, [
              "error",
              (event) => {
                try {
                  if (event instanceof Failure) {
                    keep("exception", event.message, {
                      worker: script,
                      at: placed(event),
                    });
                    echoes.push(`${event.message} ${placed(event)}`);
                    if (echoes.length > 20) {
                      echoes.shift();
                    }
                  } else {
                    keep("resource", `${kind} ${script}`.trim(), { at });
                  }
                } catch (_) {
                  // То же.
                }
              },
            ]);
          } catch (_) {
            // Создан — без записи о нём страница проживёт.
          }
          return made;
        },
      });
    } catch (_) {
      // Не вышло подменить — останутся как есть.
    }
  }

  // Главная страница принимает сообщения своих рамок. Слушатель ставится
  // раньше всех страничных и на погружении, поэтому сообщение с меткой
  // дальше не идёт: страница своих postMessage с ним не увидит.
  if (!framed) {
    const label = (value) =>
      typeof value === "string" ? shorten(value, LABEL) : "";
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
          const claimed = label(entry.frame);
          const frame =
            claimed &&
            (origin === "null" ||
              claimed === origin ||
              claimed.startsWith(`${origin}/`))
              ? claimed
              : origin;
          keep(level, entry.text, {
            frame,
            worker: label(entry.worker),
            at: label(entry.at),
          });
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
