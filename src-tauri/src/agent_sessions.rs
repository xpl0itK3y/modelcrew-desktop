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

pub(crate) fn is_session_id(value: &str) -> bool {
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

/// Когда сессия появилась и когда в неё писали в последний раз.
///
/// Появление — created; на ФС без birth-time откатываемся к modified. Берём
/// раннее из доступных: у живого файла created ≤ modified.
fn file_times(path: &Path) -> Option<(SystemTime, SystemTime)> {
    let meta = fs::metadata(path).ok()?;
    match (meta.created().ok(), meta.modified().ok()) {
        (Some(created), Some(modified)) => Some((created.min(modified), modified)),
        (Some(instant), None) | (None, Some(instant)) => Some((instant, instant)),
        (None, None) => None,
    }
}

fn window_floor(since: SystemTime) -> SystemTime {
    since.checked_sub(LOCATE_SLACK_BEFORE).unwrap_or(UNIX_EPOCH)
}

fn within_window(instant: SystemTime, since: SystemTime) -> bool {
    let high = since + LOCATE_WINDOW_AFTER;
    instant >= window_floor(since) && instant <= high
}

/// Похожа ли сессия на принадлежащую этой панели.
///
/// Двумя способами, потому что панель приходит к диалогу двумя путями. Новый
/// разговор — файл появляется рядом с запуском агента, это прежнее правило.
/// Продолженный — файл создан хоть месяц назад, а пишут в него прямо сейчас,
/// и по времени появления его не найти уже никогда.
///
/// Второй случай был дырой, и она сама себя воспроизводила: панель без
/// привязки открывала список диалогов, пользователь выбирал старый разговор,
/// локатор его не видел, привязка не появлялась — и в следующий раз панель
/// снова открывала список. Ровно это и наблюдалось у codex.
fn belongs_to_panel(created: SystemTime, modified: SystemTime, since: SystemTime) -> bool {
    within_window(created, since) || modified >= window_floor(since)
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
    let mut best: Option<(SystemTime, String)> = None;
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
        let Some((created, modified)) = file_times(&path) else {
            continue;
        };
        if !belongs_to_panel(created, modified, since) {
            continue;
        }
        if best.as_ref().is_none_or(|(best_at, _)| modified > *best_at) {
            best = Some((modified, stem.to_string()));
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

// Первая строка rollout'а несёт и системные инструкции целиком, так что она
// бывает в десятки килобайт. Предел — против файла, где перевода строки нет
// вовсе: читать его до конца ради заголовка незачем.
const CODEX_META_LIMIT: u64 = 1024 * 1024;

/// Чей это разговор и где он идёт: метаданные из первой строки rollout'а.
struct CodexMeta {
    cwd: String,
    // Id диалога, как его понимает `codex resume`. Берётся отсюда, а не из
    // имени файла: у продолженного диалога файлов бывает несколько, и в
    // хвосте имени тогда стоит id куска, а не разговора.
    id: Option<String>,
}

fn codex_session_meta(path: &Path) -> Option<CodexMeta> {
    use std::io::{BufRead, BufReader, Read};
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file.take(CODEX_META_LIMIT));
    let mut first = String::new();
    while first.trim().is_empty() {
        first.clear();
        if reader.read_line(&mut first).ok()? == 0 {
            return None;
        }
    }
    let value: serde_json::Value = serde_json::from_str(first.trim()).ok()?;
    let cwd = json_find_cwd(&value, 3)?;
    let payload = value.get("payload").unwrap_or(&value);
    let id = ["id", "session_id"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(serde_json::Value::as_str))
        .filter(|id| is_session_id(id))
        .map(str::to_string);
    Some(CodexMeta { cwd, id })
}

fn codex_uuid_from_name(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".jsonl")?;
    if !stem.starts_with("rollout-") || stem.len() < 36 {
        return None;
    }
    let uuid = &stem[stem.len() - 36..];
    is_session_id(uuid).then_some(uuid)
}

/// Все rollout'ы codex: `<home>/sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl`.
fn codex_rollouts(codex_home: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
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
            let is_rollout = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(codex_uuid_from_name)
                .is_some();
            if is_rollout {
                found.push(path);
            }
        }
    }
    found
}

/// Id диалога из rollout'а этого проекта, если файл к проекту относится.
fn codex_session_of(path: &Path, cwd: &str) -> Option<String> {
    let meta = codex_session_meta(path)?;
    if meta.cwd != cwd {
        return None;
    }
    meta.id.or_else(|| {
        path.file_name()
            .and_then(|name| name.to_str())
            .and_then(codex_uuid_from_name)
            .map(str::to_string)
    })
}

