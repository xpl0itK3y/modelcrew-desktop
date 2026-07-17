// Постоянный кеш скачанных обновлений. Артефакт и его метаданные лежат в
// app-cache и переживают перезапуск приложения: после рестарта проверка
// находит готовый файл и обновление снова «готово к установке» без повторной
// загрузки. Модуль также выполняет self-update (macOS/Windows/AppImage):
// скачивание идёт на Rust-стороне, чтобы байты можно было сохранить на диск.

use crate::command_error::{CommandError, CommandResult, ErrorCode};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

pub const SELF_UPDATE_KIND: &str = "self";
const META_FILE: &str = "meta.json";
const ARTIFACT_FILE: &str = "artifact.bin";
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "phase",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UpdateProgress {
    Downloading {
        downloaded: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
    },
    Verifying,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedUpdateMeta {
    pub version: String,
    // Явный updater-target ("" — таргет платформы по умолчанию).
    pub target: String,
    // "self" либо суффикс нативного пакета ("deb"/"rpm"/"pacman").
    pub kind: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

pub fn parse_exact_version(version: &str) -> CommandResult<Version> {
    let parsed = Version::parse(version).map_err(|error| {
        CommandError::new(ErrorCode::UpdaterInvalidVersion)
            .with_context("version", version)
            .with_debug(error)
    })?;
    if parsed.to_string() != version {
        return Err(
            CommandError::new(ErrorCode::UpdaterInvalidVersion).with_context("version", version)
        );
    }
    Ok(parsed)
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub fn sha256_file(path: &Path) -> CommandResult<(String, u64)> {
    let mut file = fs::File::open(path)
        .map_err(|error| CommandError::new(ErrorCode::UpdaterCacheMissing).with_debug(error))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut size = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| CommandError::new(ErrorCode::UpdaterCacheInvalid).with_debug(error))?;
        if read == 0 {
            break;
        }
        size += read as u64;
        hasher.update(&buffer[..read]);
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

pub fn pending_update_dir(app: &tauri::AppHandle) -> CommandResult<PathBuf> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|error| CommandError::new(ErrorCode::UpdaterCacheWriteFailed).with_debug(error))?;
    Ok(base.join("pending-update"))
}

// Читает кеш с диска. Устаревший артефакт (обновление уже применено или файл
// пропал) удаляется на месте, чтобы не занимать место до следующего релиза.
pub fn load_cached(dir: &Path, current_version: &Version) -> Option<(CachedUpdateMeta, PathBuf)> {
    let raw = fs::read_to_string(dir.join(META_FILE)).ok()?;
    let meta: CachedUpdateMeta = serde_json::from_str(&raw).ok()?;
    let fresh = Version::parse(&meta.version).is_ok_and(|version| version > *current_version);
    let artifact = dir.join(ARTIFACT_FILE);
    if !fresh || !artifact.is_file() {
        clear_cached(dir);
        return None;
    }
    Some((meta, artifact))
}

pub fn verify_cached(meta: &CachedUpdateMeta, artifact: &Path) -> bool {
    sha256_file(artifact).is_ok_and(|(sha256, size)| sha256 == meta.sha256 && size == meta.size)
}

pub(crate) fn updater_public_key(app: &tauri::AppHandle) -> CommandResult<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            CommandError::new(ErrorCode::UpdaterCacheInvalid)
                .with_context("reason", "updaterPublicKey")
        })
}

fn decode_signed_text(value: &str, field: &str) -> CommandResult<String> {
    let decoded = BASE64.decode(value).map_err(|error| {
        CommandError::new(ErrorCode::UpdaterCacheInvalid)
            .with_context("reason", field)
            .with_debug(error)
    })?;
    String::from_utf8(decoded).map_err(|error| {
        CommandError::new(ErrorCode::UpdaterCacheInvalid)
            .with_context("reason", field)
            .with_debug(error)
    })
}

/// Re-verifies bytes loaded from the user-writable persistent cache against
/// the signature from the freshly fetched updater manifest. SHA-256 beside the
/// artifact only detects accidental corruption; it is not a trust boundary.
pub(crate) fn verify_update_signature(
    bytes: &[u8],
    release_signature: &str,
    public_key: &str,
) -> CommandResult<()> {
    let public_key =
        PublicKey::decode(&decode_signed_text(public_key, "publicKey")?).map_err(|error| {
            CommandError::new(ErrorCode::UpdaterCacheInvalid)
                .with_context("reason", "publicKey")
                .with_debug(error)
        })?;
    let signature = Signature::decode(&decode_signed_text(release_signature, "signature")?)
        .map_err(|error| {
            CommandError::new(ErrorCode::UpdaterCacheInvalid)
                .with_context("reason", "signature")
                .with_debug(error)
        })?;
    public_key.verify(bytes, &signature, true).map_err(|error| {
        CommandError::new(ErrorCode::UpdaterCacheInvalid)
            .with_context("reason", "signature")
            .with_debug(error)
    })
}

