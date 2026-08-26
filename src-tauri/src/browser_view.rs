//! Страница глазами человека: кадр браузера для панели ModelCrew.
//!
//! Браузер работает без своего окна, поэтому единственный, кто может показать
//! страницу пользователю, — само приложение. Отсюда и команда: интерфейс
//! просит кадр, бэкенд снимает его через CDP и отдаёт готовой картинкой.
//!
//! Кадр — PNG в base64, вставляется в `img` как `data:`-адрес. Отдельного
//! разрешения на это не нужно: `img-src` в CSP уже допускает `data:`.

use serde::Serialize;

use crate::command_error::{CommandError, CommandResult, ErrorCode};
use crate::workspace_roots::WorkspaceRoots;

/// Что показать в панели браузера.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFrame {
    /// Кадр страницы, PNG в base64. Пусто, когда браузера ещё нет.
    pub image: String,
    pub url: String,
    pub title: String,
    /// Поднят ли браузер этого проекта. По нему панель решает, показывать
    /// картинку или приглашение «здесь пока пусто».
    pub running: bool,
}

impl BrowserFrame {
    fn idle() -> Self {
        Self {
            image: String::new(),
            url: String::new(),
            title: String::new(),
            running: false,
        }
    }
}

/// Кадр страницы проекта.
///
/// Страница здесь **не открывается**: панель открыта у человека постоянно, и
/// её открытие не повод заводить страницу. Пока страницы нет, панель получает
/// пустой кадр и говорит об этом сама.
#[tauri::command]
pub async fn browser_frame(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    width: Option<f64>,
    height: Option<f64>,
) -> CommandResult<BrowserFrame> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    let key = root.to_string_lossy().to_string();
    if !crate::browser_page::is_open(&app, &key) {
        return Ok(BrowserFrame::idle());
    }
    // Размер места, где кадр покажут, знает только панель. Не подогнав под
    // него страницу, мы отдали бы картинку другой формы: по ширине её
    // растянут, а снизу останется пустая полоса.
    if let (Some(width), Some(height)) = (width, height) {
        // Неудача здесь не повод остаться без кадра: покажем прежней формы.
        let _ = crate::browser_page::fit(&app, &key, width, height);
    }

    // Снимок делает система и отвечает не сразу. На рантайме команд ждать его
    // нельзя — на нём же стоят в очереди остальные вызовы интерфейса, а за
    // кадром сюда приходят каждую секунду.
    tauri::async_runtime::spawn_blocking(move || {
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

        let png = crate::browser_page::snapshot(&app, &key).map_err(|reason| {
            CommandError::new(ErrorCode::BrowserCommandFailed).with_context("reason", reason)
        })?;
        // Адрес и заголовок не критичны: без них панель покажет картинку без
        // подписи, и это лучше, чем ошибка вместо страницы.
        let (url, title) = crate::browser_page::info(&app, &key).unwrap_or_default();
        Ok(BrowserFrame {
            image: BASE64.encode(png),
            url,
            title,
            running: true,
        })
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::BrowserCommandFailed).with_debug(error))?
}

/// Открыть страницу по просьбе человека, а не агента.
#[tauri::command]
pub async fn browser_go(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    url: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    // Здесь страницу как раз открываем: человек попросил её открыть.
    let key = root.to_string_lossy().to_string();
    if !crate::browser_page::is_web(&url) {
        return Err(CommandError::new(ErrorCode::BrowserUrlUnsupported).with_context("url", url));
    }
    crate::browser_page::open(&app, &key, &url).map_err(|reason| {
        CommandError::new(ErrorCode::BrowserCommandFailed).with_context("reason", reason)
    })
}
