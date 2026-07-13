use crate::command_error::{CommandError, CommandResult, ErrorCode};
use semver::Version;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex, MutexGuard,
};
use std::time::Duration;
use tauri::ipc::Channel;

#[cfg(target_os = "linux")]
use sha2::{Digest, Sha256};
#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::io::{Read, Write};
#[cfg(target_os = "linux")]
use std::os::unix::fs::PermissionsExt;
#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};
#[cfg(target_os = "linux")]
use tauri::utils::config::BundleType;
#[cfg(target_os = "linux")]
use tauri_plugin_updater::UpdaterExt;

const PKEXEC_PATH: &str = "/usr/bin/pkexec";
const DPKG_PATH: &str = "/usr/bin/dpkg";
const DPKG_DEB_PATH: &str = "/usr/bin/dpkg-deb";
const RPM_PATH: &str = "/usr/bin/rpm";
const PACMAN_PATH: &str = "/usr/bin/pacman";
const BSDTAR_PATH: &str = "/usr/bin/bsdtar";
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinuxPackageKind {
    Deb,
    Rpm,
    Pacman,
}

impl LinuxPackageKind {
    fn target_suffix(self) -> &'static str {
        match self {
            Self::Deb => "deb",
            Self::Rpm => "rpm",
            Self::Pacman => "pacman",
        }
    }

    #[cfg(target_os = "linux")]
    fn file_suffix(self) -> &'static str {
        match self {
            Self::Deb => ".deb",
            Self::Rpm => ".rpm",
            Self::Pacman => ".pkg.tar.zst",
        }
    }
}

