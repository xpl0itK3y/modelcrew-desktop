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

    // Настоящая пара minisign: подпись покрывает ровно байты SIGNED_BYTES.
    const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
    const SIGNED_BYTES: &[u8] = b"test";

    fn encoded_key() -> String {
        BASE64.encode(PUBLIC_KEY)
    }

    fn encoded_signature() -> String {
        BASE64.encode(SIGNATURE)
    }

    // Подпись того же формата, но с изменённым байтом: индекс 2 попадает в key
    // id (подпись «чужого» ключа), индекс 40 — в сами байты подписи.
    fn signature_with_patched_byte(index: usize) -> String {
        let mut lines: Vec<String> = SIGNATURE.lines().map(str::to_owned).collect();
        let mut raw = BASE64.decode(&lines[1]).unwrap();
        raw[index] ^= 0xff;
        lines[1] = BASE64.encode(&raw);
        BASE64.encode(lines.join("\n"))
    }

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
        let public_key = encoded_key();
        let signature = encoded_signature();

        verify_update_signature(SIGNED_BYTES, &signature, &public_key).unwrap();
        let error = verify_update_signature(b"tampered", &signature, &public_key).unwrap_err();
        assert_eq!(error.code, ErrorCode::UpdaterCacheInvalid);
        assert_eq!(error.context["reason"], "signature");
    }

    #[test]
    fn signature_mismatch_evicts_the_untrusted_cache() {
        let dir = tempfile::tempdir().unwrap();
        let tampered = b"tampered";
        store_cached(dir.path(), &meta("0.2.0", tampered), tampered).unwrap();

        let error = verify_cached_update_signature(
            dir.path(),
            tampered,
            &encoded_signature(),
            &encoded_key(),
        )
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::UpdaterCacheInvalid);
        assert!(!dir.path().join(ARTIFACT_FILE).exists());
        assert!(!dir.path().join(META_FILE).exists());
    }

    #[test]
    fn every_flavour_of_a_tampered_artifact_fails_verification() {
        let original: &[u8] = b"artifact-bytes";
        // Перевёрнутый бит не меняет размер: проверка обязана считать sha256.
        let mut flipped = original.to_vec();
        flipped[3] ^= 0x01;
        let truncated = original[..original.len() - 1].to_vec();
        let mut appended = original.to_vec();
        appended.push(0);

        for (label, mutated) in [
            ("flipped byte", flipped),
            ("truncated", truncated),
            ("appended byte", appended),
            ("empty file", Vec::new()),
        ] {
            let dir = tempfile::tempdir().unwrap();
            store_cached(dir.path(), &meta("0.2.0", original), original).unwrap();
            fs::write(dir.path().join(ARTIFACT_FILE), &mutated).unwrap();

            let current = Version::parse("0.1.0").unwrap();
            let (loaded, artifact) = load_cached(dir.path(), &current).unwrap();
            assert!(!verify_cached(&loaded, &artifact), "{label}");
        }
    }

    #[test]
    fn verify_cached_rejects_a_missing_artifact_or_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"payload";
        let expected = meta("0.2.0", bytes);

        assert!(!verify_cached(&expected, &dir.path().join(ARTIFACT_FILE)));
        let as_directory = dir.path().join("as-directory");
        fs::create_dir(&as_directory).unwrap();
        assert!(!verify_cached(&expected, &as_directory));
    }

    #[test]
    fn a_directory_in_place_of_the_artifact_drops_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"payload";
        store_cached(dir.path(), &meta("0.2.0", bytes), bytes).unwrap();
        fs::remove_file(dir.path().join(ARTIFACT_FILE)).unwrap();
        fs::create_dir(dir.path().join(ARTIFACT_FILE)).unwrap();

        let current = Version::parse("0.1.0").unwrap();
        assert!(load_cached(dir.path(), &current).is_none());
        assert!(!dir.path().join(META_FILE).exists());
    }

    #[test]
    fn a_lying_meta_size_fails_verification() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"payload";
        store_cached(dir.path(), &meta("0.2.0", bytes), bytes).unwrap();
        // sha256 настоящий, размер завышен: установщик не должен доверять meta.
        let mut oversized = meta("0.2.0", bytes);
        oversized.size = 40_000_000_000;
        fs::write(
            dir.path().join(META_FILE),
            serde_json::to_string(&oversized).unwrap(),
        )
        .unwrap();

        let current = Version::parse("0.1.0").unwrap();
        let (loaded, artifact) = load_cached(dir.path(), &current).unwrap();
        assert!(!verify_cached(&loaded, &artifact));
    }

    #[test]
    fn a_rewritten_meta_hash_still_fails_the_fresh_manifest_signature() {
        let dir = tempfile::tempdir().unwrap();
        store_cached(dir.path(), &meta("0.2.0", SIGNED_BYTES), SIGNED_BYTES).unwrap();

        // Локальный атакующий подменяет артефакт и пересчитывает sha256 в meta.
        let swapped = b"evil-payload";
        fs::write(dir.path().join(ARTIFACT_FILE), swapped).unwrap();
        fs::write(
            dir.path().join(META_FILE),
            serde_json::to_string(&meta("0.2.0", swapped)).unwrap(),
        )
        .unwrap();

        let current = Version::parse("0.1.0").unwrap();
        let (loaded, artifact) = load_cached(dir.path(), &current).unwrap();
        // sha256 сходится — он не граница доверия; ловит подпись из манифеста.
        assert!(verify_cached(&loaded, &artifact));

        let bytes = fs::read(&artifact).unwrap();
        let error = verify_cached_update_signature(
            dir.path(),
            &bytes,
            &encoded_signature(),
            &encoded_key(),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::UpdaterCacheInvalid);
        assert_eq!(error.context["reason"], "signature");
        assert!(!dir.path().join(ARTIFACT_FILE).exists());
        assert!(!dir.path().join(META_FILE).exists());
    }

    #[test]
    fn rejects_an_empty_or_malformed_release_signature() {
        for signature in [
            String::new(),
            "not base64!!".to_owned(),
            BASE64.encode(""),
            BASE64.encode("untrusted comment: signature from minisign secret key"),
            BASE64.encode("untrusted comment: x\nnot-base64\ntrusted comment: y\nzzz"),
        ] {
            let error =
                verify_update_signature(SIGNED_BYTES, &signature, &encoded_key()).unwrap_err();
            assert_eq!(error.code, ErrorCode::UpdaterCacheInvalid, "{signature}");
            assert_eq!(error.context["reason"], "signature", "{signature}");
        }
    }

    #[test]
    fn rejects_a_signature_made_by_another_key_or_patched_in_place() {
        for signature in [
            signature_with_patched_byte(2),
            signature_with_patched_byte(40),
        ] {
            let error =
                verify_update_signature(SIGNED_BYTES, &signature, &encoded_key()).unwrap_err();
            assert_eq!(error.code, ErrorCode::UpdaterCacheInvalid);
            assert_eq!(error.context["reason"], "signature");
        }

        // Доверенный комментарий (имя файла, отметка времени) тоже подписан.
        let forged = SIGNATURE.replace("file:test", "file:evil");
        let error = verify_update_signature(SIGNED_BYTES, &BASE64.encode(forged), &encoded_key())
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::UpdaterCacheInvalid);
        assert_eq!(error.context["reason"], "signature");
    }

    #[test]
    fn an_oversized_signature_or_public_key_errors_instead_of_panicking() {
        let oversized = BASE64.encode(vec![b'A'; 256 * 1024]);

        let error =
            verify_update_signature(SIGNED_BYTES, &encoded_signature(), &oversized).unwrap_err();
        assert_eq!(error.code, ErrorCode::UpdaterCacheInvalid);
        assert_eq!(error.context["reason"], "publicKey");

        let error = verify_update_signature(SIGNED_BYTES, &oversized, &encoded_key()).unwrap_err();
        assert_eq!(error.code, ErrorCode::UpdaterCacheInvalid);
        assert_eq!(error.context["reason"], "signature");
    }

    #[test]
    fn decode_signed_text_names_the_field_it_failed_on() {
        assert_eq!(
            decode_signed_text(&encoded_key(), "publicKey").unwrap(),
            PUBLIC_KEY
        );

        for (value, field) in [
            ("not base64!!".to_owned(), "publicKey"),
            // Пробелы и переводы строк внутри base64 — не «почти валидный» ключ.
            ("AAAA\nAAAA".to_owned(), "publicKey"),
            (BASE64.encode([0xff_u8, 0xfe, 0xfd]), "signature"),
        ] {
            let error = decode_signed_text(&value, field).unwrap_err();
            assert_eq!(error.code, ErrorCode::UpdaterCacheInvalid, "{value}");
            assert_eq!(error.context["reason"], field, "{value}");
            assert!(error.debug.is_some(), "{value}");
        }
    }

    #[test]
    fn rejects_malformed_cache_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"payload";
        store_cached(dir.path(), &meta("0.2.0", bytes), bytes).unwrap();
        let current = Version::parse("0.1.0").unwrap();

        for raw in [
            "",
            "{",
            "[]",
            "null",
            "\"0.2.0\"",
            r#"{"version":1,"target":"","kind":"self","sha256":"x","size":4}"#,
            r#"{"version":"0.2.0","target":"","kind":"self","sha256":"x","size":"4"}"#,
        ] {
            fs::write(dir.path().join(META_FILE), raw).unwrap();
            assert!(load_cached(dir.path(), &current).is_none(), "{raw}");
        }

        // Невалидный UTF-8 не должен паниковать при чтении метаданных.
        fs::write(dir.path().join(META_FILE), [0xff_u8, 0xfe, 0x00]).unwrap();
        assert!(load_cached(dir.path(), &current).is_none());
    }

    #[test]
    fn cache_metadata_fields_are_required_and_never_defaulted() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"native-package";
        store_cached(dir.path(), &meta("9.9.9", bytes), bytes).unwrap();
        let current = Version::parse("0.1.0").unwrap();
        let full = serde_json::json!({
            "version": "9.9.9",
            "target": "linux-x86_64",
            "kind": "deb",
            "sha256": sha256_bytes(bytes),
            "size": bytes.len(),
        });

        // Без kind/target подложенный meta.json стал бы «self»-обновлением с
        // таргетом по умолчанию и прошёл бы проверку install_self_update.
        for missing in ["version", "target", "kind", "sha256", "size"] {
            let mut broken = full.clone();
            broken.as_object_mut().unwrap().remove(missing);
            fs::write(dir.path().join(META_FILE), broken.to_string()).unwrap();
            assert!(load_cached(dir.path(), &current).is_none(), "{missing}");
        }

        fs::write(dir.path().join(META_FILE), full.to_string()).unwrap();
        let (loaded, _) = load_cached(dir.path(), &current).unwrap();
        assert_eq!(loaded.version, "9.9.9");
        assert_eq!(loaded.target, "linux-x86_64");
        assert_eq!(loaded.kind, "deb");
        assert_eq!(loaded.total, None);
    }

    #[test]
    fn a_meta_version_that_is_not_semver_drops_the_cache() {
        for version in ["0.2", "not-a-version", "../0.9.0", ""] {
            let dir = tempfile::tempdir().unwrap();
            let bytes = b"payload";
            store_cached(dir.path(), &meta(version, bytes), bytes).unwrap();

            let current = Version::parse("0.1.0").unwrap();
            assert!(load_cached(dir.path(), &current).is_none(), "{version}");
            assert!(!dir.path().join(ARTIFACT_FILE).exists(), "{version}");
            assert!(!dir.path().join(META_FILE).exists(), "{version}");
        }
    }

    #[test]
    fn does_not_offer_a_cached_update_that_is_not_newer() {
        // Кеш от прошлого запуска или подложенный от старого релиза: ни один
        // из вариантов не должен пережить проверку и попасть в установку.
        for (cached, running) in [
            ("0.1.0", "0.2.0"),
            ("0.2.0", "0.2.0"),
            ("0.9.0", "0.10.0"),
            ("1.0.0-beta", "1.0.0"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let bytes = b"stale-payload";
            store_cached(dir.path(), &meta(cached, bytes), bytes).unwrap();

            let current = Version::parse(running).unwrap();
            assert!(load_cached(dir.path(), &current).is_none(), "{cached}");
            assert!(!dir.path().join(ARTIFACT_FILE).exists(), "{cached}");
            assert!(!dir.path().join(META_FILE).exists(), "{cached}");
        }
    }

    #[test]
    fn parse_exact_version_rejects_anything_but_plain_semver() {
        for version in ["1.2.3", "0.0.0", "0.0.8", "10.20.30"] {
            assert_eq!(parse_exact_version(version).unwrap().to_string(), version);
        }

        for version in [
            "",
            "1.0",
            "1.0.0.0",
            "01.0.0",
            "1.01.0",
            "v1.0.0",
            " 1.0.0",
            "1.0.0 ",
            " 1.0.0 ",
            "1.0.0\n",
            "1.0.0-",
            "1.0.0+",
            "1.0.0-a..b",
            "..",
            "../0.0.9",
            "0.0.9/../0.0.1",
            "0.0.9/x",
            "0.0.9\\x",
            "0.0.9%2f..",
            "0.0.9\0",
        ] {
            let error = parse_exact_version(version).unwrap_err();
            assert_eq!(error.code, ErrorCode::UpdaterInvalidVersion, "{version:?}");
            assert_eq!(error.context["version"], version, "{version:?}");
        }
    }

    #[test]
    fn accepted_versions_stay_safe_inside_a_package_file_name() {
        // linux_updater подставляет версию прямо в имя файла пакета.
        for version in ["1.2.3", "10.20.30", "1.0.0-beta.1", "1.0.0+build.5"] {
            let parsed = parse_exact_version(version).unwrap();
            assert_eq!(parsed.to_string(), version);
            assert!(
                version
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '+')),
                "{version}"
            );
            let name = format!("ModelCrew-{parsed}.deb");
            assert!(!name.contains("..") && !name.contains('/') && !name.contains('\\'));
        }
    }

    #[test]
    fn replacing_a_pending_update_leaves_no_copy_of_the_old_artifact() {
        let dir = tempfile::tempdir().unwrap();
        let old: &[u8] = b"old-signed-payload";
        store_cached(dir.path(), &meta("0.2.0", old), old).unwrap();
        let new = b"new-signed-payload-that-is-longer";
        store_cached(dir.path(), &meta("0.3.0", new), new).unwrap();

        assert_eq!(fs::read(dir.path().join(ARTIFACT_FILE)).unwrap(), new);
        // Ни временных файлов, ни копий прежних байтов в каталоге кеша.
        let mut names = Vec::new();
        for entry in fs::read_dir(dir.path()).unwrap() {
            let path = entry.unwrap().path();
            names.push(path.file_name().unwrap().to_string_lossy().into_owned());
            let contents = fs::read(&path).unwrap();
            assert!(
                !contents.windows(old.len()).any(|window| window == old),
                "{}",
                path.display()
            );
        }
        names.sort();
        assert_eq!(names, vec![ARTIFACT_FILE.to_owned(), META_FILE.to_owned()]);
    }

    #[test]
    fn clear_cached_removes_every_cache_file() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"payload";
        store_cached(dir.path(), &meta("0.2.0", bytes), bytes).unwrap();

        clear_cached(dir.path());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        // Повторная чистка и отсутствующий каталог не должны паниковать.
        clear_cached(dir.path());
        clear_cached(&dir.path().join("missing"));
    }

    #[cfg(unix)]
    #[test]
    fn a_stored_artifact_is_not_readable_by_other_local_users() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let bytes = b"signed-payload";
        let artifact = store_cached(dir.path(), &meta("0.2.0", bytes), bytes).unwrap();

        let mode = fs::metadata(&artifact).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "mode = {mode:o}");
    }

    #[cfg(unix)]
    #[test]
    fn store_cached_replaces_a_symlink_planted_at_the_cache_paths() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let victim = elsewhere.path().join("victim.txt");
        let victim_bytes = b"victim-contents";
        fs::write(&victim, victim_bytes).unwrap();
        std::os::unix::fs::symlink(&victim, dir.path().join(ARTIFACT_FILE)).unwrap();
        std::os::unix::fs::symlink(&victim, dir.path().join(META_FILE)).unwrap();

        let bytes = b"payload";
        store_cached(dir.path(), &meta("0.2.0", bytes), bytes).unwrap();

        assert_eq!(fs::read(&victim).unwrap(), victim_bytes);
        for name in [ARTIFACT_FILE, META_FILE] {
            let file_type = fs::symlink_metadata(dir.path().join(name))
                .unwrap()
                .file_type();
            assert!(file_type.is_file(), "{name}");
        }
        assert_eq!(fs::read(dir.path().join(ARTIFACT_FILE)).unwrap(), bytes);
    }
}
