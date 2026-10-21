//! Страница плагина открывается и снимается на самом деле — здесь это и
//! проверяется.
//!
//! Адрес, ожидание загрузки и снимок у каждой системы свои: WKWebView,
//! WebKitGTK, WebView2. Проверить их можно только живыми, поэтому тест
//! запускает приложение проверкой (`--browser-page-check`): оно открывает
//! страницы сплошного цвета со своего сервера, снимает их, читает их консоль и
//! пишет отчёт. Здесь смотрим в отчёт и в сами кадры — размер и цвет
//! посередине.

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const APP: &str = env!("CARGO_BIN_EXE_modelcrew-desktop");

/// Проверка сама ждёт каждый шаг не дольше пятнадцати секунд. Если она не
/// кончилась и за полторы минуты — повисла, и ждать дальше бессмысленно.
const WATCHDOG: Duration = Duration::from_secs(90);

/// Страница по умолчанию, та, под которую проверка её подгоняет, и место, на
/// которое она ставит её в главном окне.
const VIEWPORT: (f64, f64) = (1280.0, 800.0);
const FIT: (f64, f64) = (800.0, 600.0);
const DOCK: (f64, f64) = (600.0, 400.0);

#[test]
fn the_page_loads_shows_itself_and_closes() {
    if !cfg!(debug_assertions) {
        eprintln!("пропуск: живая проверка есть только в отладочной сборке");
        return;
    }
    if cfg!(target_os = "linux")
        && std::env::var_os("DISPLAY").is_none()
        && std::env::var_os("WAYLAND_DISPLAY").is_none()
    {
        eprintln!("пропуск: окну страницы негде открыться — нет ни X, ни Wayland");
        return;
    }

    let out = tempfile::tempdir().unwrap();
    let mut check = Command::new(APP)
        .arg("--browser-page-check")
        .arg(out.path())
        .spawn()
        .expect("приложение обязано запускаться проверкой");
    let deadline = Instant::now() + WATCHDOG;
    let status = loop {
        if let Some(status) = check.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = check.kill();
            panic!("проверка не закончилась за {WATCHDOG:?}");
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let report: Value = std::fs::read(out.path().join("report.json"))
        .ok()
        .and_then(|text| serde_json::from_slice(&text).ok())
        .unwrap_or_else(|| panic!("проверка не оставила отчёта, код выхода: {status}"));
    assert!(
        status.success() && report.get("error").is_none(),
        "проверка не прошла ({status}): {report:#}"
    );

    // WebView2 снимает в пикселях устройства, остальные — в точках страницы.
    let scale = if cfg!(windows) {
        report["scale"].as_f64().expect("масштаб окна страницы")
    } else {
        1.0
    };
    let pixels = |size: (f64, f64)| ((size.0 * scale).round(), (size.1 * scale).round());

    let green = &report["green"];
    page_is(green, "green", pixels(VIEWPORT));
    assert_eq!(
        centre(&out.path().join("green.png")),
        Colour::Green,
        "{green:#}"
    );

    // Консоль: и то, что страница написала сама, и то, что с ней случилось.
    let console = &report["green_console"];
    for (level, text) in [
        // Подстановки разобраны, а CSS из %c в текст не попал.
        ("log", r#"зелёная страница {"n":1}"#),
        ("warn", "осторожно"),
        ("error", "сломалось"),
        ("exception", "не поймали"),
        ("rejection", "отказ"),
        ("resource", "/missing.png"),
    ] {
        assert!(
            said(console, level, text),
            "в консоли нет {level} «{text}»: {console:#}"
        );
    }

    // У сообщения — место в коде, как справа в инспекторе: кто позвал console,
    // а не сама запись, которая встала между ними.
    let warned = heard(console, "warn", &["осторожно"])
        .unwrap_or_else(|| panic!("в консоли нет предупреждения: {console:#}"));
    assert!(
        place_in(warned, "/green:1:"),
        "предупреждение без места в странице: {warned:#}"
    );
    let missing = heard(console, "resource", &["/missing.png"])
        .unwrap_or_else(|| panic!("в консоли нет картинки: {console:#}"));
    assert!(
        missing["at"]
            .as_str()
            .is_some_and(|at| at.ends_with("/missing.png")),
        "у картинки нет адреса: {missing:#}"
    );

    // Плагины приложения в страницу не лезут: их команды ей запрещены, и
    // отказ каждой лёг бы в консоль ошибкой, которой у проекта нет. Отказ
    // Tauri пишет так: «notification.is_permission_granted not allowed on…».
    assert!(
        !console.to_string().contains(" not allowed on "),
        "в консоли страницы — плагин приложения: {console:#}"
    );

    // Страница подогнана под ящик — и кадр с ней.
    let small = &report["small"];
    page_is(small, "green", pixels(FIT));

    // Синяя страница отвечает с задержкой: если ожидание загрузки отпустило
    // раньше времени, в кадре окажется ещё зелёная.
    let blue = &report["blue"];
    page_is(blue, "blue", pixels(FIT));
    assert_eq!(
        centre(&out.path().join("blue.png")),
        Colour::Blue,
        "{blue:#}"
    );
    // У новой страницы консоль своя: от зелёной в ней ничего не осталось.
    let blue_console = &report["blue_console"];
    let blue_said = blue_console["messages"].as_array();
    assert_eq!(blue_said.map(Vec::len), Some(1), "{blue_console:#}");
    let only = &blue_console["messages"][0];
    assert_eq!(
        (&only["level"], &only["text"]),
        (&json!("info"), &json!("синяя")),
        "{blue_console:#}"
    );
    assert!(place_in(only, "/blue:1:"), "{blue_console:#}");

    // За страницу говорят её рамки — своя и с другого домена — и потоки, и
    // каждое такое сообщение подписано, чьё оно. Сама страница сообщений
    // записи не слышит, хотя слушает postMessage.
    let talk = &report["talk_console"];
    for host in ["127.0.0.1", "localhost"] {
        let frame = format!("http://{host}:");
        for (level, text) in [("log", "рамка говорит"), ("exception", "рамка упала")]
        {
            assert!(
                said_by(talk, level, text, "frame", (&frame, "/said")),
                "в консоли нет {level} «{text}» из рамки {host}: {talk:#}"
            );
        }
    }
    assert!(
        said_by(
            talk,
            "exception",
            "поток упал",
            "worker",
            ("http://127.0.0.1:", "/worker.js")
        ),
        "в консоли нет ошибки потока: {talk:#}"
    );
    // WebKit отдаёт ту же ошибку и окну страницы — записана она один раз.
    let fell = talk["messages"].as_array().map_or(0, |messages| {
        messages
            .iter()
            .filter(|message| {
                message["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("поток упал"))
            })
            .count()
    });
    assert_eq!(fell, 1, "ошибка потока записана не один раз: {talk:#}");
    assert!(
        said(talk, "resource", "worker http://127.0.0.1:") && said(talk, "resource", "/nothing.js"),
        "в консоли нет потока, который не загрузился: {talk:#}"
    );
    let own = talk["messages"]
        .as_array()
        .and_then(|messages| {
            messages
                .iter()
                .find(|message| message["text"] == "страница говорит")
        })
        .unwrap_or_else(|| panic!("страница сама ничего не сказала: {talk:#}"));
    // Своё страница пишет без подписи рамки или потока, но с местом.
    assert_eq!(own["level"], "log", "{own:#}");
    assert!(
        own.get("frame").is_none() && own.get("worker").is_none(),
        "{own:#}"
    );
    assert!(place_in(own, "/talk:1:"), "{own:#}");
    assert!(
        !talk.to_string().contains("страница услышала"),
        "сообщение записи дошло до страницы: {talk:#}"
    );

    // Всё, что инспектор показывает помимо исключений: повтор подряд — одна
    // запись со счётом, методы console, запросы, которые не удались, —
    // каждый со своей причиной, — и запрет политики безопасности.
    let loud = &report["loud_console"];
    let again =
        heard(loud, "log", &["снова"]).unwrap_or_else(|| panic!("в консоли нет повтора: {loud:#}"));
    assert_eq!(again["count"], 3, "повтор не схлопнут: {loud:#}");
    assert!(place_in(again, "/loud:1:"), "{again:#}");
    for (level, parts) in [
        ("log", &["раз: 1"][..]),
        ("log", &["раз: 2"]),
        ("log", &["миг: ", " ms"]),
        ("debug", &["отладка"]),
        ("log", &[r#"[{"a":1}]"#]),
        ("trace", &["след"]),
        ("resource", &["fetch http://127.0.0.1:", "/gone — 404"]),
        ("resource", &["fetch http://localhost:", "/gone — "]),
        ("resource", &["xhr POST http://127.0.0.1:", "/gone — 404"]),
        ("resource", &["websocket ws://127.0.0.1:", "/socket"]),
        ("csp", &["Policy (img-src): http://localhost:", "/pic.png"]),
    ] {
        let message = heard(loud, level, parts)
            .unwrap_or_else(|| panic!("в консоли нет {level} {parts:?}: {loud:#}"));
        // Место у запроса — тот, кто его сделал.
        if level != "csp" {
            assert!(place_in(message, "/loud:1:"), "{message:#}");
        }
    }
    assert!(
        heard(loud, "rejection", &[]).is_none(),
        "отказ, который страница поймала, записан как непойманный: {loud:#}"
    );

    // Страница пересаживается в главное окно и обратно, не перезагружаясь:
    // в панели она той величины, что панель, и домой уносит тот же размер.
    // На Linux пересаживать некуда — там страницу показывают кадром.
    if cfg!(not(target_os = "linux")) {
        for name in ["docked", "home"] {
            let shot = &report[name];
            page_is(shot, "blue", pixels(DOCK));
            assert_eq!(
                centre(&out.path().join(format!("{name}.png"))),
                Colour::Blue,
                "{name}: {shot:#}"
            );
        }
    }

    // Новых окон у страницы нет: и `window.open`, и ссылка или форма «в новом
    // окне» уводят её саму. Ссылка и форма в рамку страницы приходят в рамку,
    // а страница остаётся где была. А «назад» возвращает туда, откуда увела
    // форма.
    // Размер — последний, что ей задали.
    assert_eq!(
        report["frame_heard"], true,
        "ссылка в рамку до рамки не дошла: {report:#}"
    );
    let last = if cfg!(target_os = "linux") { FIT } else { DOCK };
    for (name, colour, expected) in [
        ("opened", "green", Colour::Green),
        ("framed", "green", Colour::Green),
        ("clicked", "blue", Colour::Blue),
        ("based", "green", Colour::Green),
        ("sent", "blue", Colour::Blue),
        ("submitted", "green", Colour::Green),
        ("back", "blue", Colour::Blue),
    ] {
        let shot = &report[name];
        page_is(shot, colour, pixels(last));
        assert_eq!(
            centre(&out.path().join(format!("{name}.png"))),
            expected,
            "{name}: {shot:#}"
        );
    }

    // Действия агента — на странице с формой, по очереди, как их зовёт сервер.
    let actions = &report["actions"];
    let read = done(actions, "read");
    for part in [
        "# Форма проверки",
        "Обычный текст абзаца.",
        "[e1 textbox «Имя» required]",
        "[e2 button «Поздороваться»]",
        "[e4 combobox «Город» = «Москва»",
        "[e9 link «На зелёную» → /green]",
    ] {
        assert!(read.contains(part), "в чтении нет «{part}»: {read}");
    }
    // Страница длиннее экрана — чтение говорит, что ниже есть ещё.
    assert!(
        actions["read"]["notes"]
            .to_string()
            .contains("browser_scroll"),
        "{actions:#}"
    );
    let controls = done(actions, "controls");
    assert!(
        controls.contains("[e2 button «Поздороваться»]") && !controls.contains("Обычный текст"),
        "{controls}"
    );

    // Ввод, нажатие, Enter в форме, список, флажок и Tab видны самой странице.
    for (name, expected) in [
        ("greeted", "Привет, Ада"),
        ("searched", "Искали: кошки"),
        ("city", "spb"),
        ("agreed", "true"),
        ("focused", "send"),
        ("picked", "Файл: cat.txt 4"),
        ("dismissed_answer", "нет"),
        ("accepted_answer", "да"),
        ("promise", "42"),
    ] {
        let text = done(actions, name);
        assert!(text.ends_with(&format!("\n{expected}")), "{name}: {text}");
    }
    assert!(
        done(actions, "search").contains("форму отправили"),
        "{actions:#}"
    );
    assert!(
        done(actions, "hover").starts_with("Навели мышь"),
        "{actions:#}"
    );
    assert!(
        done(actions, "scroll").contains("Прокрутили страницу вниз"),
        "{actions:#}"
    );
    assert!(
        done(actions, "scroll_box").contains("вниз на 200 px"),
        "{actions:#}"
    );
    assert!(
        done(actions, "element").contains("<h1> ref=e"),
        "{actions:#}"
    );

    // Настоящая мышь: меню на одном CSS :hover открывается, страница видит
    // isTrusted, а в рамку с другого домена попадают точкой с кадра. Прочитать
    // такую рамку нельзя — чтение говорит, где она на кадре. В поле рамки
    // печатает настоящая клавиатура: прежнее заменяется, Enter отправляет.
    let frame = done(actions, "frame_read");
    assert!(
        frame.contains("[frame «Чужая рамка» cross-origin, "),
        "{frame}"
    );
    if report["native"] == true {
        assert!(
            frame.contains(", на кадре x ") || frame.contains(", вне экрана"),
            "{frame}"
        );
        for name in [
            "hover",
            "menu",
            "menu_item",
            "real",
            "double",
            "right",
            "frame_click",
            "frame_field",
            "frame_type",
            "frame_press",
            "frame_more",
            "frame_erase",
            "frame_left",
            "frame_cut",
            "frame_send",
            "frame_all",
            "frame_new",
            "frame_mark",
            "frame_mark_more",
            "frame_fix",
        ] {
            let notes = actions[name]["notes"].to_string();
            assert!(
                !notes.contains("Настоящий ввод до страницы не дошёл"),
                "{name}: настоящая мышь не дошла: {notes}"
            );
        }
        for (name, expected) in [
            ("chosen", "Пункт выбран"),
            ("real_how", "настоящее"),
            ("double_how", "двойное: настоящее"),
            ("right_how", "меню: настоящее"),
            ("frame_how", "рамка: настоящее"),
            ("frame_typed", "ввод: Привет, рамка"),
            ("frame_appended", "ввод: Привет, рамка!"),
            // Backspace, стрелка и Enter правят поле, как у человека.
            ("frame_edited", "ввод: Привет, рама"),
            // Command+A на Mac и Control+A на других системах выделяют всё, а
            // Shift со стрелкой — часть.
            ("frame_replaced", "ввод: новый"),
        ] {
            let text = done(actions, name);
            assert!(text.ends_with(&format!("\n{expected}")), "{name}: {text}");
        }
        assert!(
            done(actions, "frame_type").starts_with("Ввели в то, что в фокусе в рамке"),
            "{actions:#}"
        );
    } else {
        let text = done(actions, "real_how");
        assert!(text.ends_with("\nскрипт"), "{text}");
        assert!(
            refused(actions, "frame_click").contains("настоящая мышь"),
            "{actions:#}"
        );
    }

    // confirm человеку не показан, а агенту сказано, о чём спросили.
    assert!(
        actions["dismissed"]["notes"]
            .to_string()
            .contains("confirm «Удалить?» — ответили «нет»"),
        "{actions:#}"
    );

    assert!(
        done(actions, "waited").starts_with("Дождались"),
        "{actions:#}"
    );
    assert!(
        refused(actions, "not_waited").contains("не дождались"),
        "{actions:#}"
    );
    assert!(
        refused(actions, "broken").contains("синтаксическая ошибка"),
        "{actions:#}"
    );
    // Строк самого скрипта в исключении нет: агенту они ничего не скажут.
    assert_eq!(
        refused(actions, "thrown"),
        "Выражение бросило исключение:\nError: нарочно",
        "{actions:#}"
    );
    assert!(
        refused(actions, "missing").contains("browser_read"),
        "{actions:#}"
    );

    // Ссылка увела страницу — и ответ это говорит, а старые ссылки не годятся.
    let link = &actions["link"];
    assert!(
        link["left"]
            .as_str()
            .is_some_and(|url| url.ends_with("/form"))
            && link["url"]
                .as_str()
                .is_some_and(|url| url.ends_with("/green")),
        "{link:#}"
    );
    assert!(
        refused(actions, "stale").contains("browser_read"),
        "{actions:#}"
    );

    assert_eq!(report["closed"], true, "страница не закрылась: {report:#}");
}

/// Текст действия, которое удалось.
fn done<'a>(actions: &'a Value, name: &str) -> &'a str {
    let step = &actions[name];
    assert!(step.get("error").is_none(), "{name} не удалось: {step:#}");
    step["text"].as_str().unwrap_or_default()
}

/// Причина, по которой действие не сделано.
fn refused<'a>(actions: &'a Value, name: &str) -> &'a str {
    let step = &actions[name];
    step["error"]
        .as_str()
        .unwrap_or_else(|| panic!("{name} должно было не выйти: {step:#}"))
}

/// Что проверка узнала о странице: что дождалась её, куда пришла, как та
/// называется и какого размера кадр.
fn page_is(shot: &Value, name: &str, size: (f64, f64)) {
    assert_eq!(shot["ready"], true, "не дождались загрузки: {shot:#}");
    // Форма оставляет в адресе запрос с полями, пусть и пустой: `/blue?`.
    assert!(
        shot["url"]
            .as_str()
            .and_then(|url| url.split('?').next())
            .is_some_and(|path| path.ends_with(&format!("/{name}"))),
        "не тот адрес: {shot:#}"
    );
    assert_eq!(
        shot["title"].as_str(),
        Some(format!("ModelCrew check: {name}").as_str()),
        "не тот заголовок: {shot:#}"
    );
    assert_eq!(
        (shot["width"].as_f64(), shot["height"].as_f64()),
        (Some(size.0), Some(size.1)),
        "не тот размер кадра: {shot:#}"
    );
}

/// Есть ли в консоли сообщение этого уровня с таким текстом.
fn said(console: &Value, level: &str, text: &str) -> bool {
    console["messages"].as_array().is_some_and(|messages| {
        messages.iter().any(|message| {
            message["level"] == level
                && message["text"]
                    .as_str()
                    .is_some_and(|said| said.contains(text))
        })
    })
}

/// Сообщение этого уровня, в тексте которого есть всё это.
fn heard<'a>(console: &'a Value, level: &str, parts: &[&str]) -> Option<&'a Value> {
    console["messages"].as_array()?.iter().find(|message| {
        message["level"] == level
            && message["text"]
                .as_str()
                .is_some_and(|text| parts.iter().all(|part| text.contains(part)))
    })
}

