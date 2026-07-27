// Вход через GitHub по OAuth Device Flow: приложение показывает код,
// пользователь подтверждает его в браузере, мы забираем токен. Токен хранится
// файлом в конфиге приложения с правами 0600 (как это делает gh CLI).
// Служит для аватарок и будущих GitHub-функций.

use crate::command_error::{CommandError, CommandResult, ErrorCode};
use crate::git_identity::GitIdentity;
use crate::git_operations::{run_git, run_shared as coordinate_shared};
use crate::workspace_roots::WorkspaceRoots;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
#[cfg(test)]
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

fn identity_path(app: &tauri::AppHandle) -> CommandResult<PathBuf> {
    Ok(token_path(app)?.with_file_name("github-identity.json"))
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
    if let Ok(path) = identity_path(app) {
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
    #[serde(skip_serializing)]
    id: u64,
    login: String,
    avatar_url: String,
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    commit_identity: Option<GitIdentity>,
}

#[derive(Deserialize, Serialize)]
struct GithubIdentityCache {
    id: u64,
    login: String,
}

impl GithubIdentityCache {
    fn from_user(user: &GithubUser) -> Self {
        Self {
            id: user.id,
            login: user.login.clone(),
        }
    }

    fn commit_identity(&self) -> Option<GitIdentity> {
        let login = self.login.trim();
        if self.id == 0
            || login.is_empty()
            || login.len() > 100
            || !login
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return None;
        }
        Some(GitIdentity {
            name: login.to_owned(),
            email: format!("{}+{}@users.noreply.github.com", self.id, login),
        })
    }
}

