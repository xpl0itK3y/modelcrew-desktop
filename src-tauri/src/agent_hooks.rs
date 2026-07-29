//! Уведомления от самих агентов, а не по косвенным признакам вывода.
//!
//! CLI умеют звать внешнюю программу, когда закончили ход или просят
//! разрешения: у codex это `notify` в config.toml, у claude/copilot/grok/qwen —
//! hooks. Такой хук запускается внутри панели, поэтому знает её id из
//! окружения (см. `pty::set_agent_events_dir`) и просто кладёт событие файлом.
//! Приложение забирает файлы и шлёт их во фронт — без сокетов и портов, и
//! событие не теряется, пока окно занято.

use std::path::PathBuf;
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
            text(payload, &["message", "last-assistant-message", "text"]),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
