use serde::Serialize;
use std::collections::BTreeMap;

/// Stable machine-readable failures crossing the Tauri IPC boundary.
/// User-facing copy belongs to the frontend locale catalog; `debug` is only
/// diagnostic context and must not be rendered directly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub enum ErrorCode {
    MainWindowOnly,
    InvalidLocale,
    AppMenuUpdateFailed,
    WorkspaceInvalidId,
    WorkspaceRootConflict,
    WorkspaceRootNotRegistered,
    WorkspaceRootIdentityChanged,
    WorkspaceRootMissing,
    WorkspaceRootPermissionDenied,
    WorkspaceRootNotDirectory,
    WorkspaceRootUnavailable,
    WorkspacePathUnsupported,
    WorkspacePickerPathInvalid,
    TerminalPtyOpenFailed,
    TerminalShellNotFound,
    TerminalCwdUnavailable,
    TerminalSpawnFailed,
    TerminalOutputStreamFailed,
    TerminalInputStreamFailed,
    TerminalNotFound,
    TerminalWriteFailed,
    TerminalResizeFailed,
    TerminalKillFailed,
    UpdaterUnsupportedPlatform,
    UpdaterInvalidVersion,
    UpdaterOperationInProgress,
    UpdaterInstallTargetChanged,
    UpdaterCheckFailed,
    UpdaterVersionUnavailable,
    UpdaterDownloadFailed,
    UpdaterCacheWriteFailed,
    UpdaterCacheMissing,
    UpdaterCacheInvalid,
    UpdaterPackageMetadataUnavailable,
    UpdaterPackageMetadataInvalid,
    UpdaterPackageVersionMismatch,
    UpdaterAuthorizationUnavailable,
    UpdaterAuthorizationCancelled,
    UpdaterInstallFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: ErrorCode,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub context: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug: Option<String>,
}

impl CommandError {
    pub fn new(code: ErrorCode) -> Self {
        Self {
            code,
            context: BTreeMap::new(),
            debug: None,
        }
    }

    pub fn with_context(mut self, key: impl Into<String>, value: impl ToString) -> Self {
        self.context.insert(key.into(), value.to_string());
        self
    }

    pub fn with_debug(mut self, error: impl ToString) -> Self {
        self.debug = Some(error.to_string());
        self
    }
}

pub type CommandResult<T> = Result<T, CommandError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_error_has_stable_code_and_camel_case_context() {
        let value = serde_json::to_value(
            CommandError::new(ErrorCode::WorkspaceRootMissing)
                .with_context("workspaceId", "workspace-1")
                .with_debug("No such file or directory"),
        )
        .unwrap();

        assert_eq!(value["code"], "workspace_root_missing");
        assert_eq!(value["context"]["workspaceId"], "workspace-1");
        assert_eq!(value["debug"], "No such file or directory");
        assert!(value.get("message").is_none());
    }

    #[test]
    fn empty_optional_fields_are_omitted() {
        let value = serde_json::to_value(CommandError::new(ErrorCode::TerminalNotFound)).unwrap();

        assert_eq!(value, serde_json::json!({ "code": "terminal_not_found" }));
    }
}
