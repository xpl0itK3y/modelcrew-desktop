use crate::command_error::{CommandError, CommandResult, ErrorCode};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

// Локатор сессий CLI-агентов: по папке проекта и моменту запуска агента в
// панели находит id только что созданной сессии в собственном хранилище
// агента. Id привязывается к панели и даёт точное возобновление
// (`claude --resume <id>`), даже когда в одном проекте несколько
// одинаковых агентов. Только чтение имён файлов и первой строки метаданных;
// ничего не пишем и не отправляем.

// Файл сессии должен появиться в этом окне после старта агента.
const LOCATE_SLACK_BEFORE: Duration = Duration::from_secs(15);
const LOCATE_WINDOW_AFTER: Duration = Duration::from_secs(10 * 60);

fn is_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Кодирование пути проекта в имя папки, как это делает Claude Code:
/// каждый не-алфанумерик становится дефисом.
fn encode_claude_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn file_instant(path: &Path) -> Option<SystemTime> {
    let meta = fs::metadata(path).ok()?;
    // Момент появления сессии — created; на ФС без birth-time откатываемся к
    // modified. Берём раннее из доступных: у живого файла created ≤ modified.
    match (meta.created().ok(), meta.modified().ok()) {
        (Some(created), Some(modified)) => Some(created.min(modified)),
        (Some(instant), None) | (None, Some(instant)) => Some(instant),
        (None, None) => None,
    }
}

fn within_window(instant: SystemTime, since: SystemTime) -> bool {
    let low = since.checked_sub(LOCATE_SLACK_BEFORE).unwrap_or(UNIX_EPOCH);
    let high = since + LOCATE_WINDOW_AFTER;
    instant >= low && instant <= high
}

fn distance(instant: SystemTime, since: SystemTime) -> Duration {
    instant
        .duration_since(since)
        .or_else(|_| since.duration_since(instant))
        .unwrap_or(Duration::ZERO)
}

/// Claude Code: `<config>/projects/<encoded-cwd>/<uuid>.jsonl`.
pub fn locate_claude_session(
    config_dir: &Path,
    cwd: &str,
    since: SystemTime,
    exclude: &[String],
) -> Option<String> {
    let dir = config_dir
        .join("projects")
        .join(encode_claude_project_dir(cwd));
    let entries = fs::read_dir(dir).ok()?;
    let mut best: Option<(Duration, String)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl")
            || !is_session_id(stem)
            || exclude.iter().any(|id| id == stem)
        {
            continue;
        }
        let Some(instant) = file_instant(&path) else {
            continue;
        };
        if !within_window(instant, since) {
            continue;
        }
        let dist = distance(instant, since);
        if best.as_ref().is_none_or(|(bd, _)| dist < *bd) {
            best = Some((dist, stem.to_string()));
        }
    }
    best.map(|(_, id)| id)
}

/// Ищет строковое поле "cwd" в первой строке JSONL (schema-tolerant).
fn json_find_cwd(value: &serde_json::Value, depth: u8) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::String(cwd)) = map.get("cwd") {
                return Some(cwd.clone());
            }
            if depth == 0 {
                return None;
            }
            map.values().find_map(|v| json_find_cwd(v, depth - 1))
        }
        _ => None,
    }
}

fn codex_session_cwd(path: &Path) -> Option<String> {
    // Достаточно первой строки — метаданные сессии codex пишет первой записью.
    let content = fs::read_to_string(path).ok()?;
    let first = content.lines().find(|line| !line.trim().is_empty())?;
    let value: serde_json::Value = serde_json::from_str(first).ok()?;
    json_find_cwd(&value, 3)
}

fn codex_uuid_from_name(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".jsonl")?;
    if !stem.starts_with("rollout-") || stem.len() < 36 {
        return None;
    }
    let uuid = &stem[stem.len() - 36..];
    is_session_id(uuid).then_some(uuid)
}

/// Codex: `<home>/sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl`, cwd — в
/// метаданных первой строки.
pub fn locate_codex_session(
    codex_home: &Path,
    cwd: &str,
    since: SystemTime,
    exclude: &[String],
) -> Option<String> {
    let mut best: Option<(Duration, String)> = None;
    let mut stack = vec![(codex_home.join("sessions"), 0u8)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // sessions/год/месяц/день — глубже не бывает.
                if depth < 3 {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some(uuid) = codex_uuid_from_name(name) else {
                continue;
            };
            if exclude.iter().any(|id| id == uuid) {
                continue;
            }
            let Some(instant) = file_instant(&path) else {
                continue;
            };
            if !within_window(instant, since) {
                continue;
            }
            if codex_session_cwd(&path).as_deref() != Some(cwd) {
                continue;
            }
            let dist = distance(instant, since);
            if best.as_ref().is_none_or(|(bd, _)| dist < *bd) {
                best = Some((dist, uuid.to_string()));
            }
        }
    }
    best.map(|(_, id)| id)
}