pub(crate) fn verify_cached_update_signature(
    cache_dir: &Path,
    bytes: &[u8],
    release_signature: &str,
    public_key: &str,
) -> CommandResult<()> {
    match verify_update_signature(bytes, release_signature, public_key) {
        Ok(()) => Ok(()),
        Err(error) => {
            // A failed signature is not a retryable installer failure. Remove
            // both user-writable files so the next check must download again.
            clear_cached(cache_dir);
            Err(error)
        }
    }
}

// Пишет артефакт, затем метаданные (наличие meta.json означает, что артефакт
// записан целиком); обе записи идут через rename для атомарности.
pub fn store_cached(dir: &Path, meta: &CachedUpdateMeta, bytes: &[u8]) -> CommandResult<PathBuf> {
    let write_failed = |error: std::io::Error| {
        CommandError::new(ErrorCode::UpdaterCacheWriteFailed).with_debug(error)
    };
    fs::create_dir_all(dir).map_err(write_failed)?;
    let _ = fs::remove_file(dir.join(META_FILE));

    let artifact_tmp = dir.join("artifact.tmp");
    fs::write(&artifact_tmp, bytes).map_err(write_failed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&artifact_tmp, fs::Permissions::from_mode(0o600))
            .map_err(write_failed)?;
    }
    let artifact = dir.join(ARTIFACT_FILE);
    fs::rename(&artifact_tmp, &artifact).map_err(write_failed)?;

    let meta_tmp = dir.join("meta.tmp");
    let payload = serde_json::to_string(meta)
        .map_err(|error| CommandError::new(ErrorCode::UpdaterCacheWriteFailed).with_debug(error))?;
    fs::write(&meta_tmp, payload).map_err(write_failed)?;
    fs::rename(&meta_tmp, dir.join(META_FILE)).map_err(write_failed)?;
    Ok(artifact)
}

pub fn clear_cached(dir: &Path) {
    let _ = fs::remove_file(dir.join(META_FILE));
    let _ = fs::remove_file(dir.join(ARTIFACT_FILE));
}

pub struct SelfUpdaterState {
    busy: Arc<AtomicBool>,
}

