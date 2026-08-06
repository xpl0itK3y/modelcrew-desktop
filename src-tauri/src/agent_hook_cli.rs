//! Хук агента, исполняемый самим приложением.
//!
//! На POSIX хук — это `modelcrew-agent-notify.sh`, проверенный живьём на
//! восьми агентах. На Windows такого канала нет: `.sh` там не программа
//! (система отвечает «%1 is not a valid Win32 application»), а bash стоит не у
//! всех — мы его лишь предлагаем поставить. Зато exe запускает любая оболочка:
//! и cmd, и PowerShell, и bash. Поэтому на Windows хук зовёт само приложение,
//! а протокол живёт здесь — рядом с той стороной, что его читает.
//!
//! Модуль собирается и проверяется на всех платформах, а не только на Windows:
//! разбор полезной нагрузки и наречия отказа платформы не касаются, и ловить
//! в них ошибку удобнее там, где идёт основная работа.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

/// Первый аргумент, по которому приложение понимает, что запущено хуком, а не
/// пользователем. Проверяется до всего остального: окно поднимать не нужно.
pub const HOOK_FLAG: &str = "--agent-hook";

/// Сколько ждём решения. Столько же отсчитывает шелл-хелпер: двадцать проб по
/// сотой доле секунды. Дольше держать агента нельзя — он решит, что хук завис.
const ANSWER_WAIT: Duration = Duration::from_secs(2);
const ANSWER_POLL: Duration = Duration::from_millis(100);

/// Имена ключа с инструментом. `name` последним: у antigravity он лежит в
/// `toolCall.name`, но ключ слишком общий, чтобы спрашивать о нём раньше.
const TOOL_KEYS: [&str; 4] = ["tool_name", "toolName", "tool", "name"];

/// Имена ключа с путём. Схему полезной нагрузки никто не обещает, поэтому
/// перебираем известные написания по очереди.
const FILE_KEYS: [&str; 7] = [
    "file_path",
    "filePath",
    "target_file",
    "absolute_path",
    "path",
    "TargetFile",
    "AbsolutePath",
];

/// Причины отказа. Их же печатает шелл-хелпер: агент должен слышать одно и то
/// же независимо от того, каким каналом до него дошли. Совпадение закреплено
/// проверкой — разъехавшись, тексты разъехались бы молча.
pub const STALE_REASON: &str = "Файл изменился с тех пор, как ты его прочитал: в нём успел поработать другой агент. Перечитай файл и примени правку заново, иначе его работа будет затёрта.";
pub const HELD_REASON: &str = "Файл сейчас правит другой агент этого проекта";
/// Про оболочку сказано нарочно: агент, которому отказали в правке, охотно
/// пробует переписать файл через `printf >` — это видно на живых copilot и
/// opencode, и такая запись проходит мимо всех заявок.
pub const HELD_ADVICE: &str =
    ". Возьмись за другой файл и вернись к этому позже; переписывать его через оболочку тоже не нужно.";

/// Как агент читает отказ. Значения повторяют аргументы шелл-хелпера один в
/// один: канал разный, договор один.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClaimFlag {
    /// Код возврата 2 и причина в stderr: claude, grok, kimi, cursor.
    Plain,
    /// `decision` JSON-ом в stdout: antigravity.
    Json,
    /// `permissionDecision` там же: copilot.
    Copilot,
    /// Тот же код возврата, но пути лежат внутри патча: codex.
    Codex,
}

impl ClaimFlag {
    pub fn from_arg(arg: &str) -> Option<Self> {
        match arg {
            "--claim" => Some(Self::Plain),
            "--claim-json" => Some(Self::Json),
            "--claim-copilot" => Some(Self::Copilot),
            "--claim-codex" => Some(Self::Codex),
            _ => None,
        }
    }

    pub fn arg(self) -> &'static str {
        match self {
            Self::Plain => "--claim",
            Self::Json => "--claim-json",
            Self::Copilot => "--claim-copilot",
            Self::Codex => "--claim-codex",
        }
    }
}

/// Зачем нас позвали.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Mode {
    /// Заявка на файл перед правкой; агент ждёт решения.
    Claim(ClaimFlag),
    /// Обычное событие агента: конец хода, ожидание ввода. Ответа не требует.
    Notify(String),
}