fn store_commit_identity(app: &tauri::AppHandle, user: &GithubUser) -> CommandResult<()> {
    let path = identity_path(app)?;
    let content = serde_json::to_vec(&GithubIdentityCache::from_user(user))
        .map_err(|error| CommandError::new(ErrorCode::GithubRequestFailed).with_debug(error))?;
    std::fs::write(&path, content)
        .map_err(|error| CommandError::new(ErrorCode::GithubRequestFailed).with_debug(error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub(crate) fn github_commit_identity(app: &tauri::AppHandle) -> Option<GitIdentity> {
    // Identity is active only while the OAuth token is present.
    read_token(app)?;
    let content = std::fs::read(identity_path(app).ok()?).ok()?;
    serde_json::from_slice::<GithubIdentityCache>(&content)
        .ok()?
        .commit_identity()
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
    let mut user: GithubUser = response
        .json()
        .await
        .map_err(|error| CommandError::new(ErrorCode::GithubRequestFailed).with_debug(error))?;
    user.commit_identity = GithubIdentityCache::from_user(&user).commit_identity();
    store_commit_identity(&app, &user)?;
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

// Короткие provider-read операции участвуют в общей Git-очереди, но сетевой
// запрос GitHub выполняется уже без lock.
fn git_capture(root: &Path, args: &[&str]) -> Option<String> {
    coordinate_shared(root, || run_git(root, args))
        .ok()
        .map(|output| String::from_utf8_lossy(&output).trim().to_owned())
}

fn origin_url(root: &Path) -> Option<String> {
    git_capture(root, &["remote", "get-url", "origin"]).filter(|url| !url.is_empty())
}

// Первый remote, ведущий на GitHub: origin приоритетнее, но проект может
// работать и через fork/upstream с другим именем.
fn github_slug(root: &Path) -> Option<(String, String)> {
    if let Some(slug) = origin_url(root).as_deref().and_then(parse_github_slug) {
        return Some(slug);
    }
    let remotes = git_capture(root, &["remote"])?;
    remotes.lines().find_map(|remote| {
        let remote = remote.trim();
        if remote.is_empty() || remote == "origin" {
            return None;
        }
        git_capture(root, &["remote", "get-url", remote])
            .as_deref()
            .and_then(parse_github_slug)
    })
}

// Ссылка на коммит на GitHub. None — если репозиторий не связан с GitHub;
// открывать ссылку решает фронтенд, здесь мы её только собираем.
#[tauri::command]
pub async fn github_commit_url(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    hash: String,
) -> CommandResult<Option<String>> {
    super::ensure_main_window(&window)?;
    if hash.len() < 7 || !hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Ok(None);
    }
    let root = roots.resolve(&workspace_id)?;
    Ok(github_slug(&root)
        .map(|(owner, repo)| format!("https://github.com/{owner}/{repo}/commit/{hash}")))
}

// Почта, которой подписаны локальные коммиты этого репо (git config user.email).
fn local_git_email(root: &Path) -> Option<String> {
    git_capture(root, &["config", "user.email"])
        .map(|email| email.trim().to_lowercase())
        .filter(|email| email.contains('@'))
}

// Профиль вошедшего пользователя (login, avatar) — чтобы подставить его аватар
// на собственные, ещё не запушенные коммиты.
async fn current_user_account(client: &reqwest::Client, token: &str) -> Option<(String, String)> {
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
        assert!(!json.contains("\"id\""), "numeric id stays on the backend");
        assert_eq!(
            GithubIdentityCache::from_user(&user).commit_identity(),
            Some(GitIdentity {
                name: "octocat".to_owned(),
                email: "1+octocat@users.noreply.github.com".to_owned(),
            })
        );
    }

    #[test]
    fn rejects_tampered_cached_github_identities() {
        for cache in [
            GithubIdentityCache {
                id: 0,
                login: "octocat".to_owned(),
            },
            GithubIdentityCache {
                id: 1,
                login: "octo\ncat".to_owned(),
            },
            GithubIdentityCache {
                id: 1,
                login: "octocat@example.com".to_owned(),
            },
        ] {
            assert_eq!(cache.commit_identity(), None);
        }
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

    // Хост origin-URL полностью подконтролен открытому репозиторию (.git/config),
    // а распознанный slug решает, уйдёт ли Bearer-токен в api.github.com. Любой
    // похожий хост и любой выход из пути обязаны давать None.
    #[test]
    fn rejects_look_alike_github_hosts_and_path_escapes() {
        for url in [
            "",
            "   ",
            "github.com/a/b",
            "https://evil.example/a/b",
            "https://github.com.evil.example/a/b",
            "https://evil.example/github.com/a/b",
            "git@github.com.evil.example:a/b",
            "ssh://git@github.com.evil.example/a/b",
            "https://user:pass@github.com/a/b",
            "https://github.com@evil.example/a/b",
            "HTTPS://GITHUB.COM/a/b",
            "https://GitHub.com/a/b",
            "https://github.com/a/b/../../c",
            "https://github.com/a/b/c",
            "https://github.com/a",
            "https://github.com//b",
            "https://github.com/a/",
            "https://github.com/",
            "https://gitlab.com/a/b.git",
        ] {
            assert_eq!(
                parse_github_slug(url),
                None,
                "{url:?} must not be treated as a GitHub remote"
            );
        }
    }

    #[test]
    fn accepts_the_real_github_remote_forms() {
        let want = Some(("octocat".to_owned(), "Hello-World".to_owned()));
        assert_eq!(
            parse_github_slug("ssh://git@github.com/octocat/Hello-World.git"),
            want
        );
        assert_eq!(
            parse_github_slug("git://github.com/octocat/Hello-World"),
            want
        );
        assert_eq!(
            parse_github_slug("http://github.com/octocat/Hello-World.git"),
            want
        );
    }

    // Порты, соседние хосты GitHub и опечатки в scp-форме — всё это остаётся
    // чужим адресом: распознать их как GitHub значило бы отправить туда (или
    // ради них) Bearer-токен пользователя.
    #[test]
    fn rejects_github_look_alikes_with_ports_subdomains_and_scp_typos() {
        for url in [
            "https://github.com",
            "https://github.com:443/octocat/Hello-World.git",
            "ssh://git@github.com:22/octocat/Hello-World",
            "https://github.com.evil.example:443/octocat/Hello-World",
            "https://api.github.com/octocat/Hello-World",
            "https://raw.githubusercontent.com/octocat/Hello-World",
            "https://github.co/octocat/Hello-World",
            "git@github.com/octocat/Hello-World.git", // двоеточие потеряно
            "git@github.com:",
            "GIT@GITHUB.COM:octocat/Hello-World",
            "ssh://github.com/octocat/Hello-World", // без git@
            "ftp://github.com/octocat/Hello-World",
            "file:///github.com/octocat/Hello-World",
            "//github.com/octocat/Hello-World",
            "https:/github.com/octocat/Hello-World",
            "https://github.com/octocat/.git", // после срезки .git репозитория нет
        ] {
            assert_eq!(
                parse_github_slug(url),
                None,
                "{url:?} must not be treated as a GitHub remote"
            );
        }
    }

    // Всё, что пережило разбор, подставляется в путь api.github.com (с токеном
    // в заголовке) и в ссылку, которую фронтенд отдаёт системному браузеру.
    // Ни owner, ни repo не должны нести разделитель пути или уводить URL с
    // github.com — даже когда origin взят из враждебного конфига.
    #[test]
    fn parsed_slugs_never_escape_the_github_host() {
        const HASH: &str = "0123456789abcdef0123456789abcdef01234567";
        for url in [
            "https://github.com/../..",
            "https://github.com/o/r?x=y",
            "https://github.com/o/r#frag",
            "https://github.com/a@evil.example/b",
            "https://github.com/o/r epo",
            "http://github.com/octocat/Hello-World.git",
            "git@github.com:octocat/Hello-World.git",
            "https://github.com/octocat/Hello-World/",
        ] {
            let Some((owner, repo)) = parse_github_slug(url) else {
                continue;
            };
            assert!(!owner.contains('/'), "owner from {url:?} splits the path");
            assert!(!repo.contains('/'), "repo from {url:?} splits the path");

            let commit = format!("https://github.com/{owner}/{repo}/commit/{HASH}");
            let parsed = reqwest::Url::parse(&commit).expect("commit url must parse");
            assert_eq!(parsed.scheme(), "https", "{commit}");
            assert_eq!(parsed.host_str(), Some("github.com"), "{commit}");

            let api =
                format!("https://api.github.com/repos/{owner}/{repo}/commits?per_page=100&page=1");
            let parsed = reqwest::Url::parse(&api).expect("api url must parse");
            assert_eq!(parsed.scheme(), "https", "{api}");
            assert_eq!(parsed.host_str(), Some("api.github.com"), "{api}");
        }
    }

    // remote URL берётся из враждебного .git/config и подставляется в адрес
    // api.github.com, куда уходит Bearer-токен. Управляющие символы в нём не
    // должны ни расщепить строку запроса, ни увести запрос с хоста GitHub.
    #[test]
    fn control_characters_in_a_remote_cannot_split_the_api_request() {
        for url in [
            "https://github.com/o/r\nX",
            "https://github.com/o/r\r\nX-Evil: 1",
            "https://github.com/o\tr/repo",
            "https://github.com/o/r\u{0}X",
            "https://github.com/../victim-org",
            "git@github.com:../..",
            "https://github.com/octocat/Hello-World.git",
        ] {
            let Some((owner, repo)) = parse_github_slug(url) else {
                continue;
            };
            assert!(!owner.contains('/'), "owner from {url:?} splits the path");
            assert!(!repo.contains('/'), "repo from {url:?} splits the path");

            let api =
                format!("https://api.github.com/repos/{owner}/{repo}/commits?per_page=100&page=1");
            let parsed = reqwest::Url::parse(&api).expect("api url must parse");
            assert_eq!(parsed.scheme(), "https", "{url:?}");
            assert_eq!(parsed.host_str(), Some("api.github.com"), "{url:?}");
            let sent = parsed.as_str();
            assert!(
                !sent.chars().any(char::is_control),
                "a remote must not put a control character into the request line: {sent:?}"
            );
        }
    }

    // Тот же разбор, но через настоящий git и настоящий .git/config: репозиторий
    // с похожими на GitHub remote'ами не должен давать slug (иначе туда уедет
    // токен). Вторая фаза проверяет, что поиск вообще работает и None выше — не
    // следствие сломанного окружения.
    #[test]
    fn look_alike_remotes_in_a_hostile_repository_yield_no_slug() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&[
            "remote",
            "add",
            "origin",
            "https://github.com.evil.example/octocat/Hello-World.git",
        ]);
        git(&[
            "remote",
            "add",
            "upstream",
            "git@github.com.evil.example:octocat/Hello-World.git",
        ]);
        git(&[
            "remote",
            "add",
            "mirror",
            "https://evil.example/github.com/octocat/Hello-World.git",
        ]);

        assert_eq!(
            origin_url(root).as_deref(),
            Some("https://github.com.evil.example/octocat/Hello-World.git")
        );
        assert_eq!(github_slug(root), None);

        git(&[
            "remote",
            "add",
            "real",
            "git@github.com:octocat/Hello-World.git",
        ]);
        assert_eq!(
            github_slug(root),
            Some(("octocat".to_owned(), "Hello-World".to_owned()))
        );
    }

    // Конфиг открытого репозитория пишет атакующий, а git_capture запускает git
    // прямо в нём. Алиас, названный как встроенная подкоманда, git обязан
    // игнорировать, а pager/editor/sshCommand/hooksPath — не выполняться при
    // чтении remote'ов и user.email.
    #[test]
    fn a_hostile_repository_config_cannot_hijack_the_git_reads() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&[
            "remote",
            "add",
            "origin",
            "https://github.com/octocat/Hello-World.git",
        ]);
        git(&["config", "user.email", "dev@example.com"]);

        git(&["config", "alias.remote", "!echo pwned"]);
        git(&["config", "alias.config", "!echo pwned"]);
        git(&["config", "core.pager", "definitely-not-a-real-pager"]);
        git(&["config", "core.editor", "definitely-not-a-real-editor"]);
        git(&["config", "core.sshCommand", "definitely-not-a-real-ssh"]);
        git(&[
            "config",
            "core.hooksPath",
            "definitely-not-a-real-hooks-dir",
        ]);

        assert_eq!(
            origin_url(root).as_deref(),
            Some("https://github.com/octocat/Hello-World.git")
        );
        assert_eq!(
            github_slug(root),
            Some(("octocat".to_owned(), "Hello-World".to_owned()))
        );
        assert_eq!(local_git_email(root).as_deref(), Some("dev@example.com"));
    }

    // user.email тоже из враждебного конфига: он становится ключом карты
    // аватарок, поэтому регистр нормализуется (иначе одна почта даёт две
    // записи), а значение без @ отбрасывается.
    #[test]
    fn hostile_repository_email_is_lowercased_and_must_look_like_an_email() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);

        git(&["config", "user.email", "Attacker@EVIL.example"]);
        assert_eq!(
            local_git_email(root).as_deref(),
            Some("attacker@evil.example")
        );

        git(&["config", "user.email", "not-an-email"]);
        assert_eq!(local_git_email(root), None);
    }

    // Ответ commits API может быть подделан (сеть/аккаунт скомпрометированы).
    // Пустые, пробельные и отсутствующие почты не должны заводить записей,
    // коммит без привязанного аккаунта — тоже, а один и тот же адрес в разном
    // регистре и с пробелами обязан схлопываться в одну запись (первая
    // привязка выигрывает — поздний коммит не перебивает раннюю).
    // Логин и avatar_url карта не валидирует и отдаёт как есть: экранирование
    // логина и то, что avatar_url попадает только в <img src>, — на фронтенде.
    #[test]
    fn extract_avatars_drops_blank_emails_and_unlinked_accounts() {
        let json = r#"[
          {"commit":{"author":{"email":"  Mallory@Evil.example  "},"committer":{"email":""}},
           "author":{"login":"<img src=x onerror=alert(1)>","avatar_url":"https://avatars.githubusercontent.com/u/2?v=4"},
           "committer":{"login":"blank-mail","avatar_url":"https://avatars.githubusercontent.com/u/3?v=4"}},
          {"commit":{"author":{"email":"MALLORY@EVIL.EXAMPLE"}},
           "author":{"login":"late-comer","avatar_url":"https://avatars.githubusercontent.com/u/4?v=4"},
           "committer":null},
          {"commit":{"author":{"email":null},"committer":{"email":"   "}},
           "author":{"login":"null-mail","avatar_url":"https://avatars.githubusercontent.com/u/5?v=4"},
           "committer":{"login":"space-mail","avatar_url":"https://avatars.githubusercontent.com/u/6?v=4"}},
          {"commit":{"author":{"email":"ghost@example.com"}},"author":null,"committer":null}
        ]"#;
        let entries: Vec<ApiCommitEntry> = serde_json::from_str(json).unwrap();
        let mut map = std::collections::HashMap::new();
        extract_avatars(&entries, &mut map);

        let mut got: Vec<(String, String, String)> = map
            .into_iter()
            .map(|(email, (login, avatar_url))| (email, login, avatar_url))
            .collect();
        got.sort();
        assert_eq!(
            got,
            vec![(
                "mallory@evil.example".to_owned(),
                "<img src=x onerror=alert(1)>".to_owned(),
                "https://avatars.githubusercontent.com/u/2?v=4".to_owned(),
            )]
        );
    }

    // github_commit_url принимает WebviewWindow и State, поэтому здесь повторены
    // та же проверка хэша и та же сборка ссылки. Хэш приходит по IPC, а готовая
    // строка уходит системному браузеру — в неё не должно попасть ничего, кроме
    // hex-ссылки на коммит.
    #[test]
    fn the_commit_url_only_accepts_a_hex_hash() {
        let commit_url = |hash: &str| -> Option<String> {
            if hash.len() < 7 || !hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
                return None;
            }
            Some(format!(
                "https://github.com/octocat/Hello-World/commit/{hash}"
            ))
        };

        for hash in [
            "",
            "abc123", // короче семи символов
            "main",
            "HEAD@{1}",
            "../../evil",
            "..%2f..%2fevil",
            "javascript:alert(1)",
            "x\" onmouseover=alert(1) y=\"",
            "0123456 0123456",
            "0123456\nX-Evil: 1",
            "0123456\u{0}",
            "0123456g",
            "0123456?x=y",
            "деадбиф",
        ] {
            assert_eq!(
                commit_url(hash),
                None,
                "{hash:?} must never reach the URL handed to the browser"
            );
        }

        assert_eq!(
            commit_url("abc1234").as_deref(),
            Some("https://github.com/octocat/Hello-World/commit/abc1234")
        );
        let url = commit_url("0123456789abcdefABCDEF0123456789abcdef01").unwrap();
        let parsed = reqwest::Url::parse(&url).expect("commit url must parse");
        assert_eq!(parsed.scheme(), "https");
        assert_eq!(parsed.host_str(), Some("github.com"));
        assert_eq!(
            parsed.path(),
            "/octocat/Hello-World/commit/0123456789abcdefABCDEF0123456789abcdef01"
        );
    }

    fn json_keys(value: &serde_json::Value) -> Vec<String> {
        let mut keys: Vec<String> = value
            .as_object()
            .expect("payload must serialize to an object")
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    // Всё, что уходит во фронтенд по IPC, не должно нести access_token: список
    // полей зафиксирован, чтобы будущая правка не дописала его «за компанию».
    #[test]
    fn ipc_payloads_expose_no_token_field() {
        let start = DeviceStart {
            user_code: "ABCD-1234".to_owned(),
            verification_uri: "https://github.com/login/device".to_owned(),
            device_code: "device-code".to_owned(),
            interval: 5,
            expires_in: 900,
        };
        assert_eq!(
            json_keys(&serde_json::to_value(&start).unwrap()),
            vec![
                "deviceCode",
                "expiresIn",
                "interval",
                "userCode",
                "verificationUri"
            ]
        );

        let poll = PollResult {
            status: "authorized".to_owned(),
        };
        assert_eq!(
            json_keys(&serde_json::to_value(&poll).unwrap()),
            vec!["status"]
        );

        let user = GithubUser {
            id: 1,
            login: "octocat".to_owned(),
            avatar_url: "https://avatars.githubusercontent.com/u/1?v=4".to_owned(),
            commit_identity: Some(GitIdentity {
                name: "octocat".to_owned(),
                email: "1+octocat@users.noreply.github.com".to_owned(),
            }),
        };
        assert_eq!(
            json_keys(&serde_json::to_value(&user).unwrap()),
            vec!["avatarUrl", "commitIdentity", "login"]
        );
        // Debug печатается в логи/панику — токена в структурах с ним быть тоже
        // не должно (у GithubUser его нет по составу полей).
        assert!(!format!("{user:?}").contains("token"));

        let avatar = CommitAvatar {
            email: "octocat@example.com".to_owned(),
            avatar_url: "https://avatars.githubusercontent.com/u/1?v=4".to_owned(),
            login: "octocat".to_owned(),
        };
        assert_eq!(
            json_keys(&serde_json::to_value(&avatar).unwrap()),
            vec!["avatarUrl", "email", "login"]
        );
    }

    // Ошибка уходит во фронтенд целиком (включая debug), поэтому ни разбор
    // оборванного ответа токен-эндпоинта, ни неудачная запись файла не должны
    // протащить в неё сам токен.
    #[test]
    fn failed_token_handling_never_echoes_the_token() {
        const SECRET: &str = "gho_supersecrettokenvalue1234567890";

        let truncated = format!("{{\"access_token\":\"{SECRET}");
        // `unwrap_err` потребовал бы Debug у TokenResponse, а он держит сам
        // токен: печатать его не должно быть чем можно случайно.
        let parse_error = serde_json::from_str::<TokenResponse>(&truncated)
            .err()
            .expect("truncated token JSON must fail to parse");
        let error = CommandError::new(ErrorCode::GithubRequestFailed).with_debug(parse_error);
        assert_eq!(error.code, ErrorCode::GithubRequestFailed);
        let json = serde_json::to_string(&error).unwrap();
        assert!(
            !json.contains(SECRET),
            "a decode failure must not carry the token: {json}"
        );

        // Тот же путь, что в store_token: fs::write падает, io::Error → debug.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("github-token");
        std::fs::create_dir_all(&path).unwrap();
        let io_error = std::fs::write(&path, SECRET).unwrap_err();
        let error = CommandError::new(ErrorCode::GithubRequestFailed).with_debug(io_error);
        let json = serde_json::to_string(&error).unwrap();
        assert!(
            !json.contains(SECRET),
            "a write failure must not carry the token: {json}"
        );
    }

    // Токен уходит только заголовком и только помеченным как sensitive: иначе
    // он попал бы в URL (а оттуда в логи прокси и в историю) или в Debug-печать
    // запроса, которая легко утекает в CommandError.debug и дальше во фронтенд.
    #[test]
    fn the_bearer_token_stays_out_of_the_url_and_of_debug_output() {
        const SECRET: &str = "gho_supersecrettokenvalue1234567890";
        let request = http()
            .unwrap()
            .get(USER_URL)
            .header("Accept", "application/vnd.github+json")
            .bearer_auth(SECRET)
            .build()
            .expect("the /user request must build");

        assert!(
            !request.url().as_str().contains(SECRET),
            "the token must not travel in the query string"
        );
        let debug = format!("{request:?}");
        assert!(
            !debug.contains(SECRET),
            "the token must stay redacted in Debug output: {debug}"
        );
    }

    // Файл с токеном может быть подменён локально, а read_token снимает только
    // краевые пробелы — перевод строки внутри значения не должен превращаться в
    // лишний заголовок запроса к GitHub.
    #[test]
    fn a_token_with_control_characters_cannot_inject_a_header() {
        for token in [
            "gho_x\r\nX-Evil: 1",
            "gho_x\nX-Evil: 1",
            "gho_x\rX-Evil: 1",
            "gho_x\u{0}",
        ] {
            let built = http().unwrap().get(USER_URL).bearer_auth(token).build();
            assert!(
                built.is_err(),
                "{token:?} must be refused as an Authorization header"
            );
        }
        let built = http()
            .unwrap()
            .get(USER_URL)
            .bearer_auth("gho_plain_token")
            .build();
        assert!(built.is_ok(), "a normal token must still build a request");
    }

    // read_token принимает AppHandle, поэтому здесь повторена ровно та же
    // последовательность (read_to_string → trim → непусто). Пустой или
    // пробельный файл не должен считаться сессией: иначе уходит запрос с
    // «Authorization: Bearer » и приложение показывает пользователя вошедшим.
    #[test]
    fn a_blank_token_file_is_not_treated_as_a_session() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("github-token");
        let read = || -> Option<String> {
            let token = std::fs::read_to_string(&path).ok()?;
            let token = token.trim().to_owned();
            (!token.is_empty()).then_some(token)
        };

        assert_eq!(read(), None, "a missing token file must mean no session");
        std::fs::write(&path, "").unwrap();
        assert_eq!(read(), None, "an empty token file must mean no session");
        std::fs::write(&path, " \t\r\n ").unwrap();
        assert_eq!(read(), None, "a blank token file must mean no session");
        std::fs::write(&path, "  gho_real_token\n").unwrap();
        assert_eq!(read().as_deref(), Some("gho_real_token"));
    }

    // Эндпоинты device flow прибиты к github.com по https: опечатка в хосте или
    // откат на http отправили бы client_id, device_code и сам токен чужому
    // серверу открытым текстом.
    #[test]
    fn oauth_endpoints_are_pinned_to_github_over_https() {
        let parsed = |raw: &str| reqwest::Url::parse(raw).expect("endpoint must parse");
        for raw in [DEVICE_CODE_URL, TOKEN_URL, USER_URL] {
            assert_eq!(parsed(raw).scheme(), "https", "{raw}");
        }
        assert_eq!(parsed(DEVICE_CODE_URL).host_str(), Some("github.com"));
        assert_eq!(parsed(DEVICE_CODE_URL).path(), "/login/device/code");
        assert_eq!(parsed(TOKEN_URL).host_str(), Some("github.com"));
        assert_eq!(parsed(TOKEN_URL).path(), "/login/oauth/access_token");
        assert_eq!(parsed(USER_URL).host_str(), Some("api.github.com"));
        assert_eq!(parsed(USER_URL).path(), "/user");
    }

    // Ответ device-эндпоинта задаёт фронтенду темп опроса и срок жизни экрана с
    // кодом. Подделанный ответ без обязательных полей или с дробным либо
    // отрицательным интервалом обязан упасть на разборе, а не завести
    // полуготовый flow.
    #[test]
    fn a_tampered_device_code_response_cannot_produce_a_degenerate_flow() {
        for body in [
            r#"{}"#,
            r#"{"user_code":"ABCD-1234","verification_uri":"https://github.com/login/device"}"#,
            r#"{"device_code":"d","verification_uri":"https://github.com/login/device"}"#,
            r#"{"device_code":"d","user_code":"ABCD-1234"}"#,
            r#"{"device_code":null,"user_code":"ABCD-1234","verification_uri":"https://github.com/login/device"}"#,
            r#"{"device_code":"d","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","interval":-5}"#,
            r#"{"device_code":"d","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","interval":0.5}"#,
            r#"{"device_code":"d","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","expires_in":"900"}"#,
        ] {
            assert!(
                serde_json::from_str::<DeviceCodeResponse>(body).is_err(),
                "a tampered device-code response must not parse: {body}"
            );
        }

        let ok: DeviceCodeResponse = serde_json::from_str(
            r#"{"device_code":"d","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","interval":5,"expires_in":900}"#,
        )
        .expect("a well-formed device-code response must parse");
        assert_eq!(ok.device_code, "d");
        assert_eq!(ok.user_code, "ABCD-1234");
        assert_eq!(ok.interval, 5);
        assert_eq!(ok.expires_in, 900);
    }

    // store_token принимает tauri::AppHandle, поэтому здесь повторена ровно та
    // же последовательность std::fs (create_dir_all → write → set_permissions):
    // проверяется состояние файла с токеном на диске — 0600 и обычный файл,
    // причём уже существующий файл сужается, а не остаётся доступным другим.
    #[cfg(unix)]
    #[test]
    fn token_file_on_disk_is_owner_only_and_never_widened() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config").join("github-token");
        let store = |token: &str| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, token).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        };
        let mode = || {
            std::fs::symlink_metadata(&path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        };

        store("gho_first");
        assert_eq!(mode(), 0o600, "a fresh token file must be owner-only");
        let meta = std::fs::symlink_metadata(&path).unwrap();
        assert!(meta.file_type().is_file(), "the token must be a real file");

        // Файл, оставленный кем-то доступным для чтения всем, обязан сузиться.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        store("gho_second");
        assert_eq!(mode(), 0o600, "an existing token file must not stay 0644");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "gho_second");

        // clear_token: файл исчезает целиком, а не остаётся пустым.
        std::fs::remove_file(&path).unwrap();
        assert!(!path.exists());
    }
}