impl Default for SelfUpdaterState {
    fn default() -> Self {
        Self {
            busy: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl SelfUpdaterState {
    fn begin_operation(&self) -> CommandResult<OperationGuard> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| CommandError::new(ErrorCode::UpdaterOperationInProgress))?;
        Ok(OperationGuard(self.busy.clone()))
    }
}

struct OperationGuard(Arc<AtomicBool>);

impl Drop for OperationGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn build_updater(
    app: &tauri::AppHandle,
    target: Option<&str>,
) -> CommandResult<tauri_plugin_updater::Updater> {
    let mut builder = app.updater_builder().timeout(UPDATE_CHECK_TIMEOUT);
    if let Some(target) = target {
        builder = builder.target(target.to_owned());
    }
    builder
        .build()
        .map_err(|error| CommandError::new(ErrorCode::UpdaterCheckFailed).with_debug(error))
}

pub(crate) async fn check_for_version(
    app: &tauri::AppHandle,
    target: Option<&str>,
    version: &str,
) -> CommandResult<tauri_plugin_updater::Update> {
    let update = build_updater(app, target)?
        .check()
        .await
        .map_err(|error| CommandError::new(ErrorCode::UpdaterCheckFailed).with_debug(error))?
        .ok_or_else(|| {
            CommandError::new(ErrorCode::UpdaterVersionUnavailable).with_context("version", version)
        })?;
    if update.version != version {
        return Err(CommandError::new(ErrorCode::UpdaterVersionUnavailable)
            .with_context("version", version)
            .with_context("availableVersion", update.version));
    }
    Ok(update)
}

async fn prepare_self_update(
    app: tauri::AppHandle,
    state: &SelfUpdaterState,
    version: String,
    target: Option<String>,
    on_progress: Channel<UpdateProgress>,
) -> CommandResult<()> {
    parse_exact_version(&version)?;
    let _operation = state.begin_operation()?;
    let dir = pending_update_dir(&app)?;
    let current_version = app.package_info().version.clone();
    let cache_target = target.clone().unwrap_or_default();

    if let Some((meta, artifact)) = load_cached(&dir, &current_version) {
        if meta.kind == SELF_UPDATE_KIND && meta.version == version && meta.target == cache_target {
            let _ = on_progress.send(UpdateProgress::Verifying);
            if verify_cached(&meta, &artifact) {
                return Ok(());
            }
            clear_cached(&dir);
        }
    }

    let mut update = check_for_version(&app, target.as_deref(), &version).await?;
    // Таймаут UpdaterBuilder покрывает только проверку манифеста; для
    // скачивания артефакта выставляем свой явно (updater 2.10.1 не копирует).
    update.timeout = Some(UPDATE_DOWNLOAD_TIMEOUT);

    let downloaded = Arc::new(AtomicU64::new(0));
    let reported_total = Arc::new(AtomicU64::new(0));
    let download_counter = downloaded.clone();
    let total_counter = reported_total.clone();
    let progress_channel = on_progress.clone();
    let verify_channel = on_progress.clone();
    let bytes = update
        .download(
            move |chunk_size, total| {
                let chunk_size = u64::try_from(chunk_size).unwrap_or(u64::MAX);
                let current = download_counter
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                        Some(value.saturating_add(chunk_size))
                    })
                    .unwrap_or_else(|value| value)
                    .saturating_add(chunk_size);
                if let Some(total) = total {
                    total_counter.store(total, Ordering::Release);
                }
                let _ = progress_channel.send(UpdateProgress::Downloading {
                    downloaded: current,
                    total,
                });
            },
            move || {
                // Tauri зовёт это прямо перед своей проверкой подписи.
                let _ = verify_channel.send(UpdateProgress::Verifying);
            },
        )
        .await
        .map_err(|error| {
            CommandError::new(ErrorCode::UpdaterDownloadFailed)
                .with_context("version", &version)
                .with_debug(error)
        })?;

    let total = match reported_total.load(Ordering::Acquire) {
        0 => None,
        value => Some(value),
    };
    let meta = CachedUpdateMeta {
        version,
        target: cache_target,
        kind: SELF_UPDATE_KIND.to_owned(),
        sha256: sha256_bytes(&bytes),
        size: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
        total,
    };
    store_cached(&dir, &meta, &bytes)?;
    Ok(())
}

async fn install_self_update(
    app: tauri::AppHandle,
    state: &SelfUpdaterState,
    version: String,
    target: Option<String>,
) -> CommandResult<()> {
    parse_exact_version(&version)?;
    let _operation = state.begin_operation()?;
    let dir = pending_update_dir(&app)?;
    let current_version = app.package_info().version.clone();
    let cache_target = target.clone().unwrap_or_default();

    let cached = load_cached(&dir, &current_version).filter(|(meta, _)| {
        meta.kind == SELF_UPDATE_KIND && meta.version == version && meta.target == cache_target
    });
    let Some((meta, artifact)) = cached else {
        return Err(
            CommandError::new(ErrorCode::UpdaterCacheMissing).with_context("version", &version)
        );
    };
    if !verify_cached(&meta, &artifact) {
        clear_cached(&dir);
        return Err(
            CommandError::new(ErrorCode::UpdaterCacheInvalid).with_context("version", &version)
        );
    }

    // Свежая сверка с манифестом: если релиз заменили, кеш недействителен.
    let update = check_for_version(&app, target.as_deref(), &version).await?;
    let bytes = fs::read(&artifact).map_err(|error| {
        clear_cached(&dir);
        CommandError::new(ErrorCode::UpdaterCacheInvalid).with_debug(error)
    })?;
    // Кеш переживает перезапуск и доступен пользователю, поэтому локального
    // sha256 недостаточно: связываем байты со свежей подписью из манифеста.
    let public_key = updater_public_key(&app)?;
    verify_cached_update_signature(&dir, &bytes, &update.signature, &public_key)?;
    update
        .install(bytes)
        .map_err(|error| CommandError::new(ErrorCode::UpdaterInstallFailed).with_debug(error))?;
    clear_cached(&dir);
    Ok(())
}

#[tauri::command]
pub async fn updater_prepare_self_update(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, SelfUpdaterState>,
    version: String,
    target: Option<String>,
    on_progress: Channel<UpdateProgress>,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    prepare_self_update(app, &state, version, target, on_progress).await
}

