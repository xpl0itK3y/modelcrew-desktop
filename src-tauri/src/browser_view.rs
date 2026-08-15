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
/// Браузер здесь **не поднимается**: панель открыта у человека постоянно, и
/// её открытие не повод запускать Chrome. Пока браузера нет, панель получает
/// пустой кадр и говорит об этом сама.
#[tauri::command]
pub async fn browser_frame(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    browsers: tauri::State<'_, crate::browser_host::BrowserHost>,
    workspace_id: String,
) -> CommandResult<BrowserFrame> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    let Some(port) = browsers.port(&root.to_string_lossy()) else {
        return Ok(BrowserFrame::idle());
    };

    let mut cdp = crate::cdp::Cdp::connect(port)?;
    let image = cdp.screenshot()?;
    // Адрес и заголовок не критичны: без них панель покажет картинку без
    // подписи, и это лучше, чем ошибка вместо страницы.
    let (url, title) = cdp.location().unwrap_or_default();
    Ok(BrowserFrame {
        image,
        url,
        title,
        running: true,
    })
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
    // Здесь браузер как раз поднимаем: человек попросил открыть страницу.
    let port = crate::mcp::browser_port(&app, &root)
        .map_err(|reason| CommandError::new(ErrorCode::BrowserLaunchFailed).with_debug(reason))?;
    crate::cdp::Cdp::connect(port)?.navigate(&url)
}