/// Codex: по папке и моменту запуска, cwd — в метаданных первой строки.
///
/// Догадка по времени: подходит любой разговор проекта, который появился или
/// пишется рядом с запуском. Пока codex в проекте один, такой разговор один и
/// есть. Когда их два, свежими выглядят оба, и «самый свежий из них» — это
/// просто тот, кто последним дописал строку: так две панели и менялись чатами.
/// Поэтому при двух кандидатах ответа нет — точный ответ даст начало хода
/// (`locate_codex_turn`), а неверная привязка хуже никакой.
pub fn locate_codex_session(
    codex_home: &Path,
    cwd: &str,
    since: SystemTime,
    exclude: &[String],
) -> Option<String> {
    let mut found: Option<String> = None;
    for path in codex_rollouts(codex_home) {
        let Some((created, modified)) = file_times(&path) else {
            continue;
        };
        if !belongs_to_panel(created, modified, since) {
            continue;
        }
        let Some(id) = codex_session_of(&path, cwd) else {
            continue;
        };
        if exclude.contains(&id) {
            continue;
        }
        match &found {
            None => found = Some(id),
            Some(known) if *known == id => {}
            Some(_) => return None,
        }
    }
    found
}

// Начало хода ищется вокруг нажатия Enter в панели. Раньше нажатия codex ход
// не начнёт, а секунда в запас — на разницу между тем, когда фронтенд
// посмотрел на часы, и тем, когда байты дошли до PTY.
const TURN_SLACK_BEFORE: Duration = Duration::from_secs(1);
// Первый ход свежего разговора ждёт, пока поднимутся MCP-серверы, и
// начинается позже нажатия на секунды.
const TURN_WINDOW_AFTER: Duration = Duration::from_secs(8);
// За десять секунд хода в rollout не успевает попасть больше пары мегабайт
// даже с длинными выводами инструментов; читать весь файл незачем.
const TURN_TAIL_LIMIT: u64 = 2 * 1024 * 1024;

/// Начинался ли в этом rollout'е ход внутри окна вокруг нажатия.
fn codex_turn_started_near(path: &Path, turn_at: SystemTime) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let length = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let start = length.saturating_sub(TURN_TAIL_LIMIT);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut tail = Vec::new();
    if file.read_to_end(&mut tail).is_err() {
        return false;
    }
    let tail = String::from_utf8_lossy(&tail);
    let low = turn_at.checked_sub(TURN_SLACK_BEFORE).unwrap_or(UNIX_EPOCH);
    let high = turn_at + TURN_WINDOW_AFTER;
    // Первая строка хвоста почти всегда обрезана — её JSON просто не
    // разберётся и выпадет сам.
    tail.lines()
        // Дешёвый отсев до разбора: ходов в файле единицы, строк — тысячи.
        .filter(|line| line.contains("task_started") || line.contains("user_message"))
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|value| value.get("type").and_then(serde_json::Value::as_str) == Some("event_msg"))
        .filter(|value| {
            matches!(
                value
                    .get("payload")
                    .and_then(|payload| payload.get("type"))
                    .and_then(serde_json::Value::as_str),
                Some("task_started" | "user_message")
            )
        })
        .filter_map(|value| {
            value
                .get("timestamp")
                .and_then(serde_json::Value::as_str)
                .and_then(parse_utc_timestamp)
        })
        .any(|at| at >= low && at <= high)
}

/// Codex: диалог, в котором ход начался сразу после нажатия Enter в панели.
///
/// Это уже не догадка по свежести файла. Ход начинается ровно от отправки
/// сообщения, и codex пишет его начало в rollout с меткой времени, так что
/// соседняя панель в том же проекте сюда не попадает: её ходы начинаются от
/// её нажатий. Если ходы в окне начались в двух разных разговорах, ответа нет —
/// угадывать между ними нечем, а следующий Enter спросит снова.
///
/// Чужие привязки здесь не исключаются, а считаются: ход в разговоре
/// соседки — такой же свидетель, и без него единственным кандидатом мог бы
/// остаться неверный.
pub fn locate_codex_turn(codex_home: &Path, cwd: &str, turn_at: SystemTime) -> Option<String> {
    let floor = turn_at.checked_sub(TURN_SLACK_BEFORE).unwrap_or(UNIX_EPOCH);
    let mut found: Option<String> = None;
    for path in codex_rollouts(codex_home) {
        // Ход в окне сдвинул бы время записи; файл, который с тех пор не
        // трогали, читать незачем.
        let Some((_, modified)) = file_times(&path) else {
            continue;
        };
        if modified < floor {
            continue;
        }
        let Some(id) = codex_session_of(&path, cwd) else {
            continue;
        };
        if !codex_turn_started_near(&path, turn_at) {
            continue;
        }
        match &found {
            None => found = Some(id),
            Some(known) if *known == id => {}
            Some(_) => return None,
        }
    }
    found
}

