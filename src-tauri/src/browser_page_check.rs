//! Живая проверка страницы плагина: настоящий webview и настоящие кадры.
//!
//! Юнит-тестом страницу не проверить: она живёт только в работающем
//! приложении, с его циклом событий и окнами. Поэтому тест запускает само
//! приложение с флагом, а оно открывает страницы со своего маленького
//! сервера, снимает их, читает их консоль и записывает, что увидело. В кадры
//! и в отчёт смотрит уже тест — `tests/browser_page_live.rs`.
//!
//! Вход есть только в отладочной сборке: в выпуске его нет вовсе.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, RunEvent};

use crate::browser_page;

/// Флаг запуска проверкой. Следом за ним — каталог для кадров и отчёта.
pub const FLAG: &str = "--browser-page-check";

/// Под каким корнем проверка открывает страницу. Настоящих проектов с таким
/// путём не бывает, а окна страниц у приложения всё равно свои.
const ROOT: &str = "modelcrew-browser-page-check";

/// Сколько ждать загрузки — столько же, сколько ждёт `browser_navigate`.
const LOAD_WAIT: Duration = Duration::from_secs(15);

/// Сколько синяя страница заставляет себя ждать. Без задержки переход
/// успевал бы закончиться раньше первого вопроса «догрузилась?», и
/// ожидание загрузки было бы не проверить.
const SLOW_PAGE: Duration = Duration::from_millis(800);

/// Сколько ждать, пока страница перерисуется в новом размере или закроется.
const SETTLE_WAIT: Duration = Duration::from_secs(5);

/// Размер, под который проверка подгоняет страницу.
const FIT: (f64, f64) = (800.0, 600.0);

/// Место, на которое проверка ставит страницу в главном окне.
const DOCK: browser_page::Place = browser_page::Place {
    x: 100.0,
    y: 50.0,
    width: 600.0,
    height: 400.0,
};

/// Что зелёная страница пишет в консоль: всё, что запись обязана поймать, —
/// подстановки с цветом, предупреждение, ошибку, исключение, которое никто не
/// поймал, отказ промиса и картинку, которой нет.
const GREEN_SCRIPT: &str = concat!(
    "<img src=\"/missing.png\" alt=\"\">",
    "<script>",
    "console.log(\"%cзелёная%c %s\", \"color: green\", \"\", \"страница\", { n: 1 });",
    "console.warn(\"осторожно\");",
    "console.error(new Error(\"сломалось\"));",
    "Promise.reject(new Error(\"отказ\"));",
    "throw new Error(\"не поймали\");",
    "</script>",
);

/// Сколько сообщений у зелёной страницы — по одному на строку выше.
const GREEN_MESSAGES: usize = 6;

/// Синяя страница пишет одно: после перехода консоль обязана начаться заново.
const BLUE_SCRIPT: &str = "<script>console.info(\"синяя\");</script>";

/// Страница, за которую говорят другие: две рамки — своя и с другого домена,
/// localhost вместо 127.0.0.1, — поток, который падает, и поток, которого
/// нет. Сама страница слушает postMessage: сообщения записи до неё доходить
/// не должны.
const TALK_BODY: &str = concat!(
    "<script>addEventListener('message', (event) => ",
    "console.warn('страница услышала: ' + JSON.stringify(event.data)));</script>",
    "<iframe src=\"/said\" title=\"Своя рамка\"></iframe>",
    "<iframe id=\"far\" title=\"Чужая рамка\"></iframe>",
    "<script>far.src = 'http://localhost:' + location.port + '/said';",
    "new Worker('/worker.js'); new Worker('/nothing.js');",
    "console.log('страница говорит');</script>",
);

/// Что пишет рамка: сообщение и исключение, которое никто не поймал.
const SAID_SCRIPT: &str =
    "<script>console.log(\"рамка говорит\"); throw new Error(\"рамка упала\");</script>";

/// Поток, который падает сразу.
const WORKER_SCRIPT: &str = "throw new Error(\"поток упал\");";

