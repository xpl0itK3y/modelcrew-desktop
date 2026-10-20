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
    assert_eq!(
        report["blue_console"]["messages"],
        json!([{ "level": "info", "text": "синяя" }]),
        "{:#}",
        report["blue_console"]
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

    // Новых окон у страницы нет: и `window.open`, и ссылка «в новом окне»
    // уводят её саму. Ссылка в рамку страницы приходит в рамку, а страница
    // остаётся где была. А «назад» возвращает туда, откуда увела ссылка.
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
        ("back", "green", Colour::Green),
    ] {
        let shot = &report[name];
        page_is(shot, colour, pixels(last));
        assert_eq!(
            centre(&out.path().join(format!("{name}.png"))),
            expected,
            "{name}: {shot:#}"
        );
    }

    assert_eq!(report["closed"], true, "страница не закрылась: {report:#}");
}

/// Что проверка узнала о странице: что дождалась её, куда пришла, как та
/// называется и какого размера кадр.
fn page_is(shot: &Value, name: &str, size: (f64, f64)) {
    assert_eq!(shot["ready"], true, "не дождались загрузки: {shot:#}");
    assert!(
        shot["url"]
            .as_str()
            .is_some_and(|url| url.ends_with(&format!("/{name}"))),
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