impl std::fmt::Display for LinuxPackageKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.target_suffix())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UpdaterInstallTarget {
    SelfUpdate {
        #[serde(skip_serializing_if = "Option::is_none")]
        target: Option<String>,
    },
    NativePackage {
        package_kind: LinuxPackageKind,
        target: String,
    },
    Manual,
    Development,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "phase",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LinuxUpdateProgress {
    Downloading {
        downloaded: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
    },
    Verifying,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedLinuxPackageInfo {
    version: String,
    package_kind: LinuxPackageKind,
    target: String,
    downloaded: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct LinuxInstallEvidence {
    pacman_owns_executable: bool,
    bundle_marker: Option<LinuxBundleMarker>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LinuxBundleMarker {
    AppImage,
    Deb,
    Rpm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DetectedLinuxInstall {
    SelfUpdate,
    Native(LinuxPackageKind),
    Manual,
}

fn classify_linux_install(evidence: LinuxInstallEvidence) -> DetectedLinuxInstall {
    // The binary-patched Tauri marker describes this executable. In particular,
    // never let an inherited APPIMAGE environment variable override a Deb/RPM
    // marker: children of an unrelated AppImage can inherit that variable.
    if evidence.bundle_marker == Some(LinuxBundleMarker::AppImage) {
        return DetectedLinuxInstall::SelfUpdate;
    }

    // The Arch package is deliberately repacked from the .deb artifact, so its
    // embedded Tauri bundle marker remains `Deb`. Package ownership is the
    // authoritative override in that case.
    if evidence.pacman_owns_executable {
        return DetectedLinuxInstall::Native(LinuxPackageKind::Pacman);
    }

    match evidence.bundle_marker {
        Some(LinuxBundleMarker::Deb) => DetectedLinuxInstall::Native(LinuxPackageKind::Deb),
        Some(LinuxBundleMarker::Rpm) => DetectedLinuxInstall::Native(LinuxPackageKind::Rpm),
        _ => DetectedLinuxInstall::Manual,
    }
}

fn native_target_for_arch(kind: LinuxPackageKind, arch: &str) -> Option<String> {
    match arch {
        "x86_64" | "aarch64" => Some(format!("linux-{arch}-{}", kind.target_suffix())),
        _ => None,
    }
}

fn appimage_target_for_arch(arch: &str) -> Option<String> {
    match arch {
        "x86_64" | "aarch64" => Some(format!("linux-{arch}-appimage")),
        _ => None,
    }
}

fn parse_exact_version(version: &str) -> CommandResult<Version> {
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

struct PreparedLinuxPackage {
    version: String,
    package_kind: LinuxPackageKind,
    target: String,
    path: tempfile::TempPath,
    sha256: String,
    size: u64,
    total: Option<u64>,
}

#[derive(Clone)]
struct PreparedLinuxPackageSnapshot {
    version: String,
    package_kind: LinuxPackageKind,
    target: String,
    path: PathBuf,
    sha256: String,
    size: u64,
    total: Option<u64>,
}

impl PreparedLinuxPackage {
    fn snapshot(&self) -> PreparedLinuxPackageSnapshot {
        PreparedLinuxPackageSnapshot {
            version: self.version.clone(),
            package_kind: self.package_kind,
            target: self.target.clone(),
            path: self.path.to_path_buf(),
            sha256: self.sha256.clone(),
            size: self.size,
            total: self.total,
        }
    }
}

pub struct LinuxUpdaterState {
    prepared: Mutex<Option<PreparedLinuxPackage>>,
    busy: Arc<AtomicBool>,
}

impl Default for LinuxUpdaterState {
    fn default() -> Self {
        Self {
            prepared: Mutex::new(None),
            busy: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl LinuxUpdaterState {
    fn prepared(&self) -> CommandResult<MutexGuard<'_, Option<PreparedLinuxPackage>>> {
        self.prepared
            .lock()
            .map_err(|error| CommandError::new(ErrorCode::UpdaterCacheInvalid).with_debug(error))
    }

    fn begin_operation(&self) -> CommandResult<UpdaterOperationGuard> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| CommandError::new(ErrorCode::UpdaterOperationInProgress))?;
        Ok(UpdaterOperationGuard(self.busy.clone()))
    }
}

struct UpdaterOperationGuard(Arc<AtomicBool>);

impl Drop for UpdaterOperationGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub fn updater_install_target(window: tauri::WebviewWindow) -> CommandResult<UpdaterInstallTarget> {
    super::ensure_main_window(&window)?;

    if cfg!(debug_assertions) {
        return Ok(UpdaterInstallTarget::Development);
    }

    #[cfg(target_os = "linux")]
    {
        let detected = detect_linux_install();
        Ok(match detected {
            DetectedLinuxInstall::SelfUpdate => UpdaterInstallTarget::SelfUpdate {
                target: appimage_target_for_arch(std::env::consts::ARCH),
            },
            DetectedLinuxInstall::Native(package_kind) => {
                match native_target_for_arch(package_kind, std::env::consts::ARCH) {
                    Some(target) => UpdaterInstallTarget::NativePackage {
                        package_kind,
                        target,
                    },
                    None => UpdaterInstallTarget::Manual,
                }
            }
            DetectedLinuxInstall::Manual => UpdaterInstallTarget::Manual,
        })
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        Ok(UpdaterInstallTarget::SelfUpdate { target: None })
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Ok(UpdaterInstallTarget::Manual)
    }
}

#[tauri::command]
pub async fn updater_prepare_linux_package(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, LinuxUpdaterState>,
    version: String,
    on_progress: Channel<LinuxUpdateProgress>,
) -> CommandResult<PreparedLinuxPackageInfo> {
    super::ensure_main_window(&window)?;

    #[cfg(target_os = "linux")]
    {
        prepare_linux_package(app, &state, version, on_progress).await
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state, version, on_progress);
        Err(CommandError::new(ErrorCode::UpdaterUnsupportedPlatform))
    }
}

#[tauri::command]
pub async fn updater_install_linux_package(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, LinuxUpdaterState>,
    version: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;

    #[cfg(target_os = "linux")]
    {
        install_linux_package(&state, version).await
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, version);
        Err(CommandError::new(ErrorCode::UpdaterUnsupportedPlatform))
    }
}

#[cfg(target_os = "linux")]
fn detect_linux_install() -> DetectedLinuxInstall {
    let bundle_marker = match tauri::utils::platform::bundle_type() {
        Some(BundleType::AppImage) => Some(LinuxBundleMarker::AppImage),
        Some(BundleType::Deb) => Some(LinuxBundleMarker::Deb),
        Some(BundleType::Rpm) => Some(LinuxBundleMarker::Rpm),
        _ => None,
    };
    let pacman_owns_executable = std::env::current_exe()
        .ok()
        .is_some_and(|executable| pacman_owns(&executable));
    classify_linux_install(LinuxInstallEvidence {
        pacman_owns_executable,
        bundle_marker,
    })
}

#[cfg(target_os = "linux")]
fn pacman_owns(path: &Path) -> bool {
    Path::new(PACMAN_PATH).is_file()
        && Command::new(PACMAN_PATH)
            .args(["--query", "--owns"])
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
}

#[cfg(target_os = "linux")]
fn current_native_target() -> CommandResult<(LinuxPackageKind, String)> {
    let DetectedLinuxInstall::Native(package_kind) = detect_linux_install() else {
        return Err(CommandError::new(ErrorCode::UpdaterInstallTargetChanged));
    };
    let target = native_target_for_arch(package_kind, std::env::consts::ARCH).ok_or_else(|| {
        CommandError::new(ErrorCode::UpdaterUnsupportedPlatform)
            .with_context("arch", std::env::consts::ARCH)
    })?;
    Ok((package_kind, target))
}

#[cfg(target_os = "linux")]
async fn prepare_linux_package(
    app: tauri::AppHandle,
    state: &LinuxUpdaterState,
    version: String,
    on_progress: Channel<LinuxUpdateProgress>,
) -> CommandResult<PreparedLinuxPackageInfo> {
    let requested_version = parse_exact_version(&version)?;
    let (package_kind, target) = current_native_target()?;
    let _operation = state.begin_operation()?;

    let cached = state.prepared()?.as_ref().and_then(|prepared| {
        (prepared.version == version
            && prepared.package_kind == package_kind
            && prepared.target == target)
            .then(|| prepared.snapshot())
    });
    if let Some(cached) = cached {
        let _ = on_progress.send(LinuxUpdateProgress::Verifying);
        if verify_cached_package(&cached).is_ok() {
            verify_package_version(cached.package_kind, &cached.path, &requested_version)?;
            return Ok(PreparedLinuxPackageInfo {
                version,
                package_kind,
                target,
                downloaded: cached.size,
                total: cached.total,
            });
        }
        let mut prepared = state.prepared()?;
        if prepared
            .as_ref()
            .is_some_and(|entry| entry.version == cached.version && entry.target == cached.target)
        {
            prepared.take();
        }
    }

    let updater = app
        .updater_builder()
        .target(target.clone())
        .timeout(UPDATE_CHECK_TIMEOUT)
        .build()
        .map_err(|error| CommandError::new(ErrorCode::UpdaterCheckFailed).with_debug(error))?;
    let mut update = updater
        .check()
        .await
        .map_err(|error| CommandError::new(ErrorCode::UpdaterCheckFailed).with_debug(error))?
        .ok_or_else(|| {
            CommandError::new(ErrorCode::UpdaterVersionUnavailable)
                .with_context("version", &version)
                .with_context("target", &target)
        })?;
    if update.version != version {
        return Err(CommandError::new(ErrorCode::UpdaterVersionUnavailable)
            .with_context("version", &version)
            .with_context("availableVersion", update.version));
    }
    // UpdaterBuilder's timeout covers the metadata check. In updater 2.10.1
    // it is not copied into Update, so set the package request explicitly.
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
                let _ = progress_channel.send(LinuxUpdateProgress::Downloading {
                    downloaded: current,
                    total,
                });
            },
            move || {
                // Tauri calls this immediately before its signature check.
                let _ = verify_channel.send(LinuxUpdateProgress::Verifying);
            },
        )
        .await
        .map_err(|error| {
            CommandError::new(ErrorCode::UpdaterDownloadFailed)
                .with_context("version", &version)
                .with_context("target", &target)
                .with_debug(error)
        })?;

    let total = match reported_total.load(Ordering::Acquire) {
        0 => None,
        value => Some(value),
    };
    let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    let sha256 = sha256_bytes(&bytes);
    let mut temporary = tempfile::Builder::new()
        .prefix("modelcrew-update-")
        .suffix(package_kind.file_suffix())
        .tempfile()
        .map_err(|error| CommandError::new(ErrorCode::UpdaterCacheWriteFailed).with_debug(error))?;
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o600))
        .map_err(|error| CommandError::new(ErrorCode::UpdaterCacheWriteFailed).with_debug(error))?;
    temporary
        .write_all(&bytes)
        .map_err(|error| CommandError::new(ErrorCode::UpdaterCacheWriteFailed).with_debug(error))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| CommandError::new(ErrorCode::UpdaterCacheWriteFailed).with_debug(error))?;
    let path = temporary.into_temp_path();
    verify_package_version(package_kind, &path, &requested_version)?;

    *state.prepared()? = Some(PreparedLinuxPackage {
        version: version.clone(),
        package_kind,
        target: target.clone(),
        path,
        sha256,
        size,
        total,
    });

    Ok(PreparedLinuxPackageInfo {
        version,
        package_kind,
        target,
        downloaded: size,
        total,
    })
}