/// Что вернуть агенту. Собираем целиком и печатаем один раз: половина ответа
/// в stdout читается агентом как «можно».
#[derive(Debug, PartialEq, Eq)]
pub struct Outcome {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Outcome {
    fn allow() -> Self {
        Self {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        }
    }
}

/// Разбирает аргументы запуска. `None` — значит запуск обычный, и приложение
/// должно подниматься как всегда.
pub fn mode_from_args<I, S>(args: I) -> Option<Mode>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut args = args.into_iter().skip(1);
    if args.next()?.as_ref() != HOOK_FLAG {
        return None;
    }
    let what = args.next()?;
    let what = what.as_ref();
    if let Some(flag) = ClaimFlag::from_arg(what) {
        return Some(Mode::Claim(flag));
    }
    Some(Mode::Notify(what.to_string()))
}

/// Заявка: спрашиваем приложение про каждый файл вызова и ждём решение.
///
/// Всё, что пошло не так — нет каталога, не разобрался путь, приложение
/// молчит, — считаем разрешением. Слой согласования не должен останавливать
/// работу из-за себя: цена ложного отказа выше цены пропуска, потому что
/// пропущенную правку ещё поймает снимок дерева, а вставший агент не поймает
/// никто.
pub fn claim(flag: ClaimFlag, payload: &str, dir: &Path, panel_id: &str) -> Outcome {
    claim_waiting(flag, payload, dir, panel_id, ANSWER_WAIT)
}

fn claim_waiting(
    flag: ClaimFlag,
    payload: &str,
    dir: &Path,
    panel_id: &str,
    wait: Duration,
) -> Outcome {
    let parsed: Option<Value> = serde_json::from_str(payload).ok();
    let files = match flag {
        ClaimFlag::Codex => files_from_patch(payload),
        _ => parsed.as_ref().map(files_from_keys).unwrap_or_default(),
    };
    if files.is_empty() {
        return Outcome::allow();
    }
    if std::fs::create_dir_all(dir).is_err() {
        return Outcome::allow();
    }
    let tool = parsed.as_ref().map(tool_name).unwrap_or_default();

    // Спрашиваем про каждый файл вызова: занят хотя бы один — правку целиком
    // пропускать нельзя, патч применяется весь или никак.
    let mut reason = None;
    for (index, file) in files.iter().enumerate() {
        let answer = ask(dir, panel_id, file, &tool, index, wait).unwrap_or_default();
        if answer.contains("\"stale\"") {
            reason = Some(STALE_REASON.to_string());
            break;
        }
        if answer.contains("\"deny\"") {
            reason = Some(held_reason(task_of(&answer)));
            break;
        }
    }

    answer_in(flag, reason)
}

/// Причина отказа держателем, с его задачей, если приложение её назвало.
fn held_reason(task: &str) -> String {
    let mut reason = HELD_REASON.to_string();
    if !task.is_empty() {
        reason.push_str(": ");
        reason.push_str(task);
    }
    reason.push_str(HELD_ADVICE);
    reason
}

fn answer_in(flag: ClaimFlag, reason: Option<String>) -> Outcome {
    match (flag, reason) {
        // Antigravity ждёт решение всегда, в том числе разрешающее.
        (ClaimFlag::Json, None) => Outcome {
            code: 0,
            stdout: "{\"decision\":\"allow\"}\n".to_string(),
            stderr: String::new(),
        },
        (_, None) => Outcome::allow(),
        (ClaimFlag::Json, Some(reason)) => Outcome {
            code: 0,
            stdout: format!(
                "{{\"decision\":\"deny\",\"reason\":{}}}\n",
                json_string(&reason)
            ),
            stderr: String::new(),
        },
        (ClaimFlag::Copilot, Some(reason)) => Outcome {
            code: 0,
            stdout: format!(
                "{{\"permissionDecision\":\"deny\",\"permissionDecisionReason\":{}}}\n",
                json_string(&reason)
            ),
            stderr: String::new(),
        },
        (_, Some(reason)) => Outcome {
            code: 2,
            stdout: String::new(),
            stderr: format!("{reason}\n"),
        },
    }
}