/// Что обязано прозвучать в консоли той страницы — каждое столько раз,
/// сколько оно здесь: у рамок по сообщению от каждой.
const TALK_HEARD: &[&str] = &[
    "страница говорит",
    "рамка говорит",
    "рамка говорит",
    "рамка упала",
    "рамка упала",
    "поток упал",
    "/nothing.js",
];

/// Страница со всем, что инспектор показывает помимо исключений (их хватает
/// на других страницах): повторы подряд, счётчик, таймер, таблица,
/// трассировка, отладка, fetch с ответом 404 и fetch на другой домен, который
/// не пускает CORS, XHR с 404, WebSocket, которого нет, и картинка, которую
/// не пускает политика безопасности страницы (CSP — заголовком ответа).
const LOUD_BODY: &str = concat!(
    "<script>",
    "for (let i = 0; i < 3; i++) console.log('снова');",
    "console.count('раз'); console.count('раз');",
    "console.time('миг'); console.timeEnd('миг');",
    "console.debug('отладка'); console.table([{ a: 1 }]); console.trace('след');",
    "fetch('/gone');",
    "fetch('http://localhost:' + location.port + '/gone').catch(() => {});",
    "const xhr = new XMLHttpRequest(); xhr.open('POST', '/gone'); xhr.send();",
    "new WebSocket('ws://' + location.host + '/socket');",
    "const img = new Image(); img.src = 'http://localhost:' + location.port + '/pic.png';",
    "document.body.append(img);",
    "</script>",
);

/// Политика той страницы: картинки только со своего адреса.
const LOUD_POLICY: &str = "img-src 'self'";

/// Что обязано прозвучать в консоли той страницы.
const LOUD_HEARD: &[&str] = &[
    "снова",
    "раз: 2",
    "миг: ",
    "отладка",
    "[{\"a\":1}]",
    "след",
    "fetch http://127.0.0.1:",
    "fetch http://localhost:",
    "xhr POST http://127.0.0.1:",
    "websocket ws://127.0.0.1:",
    "Content Security Policy (img-src)",
];

/// Страница для действий агента: всё, что они умеют, — поле с подписью,
/// кнопка, форма поиска, список, флажок, прокручиваемый блок, поле файла,
/// confirm, ответ с задержкой и ссылка. Страница длиннее экрана: прокрутка
/// тоже проверяется.
///
/// Ниже ссылки — то, чего события скрипта не умеют: меню, которое открывает
/// только CSS-правило :hover, кнопка, что отличает настоящее нажатие, и рамка
/// с другого домена — localhost вместо 127.0.0.1.
const FORM_BODY: &str = concat!(
    "<main style=\"background:#fff\">",
    "<h1>Форма проверки</h1><p>Обычный текст абзаца.</p>",
    "<label for=\"name\">Имя</label> <input id=\"name\" required>",
    "<button id=\"send\" type=\"button\" onclick=\"out.textContent = ",
    "'Привет, ' + document.getElementById('name').value\">Поздороваться</button>",
    "<p id=\"out\"></p>",
    "<form onsubmit=\"event.preventDefault(); found.textContent = 'Искали: ' + this.q.value\">",
    "<input name=\"q\" aria-label=\"Поиск\"></form><p id=\"found\"></p>",
    "<label>Город <select id=\"city\"><option>Москва</option>",
    "<option value=\"spb\">Санкт-Петербург</option></select></label>",
    "<label><input type=\"checkbox\" id=\"agree\"> Согласен</label>",
    "<div id=\"box\" style=\"height:80px;overflow:auto\"><div style=\"height:1000px\">",
    "Длинный список</div></div>",
    "<label>Файл <input type=\"file\" id=\"file\" onchange=\"picked.textContent = ",
    "'Файл: ' + this.files[0].name + ' ' + this.files[0].size\"></label><p id=\"picked\"></p>",
    "<button id=\"ask\" onclick=\"answer.textContent = confirm('Удалить?') ? 'да' : 'нет'\">",
    "Спросить</button><p id=\"answer\"></p>",
    "<button onclick=\"setTimeout(() => late.textContent = 'Сохранено', 500)\">Сохранить</button>",
    "<p id=\"late\"></p><a href=\"/green\">На зелёную</a>",
    "<nav id=\"menu\"><style>#menu .sub{display:none}#menu:hover .sub{display:block}</style>",
    "<span>Меню</span><div class=\"sub\"><button id=\"deep\" ",
    "onclick=\"chosen.textContent = 'Пункт выбран'\">Пункт меню</button></div></nav>",
    "<p id=\"chosen\"></p>",
    "<button id=\"real\" onclick=\"how.textContent = event.isTrusted ? 'настоящее' : 'скрипт'\" ",
    "ondblclick=\"how.textContent = 'двойное: ' + (event.isTrusted ? 'настоящее' : 'скрипт')\" ",
    "oncontextmenu=\"how.textContent = 'меню: ' + (event.isTrusted ? 'настоящее' : 'скрипт')\">",
    "Как нажали</button><p id=\"how\"></p>",
    "<iframe id=\"other\" title=\"Чужая рамка\" style=\"width:300px;height:120px;border:0\"></iframe>",
    "<p id=\"inside\"></p>",
    "<script>other.src = 'http://localhost:' + location.port + '/frame';",
    "addEventListener('message', (event) => { inside.textContent = String(event.data); });</script>",
    "<div style=\"height:3000px\"></div></main>",
);

