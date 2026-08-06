//! Хук агента запускается как настоящая программа — здесь это и проверяется.
//!
//! Разбор и наречия отказа покрыты юнит-тестами, но они зовут функции внутри
//! процесса. Здесь запускается собранный бинарь, ровно так, как его позовёт
//! агент: с аргументами из его конфига, нагрузкой на stdin и каталогом
//! событий в окружении. Именно этот путь и не работал на Windows — `.sh` там
//! не программа, — поэтому проверка нарочно платформы не выбирает: она обязана
//! проходить всюду, где приложение собирается.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Собранное приложение. Cargo подставляет путь сам, поэтому имя бинаря здесь
/// не повторяется строкой и не разъедется с манифестом.
const APP: &str = env!("CARGO_BIN_EXE_modelcrew-desktop");

fn sandbox(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mc-hook-bin-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Запускает приложение хуком и отдаёт код возврата вместе с обоими потоками.
fn run_hook(args: &[&str], payload: &str, events: &Path) -> (i32, String, String) {
    let mut child = Command::new(APP)
        .arg("--agent-hook")
        .args(args)
        .env("MODELCREW_EVENTS_DIR", events)
        .env("MODELCREW_PANEL_ID", "panel-1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("хук обязан запускаться как программа");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

/// Ждёт заявку и отвечает на неё так, как это делает приложение.
fn answer(events: &Path, answer: &str) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let found = std::fs::read_dir(events).ok().and_then(|entries| {
            entries
                .flatten()
                .find(|entry| entry.path().extension().and_then(|k| k.to_str()) == Some("json"))
        });
        if let Some(entry) = found {
            let raw = std::fs::read_to_string(entry.path()).unwrap();
            std::fs::remove_file(entry.path()).unwrap();
            std::fs::write(entry.path().with_extension("res"), answer).unwrap();
            return serde_json::from_str(&raw).expect("заявка обязана разбираться");
        }
        assert!(Instant::now() < deadline, "заявка так и не появилась");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn the_application_answers_a_claim_when_an_agent_runs_it() {
    let events = sandbox("claim");
    let waiter = {
        let events = events.clone();
        std::thread::spawn(move || {
            answer(
                &events,
                r#"{"decision":"deny","reason":"held","holder":"panel-2","task":"чинит сборку"}"#,
            )
        })
    };

    let (code, stdout, stderr) = run_hook(
        &["--claim"],
        r#"{"tool_name":"Edit","file_path":"/w/auth.rs"}"#,
        &events,
    );

    let request = waiter.join().unwrap();
    assert_eq!(request["file"], "/w/auth.rs");
    assert_eq!(request["panelId"], "panel-1");
    // Отказ агент читает кодом возврата и причиной в stderr.
    assert_eq!(code, 2, "stdout={stdout} stderr={stderr}");
    assert!(stderr.contains("другой агент"), "{stderr}");
    assert!(stderr.contains("чинит сборку"), "{stderr}");
    let _ = std::fs::remove_dir_all(&events);
}

#[test]
fn copilot_hears_the_refusal_in_its_own_keys() {
    let events = sandbox("copilot");
    let waiter = {
        let events = events.clone();
        std::thread::spawn(move || {
            answer(&events, r#"{"decision":"deny","reason":"held","task":""}"#)
        })
    };

    let (code, stdout, _) = run_hook(
        &["--claim-copilot"],
        r#"{"tool_name":"Edit","tool_input":{"path":"/w/note.txt"}}"#,
        &events,
    );

    waiter.join().unwrap();
    // Copilot читает решение из stdout, а код возврата у него ничего не значит.
    assert_eq!(code, 0);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim()).expect("{stdout}");
    assert_eq!(parsed["permissionDecision"], "deny");
    let _ = std::fs::remove_dir_all(&events);
}

#[test]
fn a_free_file_is_let_through_without_a_word() {
    let events = sandbox("allow");
    let waiter = {
        let events = events.clone();
        std::thread::spawn(move || answer(&events, r#"{"decision":"allow"}"#))
    };

    let (code, stdout, stderr) = run_hook(
        &["--claim"],
        r#"{"tool_name":"Edit","file_path":"/w/free.rs"}"#,
        &events,
    );

    waiter.join().unwrap();
    assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
    let _ = std::fs::remove_dir_all(&events);
}

#[test]
fn an_event_reaches_the_application_as_a_file() {
    let events = sandbox("notify");

    let (code, _, _) = run_hook(&["claude"], r#"{"type":"stop"}"#, &events);

    assert_eq!(code, 0);
    let entry = std::fs::read_dir(&events)
        .unwrap()
        .flatten()
        .next()
        .expect("событие обязано лечь файлом");
    let event: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(entry.path()).unwrap()).unwrap();
    assert_eq!(event["agent"], "claude");
    assert_eq!(event["payload"]["type"], "stop");
    let _ = std::fs::remove_dir_all(&events);
}

/// Приложение может быть и не запущено: тогда каталога событий в окружении
/// нет. Хук обязан промолчать и пропустить правку — иначе агент встанет
/// намертво из-за нашего отсутствия.
#[test]
fn without_the_application_the_hook_steps_aside() {
    let mut child = Command::new(APP)
        .args(["--agent-hook", "--claim"])
        .env_remove("MODELCREW_EVENTS_DIR")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"tool_name":"Edit","file_path":"/w/a.rs"}"#)
        .unwrap();

    let out = child.wait_with_output().unwrap();

    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty());
    assert!(out.stderr.is_empty());
}
