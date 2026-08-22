//! Выключатель MCP: помнит между запусками, включён ли сервер.
//!
//! Файл, а не память фронта: слушатель поднимается в `setup()`, когда окна ещё
//! нет и спросить у него нечего. Ждать окна нельзя — агента в восстановленной
//! панели запускают раньше, чем настройки успевают долететь.
//!
//! По умолчанию включено: файла нет у всех, кто ни разу не заходил в
//! настройки, и «нет файла» должно означать «работает как работало».

use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};

use crate::command_error::{CommandError, CommandResult, ErrorCode};

/// Имя файла в каталоге данных приложения — рядом с сокетом и событиями хуков.
const FILE_NAME: &str = "mcp.json";

/// Ключ внутри файла. Назван по тому, что выключает: сегодня весь сервер — это
/// браузер, и когда рядом встанет второй плагин, ключ не придётся переименовывать.
const KEY: &str = "browser";

/// Включён ли сервер. Любая беда с файлом читается как «включён»: остаться без
/// инструментов из-за нечитаемого байта хуже, чем показать их лишний раз.
pub fn enabled(app: &tauri::AppHandle) -> bool {
    let Some(path) = file_path(app) else {
        return true;
    };
    match std::fs::read_to_string(path) {
        Ok(text) => enabled_in(&text),
        Err(_) => true,
    }
}

/// Запоминает положение выключателя. Ошибка не молчит: без неё пользователь
/// увидел бы переключатель, который вернётся в прежнее положение после
/// перезапуска, и не понял бы почему.
pub fn save(app: &tauri::AppHandle, on: bool) -> Result<(), String> {
    let Some(path) = file_path(app) else {
        return Err("каталог данных приложения неизвестен".into());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    // Через временный файл: оборванная запись оставила бы обрезанный JSON, а
    // он читается как «включено» — то есть выключатель тихо отменил бы себя.
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, document(on)).map_err(|error| error.to_string())?;
    std::fs::rename(&temp, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        error.to_string()
    })
}

fn file_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    Some(app.path().app_data_dir().ok()?.join(FILE_NAME))
}

/// Разбор отдельно от файла: так проверяется без приложения и без диска.
fn enabled_in(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.get(KEY).and_then(Value::as_bool))
        .unwrap_or(true)
}

fn document(on: bool) -> String {
    json!({ KEY: on }).to_string()
}

/// Что показать в настройках.
///
/// `enabled` — положение выключателя, `listening` — есть ли сокет на самом
/// деле. Они расходятся там, где сервера нет и быть не может (Windows), и
/// показать надо именно второе: обещать включённый сервер, которого нет, —
/// худшее из двух.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    enabled: bool,
    listening: bool,
    /// Адрес сокета: единственный способ для человека убедиться, что сервер
    /// поднялся, и вставить путь в чужой конфиг.
    socket: Option<String>,
    /// Имена инструментов берём у самого сервера, а не переписываем в
    /// настройках: переписанный список разъехался бы с настоящим молча.
    tools: Vec<String>,
}

fn status(app: &tauri::AppHandle) -> McpStatus {
    let listening = crate::mcp::listening();
    McpStatus {
        enabled: enabled(app),
        listening,
        socket: listening
            .then(|| crate::mcp::socket_path(app))
            .flatten()
            .map(|path| path.display().to_string()),
        tools: crate::mcp::tool_names(),
    }
}

#[tauri::command]
pub fn mcp_status(window: tauri::WebviewWindow, app: tauri::AppHandle) -> CommandResult<McpStatus> {
    crate::ensure_main_window(&window)?;
    Ok(status(&app))
}

#[tauri::command]
pub fn mcp_set_enabled(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    enabled: bool,
) -> CommandResult<McpStatus> {
    crate::ensure_main_window(&window)?;
    // Сначала на диск: переключатель, который сработал, но не пережил
    // перезапуск, обманывает молча.
    save(&app, enabled)
        .map_err(|error| CommandError::new(ErrorCode::McpSettingsWriteFailed).with_debug(error))?;
    if enabled {
        crate::mcp::resume(app.clone());
    } else {
        crate::mcp::stop();
    }
    Ok(status(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_was_switched_off_stays_switched_off() {
        assert!(!enabled_in(&document(false)));
        assert!(enabled_in(&document(true)));
    }

    #[test]
    fn anything_unreadable_means_switched_on() {
        // Пустой файл, обрезанная запись, чужой ключ, не то значение — во всех
        // этих случаях приложение обязано работать как до появления
        // выключателя, а не остаться без инструментов молча.
        for text in ["", "{", "{}", r#"{"other":false}"#, r#"{"browser":"нет"}"#] {
            assert!(enabled_in(text), "{text}");
        }
    }
}