#[tauri::command]
pub async fn updater_install_self_update(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, SelfUpdaterState>,
    version: String,
    target: Option<String>,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    install_self_update(app, &state, version, target).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(version: &str, bytes: &[u8]) -> CachedUpdateMeta {
        CachedUpdateMeta {
            version: version.to_owned(),
            target: String::new(),
            kind: SELF_UPDATE_KIND.to_owned(),
            sha256: sha256_bytes(bytes),
            size: bytes.len() as u64,
            total: Some(bytes.len() as u64),
        }
    }

    #[test]
    fn stores_and_loads_a_pending_update() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"artifact-bytes";
        let stored = store_cached(dir.path(), &meta("0.2.0", bytes), bytes).unwrap();

        let current = Version::parse("0.1.0").unwrap();
        let (loaded, artifact) = load_cached(dir.path(), &current).unwrap();
        assert_eq!(loaded.version, "0.2.0");
        assert_eq!(artifact, stored);
        assert!(verify_cached(&loaded, &artifact));
        assert_eq!(fs::read(&artifact).unwrap(), bytes);
    }

    #[test]
    fn drops_the_cache_once_the_update_is_applied() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"already-installed";
        store_cached(dir.path(), &meta("0.2.0", bytes), bytes).unwrap();

        // После установки 0.2.0 текущая версия >= кешированной: кеш стирается.
        let current = Version::parse("0.2.0").unwrap();
        assert!(load_cached(dir.path(), &current).is_none());
        assert!(!dir.path().join(ARTIFACT_FILE).exists());
        assert!(!dir.path().join(META_FILE).exists());
    }

    #[test]
    fn detects_a_tampered_artifact() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"good-bytes";
        store_cached(dir.path(), &meta("0.2.0", bytes), bytes).unwrap();
        fs::write(dir.path().join(ARTIFACT_FILE), b"evil-bytes").unwrap();

        let current = Version::parse("0.1.0").unwrap();
        let (loaded, artifact) = load_cached(dir.path(), &current).unwrap();
        assert!(!verify_cached(&loaded, &artifact));
    }

    #[test]
    fn rejects_a_cache_without_an_artifact() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"payload";
        store_cached(dir.path(), &meta("0.2.0", bytes), bytes).unwrap();
        fs::remove_file(dir.path().join(ARTIFACT_FILE)).unwrap();

        let current = Version::parse("0.1.0").unwrap();
        assert!(load_cached(dir.path(), &current).is_none());
        // Осиротевшие метаданные вычищены.
        assert!(!dir.path().join(META_FILE).exists());
    }

    #[test]
    fn replaces_a_previous_pending_update() {
        let dir = tempfile::tempdir().unwrap();
        let old = b"version-2";
        store_cached(dir.path(), &meta("0.2.0", old), old).unwrap();
        let new = b"version-3-longer-payload";
        store_cached(dir.path(), &meta("0.3.0", new), new).unwrap();

        let current = Version::parse("0.1.0").unwrap();
        let (loaded, artifact) = load_cached(dir.path(), &current).unwrap();
        assert_eq!(loaded.version, "0.3.0");
        assert!(verify_cached(&loaded, &artifact));
    }

    #[test]
    fn parses_only_exact_versions() {
        assert!(parse_exact_version("1.2.3").is_ok());
        assert!(parse_exact_version("v1.2.3").is_err());
        assert!(parse_exact_version("1.2.3 ").is_err());
        assert!(parse_exact_version("01.2.3").is_err());
    }

    #[test]
    fn cached_bytes_must_match_the_fresh_manifest_signature() {
        const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        let public_key = BASE64.encode(PUBLIC_KEY);
        let signature = BASE64.encode(SIGNATURE);

        verify_update_signature(b"test", &signature, &public_key).unwrap();
        let error = verify_update_signature(b"tampered", &signature, &public_key).unwrap_err();
        assert_eq!(error.code, ErrorCode::UpdaterCacheInvalid);
        assert_eq!(error.context["reason"], "signature");
    }

    #[test]
    fn signature_mismatch_evicts_the_untrusted_cache() {
        const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        let dir = tempfile::tempdir().unwrap();
        let tampered = b"tampered";
        store_cached(dir.path(), &meta("0.2.0", tampered), tampered).unwrap();

        let error = verify_cached_update_signature(
            dir.path(),
            tampered,
            &BASE64.encode(SIGNATURE),
            &BASE64.encode(PUBLIC_KEY),
        )
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::UpdaterCacheInvalid);
        assert!(!dir.path().join(ARTIFACT_FILE).exists());
        assert!(!dir.path().join(META_FILE).exists());
    }
}