/// Рамка с другого домена: кнопка говорит странице, как её нажали, а форма —
/// что в неё ввели.
const FRAME_BODY: &str = concat!(
    "<button style=\"width:100%;height:60px\" onclick=\"parent.postMessage(",
    "'рамка: ' + (event.isTrusted ? 'настоящее' : 'скрипт'), '*')\">Внутри рамки</button>",
    "<form onsubmit=\"event.preventDefault(); parent.postMessage('ввод: ' + word.value, '*')\">",
    "<input id=\"word\" value=\"старое\" style=\"width:100%;height:60px;box-sizing:border-box\">",
    "</form>",
);

/// Чем закончилась проверка. Код, переданный в `exit`, Tauri возвращает не
/// везде — на Linux он теряется, и проваленная проверка выходила бы нулём.
static OUTCOME: AtomicI32 = AtomicI32::new(1);

/// Запуск проверкой. `None` — запуск обычный.
pub fn run_if_check() -> Option<i32> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(FLAG) {
        return None;
    }
    let Some(out) = args.next().map(PathBuf::from) else {
        eprintln!("{FLAG}: нужен каталог для кадров");
        return Some(2);
    };
    Some(run(out))
}

fn run(out: PathBuf) -> i32 {
    #[cfg(target_os = "linux")]
    crate::disable_dmabuf_renderer_by_default();

    // Проверке нужно только окно страницы: главное окно с интерфейсом здесь
    // было бы лишним окном на экране того, кто запустил тесты.
    let mut context = crate::app_context();
    context.config_mut().app.windows.clear();
    let app = crate::with_app_plugins(tauri::Builder::default())
        .setup(move |app| {
            // Без этого на время теста в Dock появлялась бы иконка.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let code = report(&handle, &out);
                OUTCOME.store(code, Ordering::SeqCst);
                browser_page::close_all(&handle);
                handle.exit(code);
            });
            Ok(())
        })
        .build(context);
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("{FLAG}: приложение не поднялось: {error}");
            return 1;
        }
    };
    app.run_return(|_, event| {
        // Окон, кроме страницы, нет, и её закрытие Tauri понял бы как «всё
        // закрыто — выходим». Выходит здесь только сама проверка, с кодом.
        if let RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            api.prevent_exit();
        }
    });
    OUTCOME.load(Ordering::SeqCst)
}

/// Пройти проверку и записать отчёт. Код выхода — удалась ли она.
fn report(app: &AppHandle, out: &Path) -> i32 {
    let (code, report) = match check(app, out) {
        Ok(report) => (0, report),
        Err(error) => (1, json!({ "error": error })),
    };
    let text = serde_json::to_string_pretty(&report).unwrap_or_default();
    if let Err(error) = std::fs::write(out.join("report.json"), text) {
        eprintln!("{FLAG}: отчёт не записать: {error}");
        return 1;
    }
    code
}

