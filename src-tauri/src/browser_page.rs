//! Страница внутри приложения: браузер плагина без второй программы.
//!
//! Chrome снаружи — это вторая программа. macOS заводит ей плитку в Dock на
//! каждый запуск, и плитка переживает сам процесс, поэтому они копятся.
//! Спрятать её нечем: своего ключа у Chrome нет, подменить бандл на скрытый
//! нельзя — ломается подпись Google, а запуск без доступа к сеансу Chrome не
//! переживает. Поэтому страницу грузит webview самого ModelCrew: снаружи не
//! появляется ничего, потому что появляться нечему.
//!
//! Окно страницы человеку не показывается — оно живёт за краем экранов, а
//! видит его человек кадром в панели браузера, как и раньше.

use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Размер страницы, пока о ней никто не спрашивал. От него зависит вёрстка,
/// которую увидит агент, открывший страницу до того, как человек открыл ящик.
const VIEWPORT: (f64, f64) = (1280.0, 800.0);

/// Меньше этого страницу не сжимаем. Ящик можно ужать до полоски, но вёрстка
/// в полосок шириной с ладонь — это уже не то, что человек хотел посмотреть,
/// и агенту она сказала бы о странице неправду.
const MIN_VIEWPORT: (f64, f64) = (480.0, 360.0);

/// Куда убрано окно страницы.
///
/// Спрятанное окно система не рисует, а нам нужен настоящий кадр. Поэтому
/// окно остаётся видимым для системы, но стоит за краем любого экрана.
const OFFSCREEN: (f64, f64) = (-31_000.0, -31_000.0);

/// Сколько ждать кадр. Снимок делает система и отвечает не сразу; ждать
/// вечно нельзя — на том конце живой агент.
const SNAPSHOT_WAIT: Duration = Duration::from_secs(5);

/// Сколько ждать, пока переход вообще начнётся: до этого страница честно
/// отвечает «не гружусь» — про прошлую страницу, а не про новую.
const LOAD_START: Duration = Duration::from_millis(150);

/// Как часто переспрашивать, догрузилась ли страница.
const LOAD_POLL: Duration = Duration::from_millis(100);

/// С чего начинается метка окна страницы: по нему они находятся среди окон
/// самого приложения.
const LABEL_PREFIX: &str = "page-";

/// Метка окна страницы проекта.
///
/// Метка — отпечаток корня, а не сам путь: в пути есть разделители, пробелы и
/// юникод, а метка окна должна быть простой и устойчивой — один и тот же
/// проект после перезапуска находит своё окно.
pub fn label_for(root: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(root.as_bytes());
    let name: String = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{LABEL_PREFIX}{name}")
}

/// Открыть страницу проекта или перевести уже открытую на новый адрес.
pub fn open(app: &AppHandle, root: &str, url: &str) -> Result<(), String> {
    let target: tauri::Url = url
        .parse()
        .map_err(|_| format!("адрес не разобрать: {url}"))?;
    let label = label_for(root);
    if let Some(window) = app.get_webview_window(&label) {
        return window
            .navigate(target)
            .map_err(|error| format!("страница не перешла по адресу: {error}"));
    }
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(target))
        .title("ModelCrew")
        .inner_size(VIEWPORT.0, VIEWPORT.1)
        .position(OFFSCREEN.0, OFFSCREEN.1)
        .decorations(false)
        .skip_taskbar(true)
        .focused(false)
        .build()
        .map(|_| ())
        .map_err(|error| format!("страница не открылась: {error}"))
}

/// Подогнать страницу под то место, где её показывают.
///
/// Ящик и страница должны совпадать: иначе кадр 1280×800 растягивается по
/// ширине ящика, снизу остаётся чёрная полоса, а агент видит вёрстку, которой
/// перед человеком нет.
pub fn fit(app: &AppHandle, root: &str, width: f64, height: f64) -> Result<(), String> {
    let window = app
        .get_webview_window(&label_for(root))
        .ok_or_else(|| "страница ещё не открыта".to_string())?;
    let wanted = (width.max(MIN_VIEWPORT.0), height.max(MIN_VIEWPORT.1));
    // Кадр просят раз в секунду, а перерисовка страницы стоит времени: меняем
    // размер, только когда он и правда разъехался с местом.
    if let Some(current) = logical_size(&window) {
        if (current.0 - wanted.0).abs() < 1.0 && (current.1 - wanted.1).abs() < 1.0 {
            return Ok(());
        }
    }
    window
        .set_size(tauri::LogicalSize::new(wanted.0, wanted.1))
        .map_err(|error| format!("страницу не изменить в размере: {error}"))
}

