use crate::agent_sessions::is_session_id;
use crate::command_error::{CommandError, CommandResult, ErrorCode};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

// Какой разговор ведёт каждая панель — единственное, что нельзя потерять.
// Всё остальное приложение умеет восстановить: раскладку, текст терминала,
// историю команд. Разговор восстановить нечем — агент отдаёт его только по
// точному id, и без id панель после перезапуска открывает список чужих чатов
// и просит пользователя вспомнить, где он был.
//
// Поэтому привязки живут здесь: обычный файл в данных приложения, атомарная
// запись, никакого вебвью. localStorage остаётся рабочей копией на время
// запуска — он синхронный, и весь фронтенд читает его на каждый чих, — но
// пережить закрытие приложения обязан именно этот файл. Хранилище вебвью
// чистится вместе с данными сайта, отличается у dev- и установленной сборки
// и не переживает переустановку; для «фишки приложения» это негодный дом.

const STORE_FILE: &str = "agent-sessions.json";
const STORE_VERSION: u32 = 1;

// Панелей столько не бывает; предел — против распухания файла, если что-то
// начнёт писать в него в цикле. Лишними считаются самые давние.
const MAX_SESSIONS: usize = 512;

/// Привязка одной панели к одному разговору.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub panel_id: String,
    pub agent_id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    // Момент последней записи: по нему выбирается, кем жертвовать при
    // переполнении, и кто победит, если один разговор попал в две панели.
    pub updated_at: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    // BTreeMap, а не HashMap: файл читают глазами, и порядок ключей должен
    // быть один и тот же от записи к записи.
    #[serde(default)]
    sessions: BTreeMap<String, StoredEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredEntry {
    agent_id: String,
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    #[serde(default)]
    updated_at: u64,
}

// Чтение-правка-запись должны идти по одному: команды приходят из разных
// задач, а файл один.
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn storage_error(error: std::io::Error) -> CommandError {
    CommandError::new(ErrorCode::AgentSessionStorageFailed).with_debug(error)
}

fn invalid(field: &str, value: &str) -> CommandError {
    CommandError::new(ErrorCode::AgentSessionInvalidId).with_context(field, value)
}

// Панели и проекты приложение именует само (uuid), агентов — из своего
// каталога. Всё, что приходит снаружи этого, в файл не попадает: файл потом
// разбирается обратно во фронтенд и уходит в команду оболочки.
fn is_plain_id(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn store_path(dir: &Path) -> PathBuf {
    dir.join(STORE_FILE)
}

// Битый или чужой файл — не повод падать: привязки просто начнутся заново.
// Молча вернуть пустоту здесь честнее, чем не дать приложению запуститься.
fn read_store(dir: &Path) -> StoreFile {
    let Ok(raw) = fs::read_to_string(store_path(dir)) else {
        return StoreFile {
            version: STORE_VERSION,
            sessions: BTreeMap::new(),
        };
    };
    let mut file: StoreFile = serde_json::from_str(&raw).unwrap_or_default();
    file.version = STORE_VERSION;
    // Проверяем на входе, а не только на записи: файл лежит на диске, и
    // отредактировать его может кто угодно.
    file.sessions.retain(|panel_id, entry| {
        is_plain_id(panel_id, 128)
            && is_plain_id(&entry.agent_id, 64)
            && is_session_id(&entry.session_id)
            && entry
                .workspace_id
                .as_ref()
                .is_none_or(|id| is_plain_id(id, 128))
    });
    file
}

fn write_store(dir: &Path, file: &StoreFile) -> CommandResult<()> {
    fs::create_dir_all(dir).map_err(storage_error)?;
    let body = serde_json::to_string_pretty(file)
        .map_err(|error| CommandError::new(ErrorCode::AgentSessionStorageFailed).with_debug(error))?;
    // Атомарно: оборванная запись не должна оставить панели без разговоров.
    let tmp_path = dir.join(format!("{STORE_FILE}.tmp"));
    {
        let mut handle = fs::File::create(&tmp_path).map_err(storage_error)?;
        handle.write_all(body.as_bytes()).map_err(storage_error)?;
        handle.flush().map_err(storage_error)?;
        // Переименование атомарно только относительно содержимого, которое уже
        // дошло до диска: без sync внезапное выключение оставляет пустой файл
        // под правильным именем.
        handle.sync_all().map_err(storage_error)?;
    }
    fs::rename(&tmp_path, store_path(dir)).map_err(storage_error)
}

fn to_sessions(file: &StoreFile) -> Vec<StoredSession> {
    file.sessions
        .iter()
        .map(|(panel_id, entry)| StoredSession {
            panel_id: panel_id.clone(),
            agent_id: entry.agent_id.clone(),
            session_id: entry.session_id.clone(),
            workspace_id: entry.workspace_id.clone(),
            updated_at: entry.updated_at,
        })
        .collect()
}

pub fn all(dir: &Path) -> Vec<StoredSession> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    to_sessions(&read_store(dir))
}

