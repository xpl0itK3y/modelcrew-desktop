//! Уведомления от самих агентов, а не по косвенным признакам вывода.
//!
//! CLI умеют звать внешнюю программу, когда закончили ход или просят
//! разрешения: у codex это `notify` в config.toml, у claude/copilot/grok/qwen —
//! hooks. Такой хук запускается внутри панели, поэтому знает её id из
//! окружения (см. `pty::set_agent_events_dir`) и просто кладёт событие файлом.
//! Приложение забирает файлы и шлёт их во фронт — без сокетов и портов, и
//! событие не теряется, пока окно занято.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager};

const EVENTS_DIR: &str = "agent-events";
const HELPER_NAME: &str = "modelcrew-agent-notify.sh";
const POLL_INTERVAL: Duration = Duration::from_millis(300);
// Событие старше этого — остаток прошлого запуска, показывать его поздно.
const MAX_EVENT_AGE: Duration = Duration::from_secs(120);

// Хук отдаёт JSON либо аргументом (codex дописывает его последним), либо на
// stdin (claude и совместимые). Файл сначала пишется во временный, потом
// переименовывается — watcher не должен прочитать половину.
const HELPER_SCRIPT: &str = r#"#!/bin/sh
# Создан ModelCrew. Вызывается хуком агента; первым аргументом — имя агента.
agent="${1:-unknown}"
payload="$2"
[ -z "$payload" ] && payload="$(cat)"
[ -z "$payload" ] && payload='{}'

# Прежняя программа уведомлений пользователя, если мы встали на её место.
chain="$(dirname "$0")/notify-chain-$agent"
[ -x "$chain" ] && "$chain" "$payload" >/dev/null 2>&1 &

dir="$MODELCREW_EVENTS_DIR"
[ -z "$dir" ] && exit 0
mkdir -p "$dir" || exit 0
file="$dir/$(date +%s)-$$"
printf '{"agent":"%s","panelId":"%s","payload":%s}' \
  "$agent" "$MODELCREW_PANEL_ID" "$payload" > "$file.tmp" || exit 0
mv "$file.tmp" "$file.json"
"#;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEventPayload {
    panel_id: String,
    agent: String,
    // Тип события так, как его назвал сам агент.
    event: String,
    // Текст сообщения, если хук его передал.
    message: String,
}

pub fn events_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|base| base.join(EVENTS_DIR))
}

pub fn helper_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|base| base.join(HELPER_NAME))
}

/// Готовит каталог событий и хелпер и запускает приём событий.
pub fn install(app: &tauri::AppHandle) {
    let Some(dir) = events_dir(app) else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    crate::pty::set_agent_events_dir(dir.clone());
    write_helper(app);
    install_known_hooks(app);
    spawn_event_watcher(app.clone(), dir);
}

fn write_helper(app: &tauri::AppHandle) {
    let Some(path) = helper_path(app) else {
        return;
    };
    // Перезаписываем всегда: скрипт мог устареть после обновления приложения.
    if std::fs::write(&path, HELPER_SCRIPT).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
    }
}

fn spawn_event_watcher(app: tauri::AppHandle, dir: PathBuf) {
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_INTERVAL);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let fresh = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .map(|modified| modified.elapsed().unwrap_or_default() < MAX_EVENT_AGE)
                .unwrap_or(true);
            let raw = std::fs::read_to_string(&path);
            // Файл забираем в любом случае: иначе битое событие останется
            // навсегда и watcher будет спотыкаться о него каждый тик.
            let _ = std::fs::remove_file(&path);
            let Ok(raw) = raw else {
                continue;
            };
            if !fresh {
                continue;
            }
            if let Some(payload) = parse_event(&raw) {
                let _ = app.emit_to("main", "agent-event", payload);
            }
        }
    });
}

fn parse_event(raw: &str) -> Option<AgentEventPayload> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let agent = text(&value, &["agent"]);
    let panel_id = text(&value, &["panelId"]);
    if panel_id.is_empty() {
        return None; // без панели уведомление некуда привязать
    }
    let payload = value.get("payload").cloned().unwrap_or(Value::Null);
    let (event, message) = normalize(&agent, &payload);
    Some(AgentEventPayload {
        panel_id,
        agent,
        event,
        message,
    })
}