fn check(app: &AppHandle, out: &Path) -> Result<Value, String> {
    std::fs::create_dir_all(out).map_err(|error| format!("каталог кадров: {error}"))?;
    let site = Site::start()?;

    browser_page::open(app, ROOT, &site.url("green"))?;
    let green = shot(app, out, "green")?;
    let green_console = console(app, GREEN_MESSAGES)?;

    browser_page::fit(app, ROOT, FIT.0, FIT.1)?;
    let small = reshot(app, out, "small", &green)?;

    browser_page::open(app, ROOT, &site.url("blue"))?;
    let blue = shot(app, out, "blue")?;
    let blue_console = console(app, 1)?;

    let (docked, home) = if browser_page::CAN_DOCK {
        dock_and_back(app, out, &blue)?
    } else {
        (Value::Null, Value::Null)
    };

    let same = same_page(app, out)?;

    // Кнопка «назад» в панели: с зелёной, куда увела форма, — на синюю.
    browser_page::step(app, ROOT, browser_page::Step::Back)?;
    let back = shot(app, out, "back")?;

    let actions = actions(app, &site)?;

    browser_page::open(app, ROOT, &site.url("talk"))?;
    shot(app, out, "talk")?;
    let talk_console = console_saying(app, TALK_HEARD)?;

    browser_page::open(app, ROOT, &site.url("loud"))?;
    shot(app, out, "loud")?;
    let loud_console = console_saying(app, LOUD_HEARD)?;

    let scale = app
        .get_webview(&browser_page::label_for(ROOT))
        .and_then(|page| page.window().scale_factor().ok());

    browser_page::close(app, ROOT);
    let deadline = Instant::now() + SETTLE_WAIT;
    while browser_page::is_open(app, ROOT) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }

    let mut report = json!({
        "scale": scale,
        "native": crate::browser_input::AVAILABLE,
        "green": green,
        "green_console": green_console,
        "small": small,
        "blue": blue,
        "blue_console": blue_console,
        "docked": docked,
        "home": home,
        "back": back,
        "actions": actions,
        "talk_console": talk_console,
        "loud_console": loud_console,
        "closed": !browser_page::is_open(app, ROOT),
    });
    if let Value::Object(fields) = &mut report {
        fields.extend(same);
    }
    Ok(report)
}

/// Дождаться страницы, снять её и записать, что о ней известно.
fn shot(app: &AppHandle, out: &Path, name: &str) -> Result<Value, String> {
    let ready = browser_page::wait_ready(app, ROOT, LOAD_WAIT);
    let (url, title) = browser_page::info(app, ROOT)?;
    let png = browser_page::snapshot(app, ROOT)?;
    let file = format!("{name}.png");
    std::fs::write(out.join(&file), &png).map_err(|error| format!("{file}: {error}"))?;
    let (width, height) = png_size(&png).ok_or_else(|| format!("{file}: это не PNG"))?;
    Ok(json!({
        "file": file,
        "ready": ready,
        "url": url,
        "title": title,
        "width": width,
        "height": height,
    }))
}

