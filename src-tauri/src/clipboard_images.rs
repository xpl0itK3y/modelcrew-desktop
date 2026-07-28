use crate::command_error::{CommandError, CommandResult, ErrorCode};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request};
use tauri::Manager;

const CLIPBOARD_IMAGE_DIR: &str = "clipboard-images";
const MAX_CLIPBOARD_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGE_AGE: Duration = Duration::from_secs(24 * 60 * 60);

fn invalid_image() -> CommandError {
    CommandError::new(ErrorCode::TerminalClipboardImageInvalid)
}

fn storage_error(error: impl ToString) -> CommandError {
    CommandError::new(ErrorCode::TerminalClipboardImageStorageFailed).with_debug(error)
}

fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(".png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some(".jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(".gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some(".webp")
    } else {
        None
    }
}

fn prune_expired_images(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let expired = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .map(|age| age > MAX_CLIPBOARD_IMAGE_AGE)
            .unwrap_or(false);
        if expired {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn save_clipboard_image(dir: &Path, bytes: &[u8]) -> CommandResult<PathBuf> {
    if bytes.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err(CommandError::new(ErrorCode::TerminalClipboardImageTooLarge));
    }
    let extension = image_extension(bytes).ok_or_else(invalid_image)?;

    fs::create_dir_all(dir).map_err(storage_error)?;
    prune_expired_images(dir);

    let mut file = tempfile::Builder::new()
        .prefix("clipboard-")
        .suffix(extension)
        .tempfile_in(dir)
        .map_err(storage_error)?;
    file.write_all(bytes).map_err(storage_error)?;
    file.flush().map_err(storage_error)?;
    let (_, path) = file.keep().map_err(|error| storage_error(error.error))?;
    Ok(path)
}

fn clipboard_images_dir(app: &tauri::AppHandle) -> CommandResult<PathBuf> {
    let base = app.path().app_cache_dir().map_err(storage_error)?;
    Ok(base.join(CLIPBOARD_IMAGE_DIR))
}

#[tauri::command]
pub fn terminal_clipboard_image_save(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request: Request<'_>,
) -> CommandResult<String> {
    super::ensure_main_window(&window)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(invalid_image());
    };
    let path = save_clipboard_image(&clipboard_images_dir(&app)?, bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "modelcrew-clipboard-images-{label}-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn supported_image_is_saved_with_detected_extension() {
        let dir = temp_dir("png");
        let bytes = b"\x89PNG\r\n\x1a\nclipboard image";

        let path = save_clipboard_image(&dir, bytes).unwrap();

        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("png")
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn image_type_comes_from_magic_bytes() {
        assert_eq!(image_extension(b"\xff\xd8\xffjpeg"), Some(".jpg"));
        assert_eq!(image_extension(b"GIF89agif"), Some(".gif"));
        assert_eq!(image_extension(b"RIFF0000WEBPdata"), Some(".webp"));
        assert_eq!(image_extension(b"not an image"), None);
    }

    #[test]
    fn invalid_and_oversized_images_have_stable_errors() {
        let dir = temp_dir("invalid");
        let invalid = save_clipboard_image(&dir, b"not an image").unwrap_err();
        assert_eq!(invalid.code, ErrorCode::TerminalClipboardImageInvalid);

        let oversized = vec![0; MAX_CLIPBOARD_IMAGE_BYTES + 1];
        let too_large = save_clipboard_image(&dir, &oversized).unwrap_err();
        assert_eq!(too_large.code, ErrorCode::TerminalClipboardImageTooLarge);
        let _ = fs::remove_dir_all(dir);
    }
}