/// Место сообщения в коде — на странице проверки с этим путём и строкой:
/// `http://127.0.0.1:порт/путь:строка:столбец`.
fn place_in(message: &Value, page: &str) -> bool {
    message["at"].as_str().is_some_and(|at| {
        at.starts_with("http://127.0.0.1:")
            && at.contains(page)
            && at
                .rsplit(':')
                .next()
                .is_some_and(|column| column.parse::<u32>().is_ok())
    })
}

/// Есть ли в консоли сообщение с этим текстом, подписанное адресом рамки
/// (`frame`) или потока (`worker`) с этим началом и концом.
fn said_by(
    console: &Value,
    level: &str,
    text: &str,
    field: &str,
    (start, end): (&str, &str),
) -> bool {
    console["messages"].as_array().is_some_and(|messages| {
        messages.iter().any(|message| {
            message["level"] == level
                && message["text"]
                    .as_str()
                    .is_some_and(|said| said.contains(text))
                && message[field]
                    .as_str()
                    .is_some_and(|address| address.starts_with(start) && address.ends_with(end))
        })
    })
}

#[derive(Debug, PartialEq)]
enum Colour {
    Green,
    Blue,
    Other(u8, u8, u8),
}

/// Цвет посередине кадра. Цвет страницы чистый, но снимок может пройти через
/// цветовой профиль экрана — поэтому сравниваем грубо, по преобладанию.
fn centre(path: &Path) -> Colour {
    let file = std::fs::File::open(path).unwrap();
    let mut decoder = png::Decoder::new(std::io::BufReader::new(file));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().unwrap();
    let mut buffer = vec![0; reader.output_buffer_size().unwrap()];
    let frame = reader.next_frame(&mut buffer).unwrap();
    let samples = frame.color_type.samples();
    let at = (frame.height as usize / 2) * frame.line_size + (frame.width as usize / 2) * samples;
    let (r, g, b) = if samples >= 3 {
        (buffer[at], buffer[at + 1], buffer[at + 2])
    } else {
        (buffer[at], buffer[at], buffer[at])
    };
    match (r, g, b) {
        (r, g, b) if g > 128 && r < 64 && b < 64 => Colour::Green,
        (r, g, b) if b > 128 && r < 64 && g < 64 => Colour::Blue,
        (r, g, b) => Colour::Other(r, g, b),
    }
}