#[cfg(target_os = "linux")]
async fn install_linux_package(state: &LinuxUpdaterState, version: String) -> CommandResult<()> {
    let requested_version = parse_exact_version(&version)?;
    let (package_kind, target) = current_native_target()?;
    let _operation = state.begin_operation()?;
    let prepared = state
        .prepared()?
        .as_ref()
        .filter(|prepared| {
            prepared.version == version
                && prepared.package_kind == package_kind
                && prepared.target == target
        })
        .map(PreparedLinuxPackage::snapshot)
        .ok_or_else(|| {
            CommandError::new(ErrorCode::UpdaterCacheMissing)
                .with_context("version", &version)
                .with_context("target", &target)
        })?;

    let install_snapshot = prepared.clone();
    tauri::async_runtime::spawn_blocking(move || {
        verify_cached_package(&install_snapshot)?;
        verify_package_version(
            install_snapshot.package_kind,
            &install_snapshot.path,
            &requested_version,
        )?;
        run_package_installer(install_snapshot.package_kind, &install_snapshot.path)
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::UpdaterInstallFailed).with_debug(error))??;

    // Keep the verified package for all failure paths, including a dismissed
    // polkit prompt. It is removed only after the package manager succeeds.
    let mut cached = state.prepared()?;
    if cached.as_ref().is_some_and(|entry| {
        entry.version == prepared.version
            && entry.package_kind == prepared.package_kind
            && entry.target == prepared.target
    }) {
        cached.take();
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(target_os = "linux")]
fn sha256_file(path: &Path) -> CommandResult<(String, u64)> {
    let mut file = fs::File::open(path)
        .map_err(|error| CommandError::new(ErrorCode::UpdaterCacheMissing).with_debug(error))?;
    let metadata = file
        .metadata()
        .map_err(|error| CommandError::new(ErrorCode::UpdaterCacheInvalid).with_debug(error))?;
    if !metadata.is_file() {
        return Err(CommandError::new(ErrorCode::UpdaterCacheInvalid));
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| CommandError::new(ErrorCode::UpdaterCacheInvalid).with_debug(error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok((format!("{:x}", hasher.finalize()), metadata.len()))
}

#[cfg(target_os = "linux")]
fn verify_cached_package(prepared: &PreparedLinuxPackageSnapshot) -> CommandResult<()> {
    let (hash, size) = sha256_file(&prepared.path)?;
    if hash != prepared.sha256 || size != prepared.size {
        return Err(CommandError::new(ErrorCode::UpdaterCacheInvalid)
            .with_context("version", &prepared.version));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PackageMetadataOutput {
    DirectVersion,
    PacmanPackageInfo,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PackageMetadataSpec {
    program: &'static str,
    arguments_before_path: &'static [&'static str],
    arguments_after_path: &'static [&'static str],
    output: PackageMetadataOutput,
}

fn package_metadata_spec(kind: LinuxPackageKind) -> PackageMetadataSpec {
    match kind {
        LinuxPackageKind::Deb => PackageMetadataSpec {
            program: DPKG_DEB_PATH,
            arguments_before_path: &["--field"],
            arguments_after_path: &["Version"],
            output: PackageMetadataOutput::DirectVersion,
        },
        LinuxPackageKind::Rpm => PackageMetadataSpec {
            program: RPM_PATH,
            arguments_before_path: &["--query", "--package", "--queryformat", "%{VERSION}\n"],
            arguments_after_path: &[],
            output: PackageMetadataOutput::DirectVersion,
        },
        LinuxPackageKind::Pacman => PackageMetadataSpec {
            // Arch packages contain a signed .PKGINFO entry. bsdtar is part of
            // libarchive (a pacman dependency) and reads it without executing
            // package hooks or requiring privileges.
            program: BSDTAR_PATH,
            arguments_before_path: &["--extract", "--to-stdout", "--file"],
            arguments_after_path: &[".PKGINFO"],
            output: PackageMetadataOutput::PacmanPackageInfo,
        },
    }
}

fn package_metadata_value(
    kind: LinuxPackageKind,
    output: PackageMetadataOutput,
    stdout: &[u8],
) -> CommandResult<String> {
    if stdout.len() > 4096 {
        return Err(CommandError::new(ErrorCode::UpdaterPackageMetadataInvalid)
            .with_context("packageKind", kind));
    }
    let text = std::str::from_utf8(stdout).map_err(|error| {
        CommandError::new(ErrorCode::UpdaterPackageMetadataInvalid)
            .with_context("packageKind", kind)
            .with_debug(error)
    })?;
    let value = match output {
        PackageMetadataOutput::DirectVersion => text.trim().to_string(),
        PackageMetadataOutput::PacmanPackageInfo => {
            let mut version = None;
            for line in text.lines() {
                if let Some(value) = line.trim_end_matches('\r').strip_prefix("pkgver = ") {
                    if version.replace(value.to_string()).is_some() {
                        return Err(CommandError::new(ErrorCode::UpdaterPackageMetadataInvalid)
                            .with_context("packageKind", kind));
                    }
                }
            }
            version.ok_or_else(|| {
                CommandError::new(ErrorCode::UpdaterPackageMetadataInvalid)
                    .with_context("packageKind", kind)
            })?
        }
    };
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
    {
        return Err(CommandError::new(ErrorCode::UpdaterPackageMetadataInvalid)
            .with_context("packageKind", kind));
    }
    Ok(value)
}

fn strip_numeric_release_suffix(value: &str) -> Option<&str> {
    let (version, release) = value.rsplit_once('-')?;
    let valid_release = !version.is_empty()
        && release
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
    valid_release.then_some(version)
}

fn normalize_package_version(kind: LinuxPackageKind, value: &str) -> CommandResult<Version> {
    // The Arch repack always appends a numeric pkgrel (`-N` or `-N.N`) to
    // ModelCrew's SemVer. DEB and RPM metadata are queried without a package
    // release component, so keep their value exact. Alphabetic SemVer
    // prereleases such as `-beta.1` remain untouched in every format.
    let normalized = match kind {
        LinuxPackageKind::Pacman => strip_numeric_release_suffix(value).unwrap_or(value),
        LinuxPackageKind::Deb | LinuxPackageKind::Rpm => value,
    };
    let parsed = Version::parse(normalized).map_err(|error| {
        CommandError::new(ErrorCode::UpdaterPackageMetadataInvalid)
            .with_context("packageKind", kind)
            .with_debug(error)
    })?;
    if parsed.to_string() != normalized {
        return Err(CommandError::new(ErrorCode::UpdaterPackageMetadataInvalid)
            .with_context("packageKind", kind));
    }
    Ok(parsed)
}

fn ensure_package_version_matches(
    kind: LinuxPackageKind,
    actual: &Version,
    requested: &Version,
) -> CommandResult<()> {
    if actual != requested {
        return Err(CommandError::new(ErrorCode::UpdaterPackageVersionMismatch)
            .with_context("packageKind", kind)
            .with_context("expectedVersion", requested)
            .with_context("actualVersion", actual));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_package_version(kind: LinuxPackageKind, package: &Path) -> CommandResult<Version> {
    let spec = package_metadata_spec(kind);
    if !Path::new(spec.program).is_file() {
        return Err(
            CommandError::new(ErrorCode::UpdaterPackageMetadataUnavailable)
                .with_context("packageKind", kind),
        );
    }
    let output = Command::new(spec.program)
        .args(spec.arguments_before_path)
        .arg(package)
        .args(spec.arguments_after_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| {
            CommandError::new(ErrorCode::UpdaterPackageMetadataUnavailable)
                .with_context("packageKind", kind)
                .with_debug(error)
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CommandError::new(ErrorCode::UpdaterPackageMetadataInvalid)
            .with_context("packageKind", kind)
            .with_context(
                "exitCode",
                output
                    .status
                    .code()
                    .map_or_else(|| "signal".to_string(), |code| code.to_string()),
            )
            .with_debug(stderr.chars().take(4096).collect::<String>()));
    }
    let value = package_metadata_value(kind, spec.output, &output.stdout)?;
    normalize_package_version(kind, &value)
}

#[cfg(target_os = "linux")]
fn verify_package_version(
    kind: LinuxPackageKind,
    package: &Path,
    requested: &Version,
) -> CommandResult<()> {
    let actual = read_package_version(kind, package)?;
    ensure_package_version_matches(kind, &actual, requested)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PackageInstallerSpec {
    program: &'static str,
    arguments: &'static [&'static str],
}

fn package_installer_spec(kind: LinuxPackageKind) -> PackageInstallerSpec {
    match kind {
        LinuxPackageKind::Deb => PackageInstallerSpec {
            program: DPKG_PATH,
            arguments: &["--install"],
        },
        LinuxPackageKind::Rpm => PackageInstallerSpec {
            program: RPM_PATH,
            arguments: &["--upgrade", "--replacepkgs"],
        },
        LinuxPackageKind::Pacman => PackageInstallerSpec {
            program: PACMAN_PATH,
            arguments: &["--upgrade", "--noconfirm"],
        },
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InstallerExit {
    Success,
    AuthorizationCancelled,
    Failed,
}

fn classify_installer_exit(code: Option<i32>, success: bool) -> InstallerExit {
    if success {
        InstallerExit::Success
    } else if matches!(code, Some(126 | 127)) {
        InstallerExit::AuthorizationCancelled
    } else {
        InstallerExit::Failed
    }
}

#[cfg(target_os = "linux")]
fn run_package_installer(kind: LinuxPackageKind, package: &Path) -> CommandResult<()> {
    if !Path::new(PKEXEC_PATH).is_file() {
        return Err(CommandError::new(
            ErrorCode::UpdaterAuthorizationUnavailable,
        ));
    }

    let spec = package_installer_spec(kind);
    if !Path::new(spec.program).is_file() {
        return Err(
            CommandError::new(ErrorCode::UpdaterInstallFailed).with_context("packageKind", kind)
        );
    }
    let output = Command::new(PKEXEC_PATH)
        .arg(spec.program)
        .args(spec.arguments)
        .arg(package)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| {
            CommandError::new(ErrorCode::UpdaterAuthorizationUnavailable).with_debug(error)
        })?;

    match classify_installer_exit(output.status.code(), output.status.success()) {
        InstallerExit::Success => Ok(()),
        InstallerExit::AuthorizationCancelled => {
            Err(CommandError::new(ErrorCode::UpdaterAuthorizationCancelled))
        }
        InstallerExit::Failed => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let diagnostics = format!("stdout: {stdout}\nstderr: {stderr}");
            Err(CommandError::new(ErrorCode::UpdaterInstallFailed)
                .with_context("packageKind", kind)
                .with_context(
                    "exitCode",
                    output
                        .status
                        .code()
                        .map_or_else(|| "signal".to_string(), |code| code.to_string()),
                )
                .with_debug(diagnostics.chars().take(4096).collect::<String>()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evidence(
        pacman_owns_executable: bool,
        bundle_marker: Option<LinuxBundleMarker>,
    ) -> LinuxInstallEvidence {
        LinuxInstallEvidence {
            pacman_owns_executable,
            bundle_marker,
        }
    }

    #[test]
    fn embedded_appimage_marker_is_self_updated() {
        assert_eq!(
            classify_linux_install(evidence(false, Some(LinuxBundleMarker::AppImage))),
            DetectedLinuxInstall::SelfUpdate
        );
    }

    #[test]
    fn pacman_ownership_overrides_repacked_deb_marker() {
        assert_eq!(
            classify_linux_install(evidence(true, Some(LinuxBundleMarker::Deb))),
            DetectedLinuxInstall::Native(LinuxPackageKind::Pacman)
        );
    }

    #[test]
    fn native_markers_and_unknown_install_are_classified_safely() {
        assert_eq!(
            classify_linux_install(evidence(false, Some(LinuxBundleMarker::Deb))),
            DetectedLinuxInstall::Native(LinuxPackageKind::Deb)
        );
        assert_eq!(
            classify_linux_install(evidence(false, Some(LinuxBundleMarker::Rpm))),
            DetectedLinuxInstall::Native(LinuxPackageKind::Rpm)
        );
        assert_eq!(
            classify_linux_install(evidence(false, None)),
            DetectedLinuxInstall::Manual
        );
    }

    #[test]
    fn native_targets_match_release_manifest_keys() {
        assert_eq!(
            native_target_for_arch(LinuxPackageKind::Deb, "x86_64").as_deref(),
            Some("linux-x86_64-deb")
        );
        assert_eq!(
            native_target_for_arch(LinuxPackageKind::Rpm, "aarch64").as_deref(),
            Some("linux-aarch64-rpm")
        );
        assert_eq!(
            native_target_for_arch(LinuxPackageKind::Pacman, "x86_64").as_deref(),
            Some("linux-x86_64-pacman")
        );
        assert_eq!(
            appimage_target_for_arch("aarch64").as_deref(),
            Some("linux-aarch64-appimage")
        );
        assert_eq!(native_target_for_arch(LinuxPackageKind::Deb, "arm"), None);
    }

    #[test]
    fn version_must_be_canonical_semver() {
        assert_eq!(parse_exact_version("0.0.2").unwrap(), Version::new(0, 0, 2));
        assert!(parse_exact_version("v0.0.2").is_err());
        assert!(parse_exact_version("0.0.2 ").is_err());
        assert!(parse_exact_version("01.0.0").is_err());
    }

    #[test]
    fn install_target_serialization_matches_frontend_contract() {
        let value = serde_json::to_value(UpdaterInstallTarget::NativePackage {
            package_kind: LinuxPackageKind::Pacman,
            target: "linux-x86_64-pacman".into(),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "mode": "nativePackage",
                "packageKind": "pacman",
                "target": "linux-x86_64-pacman"
            })
        );
    }

    #[test]
    fn progress_serialization_is_tagged_and_omits_unknown_total() {
        let downloading = serde_json::to_value(LinuxUpdateProgress::Downloading {
            downloaded: 1024,
            total: None,
        })
        .unwrap();
        assert_eq!(
            downloading,
            serde_json::json!({ "phase": "downloading", "downloaded": 1024 })
        );
        assert_eq!(
            serde_json::to_value(LinuxUpdateProgress::Verifying).unwrap(),
            serde_json::json!({ "phase": "verifying" })
        );
    }

    #[test]
    fn installer_commands_are_fixed_and_non_shell() {
        assert_eq!(
            package_installer_spec(LinuxPackageKind::Deb),
            PackageInstallerSpec {
                program: "/usr/bin/dpkg",
                arguments: &["--install"]
            }
        );
        assert_eq!(
            package_installer_spec(LinuxPackageKind::Rpm),
            PackageInstallerSpec {
                program: "/usr/bin/rpm",
                arguments: &["--upgrade", "--replacepkgs"]
            }
        );
        assert_eq!(
            package_installer_spec(LinuxPackageKind::Pacman),
            PackageInstallerSpec {
                program: "/usr/bin/pacman",
                arguments: &["--upgrade", "--noconfirm"]
            }
        );
    }

    #[test]
    fn metadata_commands_are_fixed_and_non_shell() {
        assert_eq!(
            package_metadata_spec(LinuxPackageKind::Deb),
            PackageMetadataSpec {
                program: "/usr/bin/dpkg-deb",
                arguments_before_path: &["--field"],
                arguments_after_path: &["Version"],
                output: PackageMetadataOutput::DirectVersion,
            }
        );
        assert_eq!(
            package_metadata_spec(LinuxPackageKind::Rpm),
            PackageMetadataSpec {
                program: "/usr/bin/rpm",
                arguments_before_path: &["--query", "--package", "--queryformat", "%{VERSION}\n"],
                arguments_after_path: &[],
                output: PackageMetadataOutput::DirectVersion,
            }
        );
        assert_eq!(
            package_metadata_spec(LinuxPackageKind::Pacman),
            PackageMetadataSpec {
                program: "/usr/bin/bsdtar",
                arguments_before_path: &["--extract", "--to-stdout", "--file"],
                arguments_after_path: &[".PKGINFO"],
                output: PackageMetadataOutput::PacmanPackageInfo,
            }
        );
    }

    #[test]
    fn package_versions_are_extracted_and_normalized_strictly() {
        let direct = package_metadata_value(
            LinuxPackageKind::Deb,
            PackageMetadataOutput::DirectVersion,
            b"0.0.2\n",
        )
        .unwrap();
        assert_eq!(direct, "0.0.2");
        let pkginfo = package_metadata_value(
            LinuxPackageKind::Pacman,
            PackageMetadataOutput::PacmanPackageInfo,
            b"pkgname = modelcrew-bin\npkgver = 0.0.2-1\n",
        )
        .unwrap();
        assert_eq!(pkginfo, "0.0.2-1");

        assert_eq!(
            normalize_package_version(LinuxPackageKind::Pacman, "0.0.2-1").unwrap(),
            Version::new(0, 0, 2)
        );
        assert_eq!(
            normalize_package_version(LinuxPackageKind::Pacman, "0.0.2-beta.1-1").unwrap(),
            Version::parse("0.0.2-beta.1").unwrap()
        );
        assert_eq!(
            normalize_package_version(LinuxPackageKind::Rpm, "0.0.2").unwrap(),
            Version::new(0, 0, 2)
        );
        assert_ne!(
            normalize_package_version(LinuxPackageKind::Deb, "0.0.2-1").unwrap(),
            Version::new(0, 0, 2)
        );
        // Unknown alphabetic suffixes are never stripped as distro releases;
        // a stable requested version therefore cannot accidentally accept one.
        assert_ne!(
            normalize_package_version(LinuxPackageKind::Deb, "0.0.2-1ubuntu1").unwrap(),
            Version::new(0, 0, 2)
        );
        assert!(package_metadata_value(
            LinuxPackageKind::Pacman,
            PackageMetadataOutput::PacmanPackageInfo,
            b"pkgver = 0.0.2-1\npkgver = 0.0.3-1\n",
        )
        .is_err());
    }

    #[test]
    fn package_version_mismatch_is_stable_and_timeouts_are_finite() {
        let error = ensure_package_version_matches(
            LinuxPackageKind::Deb,
            &Version::new(0, 0, 1),
            &Version::new(0, 0, 2),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::UpdaterPackageVersionMismatch);
        assert_eq!(error.context["actualVersion"], "0.0.1");
        assert_eq!(error.context["expectedVersion"], "0.0.2");
        assert_eq!(UPDATE_CHECK_TIMEOUT, Duration::from_secs(30));
        assert_eq!(UPDATE_DOWNLOAD_TIMEOUT, Duration::from_secs(600));
    }

    #[test]
    fn pkexec_cancellation_has_a_stable_classification() {
        assert_eq!(
            classify_installer_exit(Some(0), true),
            InstallerExit::Success
        );
        assert_eq!(
            classify_installer_exit(Some(126), false),
            InstallerExit::AuthorizationCancelled
        );
        assert_eq!(
            classify_installer_exit(Some(127), false),
            InstallerExit::AuthorizationCancelled
        );
        assert_eq!(
            classify_installer_exit(Some(1), false),
            InstallerExit::Failed
        );
        assert_eq!(
            serde_json::to_value(CommandError::new(ErrorCode::UpdaterAuthorizationCancelled))
                .unwrap()["code"],
            "updater_authorization_cancelled"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cached_package_hash_detects_tampering() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"signed package bytes").unwrap();
        file.flush().unwrap();
        let snapshot = PreparedLinuxPackageSnapshot {
            version: "0.0.2".into(),
            package_kind: LinuxPackageKind::Deb,
            target: "linux-x86_64-deb".into(),
            path: file.path().to_path_buf(),
            sha256: sha256_bytes(b"signed package bytes"),
            size: 20,
            total: Some(20),
        };
        verify_cached_package(&snapshot).unwrap();
        fs::write(file.path(), b"tampered").unwrap();
        assert_eq!(
            verify_cached_package(&snapshot).unwrap_err().code,
            ErrorCode::UpdaterCacheInvalid
        );
    }
}