/// OpenCode/Kilo: сессии в SQLite (`<data>/opencode.db`, таблица `session`
/// с колонками id/directory/time_created). Читаем только на чтение.
pub fn locate_opencode_session(
    db_path: &Path,
    cwd: &str,
    since: SystemTime,
    exclude: &[String],
) -> Option<String> {
    if !db_path.is_file() {
        return None;
    }
    let connection =
        rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    let mut statement = connection
        .prepare(
            "SELECT id, time_created FROM session \
             WHERE directory = ?1 AND parent_id IS NULL \
             ORDER BY time_created DESC LIMIT 50",
        )
        .ok()?;
    let rows = statement
        .query_map([cwd], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .ok()?;
    let mut best: Option<(Duration, String)> = None;
    for row in rows.flatten() {
        let (id, created_ms) = row;
        if !is_session_id(&id) || exclude.iter().any(|entry| entry == &id) {
            continue;
        }
        let instant = UNIX_EPOCH + Duration::from_millis(created_ms.max(0) as u64);
        if !within_window(instant, since) {
            continue;
        }
        let dist = distance(instant, since);
        if best.as_ref().is_none_or(|(bd, _)| dist < *bd) {
            best = Some((dist, id));
        }
    }
    best.map(|(_, id)| id)
}

/// Antigravity (agy): папки-разговоры `<cli>/brain/<uuid>/` плюс карта
/// `cache/last_conversations.json` «папка проекта → id последнего разговора».
pub fn locate_antigravity_session(
    cli_dir: &Path,
    cwd: &str,
    since: SystemTime,
    exclude: &[String],
) -> Option<String> {
    let mut candidates: Vec<(Duration, String)> = Vec::new();
    if let Ok(entries) = fs::read_dir(cli_dir.join("brain")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !is_session_id(name) || exclude.iter().any(|id| id == name) {
                continue;
            }
            let Some(instant) = file_instant(&path) else {
                continue;
            };
            // У активного разговора mtime папки обновляется — окно шире.
            if !within_window(instant, since) {
                continue;
            }
            candidates.push((distance(instant, since), name.to_string()));
        }
    }
    // Карта «cwd → последний разговор» разрешает неоднозначность между
    // параллельными проектами: у brain-папок нет собственного cwd.
    let mapped: Option<String> = fs::read_to_string(cli_dir.join("cache/last_conversations.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| {
            value
                .get(cwd)
                .and_then(|id| id.as_str())
                .map(str::to_string)
        })
        .filter(|id| is_session_id(id) && !exclude.iter().any(|entry| entry == id));

    if let Some(mapped_id) = &mapped {
        if candidates.iter().any(|(_, id)| id == mapped_id) {
            return Some(mapped_id.clone());
        }
    }
    if candidates.len() == 1 {
        return Some(candidates.remove(0).1);
    }
    // Несколько кандидатов без карты — не гадаем; ноль кандидатов — карта
    // как последний шанс (папка могла не попасть в окно по времени).
    if candidates.is_empty() {
        return mapped;
    }
    None
}

/// Grok Build: `~/.grok/sessions/**` — идентификатор в имени файла/папки,
/// принадлежность проекту проверяется по упоминанию cwd в начале файла.
pub fn locate_grok_session(
    grok_dir: &Path,
    cwd: &str,
    since: SystemTime,
    exclude: &[String],
) -> Option<String> {
    let mut best: Option<(Duration, String)> = None;
    let mut stack = vec![(grok_dir.join("sessions"), 0u8)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth < 4 {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !is_session_id(stem) || exclude.iter().any(|id| id == stem) {
                continue;
            }
            let Some(instant) = file_instant(&path) else {
                continue;
            };
            if !within_window(instant, since) {
                continue;
            }
            if !file_mentions_cwd(&path, cwd) {
                continue;
            }
            let dist = distance(instant, since);
            if best.as_ref().is_none_or(|(bd, _)| dist < *bd) {
                best = Some((dist, stem.to_string()));
            }
        }
    }
    best.map(|(_, id)| id)
}

/// Дешёвая проверка принадлежности файла сессии проекту: cwd упомянут в
/// первых килобайтах (метаданные пишутся в начале).
fn file_mentions_cwd(path: &Path, cwd: &str) -> bool {
    use std::io::Read;
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut head = vec![0_u8; 8 * 1024];
    let Ok(read) = file.read(&mut head) else {
        return false;
    };
    head.truncate(read);
    String::from_utf8_lossy(&head).contains(cwd)
}

fn claude_config_dir(home: &Path) -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"))
}

fn codex_home_dir(home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"))
}