/// `2026-09-21T12:10:08.161Z` → момент времени. Codex пишет метки в UTC; знак
/// смещения тоже понимаем, на случай если где-то он окажется не нулевым.
fn parse_utc_timestamp(text: &str) -> Option<SystemTime> {
    let bytes = text.as_bytes();
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = text.get(range)?;
        part.bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| part.parse().ok())?
    };
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't' | b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut rest = &text[19..];
    let mut nanos: u64 = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        for (index, byte) in fraction.bytes().take(9).take(digits).enumerate() {
            nanos += u64::from(byte - b'0') * 10_u64.pow(8 - index as u32);
        }
        rest = &fraction[digits..];
    }
    let offset_seconds = match rest {
        "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes().first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let offset = rest.get(1..)?;
            if offset.len() != 5 || offset.as_bytes()[2] != b':' {
                return None;
            }
            let hours: i64 = offset.get(0..2)?.parse().ok()?;
            let minutes: i64 = offset.get(3..5)?.parse().ok()?;
            sign * (hours * 3600 + minutes * 60)
        }
    };
    // Число дней от 1970-01-01 по григорианскому календарю (алгоритм Хиннанта).
    let shifted_year = if month <= 2 { year - 1 } else { year };
    let era = shifted_year.div_euclid(400);
    let year_of_era = shifted_year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset_seconds;
    let seconds = u64::try_from(seconds).ok()?;
    Some(UNIX_EPOCH + Duration::from_secs(seconds) + Duration::from_nanos(nanos))
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
    let mut best: Option<(SystemTime, String)> = None;

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
        let Some((created, modified)) = file_times(&events).or_else(|| file_times(&session_dir))
        else {
            continue;
        };
        if !belongs_to_panel(created, modified, since) {
            continue;
        }
        // Формат метаданных менялся между версиями CLI. Ищем cwd сначала в
        // выделенном workspace.yaml, затем в заголовке журнала событий.
        if !file_mentions_cwd(&workspace, cwd) && !file_mentions_cwd(&events, cwd) {
            continue;
        }

        if best.as_ref().is_none_or(|(best_at, _)| modified > *best_at) {
            best = Some((modified, id.to_string()));
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
            "SELECT id, time_created, time_updated FROM session \
             WHERE directory = ?1 AND parent_id IS NULL \
             ORDER BY time_updated DESC LIMIT 50",
        )
        .ok()?;
    let rows = statement
        .query_map([cwd], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .ok()?;
    let mut best: Option<(SystemTime, String)> = None;
    for row in rows.flatten() {
        let (id, created_ms, updated_ms) = row;
        if !is_session_id(&id) || exclude.iter().any(|entry| entry == &id) {
            continue;
        }
        let created = UNIX_EPOCH + Duration::from_millis(created_ms.max(0) as u64);
        let modified = UNIX_EPOCH + Duration::from_millis(updated_ms.max(0) as u64);
        if !belongs_to_panel(created, modified, since) {
            continue;
        }
        if best.as_ref().is_none_or(|(best_at, _)| modified > *best_at) {
            best = Some((modified, id));
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

pub(crate) fn claude_config_dir(home: &Path) -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"))
}

pub(crate) fn codex_home_dir(home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"))
}

pub(crate) fn copilot_home_dir(home: &Path) -> PathBuf {
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
pub(crate) fn opencode_db_candidates(home: &Path) -> Vec<PathBuf> {
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
    window: tauri::Webview,
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

/// Диалог, в котором ход начался сразу после нажатия Enter в панели.
///
/// Только для агентов, чей журнал помечает начало хода временем. Остальным
/// панелям id называет их собственный хук, а не этот поиск.
#[tauri::command]
pub fn agent_session_locate_turn(
    window: tauri::Webview,
    app: tauri::AppHandle,
    agent: String,
    cwd: String,
    turn_epoch_ms: u64,
) -> CommandResult<Option<String>> {
    super::ensure_main_window(&window)?;
    let turn_at = UNIX_EPOCH + Duration::from_millis(turn_epoch_ms);
    let home = app.path().home_dir().map_err(|error| {
        CommandError::new(ErrorCode::AgentSessionLookupFailed).with_debug(error)
    })?;
    Ok(match agent.as_str() {
        "codex" => locate_codex_turn(&codex_home_dir(&home), &cwd, turn_at),
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
    fn a_conversation_written_right_now_belongs_to_the_panel() {
        let since = SystemTime::now();
        let long_ago = since - Duration::from_secs(30 * 24 * 3600);
        let just_after = since + Duration::from_secs(2);

        // Новый разговор: файл появился рядом с запуском агента.
        assert!(belongs_to_panel(just_after, just_after, since));

        // Продолженный: заведён месяц назад, пишут в него прямо сейчас. Это и
        // была дыра — панель без привязки открывала список, пользователь
        // выбирал старый разговор, и найти его локатор уже не мог никогда.
        assert!(belongs_to_panel(long_ago, just_after, since));

        // Заброшенный чужой: и появился давно, и не трогали.
        assert!(!belongs_to_panel(long_ago, long_ago, since));
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

    /// Rollout codex: заголовок с проектом и id, затем строки журнала.
    fn write_rollout(path: &Path, id: &str, cwd: &str, lines: &[String]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut body = format!(
            "{{\"timestamp\":\"2026-09-21T12:00:00.000Z\",\"type\":\"session_meta\",\
             \"payload\":{{\"id\":\"{id}\",\"session_id\":\"{id}\",\"cwd\":\"{cwd}\"}}}}\n"
        );
        for line in lines {
            body.push_str(line);
            body.push('\n');
        }
        fs::write(path, body).unwrap();
    }

    fn turn_started(at: &str) -> String {
        format!(
            "{{\"timestamp\":\"{at}\",\"type\":\"event_msg\",\
             \"payload\":{{\"type\":\"task_started\",\"turn_id\":\"t\"}}}}"
        )
    }

    fn streamed_output(at: &str) -> String {
        format!(
            "{{\"timestamp\":\"{at}\",\"type\":\"response_item\",\
             \"payload\":{{\"type\":\"message\",\"role\":\"assistant\"}}}}"
        )
    }

    #[test]
    fn codex_conversation_id_comes_from_the_header_not_the_file_name() {
        // У продолженного диалога файлов несколько, и в хвосте имени стоит id
        // куска. `codex resume` с ним не найдёт ничего.
        let home = temp_dir("codex-segment");
        let thread = "01a0d305-9ca5-7000-80e7-d9fc6a32bf9c";
        let segment = "01a0d30d-ac32-7cb0-8b10-3dfc22fb894f";
        write_rollout(
            &home.join(format!(
                "sessions/2026/09/24/rollout-2026-09-24T15-54-43-{thread}_{segment}.jsonl"
            )),
            thread,
            "/tmp/proj",
            &[],
        );

        assert_eq!(
            locate_codex_session(&home, "/tmp/proj", SystemTime::now(), &[]).as_deref(),
            Some(thread)
        );
        // Исключение тоже сверяется с id диалога.
        assert_eq!(
            locate_codex_session(&home, "/tmp/proj", SystemTime::now(), &[thread.into()]),
            None
        );
    }

    #[test]
    fn codex_locator_does_not_pick_between_two_live_conversations() {
        // Два codex в одном проекте: свежие оба, и «самый свежий» — просто
        // тот, кто последним дописал строку. Так панели и менялись чатами.
        let home = temp_dir("codex-two");
        let day = home.join("sessions/2026/10/14");
        let first = "0195c9a1-1111-4222-8333-000000000001";
        let second = "0195c9a1-1111-4222-8333-000000000002";
        write_rollout(
            &day.join(format!("rollout-2026-10-14T10-00-00-{first}.jsonl")),
            first,
            "/tmp/proj",
            &[],
        );
        write_rollout(
            &day.join(format!("rollout-2026-10-14T10-00-05-{second}.jsonl")),
            second,
            "/tmp/proj",
            &[],
        );
        let since = SystemTime::now();

        assert_eq!(locate_codex_session(&home, "/tmp/proj", since, &[]), None);
        // Соседка свой уже назвала — оставшийся кандидат один.
        assert_eq!(
            locate_codex_session(&home, "/tmp/proj", since, &[first.into()]).as_deref(),
            Some(second)
        );
    }

    #[test]
    fn codex_turn_locator_names_the_conversation_the_key_started() {
        let home = temp_dir("codex-turn");
        let day = home.join("sessions/2026/09/21");
        let mine = "0195c9a1-1111-4222-8333-00000000000a";
        let neighbour = "0195c9a1-1111-4222-8333-00000000000b";
        // Соседка пишет прямо сейчас — но её ход начался полминуты назад,
        // от её собственного нажатия.
        write_rollout(
            &day.join(format!("rollout-2026-09-21T11-59-00-{neighbour}.jsonl")),
            neighbour,
            "/tmp/proj",
            &[
                turn_started("2026-09-21T12:09:38.000Z"),
                streamed_output("2026-09-21T12:10:08.200Z"),
                streamed_output("2026-09-21T12:10:09.900Z"),
            ],
        );
        write_rollout(
            &day.join(format!("rollout-2026-09-21T12-00-00-{mine}.jsonl")),
            mine,
            "/tmp/proj",
            &[
                turn_started("2026-09-21T12:01:00.000Z"),
                turn_started("2026-09-21T12:10:08.420Z"),
            ],
        );
        let pressed = parse_utc_timestamp("2026-09-21T12:10:08.161Z").unwrap();

        assert_eq!(
            locate_codex_turn(&home, "/tmp/proj", pressed).as_deref(),
            Some(mine)
        );
        // Ход начался не от этого нажатия — сказать нечего.
        let much_later = parse_utc_timestamp("2026-09-21T12:20:00.000Z").unwrap();
        assert_eq!(locate_codex_turn(&home, "/tmp/proj", much_later), None);
    }

    #[test]
    fn codex_turn_locator_gives_up_when_two_turns_began_together() {
        let home = temp_dir("codex-turn-tie");
        let day = home.join("sessions/2026/09/21");
        let first = "0195c9a1-1111-4222-8333-00000000000c";
        let second = "0195c9a1-1111-4222-8333-00000000000d";
        let other_project = "0195c9a1-1111-4222-8333-00000000000e";
        write_rollout(
            &day.join(format!("rollout-2026-09-21T12-00-00-{first}.jsonl")),
            first,
            "/tmp/proj",
            &[turn_started("2026-09-21T12:10:08.300Z")],
        );
        // Ход в другом проекте в то же мгновение спора не создаёт.
        write_rollout(
            &day.join(format!("rollout-2026-09-21T12-00-02-{other_project}.jsonl")),
            other_project,
            "/tmp/other",
            &[turn_started("2026-09-21T12:10:08.500Z")],
        );
        let pressed = parse_utc_timestamp("2026-09-21T12:10:08.000Z").unwrap();
        assert_eq!(
            locate_codex_turn(&home, "/tmp/proj", pressed).as_deref(),
            Some(first)
        );

        // А в том же проекте — создаёт: чей ход чей, по времени уже не понять.
        write_rollout(
            &day.join(format!("rollout-2026-09-21T12-00-01-{second}.jsonl")),
            second,
            "/tmp/proj",
            &[turn_started("2026-09-21T12:10:09.100Z")],
        );
        assert_eq!(locate_codex_turn(&home, "/tmp/proj", pressed), None);
    }

    #[test]
    fn codex_timestamps_are_read_as_utc() {
        assert_eq!(
            parse_utc_timestamp("1970-01-01T00:00:00Z"),
            Some(UNIX_EPOCH)
        );
        assert_eq!(
            parse_utc_timestamp("2026-09-21T12:10:08.161Z"),
            Some(UNIX_EPOCH + Duration::from_millis(1_789_992_608_161))
        );
        // Високосный день и смещение от UTC.
        assert_eq!(
            parse_utc_timestamp("2024-03-01T02:59:59+03:00"),
            Some(UNIX_EPOCH + Duration::from_secs(1_709_251_199))
        );
        for broken in [
            "",
            "2026-09-21",
            "2026-13-21T12:10:08Z",
            "2026-09-21T12:10:08",
            "2026-09-21T12:10:08.Z",
            "yesterday at noon, roughly",
        ] {
            assert_eq!(parse_utc_timestamp(broken), None, "{broken}");
        }
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
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL
                );",
            )
            .unwrap();
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        connection
            .execute_batch(&format!(
                "INSERT INTO session VALUES ('ses_target', NULL, '/tmp/proj', {now_ms}, {now_ms});
                 INSERT INTO session VALUES ('ses_other', NULL, '/tmp/other', {now_ms}, {now_ms});
                 INSERT INTO session VALUES ('ses_child', 'ses_target', '/tmp/proj', {now_ms}, {now_ms});
                 INSERT INTO session VALUES ('ses_old', NULL, '/tmp/proj', 1000, 1000);"
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

        // Продолженный разговор: заведён давно, пишут в него сейчас. По времени
        // появления его не найти уже никогда, а панель именно в нём.
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        connection
            .execute_batch(&format!(
                "UPDATE session SET time_updated = {now_ms} + 5000 WHERE id = 'ses_old';"
            ))
            .unwrap();
        drop(connection);
        assert_eq!(
            locate_opencode_session(&db_path, "/tmp/proj", since, &[]).as_deref(),
            Some("ses_old")
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