/// Размер окна страницы в тех же единицах, в которых его задают, — точках, а
/// не пикселях устройства.
fn logical_size(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let scale = window.scale_factor().ok()?;
    let size = window.inner_size().ok()?;
    (scale > 0.0).then(|| (f64::from(size.width) / scale, f64::from(size.height) / scale))
}

/// Адрес, по которому странице можно ходить.
///
/// Всё остальное — `file://`, `javascript:` и прочее — это уже не «сходи
/// посмотри страницу», а доступ к машине руками агента.
pub fn is_web(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Открыта ли страница проекта.
pub fn is_open(app: &AppHandle, root: &str) -> bool {
    app.get_webview_window(&label_for(root)).is_some()
}

/// Закрыть страницу проекта.
pub fn close(app: &AppHandle, root: &str) {
    if let Some(window) = app.get_webview_window(&label_for(root)) {
        let _ = window.destroy();
    }
}

/// Закрыть все страницы: выход из приложения и выключенный плагин.
///
/// Без этого окна остались бы висеть за краем экрана: человеку их не видно,
/// а память и загруженные страницы они держат.
pub fn close_all(app: &AppHandle) {
    for window in app.webview_windows().into_values() {
        if window.label().starts_with(LABEL_PREFIX) {
            // `destroy`, а не `close`: закрытие — это просьба, её слушает
            // обработчик окон и её можно отменить. Здесь просьб не место:
            // плагин выключили — страницы быть не должно.
            let _ = window.destroy();
        }
    }
}

/// Кадр страницы проекта, PNG.
pub fn snapshot(app: &AppHandle, root: &str) -> Result<Vec<u8>, String> {
    let window = app
        .get_webview_window(&label_for(root))
        .ok_or_else(|| "страница ещё не открыта".to_string())?;
    // Ширину снимка берём у самой страницы: она меняется вместе с ящиком, и
    // постоянная здесь означала бы кадр не того размера, что показывают.
    let width = logical_size(&window).map_or(VIEWPORT.0, |size| size.0) as u32;
    let scale = window.scale_factor().unwrap_or(1.0);
    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .with_webview(move |platform| {
            // Снимок начинает система и отвечает позже своим вызовом, поэтому
            // ответ уходит в канал, а не возвращается отсюда.
            platform_snapshot(&platform, width, scale, sender);
        })
        .map_err(|error| format!("до страницы не достучаться: {error}"))?;
    match receiver.recv_timeout(SNAPSHOT_WAIT) {
        Ok(result) => result,
        Err(_) => Err("страница не отдала кадр".to_string()),
    }
}

/// Адрес и заголовок страницы — то, чем она подписывается агенту.
pub fn info(app: &AppHandle, root: &str) -> Result<(String, String), String> {
    ask(app, root, platform_info)
}

/// Дождаться, пока страница догрузится.
///
/// Возвращает `false`, если не дождались: это не повод для отказа — кадр
/// недогруженной страницы честнее, чем ошибка вместо кадра.
pub fn wait_ready(app: &AppHandle, root: &str, wait: Duration) -> bool {
    // Сразу после перехода загрузка ещё не началась, и `is_loading` соврал бы
    // «готово». Поэтому сперва даём ей начаться.
    std::thread::sleep(LOAD_START);
    let deadline = std::time::Instant::now() + wait;
    while std::time::Instant::now() < deadline {
        match ask(app, root, platform_is_loading) {
            Ok(false) => return true,
            // Окна нет — ждать нечего.
            Err(_) => return false,
            Ok(true) => std::thread::sleep(LOAD_POLL),
        }
    }
    false
}

/// Спросить у webview то, что знает только он сам.
///
/// Отвечает он на главном потоке, а спрашивают с чужого, поэтому ответ
/// возвращается каналом.
fn ask<T: Send + 'static>(
    app: &AppHandle,
    root: &str,
    probe: fn(&tauri::webview::PlatformWebview) -> Result<T, String>,
) -> Result<T, String> {
    let window = app
        .get_webview_window(&label_for(root))
        .ok_or_else(|| "страница ещё не открыта".to_string())?;
    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .with_webview(move |platform| {
            let _ = sender.send(probe(&platform));
        })
        .map_err(|error| format!("до страницы не достучаться: {error}"))?;
    match receiver.recv_timeout(SNAPSHOT_WAIT) {
        Ok(result) => result,
        Err(_) => Err("страница не ответила".to_string()),
    }
}

/// Адрес и заголовок глазами системы.
#[cfg(target_os = "macos")]
fn platform_info(platform: &tauri::webview::PlatformWebview) -> Result<(String, String), String> {
    let webview = unsafe { &*(platform.inner() as *mut objc2_web_kit::WKWebView) };
    let url = unsafe { webview.URL() }
        .and_then(|url| url.absoluteString())
        .map(|text| text.to_string())
        .unwrap_or_default();
    let title = unsafe { webview.title() }
        .map(|text| text.to_string())
        .unwrap_or_default();
    Ok((url, title))
}

