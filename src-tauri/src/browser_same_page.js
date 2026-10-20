// Новые окна страницы плагина: открываются в ней же.
//
// Вкладок у браузера проекта нет — одна страница, которую видят и человек, и
// агент. Новое окно wry без своего обработчика не открывает ни на одной
// системе, и ссылка «в новом окне» молчала бы: человек щёлкает впустую.
// Обработчик в Rust тут не годится: на macOS wry, спрашивая его, ищет экран
// окна страницы, а у окна за краем экранов экрана нет — приложение падает.
// Поэтому такая ссылка ведёт туда же, куда обычная, — в этой же странице.
//
// Ловим ссылки и формы с чужой целью, щелчки с Cmd, Ctrl, Shift и средней
// кнопкой и `window.open` в новое окно. Чего не поймали, остаётся как было.
(() => {
  // Рамки ведут себя сами: их «новое окно» — забота страницы.
  if (window.top !== window) {
    return;
  }

  const isWeb = (url) => url.protocol === "http:" || url.protocol === "https:";
  // Эти цели и так оставляют страницу на месте: выше неё окон нет.
  const here = new Set(["", "_self", "_parent", "_top"]);

  // Уводит ли цель в новое окно. Так бывает с `_blank` и с именем, которого
  // нет ни у самой страницы, ни у её рамок. Рамку с таким именем браузер
  // находит сам — в неё ведут оплаты и встроенные окна входа, и уводить их
  // из рамки нельзя.
  const leaves = (name) => {
    const keyword = name.toLowerCase();
    if (here.has(keyword) || name === window.name) {
      return false;
    }
    if (keyword === "_blank") {
      return true;
    }
    return !Array.from(document.querySelectorAll("iframe, frame")).some(
      (frame) => frame.name === name,
    );
  };

  // Атрибуты читаем методами элемента, взятыми заранее: у формы поле с
  // именем `getAttribute` заслонило бы одноимённый метод.
  const { getAttribute, setAttribute, removeAttribute } = Element.prototype;
  const read = (element, attribute) => getAttribute.call(element, attribute);

  // Цель ссылки или формы: своя, а нет её — общая для документа, из
  // `<base target>`.
  const aim = (element, attribute) => {
    const own = read(element, attribute);
    if (own !== null) {
      return own;
    }
    const base = document.querySelector("base[target]");
    return base ? read(base, "target") : "";
  };

  const resolve = (text) => {
    try {
      return new URL(text, document.baseURI);
    } catch {
      return null;
    }
  };

  // Щелчок слушаем на всплытии, после самой страницы: если она перехватила
  // его своим роутером, ссылка уже не наша забота.
  const follow = (event) => {
    const middle = event.type === "auxclick" && event.button === 1;
    if (event.defaultPrevented || (event.button !== 0 && !middle)) {
      return;
    }
    const link =
      event.target instanceof Element
        ? event.target.closest("a[href], area[href]")
        : null;
    if (!link || link.hasAttribute("download")) {
      return;
    }
    const elsewhere =
      middle ||
      leaves(aim(link, "target")) ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey;
    const url = resolve(link.href);
    if (!elsewhere || !url || !isWeb(url)) {
      return;
    }
    event.preventDefault();
    window.location.assign(url.href);
  };
  window.addEventListener("click", follow);
  window.addEventListener("auxclick", follow);

  // Форма в новое окно уходит туда же, куда ссылка, — в эту же страницу.
  // Цель подменяем только на время отправки: атрибуты — страницы, и после
  // отправки они такие же, как были. Отдаёт, как их вернуть.
  const retarget = (form, submitter) => {
    // Кнопка отправки может задать форме свои цель и адрес.
    const button = (attribute) =>
      submitter && read(submitter, attribute) !== null ? submitter : null;
    const holder = button("formtarget") ?? form;
    const attribute = holder === form ? "target" : "formtarget";
    const sender = button("formaction");
    const url = resolve(
      (sender ? read(sender, "formaction") : read(form, "action")) ||
        document.URL,
    );
    if (!leaves(aim(holder, attribute)) || !url || !isWeb(url)) {
      return () => {};
    }
    const before = read(holder, attribute);
    setAttribute.call(holder, attribute, "_self");
    return () =>
      before === null
        ? removeAttribute.call(holder, attribute)
        : setAttribute.call(holder, attribute, before);
  };

  // Цель и адрес браузер читает сразу после события `submit`, в той же
  // задаче. Вернуть цель следующей задачей — значит вернуть, когда она уже
  // прочитана. Слушаем на всплытии, после самой страницы, как и щелчки.
  window.addEventListener("submit", (event) => {
    if (event.defaultPrevented || !(event.target instanceof HTMLFormElement)) {
      return;
    }
    setTimeout(retarget(event.target, event.submitter ?? null), 0);
  });

  // `form.submit()` события не шлёт — цель подменяем вокруг самого вызова.
  const submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (!(this instanceof HTMLFormElement)) {
      return submit.call(this);
    }
    const restore = retarget(this, null);
    try {
      return submit.call(this);
    } finally {
      restore();
    }
  };

  const open = window.open;
  window.open = function (url, target, features) {
    // Без цели, как и с пустой, `window.open` открывает новое окно.
    const name =
      typeof target === "string" && target !== "" ? target : "_blank";
    const address =
      url === undefined || url === "" ? null : resolve(String(url));
    if (!leaves(name) || !address || !isWeb(address)) {
      return open.call(window, url, target, features);
    }
    window.location.assign(address.href);
    // Окна нет — как у заблокированного всплывающего: так страница его и
    // проверяет.
    return null;
  };
})();
