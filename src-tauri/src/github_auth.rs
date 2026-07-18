// Вход через GitHub по OAuth Device Flow: приложение показывает код,
// пользователь подтверждает его в браузере, мы забираем токен. Токен хранится
// файлом в конфиге приложения с правами 0600 (как это делает gh CLI).
// Служит для аватарок и будущих GitHub-функций.

use crate::command_error::{CommandError, CommandResult, ErrorCode};
use crate::workspace_roots::WorkspaceRoots;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
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

// ---------- Аватарки коммиттеров через GitHub commits API ----------

// Карта «почта автора → GitHub-аватар», построенная из коммитов origin-репо.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct CommitAvatar {
    email: String,
    avatar_url: String,
    login: String,
}

// Разбор ответа GitHub /repos/{o}/{r}/commits: git-идентити (почта) отдельно
// от привязанного GitHub-аккаунта (может быть null, если коммит не связан).
#[derive(Deserialize)]
struct ApiCommitEntry {
    commit: ApiCommitBody,
    author: Option<ApiAccount>,
    committer: Option<ApiAccount>,
}

#[derive(Deserialize)]
struct ApiCommitBody {
    author: Option<ApiGitIdentity>,
    committer: Option<ApiGitIdentity>,
}

#[derive(Deserialize)]
struct ApiGitIdentity {
    email: Option<String>,
}

#[derive(Deserialize)]
struct ApiAccount {
    login: String,
    avatar_url: String,
}

// owner/repo из URL origin. Поддержаны https, ssh (git@ и ssh://), git://.
// Не GitHub — None (тогда аватарок из API просто не будет).
fn parse_github_slug(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let rest = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("https://github.com/"))
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| url.strip_prefix("git://github.com/"))?;
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.splitn(2, '/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim().trim_end_matches('/');
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some((owner.to_owned(), repo.to_owned()))
}

