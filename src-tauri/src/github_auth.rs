// Вход через GitHub по OAuth Device Flow: приложение показывает код,
// пользователь подтверждает его в браузере, мы забираем токен. Токен хранится
// файлом в конфиге приложения с правами 0600 (как это делает gh CLI).
// Служит для аватарок и будущих GitHub-функций.

use crate::command_error::{CommandError, CommandResult, ErrorCode};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

// Client ID зарегистрированного OAuth App (публичный, не секрет). Заведи
// OAuth App на https://github.com/settings/developers, включи «Device Flow»,
// и вставь его Client ID сюда (или задай переменной сборки GITHUB_CLIENT_ID).
// Пусто → кнопка входа сообщит, что вход не настроен.
const GITHUB_CLIENT_ID: &str = match option_env!("GITHUB_CLIENT_ID") {
    Some(id) => id,
    None => "",
};

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_URL: &str = "https://api.github.com/user";
const USER_AGENT: &str = "ModelCrew-Desktop";

fn token_path(app: &tauri::AppHandle) -> CommandResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| CommandError::new(ErrorCode::GithubRequestFailed).with_debug(error))?;
    Ok(dir.join("github-token"))
}

fn read_token(app: &tauri::AppHandle) -> Option<String> {
    let path = token_path(app).ok()?;
    let token = std::fs::read_to_string(path).ok()?;
    let token = token.trim().to_owned();
    (!token.is_empty()).then_some(token)
}

fn store_token(app: &tauri::AppHandle, token: &str) -> CommandResult<()> {
    let path = token_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| CommandError::new(ErrorCode::GithubRequestFailed).with_debug(error))?;
    }
    std::fs::write(&path, token)
        .map_err(|error| CommandError::new(ErrorCode::GithubRequestFailed).with_debug(error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn clear_token(app: &tauri::AppHandle) {
    if let Ok(path) = token_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

fn http() -> CommandResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| CommandError::new(ErrorCode::GithubRequestFailed).with_debug(error))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    user_code: String,
    verification_uri: String,
    device_code: String,
    interval: u64,
    expires_in: u64,
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    expires_in: u64,
    #[serde(default)]
    interval: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollResult {
    // pending | authorized | slowDown | denied | expired | error
    status: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    error: Option<String>,
}

// camelCase только на сериализации: во фронтенд уходит avatarUrl, а ответ
// GitHub /user читается по snake_case-именам полей (avatar_url) как есть —
// иначе десериализация падает и профиль не подхватывается.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct GithubUser {
    login: String,
    avatar_url: String,
}

#[tauri::command]
pub fn github_auth_available() -> bool {
    !GITHUB_CLIENT_ID.is_empty()
}

#[tauri::command]
pub async fn github_device_start(window: tauri::WebviewWindow) -> CommandResult<DeviceStart> {
    super::ensure_main_window(&window)?;
    if GITHUB_CLIENT_ID.is_empty() {
        return Err(CommandError::new(ErrorCode::GithubNotConfigured));
    }
    let response = http()?
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", GITHUB_CLIENT_ID), ("scope", "read:user")])
        .send()
        .await
        .map_err(|error| CommandError::new(ErrorCode::GithubRequestFailed).with_debug(error))?;
    let code: DeviceCodeResponse = response
        .json()
        .await
        .map_err(|error| CommandError::new(ErrorCode::GithubRequestFailed).with_debug(error))?;
    Ok(DeviceStart {
        user_code: code.user_code,
        verification_uri: code.verification_uri,
        device_code: code.device_code,
        interval: code.interval.max(5),
        expires_in: if code.expires_in == 0 {
            900
        } else {
            code.expires_in
        },
    })
}

#[tauri::command]
pub async fn github_device_poll(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    device_code: String,
) -> CommandResult<PollResult> {
    super::ensure_main_window(&window)?;
    if GITHUB_CLIENT_ID.is_empty() {
        return Err(CommandError::new(ErrorCode::GithubNotConfigured));
    }
    let response = http()?
        .post(TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", GITHUB_CLIENT_ID),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|error| CommandError::new(ErrorCode::GithubRequestFailed).with_debug(error))?;
    let body: TokenResponse = response
        .json()
        .await
        .map_err(|error| CommandError::new(ErrorCode::GithubRequestFailed).with_debug(error))?;

    if let Some(token) = body.access_token {
        store_token(&app, &token)?;
        return Ok(PollResult {
            status: "authorized".to_owned(),
        });
    }
    let status = match body.error.as_deref() {
        Some("authorization_pending") => "pending",
        Some("slow_down") => "slowDown",
        Some("access_denied") => "denied",
        Some("expired_token") => "expired",
        _ => "error",
    };
    Ok(PollResult {
        status: status.to_owned(),
    })
}

#[tauri::command]
pub async fn github_current_user(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> CommandResult<Option<GithubUser>> {
    super::ensure_main_window(&window)?;
    let Some(token) = read_token(&app) else {
        return Ok(None);
    };
    let response = http()?
        .get(USER_URL)
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|error| CommandError::new(ErrorCode::GithubRequestFailed).with_debug(error))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        // Токен отозван или протух — забываем.
        clear_token(&app);
        return Ok(None);
    }
    if !response.status().is_success() {
        return Ok(None);
    }
    let user: GithubUser = response
        .json()
        .await
        .map_err(|error| CommandError::new(ErrorCode::GithubRequestFailed).with_debug(error))?;
    Ok(Some(user))
}

#[tauri::command]
pub async fn github_logout(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    clear_token(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Регрессия: reqwest в нашем дереве идёт с rustls, но feature-unification
    // может дать его без криптопровайдера — тогда build() Client паникует.
    // Фича `rustls` (aws-lc-rs) в Cargo.toml включает провайдер; тест
    // упадёт (паникой), если стек снова окажется без него.
    #[test]
    fn builds_an_http_client_with_a_crypto_provider() {
        assert!(
            http().is_ok(),
            "reqwest Client must build with a rustls crypto provider present"
        );
    }

    // Ответ GitHub /user идёт в snake_case (avatar_url) — должен читаться; во
    // фронтенд поле уходит camelCase (avatarUrl).
    #[test]
    fn reads_github_user_snake_case_and_serializes_camel_case() {
        let user: GithubUser = serde_json::from_str(
            r#"{"login":"octocat","id":1,"avatar_url":"https://avatars.githubusercontent.com/u/1?v=4"}"#,
        )
        .expect("GitHub /user must deserialize");
        assert_eq!(user.login, "octocat");
        assert_eq!(
            user.avatar_url,
            "https://avatars.githubusercontent.com/u/1?v=4"
        );
        let json = serde_json::to_string(&user).unwrap();
        assert!(json.contains("\"avatarUrl\""), "frontend gets camelCase");
        assert!(!json.contains("avatar_url"));
    }

    // Ответ device-токена: авторизован (access_token) и «ещё ждём» (error).
    #[test]
    fn parses_the_device_token_response() {
        let authorized: TokenResponse = serde_json::from_str(
            r#"{"access_token":"gho_x","token_type":"bearer","scope":""}"#,
        )
        .unwrap();
        assert_eq!(authorized.access_token.as_deref(), Some("gho_x"));

        let pending: TokenResponse = serde_json::from_str(
            r#"{"error":"authorization_pending","error_description":"waiting"}"#,
        )
        .unwrap();
        assert!(pending.access_token.is_none());
        assert_eq!(pending.error.as_deref(), Some("authorization_pending"));
    }
}
