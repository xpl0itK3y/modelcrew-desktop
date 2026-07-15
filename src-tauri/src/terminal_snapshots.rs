use crate::command_error::{CommandError, CommandResult, ErrorCode};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

// Снимки текста терминалов (сериализованный буфер xterm) переживают полный
// выход из приложения: при следующем запуске панель показывает прежнюю
// историю, а поверх стартует свежая оболочка. Файл на панель, атомарная
// запись, жёсткий предел размера.

const SNAPSHOT_DIR: &str = "terminal-snapshots";
const SNAPSHOT_EXT: &str = "ans";
const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;

fn validate_snapshot_id(id: &str) -> CommandResult<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(
            CommandError::new(ErrorCode::TerminalSnapshotInvalidId).with_context("id", id)
        );
    }
    Ok(())
}

fn snapshot_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.{SNAPSHOT_EXT}"))
}

fn storage_error(error: std::io::Error) -> CommandError {
    CommandError::new(ErrorCode::TerminalSnapshotStorageFailed).with_debug(error)
}

pub fn save_snapshot(dir: &Path, id: &str, data: &str) -> CommandResult<()> {
    validate_snapshot_id(id)?;
    if data.len() > MAX_SNAPSHOT_BYTES {
        return Err(CommandError::new(ErrorCode::TerminalSnapshotTooLarge)
            .with_context("bytes", data.len()));
    }
    fs::create_dir_all(dir).map_err(storage_error)?;

    // Атомарно: незавершённая запись не должна портить прежний снимок.
    let final_path = snapshot_path(dir, id);
    let tmp_path = dir.join(format!("{id}.{SNAPSHOT_EXT}.tmp"));
    {
        let mut file = fs::File::create(&tmp_path).map_err(storage_error)?;
        file.write_all(data.as_bytes()).map_err(storage_error)?;
        file.flush().map_err(storage_error)?;
    }
    fs::rename(&tmp_path, &final_path).map_err(storage_error)
}

pub fn load_snapshot(dir: &Path, id: &str) -> CommandResult<Option<String>> {
    validate_snapshot_id(id)?;
    match fs::read_to_string(snapshot_path(dir, id)) {
        Ok(data) => Ok(Some(data)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(storage_error(error)),
    }
}

pub fn delete_snapshot(dir: &Path, id: &str) -> CommandResult<()> {
    validate_snapshot_id(id)?;
    match fs::remove_file(snapshot_path(dir, id)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(storage_error(error)),
    }
}

/// Удаляет снимки, чьих панелей больше нет ни в одной сохранённой раскладке.
pub fn prune_snapshots(dir: &Path, keep: &[String]) -> CommandResult<()> {
    for id in keep {
        validate_snapshot_id(id)?;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(storage_error(error)),
    };
    for entry in entries {
        let entry = entry.map_err(storage_error)?;
        let path = entry.path();
        // Трогаем только собственные файлы снимков (включая брошенные .tmp).
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let stem = name
            .strip_suffix(&format!(".{SNAPSHOT_EXT}.tmp"))
            .or_else(|| name.strip_suffix(&format!(".{SNAPSHOT_EXT}")));
        let Some(stem) = stem else {
            continue;
        };
        if !keep.iter().any(|id| id == stem) {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(storage_error(error)),
            }
        }
    }
    Ok(())
}

fn snapshots_dir(app: &tauri::AppHandle) -> CommandResult<PathBuf> {
    let base = app.path().app_data_dir().map_err(|error| {
        CommandError::new(ErrorCode::TerminalSnapshotStorageFailed).with_debug(error)
    })?;
    Ok(base.join(SNAPSHOT_DIR))
}

#[tauri::command]
pub fn terminal_snapshot_save(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    data: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    save_snapshot(&snapshots_dir(&app)?, &id, &data)
}

#[tauri::command]
pub fn terminal_snapshot_load(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> CommandResult<Option<String>> {
    super::ensure_main_window(&window)?;
    load_snapshot(&snapshots_dir(&app)?, &id)
}

#[tauri::command]
pub fn terminal_snapshot_delete(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    delete_snapshot(&snapshots_dir(&app)?, &id)
}

#[tauri::command]
pub fn terminal_snapshots_prune(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    keep: Vec<String>,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    prune_snapshots(&snapshots_dir(&app)?, &keep)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "modelcrew-terminal-snapshots-{label}-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        path
    }

    #[test]
    fn save_load_roundtrip_and_delete() {
        let dir = temp_dir("roundtrip");
        save_snapshot(&dir, "panel-1", "\x1b[32mhello\x1b[0m").unwrap();
        assert_eq!(
            load_snapshot(&dir, "panel-1").unwrap().as_deref(),
            Some("\x1b[32mhello\x1b[0m")
        );

        delete_snapshot(&dir, "panel-1").unwrap();
        assert_eq!(load_snapshot(&dir, "panel-1").unwrap(), None);
        // Повторное удаление отсутствующего файла — не ошибка.
        delete_snapshot(&dir, "panel-1").unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_snapshot_loads_as_none() {
        let dir = temp_dir("missing");
        assert_eq!(load_snapshot(&dir, "unknown").unwrap(), None);
    }

    #[test]
    fn invalid_ids_are_rejected() {
        let dir = temp_dir("invalid");
        for id in ["", "../escape", "a/b", "id with space", &"x".repeat(129)] {
            let error = save_snapshot(&dir, id, "data").unwrap_err();
            assert_eq!(error.code, ErrorCode::TerminalSnapshotInvalidId);
        }
    }

    #[test]
    fn oversized_snapshot_is_rejected() {
        let dir = temp_dir("oversize");
        let data = "x".repeat(MAX_SNAPSHOT_BYTES + 1);
        let error = save_snapshot(&dir, "panel", &data).unwrap_err();
        assert_eq!(error.code, ErrorCode::TerminalSnapshotTooLarge);
    }

    #[test]
    fn prune_keeps_only_listed_snapshots() {
        let dir = temp_dir("prune");
        save_snapshot(&dir, "keep-me", "a").unwrap();
        save_snapshot(&dir, "drop-me", "b").unwrap();
        // Брошенный tmp-файл тоже вычищается.
        fs::write(dir.join("stale.ans.tmp"), "junk").unwrap();
        // Чужие файлы не трогаем.
        fs::write(dir.join("unrelated.txt"), "keep").unwrap();

        prune_snapshots(&dir, &["keep-me".into()]).unwrap();

        assert!(load_snapshot(&dir, "keep-me").unwrap().is_some());
        assert!(load_snapshot(&dir, "drop-me").unwrap().is_none());
        assert!(!dir.join("stale.ans.tmp").exists());
        assert!(dir.join("unrelated.txt").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn prune_of_missing_dir_is_ok() {
        let dir = temp_dir("no-dir");
        prune_snapshots(&dir, &[]).unwrap();
    }
}
