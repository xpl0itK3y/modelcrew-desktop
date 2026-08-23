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

/// Размер страницы. От него зависит вёрстка, которую увидят и агент, и
/// человек, поэтому он задан явно, а не отдан на волю системы.
const VIEWPORT: (f64, f64) = (1280.0, 800.0);

/// Куда убрано окно страницы.
///
/// Спрятанное окно система не рисует, а нам нужен настоящий кадр. Поэтому
/// окно остаётся видимым для системы, но стоит за краем любого экрана.
const OFFSCREEN: (f64, f64) = (-31_000.0, -31_000.0);

/// Сколько ждать кадр. Снимок делает система и отвечает не сразу; ждать
/// вечно нельзя — на том конце живой агент.
const SNAPSHOT_WAIT: Duration = Duration::from_secs(5);

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
    format!("page-{name}")
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

/// Открыта ли страница проекта.
pub fn is_open(app: &AppHandle, root: &str) -> bool {
    app.get_webview_window(&label_for(root)).is_some()
}

/// Закрыть страницу проекта.
pub fn close(app: &AppHandle, root: &str) {
    if let Some(window) = app.get_webview_window(&label_for(root)) {
        let _ = window.close();
    }
}

/// Кадр страницы проекта, PNG.
pub fn snapshot(app: &AppHandle, root: &str) -> Result<Vec<u8>, String> {
    let window = app
        .get_webview_window(&label_for(root))
        .ok_or_else(|| "страница ещё не открыта".to_string())?;
    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .with_webview(move |platform| {
            // Снимок начинает система и отвечает позже своим вызовом, поэтому
            // ответ уходит в канал, а не возвращается отсюда.
            platform_snapshot(&platform, sender);
        })
        .map_err(|error| format!("до страницы не достучаться: {error}"))?;
    match receiver.recv_timeout(SNAPSHOT_WAIT) {
        Ok(result) => result,
        Err(_) => Err("страница не отдала кадр".to_string()),
    }
}

/// Снимок средствами системы.
#[cfg(target_os = "macos")]
fn platform_snapshot(
    platform: &tauri::webview::PlatformWebview,
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
    // На ретине система отдала бы кадр вдвое больше страницы. Агенту он
    // уходит картинкой в ответе, поэтому просим ровно ширину страницы:
    // вчетверо меньше байт при той же вёрстке.
    unsafe { config.setSnapshotWidth(Some(&NSNumber::new_u32(VIEWPORT.0 as u32))) };
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

/// На остальных системах снимок ещё не переведён на webview.
#[cfg(not(target_os = "macos"))]
fn platform_snapshot(
    _platform: &tauri::webview::PlatformWebview,
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
                .trim_start_matches("page-")
                .chars()
                .all(|c| c.is_ascii_hexdigit()),
            "метка окна должна остаться простой: {label}"
        );
    }
}
