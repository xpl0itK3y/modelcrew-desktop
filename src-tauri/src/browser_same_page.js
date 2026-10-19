// Новые окна страницы плагина: открываются в ней же.
//
// Вкладок у браузера проекта нет — одна страница, которую видят и человек, и
// агент. Новое окно wry без своего обработчика не открывает ни на одной
// системе, и ссылка «в новом окне» молчала бы: человек щёлкает впустую.
// Обработчик в Rust тут не годится: на macOS wry, спрашивая его, ищет экран
// окна страницы, а у окна за краем экранов экрана нет — приложение падает.
// Поэтому такая ссылка ведёт туда же, куда обычная, — в этой же странице.
//
// Ловим ссылки с чужой целью, щелчки с Cmd, Ctrl, Shift и средней кнопкой и
// `window.open` в новое окно. Чего не поймали — например, формы с `target`, —
// остаётся как было.
(() => {
  // Рамки ведут себя сами: их «новое окно» — забота страницы.
  if (window.top !== window) {
    return;
  }

  const isWeb = (url) => url.protocol === "http:" || url.protocol === "https:";
  // Эти цели и так оставляют страницу на месте: выше неё окон нет.
  const here = new Set(["", "_self", "_parent", "_top"]);

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
      !here.has(link.target.toLowerCase()) ||
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

  const open = window.open;
  window.open = function (url, target, features) {
    // Без цели, как и с пустой, `window.open` открывает новое окно.
    const name =
      typeof target === "string" && target !== ""
        ? target.toLowerCase()
        : "_blank";
    const address =
      url === undefined || url === "" ? null : resolve(String(url));
    if (here.has(name) || !address || !isWeb(address)) {
      return open.call(window, url, target, features);
    }
    window.location.assign(address.href);
    // Окна нет — как у заблокированного всплывающего: так страница его и
    // проверяет.
    return null;
  };
})();