/// Один круг вопроса-ответа. `None` — приложение промолчало.
fn ask(
    dir: &Path,
    panel_id: &str,
    file: &str,
    tool: &str,
    index: usize,
    wait: Duration,
) -> Option<String> {
    let id = format!("claim-{}-{}-{}", now_secs(), std::process::id(), index);
    let request = format!(
        "{{\"kind\":\"claim\",\"panelId\":{},\"file\":{},\"tool\":{}}}",
        json_string(panel_id),
        json_string(file),
        json_string(tool)
    );
    // Сначала во временный файл: watcher обходит каталог каждые 300 мс и
    // прочитал бы половину запроса как испорченный.
    let temp = dir.join(format!("{id}.tmp"));
    std::fs::write(&temp, request).ok()?;
    let asked = dir.join(format!("{id}.json"));
    std::fs::rename(&temp, &asked).ok()?;

    let answer = dir.join(format!("{id}.res"));
    let deadline = SystemTime::now() + wait;
    loop {
        if let Ok(text) = std::fs::read_to_string(&answer) {
            let _ = std::fs::remove_file(&answer);
            return Some(text);
        }
        if SystemTime::now() >= deadline {
            return None;
        }
        std::thread::sleep(ANSWER_POLL);
    }
}

/// Обычное событие: кладём его файлом и уходим. Ответа агент не ждёт.
pub fn notify(agent: &str, payload: &str, dir: &Path, panel_id: &str) -> Outcome {
    let payload = if payload.trim().is_empty() {
        "{}"
    } else {
        payload
    };
    if std::fs::create_dir_all(dir).is_err() {
        return Outcome::allow();
    }
    let event = format!(
        "{{\"agent\":{},\"panelId\":{},\"payload\":{}}}",
        json_string(agent),
        json_string(panel_id),
        payload
    );
    let name = format!("{}-{}", now_secs(), std::process::id());
    let temp = dir.join(format!("{name}.tmp"));
    if std::fs::write(&temp, event).is_ok() {
        let _ = std::fs::rename(&temp, dir.join(format!("{name}.json")));
    }
    Outcome::allow()
}

/// Имя инструмента: первый из известных ключей, у которого нашлась строка.
fn tool_name(payload: &Value) -> String {
    for key in TOOL_KEYS {
        let mut found = Vec::new();
        strings_under_key(payload, key, &mut found);
        if let Some(first) = found.into_iter().next() {
            return first;
        }
    }
    String::new()
}

/// Пути: берём первый ключ, который вообще нашёлся, и все его значения.
/// Перебирать дальше нельзя — один вызов не смешивает написания, а лишний
/// ключ (`path` у чужого поля) принёс бы посторонний файл.
fn files_from_keys(payload: &Value) -> Vec<String> {
    for key in FILE_KEYS {
        let mut found = Vec::new();
        strings_under_key(payload, key, &mut found);
        if !found.is_empty() {
            return found;
        }
    }
    Vec::new()
}

/// У codex правка идёт патчем: пути лежат внутри его текста, а не отдельным
/// ключом, и за один вызов он трогает сколько угодно файлов.
fn files_from_patch(raw: &str) -> Vec<String> {
    const MARKS: [&str; 3] = ["*** Update File: ", "*** Add File: ", "*** Delete File: "];
    let mut files = Vec::new();
    let mut from = 0;
    // По строкам патч не разобрать: он приходит значением JSON-поля, где
    // переводы строк экранированы, и настоящих в нём нет ни одного — весь
    // патч лежит одной строкой.
    while from < raw.len() {
        let Some((at, mark)) = MARKS
            .iter()
            .filter_map(|mark| raw[from..].find(mark).map(|found| (from + found, *mark)))
            .min_by_key(|(at, _)| *at)
        else {
            break;
        };
        let tail = &raw[at + mark.len()..];
        // Путь обрывается там же, где обрывается JSON-строка: на кавычке или
        // на обратном слэше экранированного перевода.
        let end = tail.find(['"', '\\']).unwrap_or(tail.len());
        let file = tail[..end].trim();
        if !file.is_empty() {
            files.push(file.to_string());
        }
        from = at + mark.len() + end;
    }
    files
}

