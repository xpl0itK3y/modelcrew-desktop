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
    /// Стоит ли страница сейчас живой в панели. Панель сверяет с этим своё:
    /// страницу могли открыть заново или вернуть домой, пока окно прятали.
    pub docked: bool,
    /// Умеет ли система показать страницу живой. Где не умеет — только кадр.
    pub dockable: bool,
}

impl BrowserFrame {
    fn idle() -> Self {
        Self {
            image: String::new(),
            url: String::new(),
            title: String::new(),
            running: false,
            docked: false,
            dockable: crate::browser_page::CAN_DOCK,
        }
    }
}

/// Кадр страницы проекта.
///
/// Страница здесь **не открывается**: панель открыта у человека постоянно, и
/// её открытие не повод заводить страницу. Пока страницы нет, панель получает
/// пустой кадр и говорит об этом сама.
///
/// `picture: false` — картинка не нужна: страница стоит в панели живой, и
/// панели хватает адреса с заголовком. Снимок стоил бы времени впустую.
#[tauri::command]
pub async fn browser_frame(
    window: tauri::Webview,
    app: tauri::AppHandle,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    width: Option<f64>,
    height: Option<f64>,
    picture: Option<bool>,
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

        let image = if picture.unwrap_or(true) {
            let png = crate::browser_page::snapshot(&app, &key).map_err(|reason| {
                CommandError::new(ErrorCode::BrowserCommandFailed).with_context("reason", reason)
            })?;
            BASE64.encode(png)
        } else {
            String::new()
        };
        // Адрес и заголовок не критичны: без них панель покажет картинку без
        // подписи, и это лучше, чем ошибка вместо страницы.
        let (url, title) = crate::browser_page::info(&app, &key).unwrap_or_default();
        Ok(BrowserFrame {
            image,
            url,
            title,
            running: true,
            docked: crate::browser_page::is_docked(&app, &key),
            dockable: crate::browser_page::CAN_DOCK,
        })
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::BrowserCommandFailed).with_debug(error))?
}

/// Открыть страницу по просьбе человека, а не агента.
#[tauri::command]
pub async fn browser_go(
    window: tauri::Webview,
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

/// Показать страницу проекта живой на месте панели браузера.
///
/// Место — точки от левого верхнего угла окна. Где система этого не умеет,
/// отказ: панель останется при кадре.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser_dock(
    window: tauri::Webview,
    app: tauri::AppHandle,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    let key = root.to_string_lossy().to_string();
    let place = crate::browser_page::Place {
        x,
        y,
        width,
        height,
    };
    crate::browser_page::dock(&app, &key, place).map_err(|reason| {
        CommandError::new(ErrorCode::BrowserCommandFailed).with_context("reason", reason)
    })
}

/// Убрать страницу проекта из панели обратно в её окно.
#[tauri::command]
pub async fn browser_undock(
    window: tauri::Webview,
    app: tauri::AppHandle,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    let key = root.to_string_lossy().to_string();
    crate::browser_page::undock(&app, &key).map_err(|reason| {
        CommandError::new(ErrorCode::BrowserCommandFailed).with_context("reason", reason)
    })
}

/// Назад, вперёд или заново — кнопки над страницей в панели.
#[tauri::command]
pub async fn browser_step(
    window: tauri::Webview,
    app: tauri::AppHandle,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    step: crate::browser_page::Step,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    let key = root.to_string_lossy().to_string();
    crate::browser_page::step(&app, &key, step).map_err(|reason| {
        CommandError::new(ErrorCode::BrowserCommandFailed).with_context("reason", reason)
    })
}