/// Записывает привязку панели. Тот же разговор снимается с остальных панелей:
/// два процесса в один чат всё равно не пишут, а разъезжаются такие пары
/// молча — пользователь видит просто «агент забыл, о чём мы говорили».
pub fn remember(
    dir: &Path,
    panel_id: &str,
    agent_id: &str,
    session_id: &str,
    workspace_id: Option<&str>,
) -> CommandResult<()> {
    if !is_plain_id(panel_id, 128) {
        return Err(invalid("panelId", panel_id));
    }
    if !is_plain_id(agent_id, 64) {
        return Err(invalid("agentId", agent_id));
    }
    if !is_session_id(session_id) {
        return Err(invalid("sessionId", session_id));
    }
    if let Some(workspace_id) = workspace_id {
        if !is_plain_id(workspace_id, 128) {
            return Err(invalid("workspaceId", workspace_id));
        }
    }

    let _guard = STORE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut file = read_store(dir);
    file.sessions.retain(|id, entry| {
        id == panel_id || !(entry.agent_id == agent_id && entry.session_id == session_id)
    });
    file.sessions.insert(
        panel_id.to_owned(),
        StoredEntry {
            agent_id: agent_id.to_owned(),
            session_id: session_id.to_owned(),
            workspace_id: workspace_id.map(str::to_owned),
            updated_at: now_ms(),
        },
    );
    enforce_limit(&mut file, panel_id);
    write_store(dir, &file)
}

// Переполнение: жертвуем самыми давними, но никогда — той панелью, ради
// которой сейчас пишем.
fn enforce_limit(file: &mut StoreFile, keep: &str) {
    while file.sessions.len() > MAX_SESSIONS {
        let oldest = file
            .sessions
            .iter()
            .filter(|(id, _)| id.as_str() != keep)
            .min_by_key(|(id, entry)| (entry.updated_at, (*id).clone()))
            .map(|(id, _)| id.clone());
        match oldest {
            Some(id) => {
                file.sessions.remove(&id);
            }
            None => break,
        }
    }
}

pub fn forget(dir: &Path, panel_id: &str) -> CommandResult<()> {
    if !is_plain_id(panel_id, 128) {
        return Err(invalid("panelId", panel_id));
    }
    let _guard = STORE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut file = read_store(dir);
    if file.sessions.remove(panel_id).is_none() {
        return Ok(());
    }
    write_store(dir, &file)
}

/// Оставляет привязки только живых панелей. Зовётся на старте по актуальным
/// раскладкам — так же, как чистятся снимки терминалов.
pub fn keep_only(dir: &Path, keep: &[String]) -> CommandResult<()> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut file = read_store(dir);
    let before = file.sessions.len();
    let alive: std::collections::HashSet<&str> = keep.iter().map(String::as_str).collect();
    file.sessions.retain(|panel_id, _| alive.contains(panel_id.as_str()));
    if file.sessions.len() == before {
        return Ok(());
    }
    write_store(dir, &file)
}

fn store_dir(app: &tauri::AppHandle) -> CommandResult<PathBuf> {
    app.path().app_data_dir().map_err(|error| {
        CommandError::new(ErrorCode::AgentSessionStorageFailed).with_debug(error)
    })
}