/// Снять страницу, которой только что сменили размер.
///
/// Размер меняет система, и кадр в новом размере выходит не сразу: снимаем,
/// пока ширина не уйдёт от прежней или не выйдет время.
fn reshot(app: &AppHandle, out: &Path, name: &str, before: &Value) -> Result<Value, String> {
    let deadline = Instant::now() + SETTLE_WAIT;
    loop {
        let after = shot(app, out, name)?;
        if after["width"] != before["width"] || Instant::now() >= deadline {
            return Ok(after);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Пересадить страницу в главное окно и вернуть домой, снимая её и там, и
/// там.
///
/// Главного окна у проверки нет — заводим своё, за краем экрана, как и окно
/// страницы.
fn dock_and_back(app: &AppHandle, out: &Path, before: &Value) -> Result<(Value, Value), String> {
    let main = tauri::window::WindowBuilder::new(app, "main")
        .inner_size(1000.0, 700.0)
        .position(-31_000.0, -31_000.0)
        .decorations(false)
        .skip_taskbar(true)
        .focused(false)
        .build()
        .map_err(|error| format!("главное окно проверки: {error}"))?;
    let result = (|| {
        browser_page::dock(app, ROOT, DOCK)?;
        if !browser_page::is_docked(app, ROOT) {
            return Err("страница не встала в главное окно".to_string());
        }
        let docked = reshot(app, out, "docked", before)?;
        browser_page::undock(app, ROOT)?;
        if browser_page::is_docked(app, ROOT) {
            return Err("страница не вернулась в своё окно".to_string());
        }
        let home = shot(app, out, "home")?;
        Ok((docked, home))
    })();
    let _ = main.destroy();
    result
}

/// Увести синюю страницу «в новое окно» — сперва `window.open`, потом
/// ссылкой с `target="_blank"`, ссылкой, которой новое окно задал `<base>`, и
/// формами, — и снять, куда она пришла. Между ними — ссылка и форма в рамку
/// самой страницы.
///
/// Окон, кроме своего, у страницы нет: новое окно обязано увести её саму. А
/// рамка у страницы есть, и в неё ссылка обязана прийти, не трогая страницу.
fn same_page(app: &AppHandle, out: &Path) -> Result<serde_json::Map<String, Value>, String> {
    let page = app
        .get_webview(&browser_page::label_for(ROOT))
        .ok_or_else(|| "страница пропала".to_string())?;
    let run = |script: &str| {
        page.eval(script)
            .map_err(|error| format!("до страницы не достучаться: {error}"))
    };
    let mut seen = serde_json::Map::new();
    run("window.open('/green')")?;
    seen.insert("opened".into(), shot(app, out, "opened")?);

    // Рамка — крошечная, в углу: середина кадра остаётся страницей. В рамку
    // ведут ссылка, а за ней форма. Что в рамку пришло, страница пишет в
    // консоль: рамка сама не знает, откуда пришла.
    run(concat!(
        "{ const frame = document.createElement('iframe'); frame.name = 'side';",
        "frame.style.cssText = 'position:fixed;left:0;top:0;width:8px;height:8px;border:0';",
        "document.body.append(frame);",
        "const form = document.createElement('form'); form.action = '/green';",
        "form.target = 'side'; document.body.append(form);",
        "frame.onload = () => { const path = frame.contentWindow.location.pathname;",
        " if (path === '/blue') form.requestSubmit();",
        " if (path === '/green') console.log('рамка: синяя, потом зелёная'); };",
        "const link = document.createElement('a'); link.href = '/blue'; link.target = 'side';",
        "document.body.append(link); link.click(); }",
    ))?;
    seen.insert(
        "frame_heard".into(),
        heard(app, "рамка: синяя, потом зелёная")?.into(),
    );
    seen.insert("framed".into(), shot(app, out, "framed")?);

    run(concat!(
        "{ const link = document.createElement('a');",
        "link.href = '/blue'; link.target = '_blank';",
        "document.body.append(link); link.click(); }",
    ))?;
    seen.insert("clicked".into(), shot(app, out, "clicked")?);

    // Своей цели у ссылки нет, но новое окно документ задал всем ссылкам.
    run(concat!(
        "{ const base = document.createElement('base'); base.target = '_blank';",
        "document.head.append(base);",
        "const link = document.createElement('a'); link.href = '/green';",
        "document.body.append(link); link.click(); }",
    ))?;
    seen.insert("based".into(), shot(app, out, "based")?);

    // Формы: новое окно задаёт кнопка отправки, а потом сама форма, которую
    // отправляет скрипт, — `submit()` события не шлёт. Поле с именем
    // `getAttribute` заслоняет у формы её метод: скрипт страницы на нём
    // спотыкаться не должен.
    run(concat!(
        "{ const form = document.createElement('form'); form.action = '/blue';",
        "const button = document.createElement('button'); button.formTarget = '_blank';",
        "form.append(button); document.body.append(form); form.requestSubmit(button); }",
    ))?;
    seen.insert("sent".into(), shot(app, out, "sent")?);
    run(concat!(
        "{ const form = document.createElement('form'); form.action = '/green';",
        "form.target = '_blank'; const field = document.createElement('input');",
        "field.name = 'getAttribute'; form.append(field);",
        "document.body.append(form); form.submit(); }",
    ))?;
    seen.insert("submitted".into(), shot(app, out, "submitted")?);
    Ok(seen)
}

/// Действия агента на странице с формой — так, как их зовёт сервер MCP. Что
/// вышло из каждого, разбирает тест.
fn actions(app: &AppHandle, site: &Site) -> Result<Value, String> {
    browser_page::open(app, ROOT, &site.url("form"))?;
    browser_page::wait_ready(app, ROOT, LOAD_WAIT);
    let value = |expression: &str| json!({ "op": "evaluate", "expression": expression });
    let steps = [
        ("read", json!({ "op": "read" })),
        ("controls", json!({ "op": "read", "interactive": true })),
        (
            "type",
            json!({ "op": "type", "target": { "text": "Имя" }, "text": "Ада" }),
        ),
        (
            "click",
            json!({ "op": "click", "target": { "text": "Поздороваться" } }),
        ),
        (
            "greeted",
            value("document.getElementById('out').textContent"),
        ),
        (
            "search",
            json!({ "op": "type", "target": { "text": "Поиск" }, "text": "кошки", "submit": true }),
        ),
        (
            "searched",
            value("document.getElementById('found').textContent"),
        ),
        (
            "select",
            json!({ "op": "select", "target": { "text": "Город" }, "options": "Санкт-Петербург" }),
        ),
        ("city", value("document.getElementById('city').value")),
        (
            "check",
            json!({ "op": "click", "target": { "text": "Согласен" } }),
        ),
        ("agreed", value("document.getElementById('agree').checked")),
        (
            "tab",
            json!({ "op": "press", "target": { "selector": "#name" }, "key": "Tab" }),
        ),
        ("focused", value("document.activeElement.id")),
        (
            "hover",
            json!({ "op": "hover", "target": { "selector": "#send" } }),
        ),
        ("scroll", json!({ "op": "scroll", "direction": "down" })),
        (
            "scroll_box",
            json!({ "op": "scroll", "target": { "selector": "#box" }, "direction": "down", "amount": 200 }),
        ),
        (
            "upload",
            json!({ "op": "upload", "files": [{ "name": "cat.txt", "type": "text/plain", "data": "bWVvdw==" }] }),
        ),
        (
            "picked",
            value("document.getElementById('picked').textContent"),
        ),
        (
            "dismissed",
            json!({ "op": "click", "target": { "selector": "#ask" } }),
        ),
        (
            "dismissed_answer",
            value("document.getElementById('answer').textContent"),
        ),
        (
            "accepted",
            json!({ "op": "click", "target": { "selector": "#ask" }, "dialog": "accept" }),
        ),
        (
            "accepted_answer",
            value("document.getElementById('answer').textContent"),
        ),
        (
            "save",
            json!({ "op": "click", "target": { "text": "Сохранить" } }),
        ),
        (
            "waited",
            json!({ "op": "check", "text": "Сохранено", "seconds": 3 }),
        ),
        (
            "not_waited",
            json!({ "op": "check", "text": "Никогда", "seconds": 0.5 }),
        ),
        (
            "promise",
            value("new Promise((done) => setTimeout(() => done(42), 300))"),
        ),
        ("element", value("document.querySelector('h1')")),
        ("broken", value("(")),
        ("thrown", value("() => { throw new Error('нарочно'); }")),
        (
            "missing",
            json!({ "op": "click", "target": { "text": "Такой кнопки нет" } }),
        ),
        (
            "menu",
            json!({ "op": "hover", "target": { "text": "Меню" } }),
        ),
        (
            "menu_item",
            json!({ "op": "click", "target": { "selector": "#deep" } }),
        ),
        (
            "chosen",
            value("document.getElementById('chosen').textContent"),
        ),
        (
            "real",
            json!({ "op": "click", "target": { "selector": "#real" } }),
        ),
        (
            "real_how",
            value("document.getElementById('how').textContent"),
        ),
        (
            "double",
            json!({ "op": "click", "target": { "selector": "#real" }, "double": true }),
        ),
        (
            "double_how",
            value("document.getElementById('how').textContent"),
        ),
        (
            "right",
            json!({ "op": "click", "target": { "selector": "#real" }, "right": true }),
        ),
        (
            "right_how",
            value("document.getElementById('how').textContent"),
        ),
        ("frame_read", json!({ "op": "read", "selector": "#other" })),
    ];
    let mut seen = serde_json::Map::new();
    perform_all(app, &mut seen, steps);

    // В рамку с другого домена скрипт страницы не попадёт — только мышь, в
    // точку на экране, и клавиатура туда, где в рамке фокус. Кнопка — в
    // верхней половине рамки, поле — в нижней.
    let points = browser_page::run(
        app,
        ROOT,
        "(() => { const frame = document.getElementById('other'); \
         frame.scrollIntoView({ block: 'center' }); const box = frame.getBoundingClientRect(); \
         const at = (y) => ({ x: Math.round(box.left + box.width / 2), y: Math.round(box.top + y) }); \
         return JSON.stringify({ button: at(30), field: at(90) }); })()",
    )?
    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    .ok_or("где кнопка и поле в рамке, не узнать")?;
    let inside = || value("document.getElementById('inside').textContent");
    perform_all(
        app,
        &mut seen,
        [
            (
                "frame_click",
                json!({ "op": "click", "at": points["button"] }),
            ),
            ("frame_how", inside()),
            (
                "frame_field",
                json!({ "op": "click", "at": points["field"] }),
            ),
            (
                "frame_type",
                json!({ "op": "type", "text": "Привет, рамка" }),
            ),
            ("frame_press", json!({ "op": "press", "key": "Enter" })),
            ("frame_typed", inside()),
            (
                "frame_more",
                json!({ "op": "type", "text": "!", "append": true, "submit": true }),
            ),
            ("frame_appended", inside()),
            (
                "link",
                json!({ "op": "click", "target": { "text": "На зелёную" } }),
            ),
            ("stale", json!({ "op": "click", "target": { "ref": "e1" } })),
        ],
    );
    Ok(Value::Object(seen))
}

/// Шаги по очереди — каждый так, как его позвал бы сервер, — и что вышло.
fn perform_all(
    app: &AppHandle,
    seen: &mut serde_json::Map<String, Value>,
    steps: impl IntoIterator<Item = (&'static str, Value)>,
) {
    for (name, request) in steps {
        let outcome = match crate::browser_actions::perform(app, ROOT, request) {
            Ok(acted) => json!({
                "text": acted.text,
                "notes": acted.notes,
                "url": acted.url,
                "left": acted.left,
            }),
            Err(error) => json!({ "error": error }),
        };
        seen.insert(name.into(), outcome);
    }
}

/// Дождаться в консоли страницы сообщения с этим текстом.
fn heard(app: &AppHandle, text: &str) -> Result<bool, String> {
    let deadline = Instant::now() + SETTLE_WAIT;
    loop {
        let log = browser_page::console(app, ROOT)?;
        if log
            .messages
            .iter()
            .any(|message| message.text.contains(text))
        {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Консоль страницы, когда в ней наберётся хотя бы столько сообщений.
///
/// Не всё приходит к концу загрузки: отказ промиса и незагрузившаяся картинка
/// бывают и после. Не дождались — отдаём что есть, и разберётся тест.
fn console(app: &AppHandle, at_least: usize) -> Result<Value, String> {
    let deadline = Instant::now() + SETTLE_WAIT;
    loop {
        let log = browser_page::console(app, ROOT)?;
        if log.messages.len() >= at_least || Instant::now() >= deadline {
            return Ok(json!({ "messages": log.messages, "dropped": log.dropped }));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Консоль страницы, когда в ней прозвучит каждый из этих текстов — столько
/// раз, сколько он в списке. Рамки и потоки говорят не в лад со страницей:
/// одного счёта сообщений тут мало.
fn console_saying(app: &AppHandle, texts: &[&str]) -> Result<Value, String> {
    let deadline = Instant::now() + SETTLE_WAIT;
    loop {
        let log = browser_page::console(app, ROOT)?;
        let all = texts.iter().all(|text| {
            let wanted = texts.iter().filter(|other| *other == text).count();
            let heard = log
                .messages
                .iter()
                .filter(|message| message.text.contains(text))
                .count();
            heard >= wanted
        });
        if all || Instant::now() >= deadline {
            return Ok(json!({ "messages": log.messages, "dropped": log.dropped }));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Размер PNG из его заголовка — разбирать картинку целиком ради него незачем.
fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if png.len() < 24 || !png.starts_with(SIGNATURE) || &png[12..16] != b"IHDR" {
        return None;
    }
    let number = |at: usize| u32::from_be_bytes([png[at], png[at + 1], png[at + 2], png[at + 3]]);
    Some((number(16), number(20)))
}

/// Сайт проверки: две страницы сплошного цвета и форма на петле. Всё прочее —
/// «не найдено»: на это и рассчитана картинка, которой нет.
///
/// Свой сервер, а не адрес в сети: проверка не должна зависеть от того, есть
/// ли интернет на машине, где идут тесты.
struct Site {
    port: u16,
}

impl Site {
    fn start() -> Result<Self, String> {
        let listener =
            TcpListener::bind("127.0.0.1:0").map_err(|error| format!("сайт проверки: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("сайт проверки: {error}"))?
            .port();
        std::thread::spawn(move || {
            for stream in listener.incoming().map_while(Result::ok) {
                std::thread::spawn(move || answer(stream));
            }
        });
        Ok(Self { port })
    }

    fn url(&self, page: &str) -> String {
        format!("http://127.0.0.1:{}/{page}", self.port)
    }
}

fn answer(mut stream: TcpStream) {
    let mut reader = BufReader::new(&stream);
    let mut request = String::new();
    if reader.read_line(&mut request).is_err() {
        return;
    }
    // Заголовки запроса не нужны, но дочитать их надо: иначе ответ уйдёт
    // поверх недочитанного запроса.
    let mut line = String::new();
    while reader.read_line(&mut line).is_ok_and(|read| read > 2) {
        line.clear();
    }
    let target = request.split_whitespace().nth(1).unwrap_or("/");
    // Формы без полей оставляют в адресе пустой запрос, `/blue?`: страница
    // та же.
    let path = target.split('?').next().unwrap_or(target);
    const HTML: &str = "text/html";
    let (status, kind, body) = match path {
        "/green" => ("200 OK", HTML, page("green", "#00c000", GREEN_SCRIPT)),
        "/form" => ("200 OK", HTML, page("form", "#ffffff", FORM_BODY)),
        "/frame" => ("200 OK", HTML, page("frame", "#ffeecc", FRAME_BODY)),
        "/talk" => ("200 OK", HTML, page("talk", "#ffffff", TALK_BODY)),
        "/said" => ("200 OK", HTML, page("said", "#eeeeee", SAID_SCRIPT)),
        "/loud" => ("200 OK", HTML, page("loud", "#ffffff", LOUD_BODY)),
        // Поток браузер запустит, только если сервер назвал его скриптом.
        "/worker.js" => ("200 OK", "text/javascript", WORKER_SCRIPT.to_string()),
        "/blue" => {
            std::thread::sleep(SLOW_PAGE);
            ("200 OK", HTML, page("blue", "#0000ff", BLUE_SCRIPT))
        }
        _ => ("404 Not Found", HTML, String::new()),
    };
    let policy = if path == "/loud" {
        format!("Content-Security-Policy: {LOUD_POLICY}\r\n")
    } else {
        String::new()
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {kind}; charset=utf-8\r\n{policy}\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

fn page(name: &str, color: &str, body: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
         <title>ModelCrew check: {name}</title>\
         <style>html,body{{margin:0;height:100%;background:{color}}}</style>\
         </head><body>{body}</body></html>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_size_reads_the_header() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&1280u32.to_be_bytes());
        png.extend_from_slice(&800u32.to_be_bytes());
        assert_eq!(png_size(&png), Some((1280, 800)));
    }

    #[test]
    fn png_size_refuses_what_is_not_png() {
        assert_eq!(png_size(b"GIF89a and some more bytes here"), None);
    }
}