fn text(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

/// Приводит полезную нагрузку хука к паре «тип события, текст». Схемы у
/// агентов разные, но все кладут и то и другое строкой верхнего уровня.
fn normalize(agent: &str, payload: &Value) -> (String, String) {
    match agent {
        // {"type":"agent-turn-complete", …, "last-assistant-message":"…"}
        "codex" => (
            text(payload, &["type"]),
            text(payload, &["last-assistant-message"]),
        ),
        // claude/copilot/grok/qwen: {"hook_event_name":"Stop","message":"…"}
        _ => (
            text(
                payload,
                &["hook_event_name", "type", "event", "notification_type"],
            ),
            text(
                payload,
                &[
                    "message",
                    // Stop у claude кладёт текст хода сюда, и ключ с
                    // подчёркиваниями — не тот, что у codex через дефисы.
                    "last_assistant_message",
                    "last-assistant-message",
                    "text",
                ],
            ),
        ),
    }
}

// ---------------------------------------------------------------------------
// Подключение хелпера к конфигу агента.
//
// Хелпер сам по себе бесполезен: агент должен знать, что его надо звать. У
// каждого CLI для этого свой файл и свой формат, поэтому здесь на каждого своя
// пара «прочитать — вписать». Общее правило одно: конфиг чужой, и всё, что в
// нём уже лежит, обязано пережить нашу правку. Отсюда чтение целиком, точечная
// вставка, запись во временный файл с переименованием и копия рядом.

/// Агент, к которому мы умеем подключаться, и где лежит его конфиг.
fn hook_config_path(agent: &str, home: &Path) -> Option<PathBuf> {
    match agent {
        "claude" => Some(home.join(".claude/settings.json")),
        // Остальным каналом мы пока не умеем — либо формат не подтверждён,
        // либо у самого CLI уведомлений нет.
        _ => None,
    }
}

/// Команда для конфига агента. Путь к хелперу лежит в «Application Support» —
/// с пробелом, поэтому берётся в кавычки; одинарная кавычка внутри пути
/// закрывается по-шелловски.
fn hook_command(helper: &Path, agent: &str) -> String {
    let path = helper.display().to_string().replace('\'', r"'\''");
    format!("'{path}' {agent}")
}

/// Наш ли это хук. Ищем по пути хелпера, а не по всей строке: команда могла
/// быть записана прежней версией приложения с другим хвостом.
fn is_our_hook(entry: &Value, helper: &Path) -> bool {
    let needle = helper.display().to_string();
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|command| command.contains(&needle))
            })
        })
        .unwrap_or(false)
}

/// События, на которых агент зовёт хук. Для claude это конец хода и всё, ради
/// чего он просит внимания: разрешение, вопрос, простой.
const CLAUDE_EVENTS: [&str; 2] = ["Stop", "Notification"];

fn read_json(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) if raw.trim().is_empty() => Ok(Value::Object(Default::default())),
        Ok(raw) => serde_json::from_str(&raw)
            .map_err(|error| format!("{}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(Value::Object(Default::default()))
        }
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

/// Запись без окна, в котором файл уже пуст, а нового содержимого ещё нет:
/// агент может читать конфиг в любой момент.
fn write_json_atomically(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "нет родительского каталога".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    let body = serde_json::to_string_pretty(value)
        .map_err(|error| error.to_string())?;
    let temp = path.with_extension("modelcrew-tmp");
    std::fs::write(&temp, format!("{body}\n"))
        .map_err(|error| format!("{}: {error}", temp.display()))?;
    std::fs::rename(&temp, path).map_err(|error| format!("{}: {error}", path.display()))
}

/// Копия конфига до первой нашей правки — чтобы было куда вернуться руками.
fn back_up_once(path: &Path) {
    if !path.exists() {
        return;
    }
    let backup = path.with_extension("modelcrew-backup");
    if backup.exists() {
        return;
    }
    let _ = std::fs::copy(path, backup);
}

fn claude_hook_entry(helper: &Path) -> Value {
    serde_json::json!({
        // Пустая строка — «на всё»: у Stop и Notification матчить нечего.
        "matcher": "",
        "hooks": [{ "type": "command", "command": hook_command(helper, "claude") }],
    })
}

/// Вписывает хук, не трогая ничего чужого. Возвращает true, если файл изменился.
fn install_claude_hook(settings: &mut Value, helper: &Path) -> bool {
    if !settings.is_object() {
        *settings = Value::Object(Default::default());
    }
    let root = settings.as_object_mut().expect("объект гарантирован выше");
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| Value::Object(Default::default()));
    if !hooks.is_object() {
        *hooks = Value::Object(Default::default());
    }
    let hooks = hooks.as_object_mut().expect("объект гарантирован выше");
    let mut changed = false;
    for event in CLAUDE_EVENTS {
        let list = hooks
            .entry(event)
            .or_insert_with(|| Value::Array(Vec::new()));
        if !list.is_array() {
            *list = Value::Array(Vec::new());
        }
        let list = list.as_array_mut().expect("массив гарантирован выше");
        // Повторная установка не должна плодить дубликаты.
        if list.iter().any(|entry| is_our_hook(entry, helper)) {
            continue;
        }
        list.push(claude_hook_entry(helper));
        changed = true;
    }
    changed
}