fn xdg_data_home(home: &Path) -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"))
}

/// OPENCODE_DATA_DIR может быть списком через запятую.
fn opencode_db_candidates(home: &Path) -> Vec<PathBuf> {
    if let Some(raw) = std::env::var_os("OPENCODE_DATA_DIR") {
        return raw
            .to_string_lossy()
            .split(',')
            .filter(|part| !part.trim().is_empty())
            .map(|part| PathBuf::from(part.trim()).join("opencode.db"))
            .collect();
    }
    vec![xdg_data_home(home).join("opencode/opencode.db")]
}

fn kilo_db_candidates(home: &Path) -> Vec<PathBuf> {
    let data = xdg_data_home(home);
    // Форк opencode: имя каталога данных зависит от дистрибуции.
    vec![
        data.join("kilo/opencode.db"),
        data.join("kilocode/opencode.db"),
        data.join("kilo/kilo.db"),
    ]
}

fn antigravity_cli_dir(home: &Path) -> PathBuf {
    home.join(".gemini/antigravity-cli")
}

fn grok_dir(home: &Path) -> PathBuf {
    home.join(".grok")
}

#[tauri::command]
pub fn agent_session_locate(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    agent: String,
    cwd: String,
    since_epoch_ms: u64,
    exclude: Vec<String>,
) -> CommandResult<Option<String>> {
    super::ensure_main_window(&window)?;
    for id in &exclude {
        if !is_session_id(id) {
            return Err(CommandError::new(ErrorCode::AgentSessionInvalidId).with_context("id", id));
        }
    }
    let since = UNIX_EPOCH + Duration::from_millis(since_epoch_ms);
    let home = app.path().home_dir().map_err(|error| {
        CommandError::new(ErrorCode::AgentSessionLookupFailed).with_debug(error)
    })?;
    Ok(match agent.as_str() {
        "claude" => locate_claude_session(&claude_config_dir(&home), &cwd, since, &exclude),
        "codex" => locate_codex_session(&codex_home_dir(&home), &cwd, since, &exclude),
        "opencode" => opencode_db_candidates(&home)
            .iter()
            .find_map(|db| locate_opencode_session(db, &cwd, since, &exclude)),
        "kilocode" => kilo_db_candidates(&home)
            .iter()
            .find_map(|db| locate_opencode_session(db, &cwd, since, &exclude)),
        "antigravity" => {
            locate_antigravity_session(&antigravity_cli_dir(&home), &cwd, since, &exclude)
        }
        "grok" => locate_grok_session(&grok_dir(&home), &cwd, since, &exclude),
        // Для прочих агентов адаптеров нет — мягкий фолбэк на фронте.
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "modelcrew-agent-sessions-{label}-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn touch_with_mtime(path: &Path, at: SystemTime) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"{}\n").unwrap();
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(at))
            .unwrap();
    }

    #[test]
    fn claude_project_dir_encoding_matches_observed_layout() {
        assert_eq!(
            encode_claude_project_dir("/Users/denis/github/odysseus"),
            "-Users-denis-github-odysseus"
        );
        assert_eq!(
            encode_claude_project_dir("/home/u/my_app.v2"),
            "-home-u-my-app-v2"
        );
    }

    #[test]
    fn claude_locator_picks_closest_new_session_and_respects_exclude() {
        let config = temp_dir("claude");
        let project = config.join("projects/-tmp-proj");
        let since = SystemTime::now();

        // Старый файл (за окном), занятый другим терминалом, и целевой.
        touch_with_mtime(
            &project.join("old-session.jsonl"),
            since - Duration::from_secs(3600),
        );
        touch_with_mtime(
            &project.join("claimed-session.jsonl"),
            since + Duration::from_secs(2),
        );
        touch_with_mtime(
            &project.join("fresh-session.jsonl"),
            since + Duration::from_secs(5),
        );
        // Не-сессии игнорируются.
        touch_with_mtime(&project.join("notes.txt"), since);

        let found = locate_claude_session(&config, "/tmp/proj", since, &["claimed-session".into()]);
        assert_eq!(found.as_deref(), Some("fresh-session"));
    }

    #[test]
    fn claude_locator_returns_none_outside_window_or_missing_dir() {
        let config = temp_dir("claude-none");
        assert_eq!(
            locate_claude_session(&config, "/tmp/nope", SystemTime::now(), &[]),
            None
        );

        let project = config.join("projects/-tmp-late");
        touch_with_mtime(
            &project.join("stale.jsonl"),
            SystemTime::now() - Duration::from_secs(3600),
        );
        assert_eq!(
            locate_claude_session(&config, "/tmp/late", SystemTime::now(), &[]),
            None
        );
    }

    #[test]
    fn codex_locator_matches_cwd_from_first_line_meta() {
        let home = temp_dir("codex");
        let day = home.join("sessions/2026/07/16");
        fs::create_dir_all(&day).unwrap();
        let since = SystemTime::now();

        let uuid = "0195c9a1-1111-4222-8333-444455556666";
        let path = day.join(format!("rollout-2026-07-16T10-00-00-{uuid}.jsonl"));
        fs::write(
            &path,
            b"{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/tmp/proj\"}}\n",
        )
        .unwrap();

        // Сессия другого проекта в том же окне.
        let other =
            day.join("rollout-2026-07-16T10-00-01-0195c9a1-9999-4888-8777-666655554444.jsonl");
        fs::write(&other, b"{\"payload\":{\"cwd\":\"/tmp/other\"}}\n").unwrap();

        assert_eq!(
            locate_codex_session(&home, "/tmp/proj", since, &[]).as_deref(),
            Some(uuid)
        );
        assert_eq!(
            locate_codex_session(&home, "/tmp/proj", since, &[uuid.into()]),
            None
        );
    }

    #[test]
    fn opencode_locator_queries_sessions_by_directory() {
        let dir = temp_dir("opencode");
        fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("opencode.db");
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    parent_id TEXT,
                    directory TEXT NOT NULL,
                    time_created INTEGER NOT NULL
                );",
            )
            .unwrap();
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        connection
            .execute_batch(&format!(
                "INSERT INTO session VALUES ('ses_target', NULL, '/tmp/proj', {now_ms});
                 INSERT INTO session VALUES ('ses_other', NULL, '/tmp/other', {now_ms});
                 INSERT INTO session VALUES ('ses_child', 'ses_target', '/tmp/proj', {now_ms});
                 INSERT INTO session VALUES ('ses_old', NULL, '/tmp/proj', 1000);"
            ))
            .unwrap();
        drop(connection);

        let since = SystemTime::now();
        assert_eq!(
            locate_opencode_session(&db_path, "/tmp/proj", since, &[]).as_deref(),
            Some("ses_target")
        );
        assert_eq!(
            locate_opencode_session(&db_path, "/tmp/proj", since, &["ses_target".into()]),
            None
        );
        assert_eq!(
            locate_opencode_session(&dir.join("missing.db"), "/tmp/proj", since, &[]),
            None
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn antigravity_locator_uses_brain_dirs_and_folder_map() {
        let cli = temp_dir("agy");
        let since = SystemTime::now();
        fs::create_dir_all(cli.join("brain/aaaa-1111")).unwrap();
        fs::create_dir_all(cli.join("brain/bbbb-2222")).unwrap();
        fs::create_dir_all(cli.join("cache")).unwrap();
        fs::write(
            cli.join("cache/last_conversations.json"),
            b"{\"/tmp/proj\":\"bbbb-2222\",\"/tmp/other\":\"aaaa-1111\"}",
        )
        .unwrap();

        // Два кандидата в окне — решает карта «папка → разговор».
        assert_eq!(
            locate_antigravity_session(&cli, "/tmp/proj", since, &[]).as_deref(),
            Some("bbbb-2222")
        );
        // Занятый id отдаёт оставшегося единственного кандидата.
        assert_eq!(
            locate_antigravity_session(&cli, "/tmp/proj", since, &["bbbb-2222".into()]).as_deref(),
            Some("aaaa-1111")
        );
        let _ = fs::remove_dir_all(cli);
    }

    #[test]
    fn grok_locator_matches_cwd_mention_in_session_head() {
        let grok = temp_dir("grok");
        let day = grok.join("sessions/nested");
        fs::create_dir_all(&day).unwrap();
        fs::write(
            day.join("sess-target.jsonl"),
            b"{\"cwd\":\"/tmp/proj\",\"model\":\"grok\"}\n",
        )
        .unwrap();
        fs::write(day.join("sess-other.jsonl"), b"{\"cwd\":\"/tmp/other\"}\n").unwrap();

        let since = SystemTime::now();
        assert_eq!(
            locate_grok_session(&grok, "/tmp/proj", since, &[]).as_deref(),
            Some("sess-target")
        );
        assert_eq!(
            locate_grok_session(&grok, "/tmp/proj", since, &["sess-target".into()]),
            None
        );
        let _ = fs::remove_dir_all(grok);
    }

    #[test]
    fn codex_uuid_extraction_is_strict() {
        assert_eq!(
            codex_uuid_from_name(
                "rollout-2026-07-16T10-00-00-0195c9a1-1111-4222-8333-444455556666.jsonl"
            ),
            Some("0195c9a1-1111-4222-8333-444455556666")
        );
        assert_eq!(codex_uuid_from_name("rollout-short.jsonl"), None);
        assert_eq!(codex_uuid_from_name("other-file.jsonl"), None);
    }
}