/// Идёт ли ещё загрузка.
#[cfg(target_os = "macos")]
fn platform_is_loading(platform: &tauri::webview::PlatformWebview) -> Result<bool, String> {
    let webview = unsafe { &*(platform.inner() as *mut objc2_web_kit::WKWebView) };
    Ok(unsafe { webview.isLoading() })
}

/// Снимок средствами системы.
#[cfg(target_os = "macos")]
fn platform_snapshot(
    platform: &tauri::webview::PlatformWebview,
    width: u32,
    scale: f64,
    sender: std::sync::mpsc::Sender<Result<Vec<u8>, String>>,
) {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSImage;
    use objc2_foundation::{NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    // Tauri зовёт нас на главном потоке — там же, где живёт webview и куда
    // AppKit пускает только оттуда. Если это вдруг не так, снимка не будет.
    let Some(main_thread) = MainThreadMarker::new() else {
        let _ = sender.send(Err("снимок просят не с главного потока".to_string()));
        return;
    };

    // Указатель отдаёт сам Tauri, и отдаёт его на главном потоке — там же,
    // где живёт webview. Ничего другого по этому адресу быть не может.
    let webview: &WKWebView = unsafe { &*(platform.inner() as *mut WKWebView) };
    let config = unsafe { WKSnapshotConfiguration::new(main_thread) };
    // Ширину снимка система меряет в точках и отдаёт кадр в пикселях экрана:
    // на ретине их вдвое больше по каждой стороне. Агенту кадр уходит
    // картинкой в ответе, поэтому просим столько точек, чтобы пикселей вышло
    // ровно по ширине страницы: вчетверо меньше байт при той же вёрстке.
    let points = f64::from(width) / if scale > 0.0 { scale } else { 1.0 };
    unsafe { config.setSnapshotWidth(Some(&NSNumber::new_f64(points))) };
    let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        let _ = sender.send(unsafe { png_of(image, error) });
    });
    unsafe { webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler) };
}

/// Ответ системы на снимок: картинка или беда.
#[cfg(target_os = "macos")]
unsafe fn png_of(
    image: *mut objc2_app_kit::NSImage,
    error: *mut objc2_foundation::NSError,
) -> Result<Vec<u8>, String> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;

    if let Some(error) = unsafe { error.as_ref() } {
        return Err(format!(
            "снимок не удался: {}",
            error.localizedDescription()
        ));
    }
    let image = unsafe { image.as_ref() }.ok_or_else(|| "снимка нет".to_string())?;
    let tiff = image
        .TIFFRepresentation()
        .ok_or_else(|| "кадр пуст".to_string())?;
    let rep =
        NSBitmapImageRep::imageRepWithData(&tiff).ok_or_else(|| "кадр не разобрать".to_string())?;
    let png = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or_else(|| "PNG не собрался".to_string())?;
    Ok(png.to_vec())
}

/// На остальных системах webview ещё не научен рассказывать о себе.
#[cfg(not(target_os = "macos"))]
fn platform_info(_platform: &tauri::webview::PlatformWebview) -> Result<(String, String), String> {
    Err("страница здесь пока не поддержана".to_string())
}

/// На остальных системах ждать нечего — считаем, что уже догрузилась.
#[cfg(not(target_os = "macos"))]
fn platform_is_loading(_platform: &tauri::webview::PlatformWebview) -> Result<bool, String> {
    Ok(false)
}

/// На остальных системах снимок ещё не переведён на webview.
#[cfg(not(target_os = "macos"))]
fn platform_snapshot(
    _platform: &tauri::webview::PlatformWebview,
    _width: u32,
    _scale: f64,
    sender: std::sync::mpsc::Sender<Result<Vec<u8>, String>>,
) {
    let _ = sender.send(Err("снимок страницы здесь пока не поддержан".to_string()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_project_always_gets_the_same_window() {
        assert_eq!(label_for("/w/one"), label_for("/w/one"));
    }

    #[test]
    fn different_projects_get_different_windows() {
        assert_ne!(label_for("/w/one"), label_for("/w/two"));
    }

    #[test]
    fn the_label_survives_paths_a_window_label_could_not_carry() {
        let label = label_for("/w/проект с пробелом/и-«кавычками»");
        assert!(
            label
                .trim_start_matches(LABEL_PREFIX)
                .chars()
                .all(|c| c.is_ascii_hexdigit()),
            "метка окна должна остаться простой: {label}"
        );
    }
}