/// Убирает только наши записи и подчищает за собой пустые контейнеры, чтобы
/// после отключения файл выглядел как до нас.
fn remove_claude_hook(settings: &mut Value, helper: &Path) -> bool {
    let Some(root) = settings.as_object_mut() else {
        return false;
    };
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return false;
    };
    let mut changed = false;
    for event in CLAUDE_EVENTS {
        let Some(list) = hooks.get_mut(event).and_then(Value::as_array_mut) else {
            continue;
        };
        let before = list.len();
        list.retain(|entry| !is_our_hook(entry, helper));
        changed |= list.len() != before;
        if list.is_empty() {
            hooks.remove(event);
        }
    }
    if hooks.is_empty() {
        root.remove("hooks");
    }
    changed
}

fn claude_hook_installed(settings: &Value, helper: &Path) -> bool {
    CLAUDE_EVENTS.iter().all(|event| {
        settings
            .get("hooks")
            .and_then(|hooks| hooks.get(*event))
            .and_then(Value::as_array)
            .map(|list| list.iter().any(|entry| is_our_hook(entry, helper)))
            .unwrap_or(false)
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHookState {
    pub agent: String,
    /// Умеем ли мы подключаться к этому агенту.
    pub supported: bool,
    /// Подключён ли хук прямо сейчас.
    pub installed: bool,
    /// Файл, который правится, — правка чужого конфига не должна быть вслепую.
    pub config: String,
}

fn home_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().home_dir().ok()
}

pub fn hook_state(app: &tauri::AppHandle, agent: &str) -> AgentHookState {
    let unsupported = AgentHookState {
        agent: agent.to_string(),
        supported: false,
        installed: false,
        config: String::new(),
    };
    let (Some(home), Some(helper)) = (home_dir(app), helper_path(app)) else {
        return unsupported;
    };
    let Some(path) = hook_config_path(agent, &home) else {
        return unsupported;
    };
    let installed = read_json(&path)
        .map(|settings| claude_hook_installed(&settings, &helper))
        .unwrap_or(false);
    AgentHookState {
        agent: agent.to_string(),
        supported: true,
        installed,
        config: path.display().to_string(),
    }
}

pub fn set_hook(app: &tauri::AppHandle, agent: &str, enabled: bool) -> Result<AgentHookState, String> {
    let home = home_dir(app).ok_or_else(|| "домашний каталог недоступен".to_string())?;
    let helper = helper_path(app).ok_or_else(|| "каталог приложения недоступен".to_string())?;
    let path =
        hook_config_path(agent, &home).ok_or_else(|| format!("{agent}: канал не поддержан"))?;
    // Хелпер мог не появиться, если каталог данных был недоступен на старте.
    if !helper.exists() {
        write_helper(app);
    }
    let mut settings = read_json(&path)?;
    let changed = if enabled {
        install_claude_hook(&mut settings, &helper)
    } else {
        remove_claude_hook(&mut settings, &helper)
    };
    if changed {
        back_up_once(&path);
        write_json_atomically(&path, &settings)?;
    }
    Ok(hook_state(app, agent))
}

/// Агенты, которым мы умеем прописывать себя.
const SUPPORTED_AGENTS: [&str; 1] = ["claude"];

/// Ставить хук только тем, кто у пользователя действительно есть: наличие
/// каталога конфига и есть признак, что агент хоть раз запускался. Иначе мы
/// создавали бы `~/.claude/settings.json` тому, кто Claude в глаза не видел.
fn agent_is_present(agent: &str, home: &Path) -> bool {
    hook_config_path(agent, home)
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .is_some_and(|dir| dir.is_dir())
}

/// Подключает хук всем поддержанным агентам при старте. Отдельного тумблера
/// нет намеренно: канал уведомлений — часть работы приложения, а выключатель
/// у уведомлений агентов уже есть один, общий.
fn install_known_hooks(app: &tauri::AppHandle) {
    let Some(home) = home_dir(app) else {
        return;
    };
    for agent in SUPPORTED_AGENTS {
        if !agent_is_present(agent, &home) {
            continue;
        }
        // Чужой конфиг мог оказаться битым или недоступным — это не повод
        // ронять запуск: без хука останется разбор вывода панели.
        let _ = set_hook(app, agent, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn helper() -> PathBuf {
        // Реальный путь хелпера лежит в «Application Support» — с пробелом.
        PathBuf::from("/Users/x/Library/Application Support/mc/modelcrew-agent-notify.sh")
    }

    #[test]
    fn the_command_survives_a_path_with_spaces() {
        let command = hook_command(&helper(), "claude");

        assert_eq!(
            command,
            "'/Users/x/Library/Application Support/mc/modelcrew-agent-notify.sh' claude"
        );
    }

    #[test]
    fn a_quote_in_the_path_cannot_break_out_of_the_command() {
        let command = hook_command(Path::new("/tmp/it's here/notify.sh"), "claude");

        // Кавычка закрывается по-шелловски, а не остаётся открытой.
        assert_eq!(command, r"'/tmp/it'\''s here/notify.sh' claude");
    }

    #[test]
    fn installing_keeps_every_foreign_setting_and_hook() {
        let mut settings = serde_json::json!({
            "permissions": { "allow": ["Bash(ls:*)"] },
            "hooks": {
                "PostToolUse": [{
                    "matcher": "Edit|Write",
                    "hooks": [{ "type": "command", "command": "prettier --write" }]
                }],
                "Stop": [{
                    "matcher": "",
                    "hooks": [{ "type": "command", "command": "say done" }]
                }]
            }
        });

        assert!(install_claude_hook(&mut settings, &helper()));

        // Чужое на месте: и настройки вне hooks, и чужие события, и чужой Stop.
        assert_eq!(settings["permissions"]["allow"][0], "Bash(ls:*)");
        assert_eq!(
            settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"],
            "prettier --write"
        );
        assert_eq!(settings["hooks"]["Stop"][0]["hooks"][0]["command"], "say done");
        // А наш встал рядом, а не вместо.
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert!(claude_hook_installed(&settings, &helper()));
    }

    #[test]
    fn installing_twice_does_not_pile_up_duplicates() {
        let mut settings = Value::Object(Default::default());
        assert!(install_claude_hook(&mut settings, &helper()));

        // Повторный вызов ничего не меняет — иначе после каждого запуска
        // приложения в конфиге появлялась бы ещё одна копия.
        assert!(!install_claude_hook(&mut settings, &helper()));
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(settings["hooks"]["Notification"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn removing_takes_out_only_our_own_entry() {
        let mut settings = serde_json::json!({
            "hooks": {
                "Stop": [{
                    "matcher": "",
                    "hooks": [{ "type": "command", "command": "say done" }]
                }]
            }
        });
        install_claude_hook(&mut settings, &helper());

        assert!(remove_claude_hook(&mut settings, &helper()));

        assert_eq!(settings["hooks"]["Stop"][0]["hooks"][0]["command"], "say done");
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(!claude_hook_installed(&settings, &helper()));
    }

    #[test]
    fn removing_leaves_the_file_as_it_was_before_us() {
        let clean = serde_json::json!({ "permissions": { "allow": [] } });
        let mut settings = clean.clone();

        install_claude_hook(&mut settings, &helper());
        remove_claude_hook(&mut settings, &helper());

        // Ни осиротевшего "hooks": {}, ни пустых массивов событий.
        assert_eq!(settings, clean);
    }

    #[test]
    fn a_settings_file_that_is_not_an_object_is_not_silently_kept() {
        // Строка вместо объекта — файл сломан; вписывать хук в него нельзя,
        // но и падать не за чем: заменяем на объект и продолжаем.
        let mut settings = Value::String("сломано".into());

        assert!(install_claude_hook(&mut settings, &helper()));

        assert!(claude_hook_installed(&settings, &helper()));
    }

    #[test]
    fn a_missing_file_reads_as_an_empty_object() {
        let path = std::env::temp_dir().join("modelcrew-no-such-settings.json");
        let _ = std::fs::remove_file(&path);

        assert_eq!(read_json(&path).unwrap(), Value::Object(Default::default()));
    }

    #[test]
    fn broken_json_is_reported_instead_of_being_overwritten() {
        let path = std::env::temp_dir().join(format!(
            "modelcrew-broken-settings-{}.json",
            std::process::id()
        ));
        std::fs::write(&path, "{ это не json ").unwrap();

        let error = read_json(&path).expect_err("битый конфиг должен быть ошибкой");

        // Иначе правка молча стёрла бы чужой файл целиком.
        assert!(error.contains("settings"), "в ошибке нет имени файла: {error}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_agent_the_user_never_ran_is_left_alone() {
        let home = std::env::temp_dir().join(format!(
            "modelcrew-empty-home-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&home).unwrap();

        // Каталога ~/.claude нет — значит Claude здесь не запускали, и
        // создавать ему конфиг мы не имеем права.
        assert!(!agent_is_present("claude", &home));

        std::fs::create_dir_all(home.join(".claude")).unwrap();
        assert!(agent_is_present("claude", &home));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn every_supported_agent_has_somewhere_to_write() {
        let home = Path::new("/home/x");

        // Список подключаемых и список известных путей обязаны совпадать,
        // иначе агент попал бы в автоподключение и молча ничего не получил.
        for agent in SUPPORTED_AGENTS {
            assert!(hook_config_path(agent, home).is_some(), "{agent}");
        }
    }

    #[test]
    fn only_the_agents_we_actually_support_get_a_config_path() {
        let home = Path::new("/home/x");

        assert_eq!(
            hook_config_path("claude", home),
            Some(PathBuf::from("/home/x/.claude/settings.json"))
        );
        // У этих канал либо не подтверждён, либо его нет — молча трогать
        // чужие конфиги на догадках нельзя.
        for agent in ["codex", "qwen", "kimi", "opencode", "amp"] {
            assert_eq!(hook_config_path(agent, home), None, "{agent}");
        }
    }

    #[test]
    fn a_stop_event_keeps_the_message_claude_puts_under_underscores() {
        let event = parse_event(
            r#"{"agent":"claude","panelId":"panel-9","payload":{
                "hook_event_name":"Stop",
                "last_assistant_message":"Готово, три файла"
            }}"#,
        )
        .expect("Stop должен разбираться");

        assert_eq!(event.message, "Готово, три файла");
    }

    #[test]
    fn reads_a_codex_turn_with_its_message() {
        let event = parse_event(
            r#"{"agent":"codex","panelId":"panel-1","payload":{
                "type":"agent-turn-complete",
                "cwd":"/tmp",
                "last-assistant-message":"Готово: обновил три файла"
            }}"#,
        )
        .expect("событие codex должно разбираться");

        assert_eq!(event.panel_id, "panel-1");
        assert_eq!(event.event, "agent-turn-complete");
        assert_eq!(event.message, "Готово: обновил три файла");
    }

    #[test]
    fn reads_a_claude_hook_from_stdin_shape() {
        let event = parse_event(
            r#"{"agent":"claude","panelId":"panel-2","payload":{
                "hook_event_name":"Notification",
                "session_id":"abc",
                "message":"Claude needs your permission to run Bash"
            }}"#,
        )
        .expect("событие claude должно разбираться");

        assert_eq!(event.event, "Notification");
        assert_eq!(event.message, "Claude needs your permission to run Bash");
    }

    #[test]
    fn drops_an_event_without_a_panel() {
        // Хук запустили вне панели ModelCrew — привязать событие не к чему.
        assert!(parse_event(r#"{"agent":"codex","panelId":"","payload":{}}"#).is_none());
        assert!(parse_event("не json").is_none());
    }

    #[test]
    fn survives_a_payload_it_does_not_know() {
        let event = parse_event(r#"{"agent":"newcli","panelId":"p","payload":{"a":1}}"#)
            .expect("незнакомая схема не должна ронять разбор");

        assert_eq!(event.event, "");
        assert_eq!(event.message, "");
    }
}