/// Все строки, лежащие под данным ключом, в порядке обхода. Ключ ищем по всему
/// дереву, а не на верхнем уровне: antigravity кладёт вызов вложенно, в
/// `toolCall.args.TargetFile`.
fn strings_under_key(value: &Value, key: &str, out: &mut Vec<String>) {
    match value {
        Value::Object(fields) => {
            for (name, nested) in fields {
                if name == key {
                    if let Some(text) = nested.as_str() {
                        if !text.is_empty() {
                            out.push(text.to_string());
                        }
                    }
                }
                strings_under_key(nested, key, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                strings_under_key(item, key, out);
            }
        }
        _ => {}
    }
}

/// Задача держателя из ответа приложения.
fn task_of(answer: &str) -> &str {
    let Some(at) = answer.find("\"task\":\"") else {
        return "";
    };
    let tail = &answer[at + "\"task\":\"".len()..];
    match tail.find('"') {
        Some(end) => &tail[..end],
        None => "",
    }
}

fn json_string(value: &str) -> String {
    Value::String(value.to_string()).to_string()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or_default()
}

/// Прежняя программа уведомлений пользователя, если мы встали на её место.
/// Ищется там же, где и у шелл-хелпера: рядом с каталогом данных приложения.
pub fn chained_notifier(helper_dir: &Path, agent: &str) -> PathBuf {
    helper_dir.join(format!("notify-chain-{agent}"))
}

/// Точка входа. Если приложение запущено хуком агента — делает его работу и
/// отдаёт код возврата; `None` означает обычный запуск, с окном.
///
/// Проверяется до всего остального: поднимать webview ради одной заявки
/// нельзя, агент ждёт ответа считаные секунды.
pub fn run_if_hook() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let mode = mode_from_args(&args)?;
    // Без каталога событий отвечать нечем и некому: приложение не запущено.
    // Молча пропускаем — иначе агент встал бы намертво из-за нашего же
    // отсутствия.
    let dir = std::env::var("MODELCREW_EVENTS_DIR").unwrap_or_default();
    if dir.trim().is_empty() {
        return Some(0);
    }
    let dir = PathBuf::from(dir);
    let panel = std::env::var("MODELCREW_PANEL_ID").unwrap_or_default();

    let outcome = match mode {
        Mode::Claim(flag) => claim(flag, &read_stdin(), &dir, &panel),
        Mode::Notify(agent) => {
            // Полезную нагрузку codex дописывает аргументом, остальные шлют
            // на stdin.
            let payload = match args.get(3) {
                Some(given) if !given.trim().is_empty() => given.clone(),
                _ => read_stdin(),
            };
            if let Some(home) = dir.parent() {
                start_chain(home, &agent, &payload);
            }
            notify(&agent, &payload, &dir, &panel)
        }
    };

    use std::io::Write;
    let mut out = std::io::stdout();
    let _ = out.write_all(outcome.stdout.as_bytes());
    let _ = out.flush();
    let mut err = std::io::stderr();
    let _ = err.write_all(outcome.stderr.as_bytes());
    let _ = err.flush();
    Some(outcome.code)
}

fn read_stdin() -> String {
    use std::io::Read;
    let mut buffer = String::new();
    let _ = std::io::stdin().read_to_string(&mut buffer);
    buffer
}

