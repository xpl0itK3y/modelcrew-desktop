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

/// GitHub Copilot CLI: `<home>/session-state/<uuid>/` с историей в
/// `events.jsonl` и метаданными проекта в `workspace.yaml`.
pub fn locate_copilot_session(
    copilot_home: &Path,
    cwd: &str,
    since: SystemTime,
    exclude: &[String],
) -> Option<String> {
    let entries = fs::read_dir(copilot_home.join("session-state")).ok()?;
    let mut best: Option<(Duration, String)> = None;

    for entry in entries.flatten() {
        let session_dir = entry.path();
        if !session_dir.is_dir() {
            continue;
        }
        let Some(id) = session_dir.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !is_session_id(id) || exclude.iter().any(|excluded| excluded == id) {
            continue;
        }

        let events = session_dir.join("events.jsonl");
        let workspace = session_dir.join("workspace.yaml");
        if !events.is_file() {
            continue;
        }
        let Some(instant) = file_instant(&events).or_else(|| file_instant(&session_dir)) else {
            continue;
        };
        if !within_window(instant, since) {
            continue;
        }
        // Формат метаданных менялся между версиями CLI. Ищем cwd сначала в
        // выделенном workspace.yaml, затем в заголовке журнала событий.
        if !file_mentions_cwd(&workspace, cwd) && !file_mentions_cwd(&events, cwd) {
            continue;
        }

        let dist = distance(instant, since);
        if best.as_ref().is_none_or(|(best_dist, _)| dist < *best_dist) {
            best = Some((dist, id.to_string()));
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
    let head = String::from_utf8_lossy(&head);
    if head.contains(cwd) {
        return true;
    }
    // В JSON Windows-путь записывается с удвоенными `\`. Сравниваем ещё и
    // безопасно экранированное представление, иначе точная привязка Copilot
    // работала бы на Unix, но молча откатывалась к --continue на Windows.
    serde_json::to_string(cwd)
        .ok()
        .and_then(|encoded| {
            encoded
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .map(str::to_string)
        })
        .is_some_and(|encoded| head.contains(&encoded))
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

fn copilot_home_dir(home: &Path) -> PathBuf {
    std::env::var_os("COPILOT_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".copilot"))
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
        "copilot" => locate_copilot_session(&copilot_home_dir(&home), &cwd, since, &exclude),
        "opencode" => opencode_db_candidates(&home)
            .iter()
            .find_map(|db| locate_opencode_session(db, &cwd, since, &exclude)),
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
    fn copilot_locator_matches_workspace_and_respects_exclude() {
        let home = temp_dir("copilot");
        let sessions = home.join("session-state");
        let target_id = "3a659d2e-1bb9-4814-8525-cb190c8d6e77";
        let other_id = "fe576b67-8be6-4d4d-91eb-d987825478c4";
        let since = SystemTime::now();

        let target = sessions.join(target_id);
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("workspace.yaml"), b"cwd: /tmp/proj\n").unwrap();
        fs::write(
            target.join("events.jsonl"),
            b"{\"type\":\"session.start\"}\n",
        )
        .unwrap();

        let other = sessions.join(other_id);
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("workspace.yaml"), b"cwd: /tmp/other\n").unwrap();
        fs::write(
            other.join("events.jsonl"),
            b"{\"type\":\"session.start\"}\n",
        )
        .unwrap();

        assert_eq!(
            locate_copilot_session(&home, "/tmp/proj", since, &[]).as_deref(),
            Some(target_id)
        );
        assert_eq!(
            locate_copilot_session(&home, "/tmp/proj", since, &[target_id.into()]),
            None
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn copilot_locator_falls_back_to_event_metadata() {
        let home = temp_dir("copilot-events");
        let id = "5fd54656-7dbf-4c74-954c-e7c7f49df1dd";
        let session = home.join("session-state").join(id);
        fs::create_dir_all(&session).unwrap();
        fs::write(
            session.join("events.jsonl"),
            b"{\"type\":\"session.start\",\"context\":{\"cwd\":\"/tmp/proj\"}}\n",
        )
        .unwrap();

        assert_eq!(
            locate_copilot_session(&home, "/tmp/proj", SystemTime::now(), &[]).as_deref(),
            Some(id)
        );
        let _ = fs::remove_dir_all(home);
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

    // Идентификатор сессии приходит с фронтенда и сравнивается с именами
    // файлов, поэтому в нём не должно быть ничего, что читается как путь.
    #[test]
    fn session_ids_reject_anything_that_could_become_a_path() {
        for good in [
            "a",
            "0195c9a1-1111-4222-8333-444455556666",
            "a_b-C9",
            &"x".repeat(128),
        ] {
            assert!(is_session_id(good), "rejected a legitimate id: {good}");
        }
        for bad in [
            "",
            "..",
            "../secret",
            "a/b",
            "a\\b",
            "a b",
            "a.jsonl",
            "a\0b",
            "a\nb",
            "сессия",
            "a:b",
            "~",
            "*",
            &"x".repeat(129),
        ] {
            assert!(!is_session_id(bad), "accepted a hostile id: {bad:?}");
        }
    }

    // Путь проекта подставляется в имя папки. Любой разделитель обязан
    // превратиться в дефис, иначе `..` увёл бы поиск в чужой каталог.
    #[test]
    fn project_dir_encoding_cannot_escape_the_projects_folder() {
        for cwd in [
            "../../etc",
            "/../../root/.ssh",
            "..\\..\\Windows\\System32",
            "/tmp/a/../../etc/passwd",
            "~/.ssh",
            "/tmp/проект",
            "/tmp/a b",
            "/tmp/a\0b",
        ] {
            let encoded = encode_claude_project_dir(cwd);
            assert!(
                encoded
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-'),
                "{cwd:?} encoded into something that is not a flat name: {encoded:?}"
            );
            let path = Path::new(&encoded);
            assert_eq!(
                path.components().count(),
                1,
                "{cwd:?} encoded into more than one path component: {encoded:?}"
            );
            assert!(!path.is_absolute(), "{cwd:?} encoded into an absolute path");
        }
    }

    // В каталоге проекта может лежать что угодно — берём только настоящие
    // файлы сессий, а не всё подряд с расширением.
    #[test]
    fn claude_locator_ignores_files_that_are_not_session_files() {
        let config = temp_dir("claude-hostile");
        let project = config.join("projects").join("-tmp-proj");
        let since = SystemTime::now();

        for name in [
            "not a session.jsonl",
            "session.with.dots.jsonl",
            "0195c9a1-1111-4222-8333-444455556666.txt",
            "0195c9a1-1111-4222-8333-444455556666.jsonl.bak",
        ] {
            touch_with_mtime(&project.join(name), since);
        }
        touch_with_mtime(&project.join("real0195c9a11111.jsonl"), since);

        assert_eq!(
            locate_claude_session(&config, "/tmp/proj", since, &[]),
            Some("real0195c9a11111".to_string())
        );
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn codex_uuid_extraction_rejects_separators_and_traversal() {
        for name in [
            "rollout-2026-07-16-../../../../etc/passwd0195c9a1-1111-4222.jsonl",
            "rollout-2026-07-16-0195c9a1 1111 4222 8333 444455556666.jsonl",
            "rollout-2026-07-16-0195c9a1.1111.4222.8333.444455556666.jsonl",
            "rollout-.jsonl",
        ] {
            assert_eq!(codex_uuid_from_name(name), None, "accepted {name:?}");
        }
    }

    // Файл сессии пишет агент, а не мы: он может оказаться огромным.
    // Совпадение ищется только в начале, целиком его читать нельзя.
    #[test]
    fn cwd_matching_reads_only_the_head_of_a_session_file() {
        let dir = temp_dir("head-only");
        fs::create_dir_all(&dir).unwrap();
        let cwd = "/tmp/needle-project";

        let near = dir.join("near.jsonl");
        fs::write(&near, format!("{{\"cwd\":\"{cwd}\"}}\n")).unwrap();
        assert!(file_mentions_cwd(&near, cwd));

        let far = dir.join("far.jsonl");
        fs::write(&far, format!("{}{cwd}", "a".repeat(16 * 1024))).unwrap();
        assert!(
            !file_mentions_cwd(&far, cwd),
            "the whole session file was scanned instead of its head"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cwd_matching_accepts_json_escaped_windows_paths() {
        let dir = temp_dir("windows-cwd");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.jsonl");
        let cwd = r"C:\Users\Denis\project";
        fs::write(
            &path,
            format!(
                "{{\"context\":{{\"cwd\":{}}}}}\n",
                serde_json::to_string(cwd).unwrap()
            ),
        )
        .unwrap();

        assert!(file_mentions_cwd(&path, cwd));
        let _ = fs::remove_dir_all(dir);
    }

    // Метаданные сессии — чужой JSON. Поиск cwd ограничен по глубине, иначе
    // вложенный на тысячу уровней объект увёл бы обход в рекурсию.
    #[test]
    fn cwd_lookup_in_session_metadata_is_depth_limited() {
        let shallow = serde_json::json!({ "a": { "b": { "cwd": "/tmp/p" } } });
        assert_eq!(json_find_cwd(&shallow, 3), Some("/tmp/p".to_string()));

        let deep = serde_json::json!({ "a": { "b": { "c": { "d": { "cwd": "/tmp/p" } } } } });
        assert_eq!(json_find_cwd(&deep, 3), None);

        let wrong_type = serde_json::json!({ "cwd": ["/tmp/p"] });
        assert_eq!(json_find_cwd(&wrong_type, 3), None);
    }
}