// Обёртка над git без консольного окна на Windows; None, если git упал.
fn git_capture(root: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = command.args(args).current_dir(root).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn origin_url(root: &Path) -> Option<String> {
    git_capture(root, &["remote", "get-url", "origin"]).filter(|url| !url.is_empty())
}

// Почта, которой подписаны локальные коммиты этого репо (git config user.email).
fn local_git_email(root: &Path) -> Option<String> {
    git_capture(root, &["config", "user.email"])
        .map(|email| email.trim().to_lowercase())
        .filter(|email| email.contains('@'))
}

// Профиль вошедшего пользователя (login, avatar) — чтобы подставить его аватар
// на собственные, ещё не запушенные коммиты.
async fn current_user_account(
    client: &reqwest::Client,
    token: &str,
) -> Option<(String, String)> {
    let response = client
        .get(USER_URL)
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let account: ApiAccount = response.json().await.ok()?;
    Some((account.login, account.avatar_url))
}

// Складывает почту → (login, avatar) для автора и коммиттера каждого коммита.
// Первый встреченный аккаунт для почты выигрывает (or_insert_with).
fn extract_avatars(
    entries: &[ApiCommitEntry],
    out: &mut std::collections::HashMap<String, (String, String)>,
) {
    let mut add = |identity: &Option<ApiGitIdentity>, account: &Option<ApiAccount>| {
        if let (Some(identity), Some(account)) = (identity, account) {
            if let Some(email) = &identity.email {
                let key = email.trim().to_lowercase();
                if !key.is_empty() {
                    out.entry(key)
                        .or_insert_with(|| (account.login.clone(), account.avatar_url.clone()));
                }
            }
        }
    };
    for entry in entries {
        add(&entry.commit.author, &entry.author);
        add(&entry.commit.committer, &entry.committer);
    }
}

// Строит карту почта→аватар из коммитов origin-репозитория на GitHub. Без
// токена, без origin или для не-GitHub/приватного репо возвращает пусто —
// фронтенд тогда откатывается на Gravatar/инициалы.
#[tauri::command]
pub async fn github_commit_avatars(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
) -> CommandResult<Vec<CommitAvatar>> {
    super::ensure_main_window(&window)?;
    let Some(token) = read_token(&app) else {
        return Ok(Vec::new());
    };
    let root = roots.resolve(&workspace_id)?;
    let client = http()?;
    let mut map: std::collections::HashMap<String, (String, String)> =
        std::collections::HashMap::new();

    // Реальные привязки почта→аккаунт из коммитов на GitHub — только если origin
    // ведёт на GitHub. Иначе (локальный/не-GitHub репо) полагаемся лишь на
    // локальную привязку ниже.
    if let Some((owner, repo)) = origin_url(&root).as_deref().and_then(parse_github_slug) {
        // До 5 страниц по 100 — покрывает показанную историю, не упираясь в лимиты.
        for page in 1..=5 {
            let url = format!(
                "https://api.github.com/repos/{owner}/{repo}/commits?per_page=100&page={page}"
            );
            let response = client
                .get(&url)
                .header("Accept", "application/vnd.github+json")
                .bearer_auth(&token)
                .timeout(std::time::Duration::from_secs(20))
                .send()
                .await
                .map_err(|error| {
                    CommandError::new(ErrorCode::GithubRequestFailed).with_debug(error)
                })?;
            if !response.status().is_success() {
                // Приватный репо без scope, rate limit, нет доступа — что есть.
                break;
            }
            let entries: Vec<ApiCommitEntry> = match response.json().await {
                Ok(entries) => entries,
                Err(_) => break,
            };
            let count = entries.len();
            extract_avatars(&entries, &mut map);
            if count < 100 {
                break; // последняя страница
            }
        }
    }

    // Собственные коммиты пользователя могут быть ещё не на GitHub (unpushed) —
    // их почты нет в commits API. Привязываем локальную git-почту к аватару
    // вошедшего (обычно это он и есть), не перекрывая реальные привязки.
    if let Some(email) = local_git_email(&root) {
        if !map.contains_key(&email) {
            if let Some(account) = current_user_account(&client, &token).await {
                map.entry(email).or_insert(account);
            }
        }
    }

    Ok(map
        .into_iter()
        .map(|(email, (login, avatar_url))| CommitAvatar {
            email,
            avatar_url,
            login,
        })
        .collect())
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
        let authorized: TokenResponse =
            serde_json::from_str(r#"{"access_token":"gho_x","token_type":"bearer","scope":""}"#)
                .unwrap();
        assert_eq!(authorized.access_token.as_deref(), Some("gho_x"));

        let pending: TokenResponse = serde_json::from_str(
            r#"{"error":"authorization_pending","error_description":"waiting"}"#,
        )
        .unwrap();
        assert!(pending.access_token.is_none());
        assert_eq!(pending.error.as_deref(), Some("authorization_pending"));
    }

    #[test]
    fn parses_github_origin_urls() {
        let want = Some(("octocat".to_owned(), "Hello-World".to_owned()));
        assert_eq!(
            parse_github_slug("https://github.com/octocat/Hello-World.git"),
            want
        );
        assert_eq!(
            parse_github_slug("git@github.com:octocat/Hello-World.git"),
            want
        );
        assert_eq!(
            parse_github_slug("ssh://git@github.com/octocat/Hello-World"),
            want
        );
        assert_eq!(
            parse_github_slug("https://github.com/octocat/Hello-World/"),
            want
        );
        // Не GitHub и неполные пути — None.
        assert_eq!(parse_github_slug("https://gitlab.com/a/b.git"), None);
        assert_eq!(parse_github_slug("https://github.com/only-owner"), None);
    }

    #[test]
    fn extracts_avatars_by_author_and_committer_email() {
        let json = r#"[
          {"commit":{"author":{"email":"Alice@X.com"},"committer":{"email":"bob@x.com"}},
           "author":{"login":"alice","avatar_url":"https://a"},
           "committer":{"login":"bob","avatar_url":"https://b"}},
          {"commit":{"author":{"email":"carol@x.com"}},"author":null,"committer":null}
        ]"#;
        let entries: Vec<ApiCommitEntry> = serde_json::from_str(json).unwrap();
        let mut map = std::collections::HashMap::new();
        extract_avatars(&entries, &mut map);
        // Почта нормализуется в нижний регистр.
        assert_eq!(
            map.get("alice@x.com").map(|(_, url)| url.as_str()),
            Some("https://a")
        );
        assert_eq!(
            map.get("bob@x.com").map(|(login, _)| login.as_str()),
            Some("bob")
        );
        // Коммит без привязанного аккаунта (author: null) — почты нет в карте.
        assert!(!map.contains_key("carol@x.com"));
    }
}