#[tauri::command]
pub fn agent_sessions_all(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> CommandResult<Vec<StoredSession>> {
    super::ensure_main_window(&window)?;
    Ok(all(&store_dir(&app)?))
}

#[tauri::command]
pub fn agent_sessions_remember(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    panel_id: String,
    agent_id: String,
    session_id: String,
    workspace_id: Option<String>,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    remember(
        &store_dir(&app)?,
        &panel_id,
        &agent_id,
        &session_id,
        workspace_id.as_deref(),
    )
}

#[tauri::command]
pub fn agent_sessions_forget(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    panel_id: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    forget(&store_dir(&app)?, &panel_id)
}

#[tauri::command]
pub fn agent_sessions_keep(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    keep: Vec<String>,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    keep_only(&store_dir(&app)?, &keep)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("временная папка")
    }

    #[test]
    fn remembers_a_session_across_reads() {
        let dir = dir();
        remember(dir.path(), "panel-1", "codex", "01a060ed-d936", Some("ws-1")).unwrap();

        let stored = all(dir.path());
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].panel_id, "panel-1");
        assert_eq!(stored[0].agent_id, "codex");
        assert_eq!(stored[0].session_id, "01a060ed-d936");
        assert_eq!(stored[0].workspace_id.as_deref(), Some("ws-1"));
        assert!(stored[0].updated_at > 0);
    }

    #[test]
    fn a_chat_belongs_to_one_panel_only() {
        // Тот же разговор во второй панели — это разъехавшаяся пара, а не две
        // привязки: у прежней он снимается.
        let dir = dir();
        remember(dir.path(), "panel-1", "codex", "01a060ed-d936", None).unwrap();
        remember(dir.path(), "panel-2", "codex", "01a060ed-d936", None).unwrap();

        let stored = all(dir.path());
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].panel_id, "panel-2");
    }

    #[test]
    fn the_same_id_under_another_agent_is_a_different_chat() {
        let dir = dir();
        remember(dir.path(), "panel-1", "codex", "shared-id", None).unwrap();
        remember(dir.path(), "panel-2", "claude", "shared-id", None).unwrap();

        assert_eq!(all(dir.path()).len(), 2);
    }

    #[test]
    fn rewrites_the_same_panel_without_duplicating_it() {
        let dir = dir();
        remember(dir.path(), "panel-1", "codex", "first-chat", None).unwrap();
        remember(dir.path(), "panel-1", "codex", "second-chat", Some("ws-1")).unwrap();

        let stored = all(dir.path());
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].session_id, "second-chat");
        assert_eq!(stored[0].workspace_id.as_deref(), Some("ws-1"));
    }

    #[test]
    fn forgets_one_panel_and_keeps_the_rest() {
        let dir = dir();
        remember(dir.path(), "panel-1", "codex", "chat-a", None).unwrap();
        remember(dir.path(), "panel-2", "codex", "chat-b", None).unwrap();

        forget(dir.path(), "panel-1").unwrap();
        // Панели, которой нет, забывать нечего — и это не ошибка.
        forget(dir.path(), "panel-1").unwrap();

        let stored = all(dir.path());
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].panel_id, "panel-2");
    }

    #[test]
    fn keeps_only_panels_that_still_exist() {
        let dir = dir();
        remember(dir.path(), "panel-1", "codex", "chat-a", None).unwrap();
        remember(dir.path(), "panel-2", "codex", "chat-b", None).unwrap();
        remember(dir.path(), "panel-3", "claude", "chat-c", None).unwrap();

        keep_only(dir.path(), &["panel-2".to_owned(), "panel-3".to_owned()]).unwrap();

        let mut ids: Vec<String> = all(dir.path()).into_iter().map(|s| s.panel_id).collect();
        ids.sort();
        assert_eq!(ids, vec!["panel-2".to_owned(), "panel-3".to_owned()]);
    }

    #[test]
    fn refuses_values_that_would_reach_a_shell_command() {
        let dir = dir();
        for (panel, agent, session) in [
            ("panel 1", "codex", "chat-a"),
            ("panel-1", "co dex", "chat-a"),
            ("panel-1", "codex", "chat a"),
            ("panel-1", "codex", "$(id)"),
            ("panel-1", "codex", ""),
            ("../escape", "codex", "chat-a"),
        ] {
            assert!(
                remember(dir.path(), panel, agent, session, None).is_err(),
                "принято недопустимое: {panel} {agent} {session}"
            );
        }
        assert!(remember(dir.path(), "panel-1", "codex", "chat-a", Some("ws 1")).is_err());
        assert!(all(dir.path()).is_empty(), "ничего не должно было записаться");
    }

    #[test]
    fn a_damaged_file_costs_the_bindings_but_not_the_launch() {
        let dir = dir();
        fs::create_dir_all(dir.path()).unwrap();
        fs::write(store_path(dir.path()), "{ это не json").unwrap();

        assert!(all(dir.path()).is_empty());
        // И поверх него снова можно писать.
        remember(dir.path(), "panel-1", "codex", "chat-a", None).unwrap();
        assert_eq!(all(dir.path()).len(), 1);
    }

    #[test]
    fn entries_edited_on_disk_into_something_hostile_are_dropped() {
        // Файл лежит в данных приложения, а не за семью замками: значения из
        // него уходят во фронтенд и оттуда в команду оболочки.
        let dir = dir();
        fs::create_dir_all(dir.path()).unwrap();
        fs::write(
            store_path(dir.path()),
            r#"{"version":1,"sessions":{
                "panel-1":{"agentId":"codex","sessionId":"; rm -rf /","updatedAt":1},
                "panel-2":{"agentId":"codex","sessionId":"chat-b","updatedAt":2}
            }}"#,
        )
        .unwrap();

        let stored = all(dir.path());
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].panel_id, "panel-2");
    }

    #[test]
    fn an_unfinished_write_never_replaces_the_bindings() {
        // Брошенный .tmp остаётся мусором, но rename его не подхватывает.
        let dir = dir();
        remember(dir.path(), "panel-1", "codex", "chat-a", None).unwrap();
        fs::write(dir.path().join(format!("{STORE_FILE}.tmp")), "полузапись").unwrap();

        let stored = all(dir.path());
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].session_id, "chat-a");
    }

    #[test]
    fn drops_the_oldest_when_the_file_would_grow_without_end() {
        let dir = dir();
        for index in 0..MAX_SESSIONS {
            remember(
                dir.path(),
                &format!("panel-{index:04}"),
                "codex",
                &format!("chat-{index:04}"),
                None,
            )
            .unwrap();
        }
        remember(dir.path(), "panel-last", "codex", "chat-last", None).unwrap();

        let stored = all(dir.path());
        assert_eq!(stored.len(), MAX_SESSIONS);
        assert!(
            stored.iter().any(|item| item.panel_id == "panel-last"),
            "выжить обязана та панель, ради которой писали"
        );
    }
}