/// Запускает прежнюю программу пользователя и не ждёт её: агент стоит, пока
/// хук не вернулся, и чужая задержка стала бы нашей.
fn start_chain(helper_dir: &Path, agent: &str, payload: &str) {
    let chain = chained_notifier(helper_dir, agent);
    if !chain.is_file() {
        return;
    }
    let _ = std::process::Command::new(&chain)
        .arg(payload)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mc-hook-cli-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Кладёт ответ на единственную заявку, которая появится в каталоге.
    fn answer_once(dir: &Path, answer: &'static str) -> std::thread::JoinHandle<String> {
        let dir = dir.to_path_buf();
        std::thread::spawn(move || loop {
            let found = std::fs::read_dir(&dir).ok().and_then(|entries| {
                entries.flatten().find(|entry| {
                    entry.path().extension().and_then(|kind| kind.to_str()) == Some("json")
                })
            });
            if let Some(entry) = found {
                let request = std::fs::read_to_string(entry.path()).unwrap();
                std::fs::remove_file(entry.path()).unwrap();
                std::fs::write(entry.path().with_extension("res"), answer).unwrap();
                return request;
            }
            std::thread::sleep(Duration::from_millis(10));
        })
    }

    #[test]
    fn a_hook_run_is_told_apart_from_a_normal_one() {
        assert_eq!(
            mode_from_args(["ModelCrew", HOOK_FLAG, "--claim-copilot"]),
            Some(Mode::Claim(ClaimFlag::Copilot))
        );
        assert_eq!(
            mode_from_args(["ModelCrew", HOOK_FLAG, "claude"]),
            Some(Mode::Notify("claude".to_string()))
        );
        // Обычный запуск: окно должно подняться, а не молча закрыться.
        assert_eq!(mode_from_args(["ModelCrew"]), None);
        assert_eq!(mode_from_args(["ModelCrew", "--version"]), None);
        // Флаг без продолжения — тоже обычный запуск, а не заявка ни о чём.
        assert_eq!(mode_from_args(["ModelCrew", HOOK_FLAG]), None);
    }

    #[test]
    fn the_antigravity_payload_is_read_where_it_really_lies() {
        // Ровно то, что прислал agy, вплоть до порядка ключей.
        let payload = concat!(
            r#"{"conversationId":"762f086f","modelName":"gemini-3.6-flash-high","#,
            r#""stepIdx":10,"toolCall":{"args":{"AllowMultiple":false,"#,
            r#""Instruction":"Добавить комментарий","TargetFile":"/w/README.md"},"#,
            r#""name":"replace_file_content"},"workspacePaths":["/w"]}"#
        );
        let parsed: Value = serde_json::from_str(payload).unwrap();

        assert_eq!(files_from_keys(&parsed), ["/w/README.md"]);
        assert_eq!(tool_name(&parsed), "replace_file_content");
    }

    #[test]
    fn every_file_of_a_codex_patch_is_claimed() {
        let payload = concat!(
            r#"{"tool_name":"apply_patch","tool_input":"#,
            r#"{"patch":"*** Begin Patch\n*** Update File: src/один.rs\n-a\n+b\n"#,
            r#"*** Add File: src/два.rs\n+новый\n*** Delete File: src/три.rs\n*** End Patch"}}"#
        );

        // Патч применяется весь или никак: спросить надо про все три файла,
        // иначе занятый сосед потеряет работу вместе с остальным патчем.
        assert_eq!(
            files_from_patch(payload),
            ["src/один.rs", "src/два.rs", "src/три.rs"]
        );
    }

    #[test]
    fn a_payload_without_a_path_is_let_through() {
        let dir = sandbox("no-path");

        let outcome = claim(ClaimFlag::Plain, r#"{"tool_name":"Bash"}"#, &dir, "panel-1");

        assert_eq!(outcome, Outcome::allow());
        // И заявку не кладём: watcher разбирал бы её впустую каждый тик.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[test]
    fn silence_from_the_app_means_the_edit_goes_through() {
        let dir = sandbox("silence");

        // Ответа никто не положит: приложение закрыто или не поспело.
        let outcome = claim_waiting(
            ClaimFlag::Plain,
            r#"{"tool_name":"Edit","file_path":"/w/a.rs"}"#,
            &dir,
            "panel-1",
            Duration::from_millis(150),
        );

        assert_eq!(outcome, Outcome::allow());
    }

    #[test]
    fn the_request_carries_what_the_app_needs_to_decide() {
        let dir = sandbox("request");
        let waiter = answer_once(&dir, r#"{"decision":"allow"}"#);

        let outcome = claim(
            ClaimFlag::Plain,
            r#"{"tool_name":"Edit","file_path":"/w/auth.rs"}"#,
            &dir,
            "panel-7",
        );

        let request: Value = serde_json::from_str(&waiter.join().unwrap()).unwrap();
        assert_eq!(request["kind"], "claim");
        assert_eq!(request["panelId"], "panel-7");
        assert_eq!(request["file"], "/w/auth.rs");
        assert_eq!(request["tool"], "Edit");
        assert_eq!(outcome, Outcome::allow());
    }

    #[test]
    fn a_refusal_reaches_each_agent_in_the_dialect_it_reads() {
        for (flag, expected) in [
            (
                ClaimFlag::Plain,
                Outcome {
                    code: 2,
                    stdout: String::new(),
                    stderr: format!("{HELD_REASON}: чинит сборку{HELD_ADVICE}\n"),
                },
            ),
            (
                ClaimFlag::Json,
                Outcome {
                    code: 0,
                    stdout: format!(
                        "{{\"decision\":\"deny\",\"reason\":\"{HELD_REASON}: чинит сборку{HELD_ADVICE}\"}}\n"
                    ),
                    stderr: String::new(),
                },
            ),
            (
                ClaimFlag::Copilot,
                Outcome {
                    code: 0,
                    stdout: format!(
                        "{{\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"{HELD_REASON}: чинит сборку{HELD_ADVICE}\"}}\n"
                    ),
                    stderr: String::new(),
                },
            ),
        ] {
            let dir = sandbox(&format!("deny-{}", flag.arg().trim_start_matches('-')));
            let waiter = answer_once(
                &dir,
                r#"{"decision":"deny","reason":"held","holder":"panel-2","task":"чинит сборку"}"#,
            );

            let outcome = claim(
                flag,
                r#"{"tool_name":"Edit","file_path":"/w/auth.rs"}"#,
                &dir,
                "panel-1",
            );

            waiter.join().unwrap();
            assert_eq!(outcome, expected, "{}", flag.arg());
        }
    }

    #[test]
    fn a_stale_read_is_refused_with_its_own_reason() {
        let dir = sandbox("stale");
        let waiter = answer_once(&dir, r#"{"decision":"deny","reason":"stale"}"#);

        let outcome = claim(
            ClaimFlag::Plain,
            r#"{"tool_name":"Edit","file_path":"/w/auth.rs"}"#,
            &dir,
            "panel-1",
        );

        waiter.join().unwrap();
        // Устаревшее чтение — не «занято»: агенту надо перечитать файл, а не
        // ждать соседа, и текст об этом говорит прямо.
        assert_eq!(outcome.code, 2);
        assert_eq!(outcome.stderr, format!("{STALE_REASON}\n"));
    }

    #[test]
    fn antigravity_hears_permission_too_not_only_refusal() {
        let dir = sandbox("agy-allow");
        let waiter = answer_once(&dir, r#"{"decision":"allow"}"#);

        let outcome = claim(
            ClaimFlag::Json,
            r#"{"toolCall":{"args":{"TargetFile":"/w/a.rs"},"name":"replace_file_content"}}"#,
            &dir,
            "panel-1",
        );

        waiter.join().unwrap();
        // Молчание он читает как сбой хука, а не как разрешение.
        assert_eq!(outcome.stdout, "{\"decision\":\"allow\"}\n");
        assert_eq!(outcome.code, 0);
    }

    #[test]
    fn a_holder_without_a_task_is_still_a_holder() {
        let dir = sandbox("no-task");
        let waiter = answer_once(&dir, r#"{"decision":"deny","reason":"held","task":""}"#);

        let outcome = claim(
            ClaimFlag::Plain,
            r#"{"tool_name":"Edit","file_path":"/w/auth.rs"}"#,
            &dir,
            "panel-1",
        );

        waiter.join().unwrap();
        // Без задачи — без двоеточия: «правит другой агент этого проекта: .»
        // читается как оборванная строка.
        assert_eq!(outcome.stderr, format!("{HELD_REASON}{HELD_ADVICE}\n"));
    }

    #[test]
    fn a_quote_in_the_task_does_not_break_the_answer() {
        let dir = sandbox("quoted-task");
        let waiter = answer_once(
            &dir,
            r#"{"decision":"deny","reason":"held","task":"правит README"}"#,
        );

        let outcome = claim(
            ClaimFlag::Json,
            r#"{"tool_name":"Edit","file_path":"/w/a.rs"}"#,
            &dir,
            "panel-1",
        );

        waiter.join().unwrap();
        // Ответ обязан остаться разбираемым: половину JSON antigravity
        // прочитает как сбой хука и правку пропустит.
        let parsed: Value = serde_json::from_str(outcome.stdout.trim()).unwrap();
        assert_eq!(parsed["decision"], "deny");
        assert!(parsed["reason"].as_str().unwrap().contains("правит README"));
    }

    #[test]
    fn an_event_lands_as_a_whole_file_or_not_at_all() {
        let dir = sandbox("notify");

        notify("claude", r#"{"type":"stop"}"#, &dir, "panel-3");

        let entries: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .collect();
        assert_eq!(entries.len(), 1, "{entries:?}");
        // Временного файла не осталось: watcher читает только `.json`, а `.tmp`
        // копился бы в каталоге до самой уборки по возрасту.
        assert_eq!(
            entries[0].extension().and_then(|kind| kind.to_str()),
            Some("json")
        );
        let event: Value = serde_json::from_str(&std::fs::read_to_string(&entries[0]).unwrap())
            .expect("событие обязано разбираться");
        assert_eq!(event["agent"], "claude");
        assert_eq!(event["panelId"], "panel-3");
        assert_eq!(event["payload"]["type"], "stop");
    }

    #[test]
    fn an_empty_payload_still_makes_a_readable_event() {
        let dir = sandbox("notify-empty");

        notify("cursor", "   ", &dir, "panel-4");

        let entry = std::fs::read_dir(&dir).unwrap().flatten().next().unwrap();
        let event: Value = serde_json::from_str(&std::fs::read_to_string(entry.path()).unwrap())
            .expect("событие обязано разбираться");
        assert_eq!(event["payload"], serde_json::json!({}));
    }
}
