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
    let app = tauri::Builder::default()
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

    // Кнопка «назад» в панели: со синей, куда увела ссылка, — на зелёную.
    browser_page::step(app, ROOT, browser_page::Step::Back)?;
    let back = shot(app, out, "back")?;

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
        "green": green,
        "green_console": green_console,
        "small": small,
        "blue": blue,
        "blue_console": blue_console,
        "docked": docked,
        "home": home,
        "back": back,
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
/// ссылкой с `target="_blank"` — и снять, куда она пришла. Между ними —
/// ссылка в рамку самой страницы.
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

    // Рамка — крошечная, в углу: середина кадра остаётся страницей. Что в
    // рамку пришло, страница пишет в консоль — консоль рамки нам не видна.
    run(concat!(
        "{ const frame = document.createElement('iframe'); frame.name = 'side';",
        "frame.style.cssText = 'position:fixed;left:0;top:0;width:8px;height:8px;border:0';",
        "document.body.append(frame);",
        "frame.onload = () => { if (frame.contentWindow.location.pathname === '/blue')",
        " console.log('рамка: синяя'); };",
        "const link = document.createElement('a'); link.href = '/blue'; link.target = 'side';",
        "document.body.append(link); link.click(); }",
    ))?;
    seen.insert("frame_heard".into(), heard(app, "рамка: синяя")?.into());
    seen.insert("framed".into(), shot(app, out, "framed")?);

    run(concat!(
        "{ const link = document.createElement('a');",
        "link.href = '/blue'; link.target = '_blank';",
        "document.body.append(link); link.click(); }",
    ))?;
    seen.insert("clicked".into(), shot(app, out, "clicked")?);
    Ok(seen)
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
            let messages: Vec<Value> = log
                .messages
                .iter()
                .map(|message| json!({ "level": message.level, "text": message.text }))
                .collect();
            return Ok(json!({ "messages": messages, "dropped": log.dropped }));
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

/// Сайт проверки: две страницы сплошного цвета на петле. Всё прочее —
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
    let path = request.split_whitespace().nth(1).unwrap_or("/");
    let (status, body) = match path {
        "/green" => ("200 OK", page("green", "#00c000", GREEN_SCRIPT)),
        "/blue" => {
            std::thread::sleep(SLOW_PAGE);
            ("200 OK", page("blue", "#0000ff", BLUE_SCRIPT))
        }
        _ => ("404 Not Found", String::new()),
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
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
