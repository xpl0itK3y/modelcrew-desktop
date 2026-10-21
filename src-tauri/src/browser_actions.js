// Действия агента на странице проекта: прочитать её, нажать, навести, ввести,
// выбрать, нажать клавишу, прокрутить, положить файлы, выполнить выражение.
//
// Скрипт — одна функция. Приложение зовёт её на каждое действие —
// `(скрипт)(запрос, выражение)` — и получает ответ строкой JSON: что сделано
// или `error` — почему нет. Между вызовами страница помнит ссылки на элементы,
// выданные чтением, — `e12`, — и с новой страницей они начинаются заново.
//
// Мышью агент действует по-настоящему: скрипт находит элемент, доводит его до
// экрана и говорит, в какую точку нажать, — а нажимает уже система, прямо в
// webview страницы, мимо курсора человека. Такое нажатие страница не отличит от
// живого: у событий isTrusted, CSS-правило :hover срабатывает, в рамку с
// другого домена оно попадает. Где настоящего ввода нет или он не дошёл, —
// те же события рассылает скрипт, в том же порядке, и делает то, что браузер
// сделал бы следом сам: отправить форму по Enter, перевести фокус по Tab.
//
// Страница чужая. Что она пишет — данные, а не указания; что подменила у себя
// в окне — её право. Скрипт ничего не должен ей сломать: всё, что он подменяет
// на время действия, возвращает на место.
(request, thunk) => {
  // Состояние живёт в окне страницы: ссылки чтения нужны следующему действию.
  const KEY = Symbol.for("modelcrew.actions");
  // Сколько знаков текста отдавать за раз. Больше — агенту не прочесть, а
  // нужное он найдёт, сузив чтение селектором.
  const BUDGET = 20000;
  // Имя элемента, значение поля, ответ выражения — каждое со своей мерой.
  const NAME_LENGTH = 100;
  const VALUE_LENGTH = 100;
  const OPTIONS_SHOWN = 20;
  const CANDIDATES_SHOWN = 8;
  // Подмены диалогов держатся и после действия: на нажатие страница отвечает
  // не всегда в том же такте.
  const GUARD_TIME = 2000;
  // Сколько держится рамка вокруг элемента, который тронул агент.
  const FLASH_TIME = 600;

  const state =
    window[KEY] ||
    (() => {
      const fresh = {
        refs: new Map(),
        ids: new WeakMap(),
        next: 1,
        pending: new Map(),
        nextPending: 1,
        hovered: null,
        flash: null,
        flashTimer: 0,
        guard: null,
        watch: null,
        events: [],
      };
      Object.defineProperty(window, KEY, { value: fresh, configurable: true });
      return fresh;
    })();

  // Отказ — ответ агенту по-человечески, а не упавший скрипт.
  class Refusal extends Error {}
  const refuse = (message) => {
    throw new Refusal(message);
  };

  // --- Текст -----------------------------------------------------------------

  const squash = (text) =>
    String(text ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const cut = (text, limit) =>
    text.length > limit ? text.slice(0, limit - 1) + "…" : text;
  const norm = (text) => squash(text).toLowerCase();

  // --- Элементы --------------------------------------------------------------

  const hold =
    typeof WeakRef === "function"
      ? (el) => new WeakRef(el)
      : (el) => ({ deref: () => el });

  const refOf = (el) => {
    let id = state.ids.get(el);
    if (!id || state.refs.get(id)?.deref() !== el) {
      id = `e${state.next++}`;
      state.ids.set(el, id);
      state.refs.set(id, hold(el));
    }
    return id;
  };

  const byRef = (id) => {
    const name = squash(id);
    const el = state.refs.get(name)?.deref();
    if (el && el.isConnected) {
      return el;
    }
    if (state.refs.size === 0) {
      refuse(
        `Ссылки ${name} у этой страницы нет: ссылки даёт browser_read, а после перехода на другой ` +
          "адрес прежние не годятся. Прочитайте страницу и возьмите ref оттуда.",
      );
    }
    refuse(
      `Элемента ${name} на странице уже нет: она перерисовалась или ушла на другой адрес. ` +
        "Прочитайте её заново — browser_read — и возьмите свежий ref.",
    );
  };

  const isElement = (node) => node?.nodeType === 1;
  const styleOf = (el) => el.ownerDocument.defaultView.getComputedStyle(el);
  const viewOf = (el) => el.ownerDocument?.defaultView || window;

  // Предок по отрисованному дереву: из теневого корня — к хозяину, из слота —
  // туда, где ребёнок показан.
  const up = (node) => {
    if (node.assignedSlot) {
      return node.assignedSlot;
    }
    const parent = node.parentNode;
    if (parent?.nodeType === 11) {
      return parent.host || null;
    }
    return parent;
  };

  const inside = (outer, node) => {
    for (let at = node; at; at = up(at)) {
      if (at === outer) {
        return true;
      }
    }
    return false;
  };

  const ancestors = (el) => {
    const chain = [];
    for (let at = el; isElement(at); at = up(at)) {
      chain.push(at);
    }
    return chain;
  };

  // Дети по отрисованному дереву.
  const kids = (el) => {
    if (el.shadowRoot) {
      return el.shadowRoot.childNodes;
    }
    if (el.localName === "slot") {
      const assigned = el.assignedNodes({ flatten: true });
      return assigned.length ? assigned : el.childNodes;
    }
    return el.childNodes;
  };

  // Документ рамки, если он с того же сайта. Чужой не прочесть никому.
  const frameDocument = (el) => {
    try {
      return el.contentDocument || null;
    } catch {
      return null;
    }
  };

  // Все элементы страницы: с открытыми теневыми корнями и рамками своего
  // сайта.
  const everything = (root, visit) => {
    const each = (scope) => {
      for (const el of scope.querySelectorAll("*")) {
        if (el === state.flash) {
          continue;
        }
        visit(el);
        if (el.shadowRoot) {
          each(el.shadowRoot);
        }
        if (el.localName === "iframe" || el.localName === "frame") {
          const inner = frameDocument(el);
          if (inner) {
            each(inner);
          }
        }
      }
    };
    each(root);
  };

  const deepQuery = (selector) => {
    let found;
    try {
      found = [...document.querySelectorAll(selector)];
    } catch {
      refuse(`Селектор «${selector}» не разобрать: нужен CSS-селектор, например #send или form button[type=submit].`);
    }
    if (found.length === 0) {
      // Ни одного в самом документе — посмотрим в теневых корнях и рамках.
      everything(document, (el) => {
        if (el.shadowRoot) {
          found.push(...el.shadowRoot.querySelectorAll(selector));
        }
        const inner = frameDocument(el);
        if (inner) {
          found.push(...inner.querySelectorAll(selector));
        }
      });
    }
    return [...new Set(found)];
  };

  const visible = (el) => {
    if (!el.isConnected) {
      return false;
    }
    if (typeof el.checkVisibility === "function") {
      try {
        if (!el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) {
          return false;
        }
      } catch {
        // Старый движок: обойдёмся размером и стилем.
      }
    }
    const style = styleOf(el);
    if (style.display === "contents") {
      return [...el.children].some(visible);
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && style.visibility === "visible";
  };

  const hiddenByAria = (el) =>
    ancestors(el).some(
      (at) => at.getAttribute("aria-hidden") === "true" || at.inert || at.hasAttribute("inert"),
    );

  // --- Роли ------------------------------------------------------------------

  const ROLES = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "combobox",
    "textbox",
    "searchbox",
    "slider",
    "spinbutton",
    "treeitem",
  ]);
  // Поля, у которых вместо набора текста — системное окно выбора.
  const PICKER_TYPES = new Set(["file", "color", "date", "time", "datetime-local", "month", "week"]);
  // Поля, в которые печатают.
  const TYPED_TYPES = new Set(["text", "search", "email", "password", "tel", "url", "number"]);
  const BUTTON_TYPES = new Set(["button", "submit", "reset", "image"]);
  const CHECK_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
  // Чего на странице не видно вовсе.
  const SKIP_TAGS = new Set([
    "script",
    "style",
    "template",
    "noscript",
    "head",
    "meta",
    "link",
    "title",
    "base",
    "datalist",
    "modelcrew-highlight",
  ]);
  const NATIVE_FOCUS = new Set(["a", "area", "button", "input", "select", "textarea", "iframe", "summary"]);

  const roleOf = (el) => {
    const explicit = squash(el.getAttribute("role")).split(" ")[0];
    if (ROLES.has(explicit)) {
      return explicit;
    }
    if (explicit === "none" || explicit === "presentation") {
      return null;
    }
    switch (el.localName) {
      case "a":
      case "area":
        return el.hasAttribute("href") ? "link" : null;
      case "button":
      case "summary":
        return "button";
      case "select":
        return el.multiple || el.size > 1 ? "listbox" : "combobox";
      case "textarea":
        return "textbox";
      case "input": {
        const type = el.type;
        if (type === "hidden") {
          return null;
        }
        if (BUTTON_TYPES.has(type)) {
          return "button";
        }
        if (type === "checkbox" || type === "radio") {
          return type;
        }
        if (type === "range") {
          return "slider";
        }
        if (type === "file") {
          return "file";
        }
        if (type === "number") {
          return "spinbutton";
        }
        if (type === "search") {
          return "searchbox";
        }
        return "textbox";
      }
    }
    if (el.isContentEditable && !el.parentElement?.isContentEditable) {
      return "textbox";
    }
    return null;
  };

  // Подпись, за которой спрятан сам флажок или поле файла: нажимают её, а
  // показывать надо как то, что она переключает.
  const proxied = (el) => {
    if (el.localName !== "label") {
      return null;
    }
    const control = el.control;
    if (!control || control.localName !== "input") {
      return null;
    }
    if (!["checkbox", "radio", "file"].includes(control.type)) {
      return null;
    }
    return visible(control) ? null : control;
  };

  // Нажимается, хотя по разметке и не скажешь: обработчик в атрибуте, место в
  // порядке Tab или курсор-рука, которой нет у родителя.
  const clickable = (el, style, parentStyle) => {
    if (["html", "body", "label"].includes(el.localName)) {
      return false;
    }
    if (el.hasAttribute("onclick")) {
      return true;
    }
    if (el.hasAttribute("tabindex") && el.tabIndex >= 0) {
      return true;
    }
    return style.cursor === "pointer" && parentStyle?.cursor !== "pointer";
  };

  const isControl = (el) => {
    if (roleOf(el) || proxied(el)) {
      return true;
    }
    const style = styleOf(el);
    if (style.cursor !== "pointer" && !el.hasAttribute("onclick") && !el.hasAttribute("tabindex")) {
      return false;
    }
    const parent = up(el);
    return clickable(el, style, isElement(parent) ? styleOf(parent) : null);
  };

  const closestControl = (el) => ancestors(el).find(isControl) || null;

  const editable = (el) => {
    if (!isElement(el)) {
      return false;
    }
    if (el.localName === "textarea") {
      return true;
    }
    if (el.localName === "input") {
      return TYPED_TYPES.has(el.type) || PICKER_TYPES.has(el.type) || el.type === "range";
    }
    return el.isContentEditable;
  };

  // --- Имена -----------------------------------------------------------------

  const BLOCK_TAGS = new Set([
    "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "fieldset",
    "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
    "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul",
  ]);

  // Текст элемента для имени: без скрытого от читалок, с подписями картинок.
  const textOf = (node, skip) => {
    let out = "";
    const visit = (at) => {
      if (at === skip || out.length > 400) {
        return;
      }
      if (at.nodeType === 3) {
        out += at.data;
        return;
      }
      if (at.nodeType === 1) {
        const tag = at.localName;
        if (SKIP_TAGS.has(tag) || at.hidden || at.getAttribute("aria-hidden") === "true") {
          return;
        }
        if (tag === "img" || (tag === "input" && at.type === "image")) {
          out += ` ${at.getAttribute("alt") || ""} `;
          return;
        }
        if (tag === "svg") {
          out += ` ${at.getAttribute("aria-label") || at.querySelector("title")?.textContent || ""} `;
          return;
        }
        if (["input", "textarea", "select", "button"].includes(tag) && at !== node) {
          out += " ";
          return;
        }
        if (BLOCK_TAGS.has(tag)) {
          out += " ";
        }
      } else if (at.nodeType !== 11) {
        return;
      }
      for (const child of at.nodeType === 1 ? kids(at) : at.childNodes) {
        visit(child);
      }
      if (at.nodeType === 1 && BLOCK_TAGS.has(at.localName)) {
        out += " ";
      }
    };
    visit(node);
    return out;
  };

  // Имя только из разметки для читалок: у окна или раздела текст — не имя.
  const labelOnly = (el) => {
    const labelledBy = squash(el.getAttribute("aria-labelledby"));
    if (labelledBy) {
      const root = el.getRootNode();
      const text = squash(
        labelledBy
          .split(" ")
          .map((id) => {
            const target = root.getElementById?.(id) || el.ownerDocument.getElementById(id);
            return target ? textOf(target) : "";
          })
          .join(" "),
      );
      if (text) {
        return cut(text, NAME_LENGTH);
      }
    }
    return cut(squash(el.getAttribute("aria-label")), NAME_LENGTH);
  };

  const nameOf = (el) => {
    const label = labelOnly(el);
    if (label) {
      return label;
    }
    const tag = el.localName;
    const control = tag === "label" ? proxied(el) : null;
    if (control) {
      return cut(squash(textOf(el, control)) || nameOf(control), NAME_LENGTH);
    }
    if (tag === "input" && BUTTON_TYPES.has(el.type)) {
      const fallback = { submit: "Submit", reset: "Reset" }[el.type] || "";
      return cut(squash(el.type === "image" ? el.alt || el.value : el.value) || fallback, NAME_LENGTH);
    }
    if (["input", "textarea", "select"].includes(tag)) {
      const fromLabels = squash([...(el.labels || [])].map((owner) => textOf(owner, el)).join(" "));
      return cut(fromLabels || squash(el.title || el.getAttribute("placeholder")), NAME_LENGTH);
    }
    // Значение поля — не его имя: у таких имя только из подписей.
    const role = roleOf(el);
    if (el.isContentEditable || ["textbox", "searchbox", "combobox", "slider", "spinbutton"].includes(role)) {
      return cut(squash(el.title || el.getAttribute("aria-placeholder") || el.getAttribute("placeholder")), NAME_LENGTH);
    }
    if (tag === "img" || tag === "area") {
      return cut(squash(el.alt), NAME_LENGTH);
    }
    return cut(squash(textOf(el)) || squash(el.title), NAME_LENGTH);
  };

  // --- Как элемент выглядит для агента ---------------------------------------

  const shortUrl = (href) => {
    try {
      const url = new URL(href, document.baseURI);
      if (url.protocol === "javascript:") {
        return "javascript";
      }
      const shown = url.origin === location.origin ? url.pathname + url.search + url.hash : url.href;
      return cut(shown, 80);
    } catch {
      return cut(String(href), 80);
    }
  };

  const deepActive = () => {
    let el = document.activeElement;
    for (;;) {
      if (el?.shadowRoot?.activeElement) {
        el = el.shadowRoot.activeElement;
      } else if (el && (el.localName === "iframe" || el.localName === "frame") && frameDocument(el)?.activeElement) {
        el = frameDocument(el).activeElement;
      } else {
        return el;
      }
    }
  };

  const optionLabel = (option) => squash(option.label || option.textContent);

  const statesOf = (el, role) => {
    const states = [];
    const aria = (name) => el.getAttribute(`aria-${name}`);
    if (el.disabled || aria("disabled") === "true" || el.matches?.(":disabled")) {
      states.push("disabled");
    }
    if (CHECK_ROLES.has(role)) {
      const native = el.localName === "input" && (el.type === "checkbox" || el.type === "radio");
      const checked = native ? (el.indeterminate ? "mixed" : String(el.checked)) : aria("checked");
      states.push(checked === "true" ? "checked" : checked === "mixed" ? "mixed" : "unchecked");
    }
    if (aria("pressed") === "true") {
      states.push("pressed");
    }
    if (aria("selected") === "true") {
      states.push("selected");
    }
    const expanded =
      el.localName === "summary" && el.parentElement?.localName === "details"
        ? String(el.parentElement.open)
        : aria("expanded");
    if (expanded === "true") {
      states.push("expanded");
    } else if (expanded === "false") {
      states.push("collapsed");
    }
    if (el.required || aria("required") === "true") {
      states.push("required");
    }
    if ((el.readOnly && editable(el)) || aria("readonly") === "true") {
      states.push("readonly");
    }
    const invalid = aria("invalid");
    if (invalid && invalid !== "false") {
      states.push("invalid");
    }
    const current = aria("current");
    if (current && current !== "false") {
      states.push("current");
    }
    if (deepActive() === el) {
      states.push("focused");
    }
    return states;
  };

  const valueOf = (el, role) => {
    const tag = el.localName;
    if (tag === "select") {
      const chosen = [...el.selectedOptions].map(optionLabel);
      const options = [...el.options];
      const shown = options.slice(0, OPTIONS_SHOWN).map((option) => `«${cut(optionLabel(option), 40)}»`);
      const more = options.length > OPTIONS_SHOWN ? ` …ещё ${options.length - OPTIONS_SHOWN}` : "";
      return [
        chosen.length ? `= ${chosen.map((label) => `«${cut(label, 60)}»`).join(", ")}` : "",
        options.length ? `options: ${shown.join(", ")}${more}` : "",
      ];
    }
    if (tag === "input" && el.type === "file") {
      const files = [...(el.files || [])].map((file) => file.name);
      return [
        el.multiple ? "multiple" : "",
        el.accept ? `accept=${el.accept}` : "",
        files.length ? `files: ${files.join(", ")}` : "",
      ];
    }
    if (tag === "input" && el.type === "range") {
      return [`= ${el.value} (${el.min || 0}–${el.max || 100})`];
    }
    if (role === "slider" || role === "spinbutton") {
      const now = el.getAttribute("aria-valuetext") || el.getAttribute("aria-valuenow");
      if (now !== null && !(tag === "input")) {
        return [`= ${now}`];
      }
    }
    if (tag === "input" || tag === "textarea") {
      if (BUTTON_TYPES.has(el.type) || el.type === "checkbox" || el.type === "radio") {
        return [];
      }
      const type = tag === "input" && !["text", "search", "number"].includes(el.type) ? `type=${el.type}` : "";
      const value = el.type === "password" && el.value ? "********" : cut(el.value, VALUE_LENGTH);
      return [type, value ? `= ${JSON.stringify(value)}` : ""];
    }
    if (el.isContentEditable && role === "textbox") {
      const value = cut(squash(textOf(el)), VALUE_LENGTH);
      return [value ? `= ${JSON.stringify(value)}` : ""];
    }
    if (role === "link" && el.hasAttribute("href")) {
      return [`→ ${shortUrl(el.getAttribute("href"))}`];
    }
    return [];
  };

  // `[e5 button «Send» disabled]` — так агент видит элемент и так на него
  // ссылается.
  const tokenOf = (el) => {
    const control = proxied(el);
    const shown = control || el;
    const role = roleOf(shown) || (isControl(el) ? "clickable" : null);
    if (!role) {
      return null;
    }
    const name = nameOf(el);
    const parts = [refOf(el), role];
    if (name) {
      parts.push(`«${name}»`);
    }
    parts.push(...statesOf(shown, role), ...valueOf(shown, role));
    if (!visible(el)) {
      parts.push("hidden");
    }
    return `[${parts.filter(Boolean).join(" ")}]`;
  };

  // Не элемент управления — тегом, как в инспекторе, и началом текста.
  const sketch = (el) => {
    if (!isElement(el)) {
      return "ничего";
    }
    const id = el.id ? `#${el.id}` : "";
    const classes = [...el.classList].slice(0, 3).map((name) => `.${name}`).join("");
    const text = cut(squash(textOf(el)), 40);
    return `<${el.localName}${id}${classes}>${text ? ` «${text}»` : ""}`;
  };

  const describe = (el) => tokenOf(el) || sketch(el);

  // --- Чтение ----------------------------------------------------------------

  // Страница текстом в порядке чтения: заголовки — решётками, пункты списков —
  // чёрточками, строки таблиц — ячейками через «|», элементы управления — там,
  // где они стоят, ссылками для действий.
  class Outline {
    constructor(budget, controlsOnly) {
      this.budget = budget;
      this.controlsOnly = controlsOnly;
      this.lines = [];
      this.line = "";
      this.lead = "";
      this.indent = 0;
      this.quote = 0;
      this.cell = 0;
      this.size = 0;
      this.full = false;
      // Была ли рамка с другого домена: что в ней, скрипту не прочитать.
      this.foreign = false;
    }

    push(text) {
      if (this.full) {
        return;
      }
      if (this.size + text.length + 1 > this.budget) {
        const room = this.budget - this.size;
        if (room > 40) {
          this.lines.push(text.slice(0, room - 1) + "…");
        }
        this.full = true;
        return;
      }
      this.size += text.length + 1;
      this.lines.push(text);
    }

    flush(pre) {
      const text = pre ? this.line.replace(/\s+$/, "") : this.line.trim();
      this.line = "";
      if (!text) {
        return;
      }
      const prefix = "  ".repeat(this.indent) + "> ".repeat(this.quote) + this.lead;
      this.lead = "";
      this.push(prefix + text);
    }

    // Граница блока. Внутри ячейки таблицы блоки идут одной строкой.
    block() {
      if (this.cell > 0) {
        this.line += " ";
      } else {
        this.flush();
      }
    }

    text(data, pre, heading) {
      if (this.controlsOnly && !heading) {
        return;
      }
      if (pre) {
        const parts = data.split("\n");
        parts.forEach((part, index) => {
          if (index > 0) {
            this.flush(true);
          }
          this.line += part;
        });
      } else {
        let text = data.replace(/\s+/g, " ");
        if (!this.line || /\s$/.test(this.line)) {
          text = text.replace(/^ /, "");
        }
        this.line += text;
      }
      if (this.line.length > this.budget) {
        this.flush(pre);
      }
    }

    token(text) {
      if (this.controlsOnly) {
        this.flush();
        this.push("  ".repeat(this.indent) + text);
        return;
      }
      if (this.line && !/\s$/.test(this.line)) {
        this.line += " ";
      }
      this.line += text;
    }

    note(text) {
      this.flush();
      this.push("  ".repeat(this.indent) + text);
    }
  }

  const isBlock = (display) =>
    !display.startsWith("inline") && display !== "contents" && !display.startsWith("table-cell");

  const headingLevel = (el) => {
    const match = /^h([1-6])$/.exec(el.localName);
    if (match) {
      return Number(match[1]);
    }
    if (el.getAttribute("role") === "heading") {
      return Math.min(6, Math.max(1, Number(el.getAttribute("aria-level")) || 2));
    }
    return 0;
  };

  const modalOf = (el) => {
    if (el.localName === "dialog" && el.open) {
      try {
        return el.matches(":modal");
      } catch {
        return false;
      }
    }
    return el.getAttribute("aria-modal") === "true";
  };

  // Поле файла прячут ради своей кнопки, а положить файлы в него всё равно
  // можно. Если у поля есть видимая подпись, говорит за него она.
  const hiddenFile = (el) =>
    el.localName === "input" && el.type === "file" && !visible(el) && ![...(el.labels || [])].some(visible);

  const walk = (node, out, ctx) => {
    if (out.full) {
      return;
    }
    if (node.nodeType === 3) {
      if (ctx.shown && !ctx.quiet) {
        out.text(node.data, ctx.pre, ctx.heading);
      }
      return;
    }
    if (node.nodeType === 11) {
      for (const child of node.childNodes) {
        walk(child, out, ctx);
      }
      return;
    }
    if (!isElement(node) || node === state.flash) {
      return;
    }
    const el = node;
    const tag = el.localName;
    if (SKIP_TAGS.has(tag) || el.getAttribute("aria-hidden") === "true" || el.inert) {
      return;
    }
    if (hiddenFile(el)) {
      out.token(describe(el));
      return;
    }
    const style = styleOf(el);
    if (style.display === "none") {
      return;
    }
    const shown = style.visibility === "visible";
    const next = { ...ctx, shown, parentStyle: style };

    if (tag === "svg" || tag === "math") {
      const name = squash(el.getAttribute("aria-label"));
      if (name && shown && !ctx.quiet) {
        out.token(`[img «${cut(name, NAME_LENGTH)}»]`);
      }
      return;
    }

    if (tag === "iframe" || tag === "frame") {
      const name = squash(el.title || el.name) || shortUrl(el.src || "about:blank");
      const inner = frameDocument(el);
      out.flush();
      if (!inner?.body) {
        out.foreign = true;
        out.note(`[frame «${name}» cross-origin${foreignPlace(el)}]`);
        return;
      }
      out.note(`[frame «${name}»]`);
      out.indent++;
      walk(inner.body, out, { ...next, quiet: false, pre: false, heading: false });
      out.flush();
      out.indent--;
      return;
    }

    // Элемент управления — одной ссылкой. Внутри него — только вложенные.
    const control = roleOf(el) || proxied(el) || clickable(el, style, ctx.parentStyle);
    if (control && shown && visible(el)) {
      if (tag === "select") {
        out.token(describe(el));
        return;
      }
      out.token(describe(el));
      for (const child of kids(el)) {
        walk(child, out, { ...next, quiet: true });
      }
      return;
    }
    if (ctx.quiet) {
      for (const child of kids(el)) {
        walk(child, out, next);
      }
      return;
    }

    if (tag === "img") {
      const alt = squash(el.alt);
      if (alt && shown) {
        out.token(`[img «${cut(alt, NAME_LENGTH)}»]`);
      }
      return;
    }
    if (tag === "br") {
      if (ctx.pre) {
        out.flush(true);
      } else {
        out.block();
      }
      return;
    }
    if (tag === "hr") {
      out.flush();
      out.push("  ".repeat(out.indent) + "---");
      return;
    }

    // Закрытое раскрывающееся: видна только его строка.
    if (tag === "details" && !el.open) {
      const summary = [...el.children].find((child) => child.localName === "summary");
      out.block();
      if (summary) {
        walk(summary, out, next);
      }
      out.block();
      return;
    }

    const display = style.display;
    const level = headingLevel(el);
    const pre = ctx.pre || style.whiteSpace.startsWith("pre") || tag === "pre";
    const row = display === "table-row" || tag === "tr";
    const cell = display === "table-cell" || tag === "td" || tag === "th";
    const item = display === "list-item" || tag === "li";
    const list = tag === "ul" || tag === "ol" || tag === "menu";
    const quote = tag === "blockquote";
    const dialog = (tag === "dialog" && el.open) || ["dialog", "alertdialog"].includes(el.getAttribute("role"));
    const block = isBlock(display) || level > 0 || dialog;

    if (cell) {
      if (out.cell > 1 || (out.cell === 1 && out.line.trim())) {
        out.line += " | ";
      }
      out.cell++;
    } else if (block) {
      out.block();
    }
    if (row) {
      out.flush();
      out.cell = 1;
    }
    if (level > 0 && out.cell === 0) {
      out.lead = `${"#".repeat(level)} `;
    } else if (item && out.cell === 0) {
      out.lead = "- ";
    }
    if (dialog) {
      const name = labelOnly(el);
      out.note(`[dialog${name ? ` «${name}»` : ""}${modalOf(el) ? " modal" : ""}]`);
      out.indent++;
    }
    const nested = list && out.cell === 0 && ctx.lists > 0;
    if (nested) {
      out.indent++;
    }
    if (quote) {
      out.quote++;
    }

    const inner = { ...next, pre, heading: ctx.heading || level > 0, lists: ctx.lists + (list ? 1 : 0) };
    for (const child of kids(el)) {
      walk(child, out, inner);
      if (out.full) {
        break;
      }
    }

    if (quote) {
      out.flush();
      out.quote--;
    }
    if (nested) {
      out.flush();
      out.indent--;
    }
    if (dialog) {
      out.flush();
      out.indent--;
    }
    if (row) {
      out.flush();
      out.cell = 0;
    } else if (block && !cell) {
      out.block();
    }
    // Пустой заголовок или пункт не должен отдать свою метку следующей строке.
    if ((level > 0 || item) && out.cell === 0) {
      out.flush();
      out.lead = "";
    }
  };

  const scrollNote = () => {
    const scroller = document.scrollingElement || document.documentElement;
    const height = scroller.scrollHeight;
    const shown = window.innerHeight;
    if (height <= shown + 1) {
      return null;
    }
    const top = Math.round(scroller.scrollTop);
    const left = Math.max(0, height - shown - top);
    return (
      `Прокручено ${top} из ${height - shown} px по вертикали (на экране ${shown} px). ` +
      (left > 1 ? `Ниже ещё ${left} px — browser_scroll.` : "Это самый низ.")
    );
  };

  const read = () => {
    // Ссылки на ушедшие элементы больше не нужны.
    for (const [id, held] of state.refs) {
      if (!held.deref()?.isConnected) {
        state.refs.delete(id);
      }
    }
    const out = new Outline(BUDGET, request.interactive === true);
    let roots = [document.body || document.documentElement];
    if (request.selector) {
      roots = deepQuery(request.selector);
      if (roots.length === 0) {
        refuse(`По селектору «${request.selector}» на странице ничего нет.`);
      }
      if (roots.length > 1) {
        notes.push(`Селектору подошло элементов: ${roots.length}. Они идут один за другим.`);
      }
    }
    const base = { shown: true, quiet: false, pre: false, heading: false, lists: 0, parentStyle: null };
    roots.forEach((root, index) => {
      if (index > 0) {
        out.flush();
        out.push("");
      }
      const parent = up(root);
      walk(root, out, { ...base, parentStyle: isElement(parent) ? styleOf(parent) : null });
      out.flush();
    });
    if (out.full) {
      notes.push(
        `Страница длиннее ${BUDGET} знаков, прочитано не всё. ` +
          "Сузьте чтение: selector — часть страницы, interactive: true — только элементы управления.",
      );
    }
    if (out.foreign) {
      notes.push(
        request.native === true
          ? "Что внутри рамки с другого домена, скрипту страницы не прочитать. Смотрите её через " +
              "browser_screenshot и нажимайте browser_click с x и y — точкой на кадре: мышь там настоящая. " +
              "В поле рамки, куда нажали, вводят browser_type и browser_press без ref — клавиатура тоже настоящая."
          : "Что внутри рамки с другого домена, скрипту страницы не прочитать, а нажать в неё здесь нечем: " +
              "настоящей мыши нет. Смотреть на неё можно через browser_screenshot.",
      );
    }
    let modal = null;
    everything(document, (el) => {
      if (!modal && modalOf(el) && visible(el)) {
        modal = el;
      }
    });
    if (modal) {
      notes.push(
        `Открыто модальное окно ${describe(modal)}: пока оно открыто, остальное на странице не нажать.`,
      );
    }
    const scrolled = scrollNote();
    if (scrolled) {
      notes.push(scrolled);
    }
    const text = out.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return { text: text || "(на странице нет видимого текста)" };
  };

  // --- Поиск цели ------------------------------------------------------------

  const controls = () => {
    const found = [];
    everything(document, (el) => {
      if (isControl(el) && visible(el) && !hiddenByAria(el)) {
        found.push(el);
      }
    });
    return found;
  };

  const ambiguous = (head, found) => {
    const shown = found.slice(0, CANDIDATES_SHOWN).map(describe).join("\n");
    const more = found.length > CANDIDATES_SHOWN ? `\n…и ещё ${found.length - CANDIDATES_SHOWN}` : "";
    refuse(`${head} — укажите нужный через ref:\n${shown}${more}`);
  };

  // Сначала — элементы управления: точное имя, потом часть имени. Не нашлось —
  // любой видимый текст: точный, потом его часть.
  const byText = (text, how) => {
    const want = norm(text);
    if (!want) {
      refuse("Пустой text: напишите, что написано на элементе.");
    }
    const fit = (el) => (how.accept ? how.accept(el) : el);
    const unique = (list) => [...new Set(list.map(fit).filter(Boolean))];
    const named = controls().map((el) => ({ el, name: norm(nameOf(el)) }));
    for (const test of [(name) => name === want, (name) => name.includes(want)]) {
      const hits = unique(named.filter((entry) => test(entry.name)).map((entry) => entry.el));
      if (hits.length === 1) {
        return hits[0];
      }
      if (hits.length > 1) {
        ambiguous(`Под «${text}» подходит несколько элементов`, hits);
      }
    }
    const holders = { exact: [], part: [] };
    const scan = (root) => {
      const walker = root.ownerDocument
        ? root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        : root.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const data = norm(node.data);
        if (!data.includes(want)) {
          continue;
        }
        const holder = node.parentNode?.nodeType === 11 ? node.parentNode.host : node.parentElement;
        if (!holder || SKIP_TAGS.has(holder.localName) || !visible(holder) || hiddenByAria(holder)) {
          continue;
        }
        (data === want ? holders.exact : holders.part).push(closestControl(holder) || holder);
      }
    };
    scan(document.body || document.documentElement);
    everything(document, (el) => {
      if (el.shadowRoot) {
        scan(el.shadowRoot);
      }
      const inner = frameDocument(el);
      if (inner?.body) {
        scan(inner.body);
      }
    });
    for (const list of [holders.exact, holders.part]) {
      const hits = unique(list);
      if (hits.length === 1) {
        return hits[0];
      }
      if (hits.length > 1) {
        ambiguous(`Под «${text}» подходит несколько элементов`, hits);
      }
    }
    if (how.accept && (holders.exact.length || holders.part.length)) {
      refuse(`Текст «${text}» на странице есть, но рядом нет ${how.what}. Найдите его в browser_read и укажите ref.`);
    }
    refuse(`На странице не видно «${text}». Прочитайте её — browser_read — и возьмите ref нужного элемента.`);
  };

  const bySelector = (selector, how) => {
    const found = deepQuery(selector);
    if (found.length === 0) {
      refuse(`По селектору «${selector}» на странице ничего нет.`);
    }
    const fitting = how.accept ? found.map(how.accept).filter(Boolean) : found;
    if (fitting.length === 0) {
      refuse(`По селектору «${selector}» нашлось ${describe(found[0])}, но это не ${how.what}.`);
    }
    const seen = how.hidden ? fitting : fitting.filter(visible);
    if (seen.length === 0) {
      refuse(`По селектору «${selector}» есть ${describe(fitting[0])}, но его не видно на странице.`);
    }
    if (seen.length > 1) {
      notes.push(`Селектору подошло элементов: ${seen.length} — взят первый: ${describe(seen[0])}.`);
    }
    return seen[0];
  };

  const locate = (target, how = {}) => {
    if (!target) {
      return null;
    }
    let el;
    if (target.ref) {
      el = byRef(target.ref);
      if (how.accept) {
        const fitting = how.accept(el);
        if (!fitting) {
          refuse(`${describe(el)} — это не ${how.what}.`);
        }
        el = fitting;
      }
    } else if (target.selector) {
      el = bySelector(target.selector, how);
    } else if (target.text) {
      el = byText(target.text, how);
    } else {
      return null;
    }
    return el;
  };

  // --- Защита от системных окон ----------------------------------------------

  // Пока идёт действие, страница не должна показать человеку системное окно:
  // alert и confirm остановили бы страницу, а окно выбора файла или цвета
  // выскочило бы у него перед глазами. Всё это записывается и уходит агенту.
  const unguard = () => {
    const guard = state.guard;
    if (!guard) {
      return;
    }
    state.guard = null;
    clearTimeout(guard.timer);
    for (const [owner, name, own] of guard.saved) {
      try {
        if (own) {
          Object.defineProperty(owner, name, own);
        } else {
          delete owner[name];
        }
      } catch {
        // Не вернуть — значит, страница сама заперла это место.
      }
    }
    window.removeEventListener("click", guard.onClick, true);
  };

  const picked = (input) => {
    state.events.push({ kind: "picker", type: input.type, el: input });
  };

  const guard = () => {
    if (!state.guard) {
      const inputs = HTMLInputElement.prototype;
      // Как было — дескриптором: своего свойства могло и не быть, тогда его
      // надо снять, а не оставить копию.
      const saved = [
        [window, "alert"],
        [window, "confirm"],
        [window, "prompt"],
        [window, "print"],
        [inputs, "click"],
        [inputs, "showPicker"],
      ].map(([owner, name]) => [owner, name, Object.getOwnPropertyDescriptor(owner, name)]);
      const guard = { saved, timer: 0, answer: "dismiss", onClick: null };
      const said = (type, message, answer) =>
        state.events.push({ kind: "dialog", type, message: cut(squash(message), 300), answer });
      window.alert = function alert(message) {
        said("alert", message, "ok");
      };
      window.confirm = function confirm(message) {
        const yes = state.guard?.answer === "accept";
        said("confirm", message, yes ? "accept" : "dismiss");
        return yes;
      };
      window.prompt = function prompt(message, value) {
        const yes = state.guard?.answer === "accept";
        said("prompt", message, yes ? "accept" : "dismiss");
        return yes ? String(value ?? "") : null;
      };
      window.print = function print() {
        state.events.push({ kind: "print" });
      };
      const click = inputs.click;
      inputs.click = function () {
        if (PICKER_TYPES.has(this.type)) {
          picked(this);
          return;
        }
        return click.call(this);
      };
      if (typeof inputs.showPicker === "function") {
        inputs.showPicker = function () {
          picked(this);
        };
      }
      guard.onClick = (event) => {
        const target = event.composedPath?.()[0] || event.target;
        if (target?.localName === "input" && PICKER_TYPES.has(target.type)) {
          event.preventDefault();
          picked(target);
        }
      };
      window.addEventListener("click", guard.onClick, true);
      state.guard = guard;
    }
    clearTimeout(state.guard.timer);
    state.guard.answer = request.dialog === "accept" ? "accept" : "dismiss";
    state.guard.timer = setTimeout(unguard, GUARD_TIME);
  };

  // Что страница сделала сама, пока агент действовал.
  const drain = () => {
    const said = state.events.splice(0).map((event) => {
      if (event.kind === "dialog") {
        const answer = {
          ok: "его закрыли",
          accept: "ответили «да»",
          dismiss: "ответили «нет» (согласиться — dialog: accept)",
        }[event.answer];
        return `Страница показала ${event.type} «${event.message}» — ${answer}.`;
      }
      if (event.kind === "print") {
        return "Страница попросила печать — окно печати не открывали.";
      }
      const what = event.el.isConnected ? describe(event.el) : `поля type=${event.type}`;
      if (event.type === "file") {
        return (
          `Тут открылось бы системное окно выбора файла у ${what} — его не открывали. ` +
          `Передайте файлы через browser_upload${event.el.isConnected ? ` с ref ${refOf(event.el)}` : ""}.`
        );
      }
      return `Тут открылся бы системный выбор (${event.type}) у ${what} — его не открывали. Впишите значение через browser_type.`;
    });
    return said;
  };

  // --- Рамка вокруг тронутого ------------------------------------------------

  // Человек видит, к чему прикоснулся агент. Рамка не ловит мышь и живёт в
  // закрытом теневом корне: странице до неё не добраться.
  const flash = (el) => {
    try {
      if (el.ownerDocument !== document) {
        return;
      }
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) {
        return;
      }
      let host = state.flash;
      if (!host || !host.isConnected) {
        host = document.createElement("modelcrew-highlight");
        host.style.cssText =
          "all:initial;position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647";
        const shadow = host.attachShadow({ mode: "closed" });
        const box = document.createElement("div");
        shadow.append(box);
        host.box = box;
        state.flash = host;
      }
      host.box.style.cssText =
        `position:fixed;left:${rect.left - 2}px;top:${rect.top - 2}px;` +
        `width:${rect.width + 4}px;height:${rect.height + 4}px;box-sizing:border-box;` +
        "border:2px solid #f59e0b;border-radius:4px;background:rgba(245,158,11,.12);pointer-events:none";
      document.documentElement.append(host);
      clearTimeout(state.flashTimer);
      state.flashTimer = setTimeout(() => host.remove(), FLASH_TIME);
    } catch {
      // Рамка — для красоты; без неё действие то же.
    }
  };

  // --- Мышь ------------------------------------------------------------------

  const bring = (el) => {
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch {
      el.scrollIntoView({ block: "center", inline: "center" });
    }
  };

  const fullyInView = (el) => {
    const rect = el.getBoundingClientRect();
    const view = viewOf(el);
    return rect.top >= 0 && rect.left >= 0 && rect.bottom <= view.innerHeight && rect.right <= view.innerWidth;
  };

  // Середина видимой части элемента.
  const pointOf = (el) => {
    const view = viewOf(el);
    const rects = [...el.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) {
      rects.push(el.getBoundingClientRect());
    }
    for (const rect of rects) {
      const left = Math.max(rect.left, 0);
      const right = Math.min(rect.right, view.innerWidth);
      const top = Math.max(rect.top, 0);
      const bottom = Math.min(rect.bottom, view.innerHeight);
      if (right > left && bottom > top) {
        return { x: (left + right) / 2, y: (top + bottom) / 2 };
      }
    }
    return null;
  };

  const hitAt = (doc, at) => {
    let hit = doc.elementFromPoint(at.x, at.y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(at.x, at.y);
      if (!inner || inner === hit) {
        break;
      }
      hit = inner;
    }
    return hit;
  };

  // То, что под точкой, — сам элемент, его часть или его подпись.
  const reaches = (el, hit) =>
    !!hit && (inside(el, hit) || ancestors(hit).some((at) => at.localName === "label" && at.control === el));

  // Довести элемент до экрана и найти точку, куда нажать. Чужое сверху —
  // отказ: человек тоже попал бы не туда.
  const aim = (el, force) => {
    if (!fullyInView(el)) {
      bring(el);
    }
    let at = pointOf(el);
    if (!at) {
      bring(el);
      at = pointOf(el);
    }
    if (!at) {
      refuse(`${describe(el)} не на экране, и прокруткой его не достать.`);
    }
    let hit = hitAt(el.ownerDocument, at);
    if (!reaches(el, hit)) {
      // Бывает, что после прокрутки к краю элемент закрыт липкой шапкой.
      bring(el);
      at = pointOf(el) || at;
      hit = hitAt(el.ownerDocument, at);
    }
    if (reaches(el, hit)) {
      return { at, target: hit, covered: false };
    }
    if (force) {
      return { at, target: el, covered: true };
    }
    refuse(
      `Нажать не получилось: поверх ${describe(el)} лежит ${describe(hit)}. ` +
        "Возможно, открыто окно или баннер — закройте его. Если так и задумано, нажмите с force: true — событие уйдёт прямо элементу.",
    );
  };

  const modifiers = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };

  const mouse = (target, type, at, extra = {}) => {
    const view = viewOf(target);
    const pointer = type.startsWith("pointer");
    const Kind = pointer ? view.PointerEvent : view.MouseEvent;
    if (!Kind) {
      return true;
    }
    const passing = type.endsWith("enter") || type.endsWith("leave");
    const init = {
      bubbles: !passing,
      cancelable: !passing,
      composed: !passing,
      view,
      clientX: at.x,
      clientY: at.y,
      screenX: at.x + (view.screenX || 0),
      screenY: at.y + (view.screenY || 0),
      button: 0,
      buttons: 0,
      detail: 0,
      ...modifiers,
      ...extra,
    };
    if (pointer) {
      Object.assign(init, { pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1 });
    }
    return target.dispatchEvent(new Kind(type, init));
  };

  // Наведение: кто был под мышью — уходит, новый — входит, как у настоящей.
  const hover = (target, at) => {
    const before = state.hovered?.deref();
    if (before === target) {
      mouse(target, "pointermove", at);
      mouse(target, "mousemove", at);
      return;
    }
    if (before?.isConnected) {
      mouse(before, "pointerout", at, { relatedTarget: target });
      const left = ancestors(before).filter((node) => !inside(node, target));
      left.forEach((node) => mouse(node, "pointerleave", at, { relatedTarget: target }));
      mouse(before, "mouseout", at, { relatedTarget: target });
      left.forEach((node) => mouse(node, "mouseleave", at, { relatedTarget: target }));
    }
    const entered = ancestors(target)
      .filter((node) => !before?.isConnected || !inside(node, before))
      .reverse();
    mouse(target, "pointerover", at, { relatedTarget: before || null });
    entered.forEach((el) => mouse(el, "pointerenter", at, { relatedTarget: before || null }));
    mouse(target, "mouseover", at, { relatedTarget: before || null });
    entered.forEach((el) => mouse(el, "mouseenter", at, { relatedTarget: before || null }));
    mouse(target, "pointermove", at);
    mouse(target, "mousemove", at);
    state.hovered = hold(target);
  };

  const focusable = (el) =>
    !el.disabled &&
    (el.hasAttribute("tabindex") ||
      el.isContentEditable ||
      (NATIVE_FOCUS.has(el.localName) &&
        !(el.localName === "input" && el.type === "hidden") &&
        !((el.localName === "a" || el.localName === "area") && !el.hasAttribute("href"))));

  // Нажатие мыши переводит фокус — или снимает его, если нажали мимо.
  const focusAt = (target) => {
    const owner = ancestors(target).find(focusable);
    if (owner) {
      owner.focus({ preventScroll: true });
    } else {
      const active = deepActive();
      if (active && active !== document.body) {
        active.blur();
      }
    }
  };

  const common = (one, two) => {
    const chain = new Set(ancestors(one));
    return ancestors(two).find((at) => chain.has(at)) || one;
  };

  const clickAt = (target, at, { button = 0, count = 1 } = {}) => {
    const buttons = button === 2 ? 2 : 1;
    hover(target, at);
    let down = target;
    for (let n = 1; n <= count; n++) {
      down = target.isConnected ? target : hitAt(target.ownerDocument, at) || target;
      mouse(down, "pointerdown", at, { button, buttons });
      if (mouse(down, "mousedown", at, { button, buttons, detail: n }) && n === 1) {
        focusAt(down);
      }
      const upon = down.isConnected ? hitAt(down.ownerDocument, at) || down : down;
      mouse(upon, "pointerup", at, { button });
      mouse(upon, "mouseup", at, { button, detail: n });
      if (button === 0) {
        // Нажали в одном месте, отпустили в другом — click достаётся их
        // общему предку.
        mouse(down.isConnected ? common(down, upon) : upon, "click", at, { button, detail: n });
      }
    }
    if (button === 0 && count === 2) {
      mouse(down.isConnected ? down : target, "dblclick", at, { detail: 2 });
    }
    if (button === 2) {
      mouse(target, "contextmenu", at, { button: 2 });
    }
  };

  // --- Настоящая мышь ---------------------------------------------------------

  // Точка в рамке — точка в окне страницы: каждая рамка сдвигает её на своё
  // место.
  const toTop = (el, at) => {
    let { x, y } = at;
    let view = viewOf(el);
    while (view !== window) {
      const frame = view.frameElement;
      if (!frame) {
        return null;
      }
      const box = frame.getBoundingClientRect();
      const style = styleOf(frame);
      x += box.left + frame.clientLeft + (parseFloat(style.paddingLeft) || 0);
      y += box.top + frame.clientTop + (parseFloat(style.paddingTop) || 0);
      view = viewOf(frame);
    }
    return { x, y };
  };

  // То же, но `null`, если точка не в окне.
  const onPage = (el, at) => {
    const point = toTop(el, at);
    return point && point.x >= 0 && point.y >= 0 && point.x < innerWidth && point.y < innerHeight
      ? point
      : null;
  };

  // Где рамка с другого домена на кадре: внутрь неё агенту только смотреть и
  // нажимать по точке.
  const foreignPlace = (frame) => {
    const box = frame.getBoundingClientRect();
    const from = toTop(frame, { x: box.left, y: box.top });
    if (!from) {
      return "";
    }
    const scale = shotScale();
    const left = Math.max(0, from.x);
    const top = Math.max(0, from.y);
    const right = Math.min(innerWidth, from.x + box.width);
    const bottom = Math.min(innerHeight, from.y + box.height);
    if (right - left < 1 || bottom - top < 1) {
      return ", вне экрана — browser_scroll";
    }
    const span = (start, end) => `${Math.round(start * scale)}–${Math.round(end * scale)}`;
    return `, на кадре x ${span(left, right)}, y ${span(top, bottom)}`;
  };

  // Выпадающий список под настоящей мышью раскрылся бы системным меню — у
  // человека перед глазами, а на macOS ещё и остановил бы приложение, пока
  // меню не закроют. Такое нажимает скрипт.
  const opensMenu = (el) => {
    const list = el.closest?.("select");
    return !!list && !list.multiple && list.size <= 1;
  };

  // Дошла ли настоящая мышь, видно по событиям: у её событий isTrusted, и
  // приходят они в ту точку, куда целились.
  const PRESSES = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "auxclick", "dblclick", "contextmenu"];
  const FELT = ["pointermove", "mousemove", ...PRESSES];
  const FIRST_PRESS = new Set(["pointerdown", "mousedown", "contextmenu"]);

  const unfeel = () => {
    const watch = state.watch;
    if (!watch) {
      return;
    }
    state.watch = null;
    clearTimeout(watch.timer);
    for (const type of FELT) {
      watch.view.removeEventListener(type, watch.listener, true);
    }
  };

  // `aimed` — элемент, в который целились. Пока мышь шла к точке, страница
  // могла сдвинуться: от наведения закрылось меню, догрузилась картинка. Тогда
  // нажатие попало бы не туда, и странице его не отдаём: агенту скажут, и
  // прицелятся заново.
  const feel = (el, at, plan, aimed) => {
    unfeel();
    const view = viewOf(el);
    const watch = {
      view,
      el: hold(el),
      aimed: aimed ? hold(aimed) : null,
      hover: plan.kind === "move",
      felt: false,
      // Сколько раз кнопку отпустят: это последнее событие нажатия.
      presses: plan.kind === "click" ? plan.count : 0,
      released: 0,
      pressed: false,
      wrong: null,
      listener: null,
      timer: 0,
    };
    watch.listener = (event) => {
      if (!event.isTrusted || Math.abs(event.clientX - at.x) > 3 || Math.abs(event.clientY - at.y) > 3) {
        return;
      }
      watch.felt = true;
      if (event.type === "pointerup") {
        watch.released += 1;
      }
      // Контекстное меню системы встало бы посреди экрана человека и, как
      // список, остановило бы приложение. Страница своё меню всё равно
      // покажет: её обработчики событие получат.
      if (event.type === "contextmenu") {
        event.preventDefault();
      }
      const target = watch.aimed?.deref();
      if (!target || !PRESSES.includes(event.type)) {
        return;
      }
      if (!watch.pressed && !watch.wrong && FIRST_PRESS.has(event.type)) {
        const hit = event.composedPath?.()[0] || event.target;
        if (reaches(target, hit)) {
          watch.pressed = true;
        } else {
          watch.wrong = hold(isElement(hit) ? hit : hit?.parentElement || document.body);
        }
      }
      if (watch.wrong) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    for (const type of FELT) {
      view.addEventListener(type, watch.listener, true);
    }
    // Слушатели снимает следующий шаг, а этот срок — на случай, если до него
    // не дойдёт.
    watch.timer = setTimeout(unfeel, 30000);
    state.watch = watch;
  };

  // Нажмёт система: скрипт только говорит куда. `null` — нажимать скрипту:
  // настоящей мыши нет, точка не в окне или под ней раскрылся бы список.
  const planned = (target, at, plan, aimed = null) => {
    if (request.native !== true || opensMenu(target)) {
      return null;
    }
    const point = onPage(target, at);
    if (!point) {
      return null;
    }
    feel(target, at, plan, aimed);
    return { ...plan, x: point.x, y: point.y, width: innerWidth, height: innerHeight };
  };

  // Сколько пикселей кадра на пиксель страницы: WebView2 снимает в пикселях
  // устройства, и точку с его кадра надо привести к странице.
  const shotScale = () => (Number(request.shot) > 0 ? Number(request.shot) : 1);

  // Точка вместо элемента — для того, чего скрипту не найти: рамок с другого
  // домена, рисунков на canvas. Точка — в пикселях кадра browser_screenshot,
  // от левого верхнего угла. В рамках своего сайта ищется то, что под точкой
  // в них самих. `page` — та же точка в окне страницы: туда нажимает мышь.
  const spotAt = (point) => {
    const scale = shotScale();
    const x = Number(point.x) / scale;
    const y = Number(point.y) / scale;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
      refuse(
        `Точка (${point.x}, ${point.y}) вне окна страницы: на кадре оно ` +
          `${Math.round(innerWidth * scale)}×${Math.round(innerHeight * scale)}. ` +
          "x и y — пиксели кадра browser_screenshot от его левого верхнего угла.",
      );
    }
    const page = { x, y };
    let at = page;
    let hit = hitAt(document, at);
    if (!hit) {
      refuse(`В точке (${point.x}, ${point.y}) на странице ничего нет.`);
    }
    for (;;) {
      if (hit.localName !== "iframe" && hit.localName !== "frame") {
        return { at, page, target: hit, foreign: false };
      }
      const inner = frameDocument(hit);
      if (!inner) {
        return { at, page, target: hit, foreign: true };
      }
      const box = hit.getBoundingClientRect();
      const style = styleOf(hit);
      const within = {
        x: at.x - box.left - hit.clientLeft - (parseFloat(style.paddingLeft) || 0),
        y: at.y - box.top - hit.clientTop - (parseFloat(style.paddingTop) || 0),
      };
      const next = hitAt(inner, within);
      if (!next) {
        return { at, page, target: hit, foreign: false };
      }
      at = within;
      hit = next;
    }
  };

  const FOREIGN_BY_SCRIPT =
    "В рамку с другого домена попадает только настоящая мышь, а она до страницы не дошла: событиям скрипта туда хода нет.";

  // Что в точке — словами для ответа.
  const spotName = (spot) =>
    spot.foreign
      ? `рамка с другого домена ${describe(spot.target)} — что в ней, скрипту страницы не видно, смотрите browser_screenshot`
      : describe(spot.target);

  const isFileField = (el) =>
    (el.localName === "input" && el.type === "file") ||
    (el.localName === "label" && el.control?.localName === "input" && el.control.type === "file");

  // Кнопка отправки: что браузер скажет о полях формы, прежде чем отправить.
  const invalidFields = (form, submitter) => {
    if (!form || form.noValidate || submitter?.formNoValidate) {
      return [];
    }
    return [...form.elements].filter((field) => field.willValidate && !field.validity.valid);
  };

  const submitterOf = (el) => {
    const button = ancestors(el).find(
      (at) =>
        (at.localName === "button" && at.type === "submit") ||
        (at.localName === "input" && (at.type === "submit" || at.type === "image")),
    );
    return button?.form ? button : null;
  };

  const validityNote = (form, submitter) => {
    const bad = invalidFields(form, submitter);
    if (bad.length === 0) {
      return null;
    }
    const shown = bad
      .slice(0, 5)
      .map((field) => `${describe(field)} — ${field.validationMessage || "неверное значение"}`)
      .join("; ");
    return `Браузер не пропустит форму: ${shown}.`;
  };

  const clickSpot = () => {
    const spot = spotAt(request.at);
    const button = request.right ? 2 : 0;
    const count = request.double ? 2 : 1;
    guard();
    flash(spot.target);
    let input = null;
    if (spot.foreign) {
      if (request.native !== true) {
        refuse(FOREIGN_BY_SCRIPT);
      }
      if (button === 2) {
        refuse("Правой кнопкой в рамку с другого домена не нажать: её системное меню нечем закрыть.");
      }
      input = { kind: "click", button: "left", count, ...spot.page, width: innerWidth, height: innerHeight };
    } else {
      input = planned(spot.target, spot.at, { kind: "click", button: button === 2 ? "right" : "left", count });
      if (!input) {
        if (opensMenu(spot.target)) {
          const list = spot.target.closest("select");
          refuse(`В точке — выпадающий список ${describe(list)}. Выберите пункт через browser_select с ref ${refOf(list)}.`);
        }
        clickAt(spot.target, spot.at, { button, count });
      }
    }
    const how = request.right ? "правой кнопкой " : request.double ? "дважды " : "";
    return {
      text: `Нажали ${how}в точке (${request.at.x}, ${request.at.y}): там ${spotName(spot)}.`,
      ref: spot.foreign ? null : refOf(spot.target),
      ...(input && { input }),
    };
  };

  const click = () => {
    if (request.at) {
      return clickSpot();
    }
    const el = locate(request.target);
    if (!el) {
      refuse("Не сказано, на что нажать: нужен ref из browser_read, selector или text.");
    }
    if (el.localName === "select" || el.localName === "option") {
      const list = el.localName === "option" ? el.closest("select") || el : el;
      refuse(`${describe(list)} — выпадающий список. Выберите пункт через browser_select с ref ${refOf(list)}.`);
    }
    if (isFileField(el)) {
      const field = el.localName === "label" ? el.control : el;
      refuse(
        `${describe(field)} — выбор файла: системное окно выбора агенту не открыть. ` +
          `Передайте файлы через browser_upload с ref ${refOf(field)}.`,
      );
    }
    const disabled = el.disabled || el.matches?.(":disabled");
    if (disabled && !request.force) {
      refuse(
        `${describe(el)} отключён — нажатие ничего не сделает. ` +
          "Сначала сделайте то, что его включает: например, заполните обязательные поля.",
      );
    }
    guard();
    const { at, target, covered } = aim(el, request.force === true);
    flash(el);
    const submitter = request.right ? null : submitterOf(target);
    const blocked = submitter ? validityNote(submitter.form, submitter) : null;
    const button = request.right ? 2 : 0;
    const count = request.double ? 2 : 1;
    // Закрытое другим или отключённое настоящая мышь не нажмёт — с force
    // событие уходит элементу прямо.
    const input =
      covered || disabled
        ? null
        : planned(target, at, { kind: "click", button: request.right ? "right" : "left", count }, el);
    if (!input) {
      clickAt(target, at, { button, count });
    }
    const how = request.right ? "правой кнопкой " : request.double ? "дважды " : "";
    if (el.getAttribute("aria-disabled") === "true") {
      notes.push("Элемент помечен как отключённый (aria-disabled): страница могла нажатие проигнорировать.");
    }
    if (blocked) {
      notes.push(blocked);
    }
    return { text: `Нажали ${how}${describe(el)}.`, ref: refOf(el), ...(input && { input }) };
  };

  const hoverOver = () => {
    if (request.at) {
      const spot = spotAt(request.at);
      guard();
      flash(spot.target);
      let input = null;
      if (spot.foreign) {
        if (request.native !== true) {
          refuse(FOREIGN_BY_SCRIPT);
        }
        input = { kind: "move", ...spot.page, width: innerWidth, height: innerHeight };
      } else {
        input = planned(spot.target, spot.at, { kind: "move" });
        if (!input) {
          hover(spot.target, spot.at);
        }
      }
      return {
        text: `Навели мышь на точку (${request.at.x}, ${request.at.y}): там ${spotName(spot)}.`,
        ref: spot.foreign ? null : refOf(spot.target),
        ...(input && { input }),
      };
    }
    const el = locate(request.target);
    if (!el) {
      refuse("Не сказано, на что навести: нужен ref из browser_read, selector или text.");
    }
    guard();
    const { at, target, covered } = aim(el, request.force === true);
    flash(el);
    const input = covered ? null : planned(target, at, { kind: "move" });
    if (!input) {
      hover(target, at);
    }
    return { text: `Навели мышь на ${describe(el)}.`, ref: refOf(el), ...(input && { input }) };
  };

  // --- Ввод ------------------------------------------------------------------

  const fieldOf = (el) => {
    if (editable(el)) {
      return el;
    }
    if (el.localName === "label" && el.control && editable(el.control)) {
      return el.control;
    }
    if (el.localName === "input" && (el.type === "checkbox" || el.type === "radio" || el.type === "file")) {
      return el;
    }
    const inner = [...el.querySelectorAll("input, textarea, [contenteditable]")].filter(
      (field) => editable(field) && visible(field),
    );
    return inner.length === 1 ? inner[0] : null;
  };

  const nativeSetter = (el) => {
    const view = viewOf(el);
    const proto =
      el.localName === "textarea"
        ? view.HTMLTextAreaElement.prototype
        : el.localName === "select"
          ? view.HTMLSelectElement.prototype
          : view.HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, "value")?.set;
  };

  const announce = (el, type, data) => {
    const view = viewOf(el);
    const event =
      type === "input" && typeof view.InputEvent === "function"
        ? new view.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data })
        : new view.Event(type, { bubbles: true, composed: type === "input" });
    el.dispatchEvent(event);
  };

  // Значение — мимо редактора: тем же сеттером, что и браузер, чтобы
  // фреймворк, подменивший value у поля, увидел перемену.
  const setValue = (el, value, data) => {
    const setter = nativeSetter(el);
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    announce(el, "input", data ?? value);
  };

  const selectAll = (el) => {
    if (el.isContentEditable) {
      const doc = el.ownerDocument;
      const range = doc.createRange();
      range.selectNodeContents(el);
      const selection = viewOf(el).getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    try {
      el.select();
    } catch {
      // У поля нет выделения — значение заменится целиком.
    }
  };

  const caretToEnd = (el) => {
    if (el.isContentEditable) {
      const doc = el.ownerDocument;
      const range = doc.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = viewOf(el).getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    try {
      el.setSelectionRange(el.value.length, el.value.length);
      return true;
    } catch {
      return false;
    }
  };

  const valueNow = (el) => (el.isContentEditable ? el.textContent : el.value);

  // Вставить текст туда, где курсор. Через редактор браузера — так поле
  // получает те же beforeinput и input, что и от клавиатуры; не вышло —
  // сеттером.
  const insert = (el, text, expected) => {
    let heard = false;
    const listen = () => {
      heard = true;
    };
    // Редактор пишет туда, где выделение. Не в поле — значит, мимо него.
    const focused = el.isContentEditable
      ? inside(el, viewOf(el).getSelection()?.anchorNode)
      : deepActive() === el;
    el.addEventListener("input", listen, true);
    let done = false;
    try {
      done = focused && el.ownerDocument.execCommand(text ? "insertText" : "delete", false, text);
    } catch {
      done = false;
    }
    el.removeEventListener("input", listen, true);
    if (done && heard) {
      return;
    }
    if (el.isContentEditable) {
      el.textContent = expected;
      announce(el, "input", text);
    } else {
      setValue(el, expected, text);
    }
  };

  const FORMATS = {
    date: "2024-05-31",
    time: "13:45",
    "datetime-local": "2024-05-31T13:45",
    month: "2024-05",
    week: "2024-W22",
    color: "#ff8800",
    range: "число в пределах поля",
    number: "число",
  };

  const typeInto = () => {
    const text = String(request.text ?? "");
    let el = locate(request.target, { accept: fieldOf, what: "поле ввода" });
    if (!el) {
      const frame = foreignFocus();
      if (frame) {
        return typeIntoFrame(frame, text);
      }
      const active = deepActive();
      el = active && fieldOf(active);
      if (!el) {
        refuse("Не сказано, куда вводить: нужен ref поля из browser_read, selector или field — подпись поля.");
      }
    }
    if (el.localName === "input" && (el.type === "checkbox" || el.type === "radio")) {
      refuse(`${describe(el)} — флажок, в него не печатают. Переключите его через browser_click.`);
    }
    if (el.localName === "input" && el.type === "file") {
      refuse(`${describe(el)} — выбор файла. Передайте файлы через browser_upload с ref ${refOf(el)}.`);
    }
    if (el.disabled || el.matches?.(":disabled")) {
      refuse(`${describe(el)} отключено — ввести в него нельзя.`);
    }
    if (el.readOnly) {
      refuse(`${describe(el)} только для чтения — ввести в него нельзя.`);
    }
    guard();
    if (!fullyInView(el)) {
      bring(el);
    }
    flash(el);
    if (deepActive() !== el) {
      el.focus({ preventScroll: true });
    }
    const tag = el.localName;
    const special = tag === "input" && (PICKER_TYPES.has(el.type) || el.type === "range");
    if (special) {
      // Дата, время, цвет, ползунок: печатать в них нечего, значение ставится
      // целиком — и только в своём формате.
      setValue(el, text);
      announce(el, "change");
      if (el.value !== text && text) {
        refuse(
          `${describe(el)} не приняло «${text}»: поле type=${el.type} ждёт значение вида ${FORMATS[el.type] || "в своём формате"}.`,
        );
      }
      return { text: `Поставили значение ${describe(el)}.`, ref: refOf(el) };
    }
    const before = valueNow(el);
    let start = before;
    if (request.append) {
      if (!caretToEnd(el)) {
        setValue(el, before + text, text);
        announce(el, "change");
        return { text: `Дописали в ${describe(el)}.`, ref: refOf(el) };
      }
    } else {
      selectAll(el);
      start = "";
    }
    if (request.slowly && text) {
      // По клавише: для подсказок, которые слушают keydown и keyup.
      let typed = start;
      for (const char of text) {
        typed += char;
        const info = keyInfo(char);
        const target = deepActive() || el;
        if (key(target, "keydown", info) && key(target, "keypress", { ...info, char: char.codePointAt(0) })) {
          insert(el, char, typed);
        }
        key(target, "keyup", info);
      }
    } else if (text || before) {
      insert(el, text, start + text);
    }
    if (!el.isContentEditable) {
      announce(el, "change");
    }
    const after = valueNow(el);
    if (el.maxLength > 0 && (start + text).length > el.maxLength) {
      notes.push(`Поле берёт не больше ${el.maxLength} знаков — лишнее обрезано.`);
    } else if (text && !after.includes(text) && el.type !== "password") {
      notes.push(
        el.type === "number" || el.type === "email"
          ? `Поле type=${el.type} не приняло «${cut(text, 60)}» как есть — проверьте значение.`
          : "Страница переделала введённое по-своему — проверьте значение.",
      );
    }
    let what = `Ввели в ${describe(el)}.`;
    if (request.submit) {
      const effect = pressKey("Enter", el);
      what += ` Нажали Enter${effect ? `: ${effect}` : ""}.`;
    }
    return { text: what, ref: refOf(el) };
  };

  // --- Списки ----------------------------------------------------------------

  const selectOf = (el) => {
    if (el.localName === "select") {
      return el;
    }
    if (el.localName === "label" && el.control?.localName === "select") {
      return el.control;
    }
    if (el.localName === "option") {
      return el.closest("select");
    }
    const inner = el.querySelectorAll?.("select") || [];
    return inner.length === 1 ? inner[0] : null;
  };

  const pick = (select, wanted) => {
    const options = [...select.options];
    const want = squash(wanted);
    const lower = want.toLowerCase();
    const tries = [
      (option) => optionLabel(option) === want,
      (option) => optionLabel(option).toLowerCase() === lower,
      (option) => option.value === wanted,
      (option) => optionLabel(option).toLowerCase().includes(lower),
    ];
    for (const test of tries) {
      const hits = options.filter(test);
      if (hits.length === 1) {
        return hits[0];
      }
      if (hits.length > 1) {
        refuse(
          `В ${describe(select)} под «${want}» подходят пункты: ${hits
            .slice(0, 10)
            .map((option) => `«${optionLabel(option)}»`)
            .join(", ")}. Напишите пункт целиком.`,
        );
      }
    }
    const shown = options
      .slice(0, 30)
      .map((option) => `«${optionLabel(option)}»`)
      .join(", ");
    refuse(`В ${describe(select)} нет пункта «${want}». Есть: ${shown}${options.length > 30 ? " …" : ""}.`);
  };

  const choose = () => {
    const el = locate(request.target, {
      accept: (found) => selectOf(found) || (customList(found) ? found : null),
      what: "список <select>",
    });
    if (!el) {
      refuse("Не сказано, в каком списке выбирать: нужен ref из browser_read, selector или field — подпись списка.");
    }
    if (el.localName !== "select") {
      refuse(
        `${describe(el)} — список, нарисованный страницей, а не <select>. ` +
          "Откройте его через browser_click и нажмите нужный пункт.",
      );
    }
    const wanted = (Array.isArray(request.options) ? request.options : [request.options]).filter(
      (option) => option !== undefined && option !== null,
    );
    if (wanted.length === 0) {
      refuse("Не сказано, что выбрать: option — пункт списка.");
    }
    if (el.disabled || el.matches?.(":disabled")) {
      refuse(`${describe(el)} отключён — выбрать в нём нельзя.`);
    }
    if (wanted.length > 1 && !el.multiple) {
      refuse(`${describe(el)} берёт один пункт, а не ${wanted.length}.`);
    }
    const chosen = wanted.map((option) => pick(el, String(option)));
    const off = chosen.find((option) => option.disabled);
    if (off) {
      refuse(`Пункт «${optionLabel(off)}» в ${describe(el)} отключён.`);
    }
    guard();
    if (!fullyInView(el)) {
      bring(el);
    }
    flash(el);
    el.focus({ preventScroll: true });
    if (el.multiple) {
      for (const option of el.options) {
        option.selected = chosen.includes(option);
      }
    } else {
      el.selectedIndex = chosen[0].index;
    }
    announce(el, "input");
    announce(el, "change");
    return { text: `Выбрали в ${describe(el)}.`, ref: refOf(el) };
  };

  // Нарисованный страницей список — не <select>: его открывают нажатием.
  const customList = (el) =>
    ["combobox", "listbox", "option"].includes(squash(el.getAttribute?.("role"))) ||
    el.getAttribute?.("aria-haspopup") === "listbox";

  // --- Клавиатура ------------------------------------------------------------

  const MODIFIER_KEYS = { Shift: "shiftKey", Control: "ctrlKey", Alt: "altKey", Meta: "metaKey" };
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const ALIASES = {
    ctrl: "Control",
    control: "Control",
    cmd: "Meta",
    command: "Meta",
    meta: "Meta",
    win: "Meta",
    super: "Meta",
    option: "Alt",
    opt: "Alt",
    alt: "Alt",
    shift: "Shift",
    controlormeta: mac ? "Meta" : "Control",
    esc: "Escape",
    escape: "Escape",
    return: "Enter",
    enter: "Enter",
    del: "Delete",
    delete: "Delete",
    backspace: "Backspace",
    space: " ",
    spacebar: " ",
    tab: "Tab",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    pageup: "PageUp",
    pgup: "PageUp",
    pagedown: "PageDown",
    pgdn: "PageDown",
    home: "Home",
    end: "End",
    insert: "Insert",
    plus: "+",
    minus: "-",
  };
  const NAMED = {
    Enter: ["Enter", 13],
    Tab: ["Tab", 9],
    Escape: ["Escape", 27],
    Backspace: ["Backspace", 8],
    Delete: ["Delete", 46],
    " ": ["Space", 32],
    ArrowLeft: ["ArrowLeft", 37],
    ArrowUp: ["ArrowUp", 38],
    ArrowRight: ["ArrowRight", 39],
    ArrowDown: ["ArrowDown", 40],
    Home: ["Home", 36],
    End: ["End", 35],
    PageUp: ["PageUp", 33],
    PageDown: ["PageDown", 34],
    Insert: ["Insert", 45],
    Shift: ["ShiftLeft", 16],
    Control: ["ControlLeft", 17],
    Alt: ["AltLeft", 18],
    Meta: ["MetaLeft", 91],
  };
  const PUNCTUATION = {
    "-": ["Minus", 189],
    "=": ["Equal", 187],
    "[": ["BracketLeft", 219],
    "]": ["BracketRight", 221],
    "\\": ["Backslash", 220],
    ";": ["Semicolon", 186],
    "'": ["Quote", 222],
    ",": ["Comma", 188],
    ".": ["Period", 190],
    "/": ["Slash", 191],
    "`": ["Backquote", 192],
  };

  const keyInfo = (name, shift) => {
    if (NAMED[name]) {
      const [code, keyCode] = NAMED[name];
      return { key: name, code, keyCode };
    }
    const fn = /^F([1-9]|1[0-2])$/.exec(name);
    if (fn) {
      return { key: name, code: name, keyCode: 111 + Number(fn[1]) };
    }
    if (/^[a-z]$/i.test(name)) {
      const upper = name.toUpperCase();
      return { key: shift ? upper : name, code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
    }
    if (/^[0-9]$/.test(name)) {
      return { key: name, code: `Digit${name}`, keyCode: 48 + Number(name) };
    }
    if (PUNCTUATION[name]) {
      const [code, keyCode] = PUNCTUATION[name];
      return { key: name, code, keyCode };
    }
    return { key: name, code: "", keyCode: 0 };
  };

  const parseKeys = (spec) => {
    const text = String(spec ?? "");
    if (!text) {
      refuse("Не сказано, какую клавишу нажать: key — например Enter, Tab, Escape, Control+A.");
    }
    let names;
    if (text === "+" || text.endsWith("++")) {
      names = [...text.slice(0, -1).split("+").filter(Boolean), "+"];
    } else {
      names = text.split("+");
    }
    const resolved = names.map((name) => {
      if ([...name].length === 1) {
        return name;
      }
      const alias = ALIASES[name.toLowerCase()];
      if (alias) {
        return alias;
      }
      const named = Object.keys(NAMED).find((known) => known.toLowerCase() === name.toLowerCase());
      if (named) {
        return named;
      }
      if (/^f([1-9]|1[0-2])$/i.test(name)) {
        return name.toUpperCase();
      }
      refuse(`Клавишу «${name}» не знаю. Примеры: Enter, Tab, Shift+Tab, Escape, ArrowDown, Backspace, Control+A.`);
    });
    const main = resolved.pop();
    if (resolved.some((name) => !MODIFIER_KEYS[name])) {
      refuse(`В «${text}» перед последней клавишей могут стоять только Shift, Control, Alt и Meta.`);
    }
    return { mods: resolved, main };
  };

  // --- Клавиатура в рамке с другого домена -----------------------------------

  // Рамка с другого домена, в которой фокус, — или `null`. Что в ней в фокусе,
  // скрипту не видно, и ввести туда может только система.
  const foreignFocus = () => {
    const el = deepActive();
    return el && (el.localName === "iframe" || el.localName === "frame") && !frameDocument(el) ? el : null;
  };

  const isForeignFrame = (el) => (el.localName === "iframe" || el.localName === "frame") && !frameDocument(el);

  // Клавиша для системы: как её назовёт событие и что зажато вместе с ней.
  const strokeOf = (spec) => {
    const { mods, main } = parseKeys(spec);
    if (MODIFIER_KEYS[main]) {
      refuse(`${main} в рамку с другого домена нажимают только вместе с другой клавишей — например Shift+Tab.`);
    }
    const info = keyInfo(main, mods.includes("Shift"));
    return {
      key: info.key,
      code: info.code,
      keyCode: info.keyCode,
      shift: mods.includes("Shift"),
      control: mods.includes("Control"),
      alt: mods.includes("Alt"),
      meta: mods.includes("Meta"),
    };
  };

  // Ввод в рамку несёт система — туда, что в ней в фокусе. Дошёл ли он,
  // скрипту не узнать: события рамки до страницы не долетают.
  const keysInto = (frame, text, steps) => {
    if (request.native !== true) {
      refuse(
        `Фокус — в рамке ${describe(frame)} с другого домена. Туда печатает только настоящая клавиатура, ` +
          "а она до страницы не дошла: событиям скрипта в рамку хода нет.",
      );
    }
    // Слежка за мышью от прошлого действия сказала бы, что ввод не дошёл, —
    // а клавиатуру ей не видно вовсе.
    unfeel();
    guard();
    flash(frame);
    notes.push("Что в рамке теперь, скрипту страницы не видно — проверьте через browser_screenshot.");
    return { text, ref: refOf(frame), input: { kind: "keys", steps } };
  };

  // Поле — в рамке с другого домена, куда нажали по точке. Как и в обычном
  // поле: прежнее выделяется и заменяется, если не сказано дописать.
  const typeIntoFrame = (frame, text) => {
    const steps = request.append ? [] : [{ select: "all" }];
    if (request.slowly) {
      steps.push(...[...text].map((char) => ({ text: char })));
    } else if (text) {
      steps.push({ text });
    }
    if (!text && !request.append) {
      steps.push(strokeOf("Backspace"));
    }
    if (request.submit) {
      steps.push(strokeOf("Enter"));
    }
    let what = `Ввели в то, что в фокусе в рамке ${describe(frame)} с другого домена.`;
    if (request.submit) {
      what += " Нажали Enter.";
    }
    return keysInto(frame, what, steps);
  };

  const key = (target, type, info) => {
    const view = viewOf(target);
    const legacy = type === "keypress" ? info.char || 0 : info.keyCode;
    const init = {
      key: info.key,
      code: info.code,
      keyCode: legacy,
      which: legacy,
      charCode: type === "keypress" ? info.char || 0 : 0,
      location: 0,
      repeat: false,
      bubbles: true,
      cancelable: true,
      composed: true,
      view,
      ...modifiers,
    };
    const event = new view.KeyboardEvent(type, init);
    // Старые свойства WebKit из словаря не берёт, а страницы их ещё читают.
    for (const [name, value] of [
      ["keyCode", legacy],
      ["which", legacy],
      ["charCode", init.charCode],
    ]) {
      if (event[name] !== value) {
        try {
          Object.defineProperty(event, name, { get: () => value });
        } catch {
          // Не переписать — пусть будет как есть.
        }
      }
    }
    return target.dispatchEvent(event);
  };

  const typeable = (el) =>
    el?.localName === "textarea" || !!el?.isContentEditable || (el?.localName === "input" && TYPED_TYPES.has(el.type));

  const isTextLine = (el) =>
    el?.localName === "input" && (TYPED_TYPES.has(el.type) || el.type === "date" || el.type === "time");

  const blocksImplicit = (el) =>
    el.localName === "input" &&
    (TYPED_TYPES.has(el.type) || ["date", "time", "datetime-local", "month", "week"].includes(el.type));

  const submitForm = (form) => {
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return;
    }
    const view = viewOf(form);
    if (form.dispatchEvent(new view.Event("submit", { bubbles: true, cancelable: true }))) {
      form.submit();
    }
  };

  // Enter в поле формы отправляет её — кнопкой по умолчанию, а если кнопки
  // нет и поле в форме одно — самой формой.
  const enter = (el) => {
    if (el.localName === "textarea" || el.isContentEditable) {
      const doc = el.ownerDocument;
      let done = false;
      try {
        done = doc.execCommand(el.isContentEditable ? "insertParagraph" : "insertLineBreak");
      } catch {
        done = false;
      }
      if (!done) {
        insert(el, "\n", valueNow(el) + "\n");
      }
      return "перевели строку";
    }
    if (isTextLine(el)) {
      const form = el.form;
      if (!form) {
        return "";
      }
      const submitter = [...form.elements].find(
        (field) =>
          (field.localName === "button" && field.type === "submit") ||
          (field.localName === "input" && (field.type === "submit" || field.type === "image")),
      );
      const blocked = validityNote(form, submitter);
      if (submitter) {
        if (submitter.disabled) {
          return `форму не отправили: кнопка отправки ${describe(submitter)} отключена`;
        }
        submitter.click();
        return blocked || `форму отправили кнопкой ${describe(submitter)}`;
      }
      if ([...form.elements].filter(blocksImplicit).length === 1) {
        submitForm(form);
        return blocked || "форму отправили";
      }
      return "";
    }
    if (
      el.localName === "button" ||
      el.localName === "summary" ||
      (el.localName === "input" && BUTTON_TYPES.has(el.type)) ||
      ((el.localName === "a" || el.localName === "area") && el.hasAttribute("href"))
    ) {
      el.click();
      return `нажали ${describe(el)}`;
    }
    return "";
  };

  const scrollerOf = (el, axis) => {
    for (let at = el; isElement(at); at = up(at)) {
      if (at === at.ownerDocument.body || at === at.ownerDocument.documentElement) {
        break;
      }
      const style = styleOf(at);
      const overflow = axis === "y" ? style.overflowY : style.overflowX;
      const room = axis === "y" ? at.scrollHeight - at.clientHeight : at.scrollWidth - at.clientWidth;
      if (/(auto|scroll|overlay)/.test(overflow) && room > 1) {
        return at;
      }
    }
    return null;
  };

  const pageScrolls = (axis) => {
    const page = document.scrollingElement || document.documentElement;
    const room = axis === "y" ? page.scrollHeight - window.innerHeight : page.scrollWidth - window.innerWidth;
    if (room <= 1) {
      return false;
    }
    // Прокрутку окна запирают на html, а если там пусто — на body.
    const overflow = (el) => (el ? (axis === "y" ? styleOf(el).overflowY : styleOf(el).overflowX) : "visible");
    const html = overflow(document.documentElement);
    const viewport = html !== "visible" ? html : overflow(document.body);
    return viewport !== "hidden" && viewport !== "clip";
  };

  const instantly = (el, how) => {
    try {
      el.scrollBy({ ...how, behavior: "instant" });
    } catch {
      el.scrollBy(how.left || 0, how.top || 0);
    }
  };

  const scrollAround = (el, top, left) => {
    const box = scrollerOf(el, top ? "y" : "x");
    instantly(box || document.scrollingElement || document.documentElement, { top, left });
  };

  const tabbables = () => {
    const found = [];
    everything(document, (el) => {
      if (focusable(el) && el.tabIndex >= 0 && visible(el) && !hiddenByAria(el)) {
        found.push(el);
      }
    });
    const ordered = found.filter((el) => el.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
    return [...ordered, ...found.filter((el) => el.tabIndex === 0)];
  };

  const radioStep = (el, step) => {
    const scope = el.form || el.ownerDocument;
    const group = [...scope.querySelectorAll("input[type=radio]")].filter(
      (radio) => radio.name === el.name && !radio.disabled,
    );
    const next = group[(group.indexOf(el) + step + group.length) % group.length];
    if (next && next !== el) {
      next.focus({ preventScroll: true });
      next.click();
      return `выбрали ${describe(next)}`;
    }
    return "";
  };

  // Что браузер делает сам, если страница не отменила keydown.
  const keyDefault = (el, main, held) => {
    const shift = held.includes("Shift");
    const command = held.includes("Control") || held.includes("Meta");
    const doc = el.ownerDocument;
    const field = editable(el) && !(el.localName === "input" && ["range", "checkbox", "radio"].includes(el.type));
    if (command && main.toLowerCase() === "a") {
      if (field) {
        selectAll(el);
      } else {
        doc.execCommand("selectAll");
      }
      return "выделили всё";
    }
    if (command && main.toLowerCase() === "z") {
      doc.execCommand(shift ? "redo" : "undo");
      return shift ? "вернули отменённое" : "отменили последнюю правку";
    }
    if (command && main.toLowerCase() === "y") {
      doc.execCommand("redo");
      return "вернули отменённое";
    }
    if (held.some((name) => name !== "Shift")) {
      return "";
    }
    switch (main) {
      case "Enter":
        return enter(el);
      case "Tab": {
        const order = tabbables();
        if (order.length === 0) {
          return "";
        }
        const at = order.indexOf(el);
        const next =
          at < 0 ? order[shift ? order.length - 1 : 0] : order[(at + (shift ? -1 : 1) + order.length) % order.length];
        next.focus({ preventScroll: false });
        if (isTextLine(next)) {
          try {
            next.select();
          } catch {
            // Поле без выделения.
          }
        }
        return `фокус на ${describe(next)}`;
      }
      case "Escape": {
        const dialog = ancestors(el).find((at) => at.localName === "dialog" && at.open) ||
          [...doc.querySelectorAll("dialog[open]")].find(modalOf);
        if (dialog) {
          const view = viewOf(dialog);
          if (dialog.dispatchEvent(new view.Event("cancel", { cancelable: true }))) {
            dialog.close();
            return `закрыли ${describe(dialog)}`;
          }
          return "";
        }
        let closed = "";
        try {
          for (const popover of doc.querySelectorAll(":popover-open")) {
            if (popover.popover === "auto") {
              popover.hidePopover();
              closed = "закрыли всплывающее окно";
            }
          }
        } catch {
          // Всплывающих окон движок не знает.
        }
        return closed;
      }
      case "Backspace":
      case "Delete":
        if (field) {
          const before = valueNow(el);
          let done = false;
          try {
            done = doc.execCommand(main === "Backspace" ? "delete" : "forwardDelete");
          } catch {
            done = false;
          }
          if (!done && !el.isContentEditable && before) {
            const start = el.selectionStart ?? before.length;
            const end = el.selectionEnd ?? before.length;
            const from = start !== end ? start : main === "Backspace" ? Math.max(0, start - 1) : start;
            const to = start !== end ? end : main === "Backspace" ? start : Math.min(before.length, start + 1);
            setValue(el, before.slice(0, from) + before.slice(to));
          }
          return "";
        }
        return "";
      case " ": {
        const activates =
          el.localName === "button" ||
          el.localName === "summary" ||
          (el.localName === "input" && (BUTTON_TYPES.has(el.type) || el.type === "checkbox" || el.type === "radio"));
        if (activates) {
          el.click();
          return `нажали ${describe(el)}`;
        }
        if (!field) {
          scrollAround(el, (shift ? -1 : 1) * window.innerHeight * 0.85, 0);
          return "прокрутили страницу";
        }
        return "";
      }
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight": {
        const forward = main === "ArrowDown" || main === "ArrowRight";
        if (el.localName === "select" && !el.multiple) {
          const options = [...el.options];
          let index = el.selectedIndex;
          do {
            index += forward ? 1 : -1;
          } while (options[index]?.disabled);
          if (options[index]) {
            el.selectedIndex = index;
            announce(el, "input");
            announce(el, "change");
            return `выбрали «${optionLabel(options[index])}»`;
          }
          return "";
        }
        if (el.localName === "input" && el.type === "range") {
          try {
            if (forward) {
              el.stepUp();
            } else {
              el.stepDown();
            }
          } catch {
            return "";
          }
          announce(el, "input");
          announce(el, "change");
          return `значение ${el.value}`;
        }
        if (el.localName === "input" && el.type === "radio") {
          return radioStep(el, forward ? 1 : -1);
        }
        if (field) {
          if (el.isContentEditable) {
            const selection = viewOf(el).getSelection();
            const vertical = main === "ArrowUp" || main === "ArrowDown";
            selection.modify?.(shift ? "extend" : "move", forward ? "forward" : "backward", vertical ? "line" : "character");
          } else {
            try {
              const length = el.value.length;
              const at = forward ? el.selectionEnd : el.selectionStart;
              const to =
                main === "ArrowUp" && el.localName !== "textarea" ? 0
                  : main === "ArrowDown" && el.localName !== "textarea" ? length
                    : Math.min(length, Math.max(0, at + (forward ? 1 : -1)));
              el.setSelectionRange(to, to);
            } catch {
              // Поле без курсора.
            }
          }
          return "";
        }
        const step = 40 * (forward ? 1 : -1);
        const vertical = main === "ArrowUp" || main === "ArrowDown";
        scrollAround(el, vertical ? step : 0, vertical ? 0 : step);
        return "прокрутили";
      }
      case "PageUp":
      case "PageDown":
        if (!field || el.localName === "textarea" || el.isContentEditable) {
          scrollAround(el, (main === "PageDown" ? 1 : -1) * window.innerHeight * 0.85, 0);
          return "прокрутили";
        }
        return "";
      case "Home":
      case "End":
        if (field && !el.isContentEditable) {
          try {
            const to = main === "Home" ? 0 : el.value.length;
            el.setSelectionRange(to, to);
          } catch {
            // Поле без курсора.
          }
          return "";
        }
        if (!field) {
          const box = scrollerOf(el, "y") || document.scrollingElement || document.documentElement;
          try {
            box.scrollTo({ top: main === "Home" ? 0 : box.scrollHeight, behavior: "instant" });
          } catch {
            box.scrollTo(0, main === "Home" ? 0 : box.scrollHeight);
          }
          return main === "Home" ? "прокрутили в начало" : "прокрутили в конец";
        }
        return "";
      default:
        return "";
    }
  };

  // Нажать клавишу: модификаторы вниз, клавиша, всё вверх — и то, что браузер
  // делает сам, если страница не отменила.
  const pressKey = (spec, el) => {
    const { mods, main } = parseKeys(spec);
    const target = el || deepActive() || document.body;
    const held = [];
    for (const name of mods) {
      modifiers[MODIFIER_KEYS[name]] = true;
      held.push(name);
      key(target, "keydown", keyInfo(name));
    }
    const info = keyInfo(main, modifiers.shiftKey);
    let effect = "";
    if (key(target, "keydown", info)) {
      const printable = [...info.key].length === 1 && !modifiers.ctrlKey && !modifiers.metaKey && !modifiers.altKey;
      if (printable || info.key === "Enter") {
        const char = info.key === "Enter" ? 13 : info.key.codePointAt(0);
        if (key(target, "keypress", { ...info, char })) {
          if (printable && typeable(target)) {
            insert(target, info.key, valueNow(target) + info.key);
          } else {
            effect = keyDefault(target, info.key, held);
          }
        }
      } else {
        effect = keyDefault(target, info.key, held);
      }
    }
    key(target, "keyup", info);
    for (const name of held.reverse()) {
      modifiers[MODIFIER_KEYS[name]] = false;
      key(target, "keyup", keyInfo(name));
    }
    return effect;
  };

  const pressOn = () => {
    const el = locate(request.target);
    if (el && isForeignFrame(el) && deepActive() !== el) {
      el.focus({ preventScroll: true });
    }
    const frame = el ? (isForeignFrame(el) ? el : null) : foreignFocus();
    if (frame) {
      return keysInto(
        frame,
        `Нажали ${request.key} в рамке ${describe(frame)} с другого домена — на том, что в ней в фокусе.`,
        [strokeOf(request.key)],
      );
    }
    guard();
    if (el) {
      if (!fullyInView(el)) {
        bring(el);
      }
      flash(el);
      if (deepActive() !== el && focusable(el)) {
        el.focus({ preventScroll: true });
      }
    }
    const target = el || deepActive() || document.body;
    const effect = pressKey(request.key, target);
    const where = target === document.body ? "на странице" : `на ${describe(target)}`;
    return { text: `Нажали ${request.key} ${where}${effect ? `: ${effect}` : ""}.`, ref: target === document.body ? null : refOf(target) };
  };

  // --- Прокрутка -------------------------------------------------------------

  const largestScroller = (axis) => {
    let best = null;
    let area = 0;
    everything(document, (el) => {
      const style = styleOf(el);
      const overflow = axis === "y" ? style.overflowY : style.overflowX;
      if (!/(auto|scroll|overlay)/.test(overflow)) {
        return;
      }
      const room = axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
      const size = el.clientWidth * el.clientHeight;
      if (room > 1 && size > area && visible(el)) {
        best = el;
        area = size;
      }
    });
    return best;
  };

  const position = (box, axis) => {
    const page = box === document.scrollingElement || box === document.documentElement;
    const at = axis === "y" ? box.scrollTop : box.scrollLeft;
    const shown = axis === "y" ? (page ? window.innerHeight : box.clientHeight) : page ? window.innerWidth : box.clientWidth;
    const total = axis === "y" ? box.scrollHeight : box.scrollWidth;
    return { at: Math.round(at), max: Math.max(0, Math.round(total - shown)), shown: Math.round(shown) };
  };

  const scroll = () => {
    const el = locate(request.target);
    const to = request.to;
    const direction = request.direction || (to ? null : "down");
    if (el && !direction && !to) {
      bring(el);
      flash(el);
      return { text: `Прокрутили к ${describe(el)}.`, ref: refOf(el) };
    }
    const axis = direction === "left" || direction === "right" ? "x" : "y";
    let box;
    if (el) {
      box = scrollerOf(el, axis) || (pageScrolls(axis) ? document.scrollingElement || document.documentElement : null);
    } else if (pageScrolls(axis)) {
      box = document.scrollingElement || document.documentElement;
    } else {
      // Страница сама стоит, а листается её часть — так устроены многие
      // приложения: прокручивается то, что под серединой экрана, или самое
      // большое из прокручиваемого.
      const middle = hitAt(document, { x: window.innerWidth / 2, y: window.innerHeight / 2 });
      box = (middle && scrollerOf(middle, axis)) || largestScroller(axis);
    }
    if (!box) {
      refuse("Прокручивать нечего: страница целиком на экране, и прокручиваемых частей на ней нет.");
    }
    const page = box === document.scrollingElement || box === document.documentElement;
    const what = page ? "страницу" : describe(box);
    const before = position(box, axis);
    guard();
    if (to === "top" || to === "bottom") {
      const top = to === "top" ? 0 : box.scrollHeight;
      try {
        box.scrollTo({ top, behavior: "instant" });
      } catch {
        box.scrollTo(box.scrollLeft, top);
      }
    } else {
      const sign = direction === "up" || direction === "left" ? -1 : 1;
      const amount = Number(request.amount) > 0 ? Number(request.amount) : Math.round(before.shown * 0.85);
      const top = axis === "y" ? sign * amount : 0;
      const left = axis === "x" ? sign * amount : 0;
      // Колесо — как от мыши: страница, что листает сама, отменит его и
      // прокрутит по-своему.
      const rect = page
        ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
        : box.getBoundingClientRect();
      const at = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const under = hitAt(document, at) || box;
      const WheelKind = window.WheelEvent;
      const wheeled = WheelKind
        ? under.dispatchEvent(
            new WheelKind("wheel", {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: window,
              clientX: at.x,
              clientY: at.y,
              deltaX: left,
              deltaY: top,
              deltaMode: 0,
            }),
          )
        : true;
      if (!wheeled) {
        notes.push("Страница сама обрабатывает колесо и прокручивает по-своему — проверьте результат чтением или снимком.");
      } else {
        instantly(box, { top, left });
      }
    }
    const after = position(box, axis);
    const word = { up: "вверх", down: "вниз", left: "влево", right: "вправо" }[direction] || "";
    const moved = Math.abs(after.at - before.at);
    let text;
    if (to) {
      text = `Прокрутили ${what} ${to === "top" ? "в начало" : "в конец"}.`;
    } else if (moved === 0 && notes.length === 0) {
      text = `${page ? "Страница" : what} дальше ${word} не прокручивается.`;
    } else {
      text = `Прокрутили ${what} ${word} на ${moved} px.`;
    }
    const back = to === "top" || direction === "up" || direction === "left";
    const toward = to === "top" || direction === "up" ? "выше" : direction === "left" ? "левее" : direction === "right" ? "правее" : "ниже";
    const ahead = back ? after.at : after.max - after.at;
    text += ` Теперь ${after.at} из ${after.max} px` + (ahead > 1 ? `, ${toward} ещё ${ahead} px.` : ", дальше некуда.");
    return { text };
  };

  // --- Файлы -----------------------------------------------------------------

  const fileFieldOf = (el) => {
    if (el.localName === "input" && el.type === "file") {
      return el;
    }
    if (el.localName === "label" && el.control?.type === "file") {
      return el.control;
    }
    const inner = el.querySelectorAll?.("input[type=file]") || [];
    return inner.length === 1 ? inner[0] : el;
  };

  const decode = (data) => {
    const raw = atob(data);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) {
      bytes[index] = raw.charCodeAt(index);
    }
    return bytes;
  };

  const accepts = (field, file) => {
    const accept = squash(field.accept);
    if (!accept) {
      return true;
    }
    return accept.split(",").some((rule) => {
      const want = rule.trim().toLowerCase();
      if (want.startsWith(".")) {
        return file.name.toLowerCase().endsWith(want);
      }
      if (want.endsWith("/*")) {
        return file.type.toLowerCase().startsWith(want.slice(0, -1));
      }
      return file.type.toLowerCase() === want;
    });
  };

  const upload = () => {
    let el = locate(request.target, { hidden: true, accept: fileFieldOf, what: "поле выбора файла" });
    if (!el) {
      const fields = [];
      everything(document, (candidate) => {
        if (candidate.localName === "input" && candidate.type === "file") {
          fields.push(candidate);
        }
      });
      if (fields.length === 0) {
        refuse(
          "На странице нет поля выбора файла. Если файлы принимает зона перетаскивания — укажите её через ref или selector.",
        );
      }
      if (fields.length > 1) {
        ambiguous("На странице несколько полей выбора файла", fields);
      }
      el = fields[0];
    }
    const view = viewOf(el);
    const files = (request.files || []).map(
      (file) => new view.File([decode(file.data)], file.name, { type: file.type, lastModified: Date.now() }),
    );
    const transfer = new view.DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    guard();
    const sizes = files.map((file) => file.name).join(", ");
    if (el.localName === "input" && el.type === "file") {
      if (el.disabled) {
        refuse(`${describe(el)} отключено — положить в него файлы нельзя.`);
      }
      if (files.length > 1 && !el.multiple) {
        refuse(`${describe(el)} берёт один файл, а не ${files.length}.`);
      }
      const odd = files.filter((file) => !accepts(el, file));
      if (odd.length) {
        notes.push(`Поле ждёт ${el.accept}, а ${odd.map((file) => file.name).join(", ")} не из них — страница может их не принять.`);
      }
      el.files = transfer.files;
      announce(el, "input");
      announce(el, "change");
      flash(visible(el) ? el : [...(el.labels || [])].find(visible) || el);
      return { text: `Положили в ${describe(el)}: ${sizes}.`, ref: refOf(el) };
    }
    // Зона перетаскивания: файлы бросают на неё, как из Finder.
    const at = pointOf(el) || { x: 0, y: 0 };
    const drag = (type) => {
      const init = { bubbles: true, cancelable: true, composed: true, clientX: at.x, clientY: at.y, dataTransfer: transfer };
      let event;
      try {
        event = new view.DragEvent(type, init);
      } catch {
        event = null;
      }
      if (!event || event.dataTransfer !== transfer) {
        event = new view.Event(type, init);
        Object.defineProperty(event, "dataTransfer", { value: transfer });
      }
      return el.dispatchEvent(event);
    };
    drag("dragenter");
    drag("dragover");
    const taken = !drag("drop");
    flash(el);
    if (!taken) {
      notes.push("Страница бросок не взяла (drop не отменён) — возможно, это не зона перетаскивания.");
    }
    return { text: `Бросили на ${describe(el)}: ${sizes}.`, ref: refOf(el) };
  };

  // --- Ожидание --------------------------------------------------------------

  const pageText = () => {
    let text = document.body?.innerText || "";
    everything(document, (el) => {
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) {
          text += `\n${child.innerText || ""}`;
        }
      }
      const inner = frameDocument(el);
      if (inner?.body) {
        text += `\n${inner.body.innerText || ""}`;
      }
    });
    return norm(text);
  };

  const check = () => {
    const gone = request.gone === true;
    if (request.text) {
      const present = pageText().includes(norm(request.text));
      return { met: present !== gone };
    }
    if (request.selector) {
      const present = deepQuery(request.selector).some(visible);
      return { met: present !== gone };
    }
    refuse("Не сказано, чего ждать: text — текст на странице, или selector.");
  };

  // --- Выражение -------------------------------------------------------------

  // Значение текстом, как в консоли: элементы — тегом и ссылкой для действий,
  // циклы и глубина — с пометкой.
  const show = (value) => {
    const seen = new WeakSet();
    const render = (item, depth, pad) => {
      if (item === undefined) {
        return "undefined";
      }
      if (item === null) {
        return "null";
      }
      const kind = typeof item;
      if (kind === "string") {
        return JSON.stringify(cut(item, 2000));
      }
      if (kind === "number" || kind === "boolean") {
        return String(item);
      }
      if (kind === "bigint") {
        return `${item}n`;
      }
      if (kind === "symbol") {
        return item.toString();
      }
      if (kind === "function") {
        return `ƒ ${item.name || "anonymous"}()`;
      }
      if (item === window || item === item.window) {
        return "[window]";
      }
      if (typeof item.nodeType === "number" && typeof item.nodeName === "string") {
        if (item.nodeType === 1) {
          const id = item.id ? `#${item.id}` : "";
          const classes = [...item.classList].slice(0, 3).map((name) => `.${name}`).join("");
          return `<${item.localName}${id}${classes}> ref=${refOf(item)}`;
        }
        if (item.nodeType === 3) {
          return `#text ${JSON.stringify(cut(item.data, 200))}`;
        }
        if (item.nodeType === 9) {
          return `#document (${item.URL})`;
        }
        return item.nodeName;
      }
      if (item instanceof Error || (typeof item.message === "string" && typeof item.name === "string" && "stack" in item)) {
        return `${item.name}: ${item.message}`;
      }
      if (item instanceof Date) {
        return Number.isNaN(item.getTime()) ? "Invalid Date" : item.toISOString();
      }
      if (item instanceof RegExp) {
        return String(item);
      }
      if (typeof item.then === "function") {
        return "[Promise]";
      }
      if (seen.has(item)) {
        return "[цикл]";
      }
      if (depth > 5) {
        return Array.isArray(item) ? "[…]" : "{…}";
      }
      seen.add(item);
      const inner = `${pad}  `;
      let open = "{";
      let close = "}";
      let parts = [];
      try {
        if (Array.isArray(item) || ArrayBuffer.isView(item) || item instanceof NodeList || item instanceof HTMLCollection) {
          const list = [...item];
          open = Array.isArray(item) ? "[" : `${item.constructor?.name || "List"}(${list.length}) [`;
          close = "]";
          parts = list.slice(0, 100).map((entry) => render(entry, depth + 1, inner));
          if (list.length > 100) {
            parts.push(`…ещё ${list.length - 100}`);
          }
        } else if (item instanceof Map) {
          open = `Map(${item.size}) {`;
          parts = [...item].slice(0, 100).map(([k, v]) => `${render(k, depth + 1, inner)} => ${render(v, depth + 1, inner)}`);
        } else if (item instanceof Set) {
          open = `Set(${item.size}) {`;
          parts = [...item].slice(0, 100).map((entry) => render(entry, depth + 1, inner));
        } else {
          const keys = Object.keys(item);
          const name = item.constructor?.name;
          if (name && name !== "Object") {
            open = `${name} {`;
          }
          parts = keys.slice(0, 100).map((k) => {
            let v;
            try {
              v = render(item[k], depth + 1, inner);
            } catch (error) {
              v = `[ошибка: ${error?.message || error}]`;
            }
            return `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${v}`;
          });
          if (keys.length > 100) {
            parts.push(`…ещё ${keys.length - 100}`);
          }
        }
      } catch (error) {
        return `[не показать: ${error?.message || error}]`;
      } finally {
        seen.delete(item);
      }
      if (parts.length === 0) {
        return `${open}${close}`;
      }
      const line = `${open} ${parts.join(", ")} ${close}`;
      if (line.length <= 80 && !line.includes("\n")) {
        return line;
      }
      return `${open}\n${inner}${parts.join(`,\n${inner}`)}\n${pad}${close}`;
    };
    if (typeof value === "string") {
      return { text: `Результат (строка):\n${cut(value, BUDGET)}` };
    }
    return { text: `Результат:\n${cut(render(value, 0, ""), BUDGET)}` };
  };

  // Где в стеке этот скрипт: строки с его номерами агенту ничего не скажут —
  // он видит только своё выражение, а не обёртку вокруг него. WebKit пишет
  // «@адрес:строка:столбец», Chromium — «at <anonymous>:строка:столбец».
  const OWN_PLACE = (() => {
    const frame = String(new Error().stack || "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /:\d+:\d+\)?$/.test(line));
    return frame?.match(/([^\s@(]+):\d+:\d+\)?$/)?.[1] || null;
  })();

  // Исключение текстом: имя, сообщение и где оно случилось — без строк самого
  // скрипта. Свои строки оставляем, только если сорвался сам скрипт: тогда
  // они и есть причина.
  const failure = (error, own = false) => {
    if (error && typeof error === "object" && "message" in error) {
      const head = `${error.name || "Error"}: ${error.message}`;
      const frames = (typeof error.stack === "string" ? error.stack.split("\n") : [])
        .map((line) => line.trim())
        .filter((line) => /:\d+:\d+\)?$/.test(line))
        .filter((line) => own || !OWN_PLACE || !line.includes(`${OWN_PLACE}:`))
        .slice(0, 6);
      return cut([head, ...frames].join("\n"), 3000);
    }
    return cut(String(error), 3000);
  };

  const evaluate = () => {
    if (typeof thunk !== "function") {
      refuse("Не сказано, что выполнить: expression — выражение JavaScript.");
    }
    guard();
    let value;
    try {
      value = thunk();
      if (typeof value === "function") {
        value = value();
      }
    } catch (error) {
      return { error: `Выражение бросило исключение:\n${failure(error)}` };
    }
    if (value && typeof value.then === "function") {
      const id = state.nextPending++;
      const entry = { done: false };
      state.pending.set(id, entry);
      value.then(
        (result) => {
          entry.done = true;
          try {
            entry.answer = show(result);
          } catch (error) {
            entry.answer = { error: `Ответ не показать: ${failure(error)}` };
          }
        },
        (error) => {
          entry.done = true;
          entry.answer = { error: `Промис отклонён:\n${failure(error)}` };
        },
      );
      return { pending: id };
    }
    try {
      return show(value);
    } catch (error) {
      return { error: `Ответ не показать: ${failure(error)}` };
    }
  };

  const settled = () => {
    const entry = state.pending.get(request.id);
    if (!entry) {
      refuse("Ответа выражения уже нет: страница перезагрузилась или ушла на другой адрес.");
    }
    if (!entry.done) {
      return { pending: request.id };
    }
    state.pending.delete(request.id);
    return entry.answer;
  };

  // После действия: каким элемент стал и что страница сделала сама.
  const after = () => {
    const el = request.ref ? state.refs.get(request.ref)?.deref() : null;
    const answer = { text: "" };
    // Настоящая мышь не дошла: ни одного её события в точке, и наведения на
    // элементе нет. Тогда то же действие сделает скрипт. Или дошла, но
    // страница под ней сдвинулась, и нажатие придержано — тогда целятся заново.
    const watch = state.watch;
    if (watch) {
      const pointed = watch.el.deref();
      const felt = watch.felt || (watch.hover && !!pointed?.matches?.(":hover"));
      const wrong = watch.wrong?.deref();
      unfeel();
      if (wrong) {
        answer.missed = "elsewhere";
        answer.hit = describe(wrong);
      } else if (!felt) {
        answer.missed = "lost";
      }
    }
    // Ссылок нет вовсе — значит, это уже другая страница: о том, куда она
    // ушла, скажет адрес.
    if (request.ref && state.refs.size > 0) {
      if (el?.isConnected) {
        answer.text = `Теперь: ${describe(el)}`;
      } else {
        answer.text = "Элемента после действия на странице больше нет.";
      }
    }
    return answer;
  };

  // Дошло ли настоящее нажатие целиком. Система отдаёт события по одному, и
  // на медленной машине кнопку отпускают позже, чем страницу уже спросили,
  // что с ней стало.
  const pressed = () => {
    const watch = state.watch;
    const waiting = watch && !watch.wrong && (watch.hover ? !watch.felt : watch.released < watch.presses);
    return { pending: !!waiting };
  };

  // --- Разбор запроса --------------------------------------------------------

  const notes = [];
  const OPS = {
    read,
    click,
    hover: hoverOver,
    type: typeInto,
    select: choose,
    press: pressOn,
    scroll,
    upload,
    check,
    evaluate,
    settled,
    after,
    pressed,
  };
  // Этот только подглядывает, пока сервер ждёт: что страница сделала сама,
  // достанется ответу на действие.
  const PEEKS = new Set(["pressed"]);

  try {
    const op = OPS[request.op];
    if (!op) {
      refuse(`Действие «${request.op}» не знаю.`);
    }
    const answer = op();
    const said = PEEKS.has(request.op) ? [] : drain();
    if (said.length || notes.length) {
      answer.notes = [...(answer.notes || []), ...notes, ...said];
    }
    return JSON.stringify(answer);
  } catch (error) {
    if (error instanceof Refusal) {
      return JSON.stringify({ error: error.message });
    }
    return JSON.stringify({ error: `Действие на странице сорвалось: ${failure(error, true)}` });
  }
}
