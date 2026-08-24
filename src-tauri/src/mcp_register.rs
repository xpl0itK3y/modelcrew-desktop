//! Прописать наш MCP-сервер агентам, чтобы человек этого не делал руками.
//!
//! Инструменты браузера бесполезны, пока агент о них не знает, а узнаёт он
//! только из своего конфига. Просить человека каждый раз запускать агента с
//! длинным флагом — значит не сделать работу до конца.
//!
//! Поэтому здесь то же, что и у хуков: при старте вписываемся в конфиг каждого
//! установленного агента. Правило то же самое — конфиг чужой, и всё, что в нём
//! уже лежит, обязано пережить нашу правку: читаем целиком, меняем одну свою
//! запись, пишем через временный файл.
//!
//! Регистрация ходит за выключателем плагина: выключили — записи снимаются, и
//! агент перестаёт видеть инструменты, а не натыкается на мёртвый сервер.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::agent_hooks::{agent_home, back_up_once, home_dir, read_json, write_json_atomically};

/// Имя сервера у всех агентов одно: по нему человек узнаёт нас в их списках
/// (`/mcp` у claude, `codex mcp list`), и по нему же мы находим свою запись,
/// чтобы снять её и не тронуть чужие. Названо по делу: сервер даёт браузер, а
/// не «всё приложение», и в чужом списке это должно читаться сразу.
const SERVER: &str = "modelcrew-browser";

/// Как сервер звался раньше. Запись под старым именем осталась у тех, кому мы
/// уже прописались: не сняв её, мы оставили бы агенту два сервера, из которых
/// один — с прежним, неверным именем.
const FORMER_NAMES: [&str; 1] = ["modelcrew"];

/// Ключ запуска: приложение зовёт само себя, и по этому ключу узнаёт, что его
/// позвали как мост к серверу, а не как приложение.
const STDIO_FLAG: &str = "--mcp-stdio";

/// Кому умеем прописывать. Список короче, чем у хуков: здесь только те, у кого
/// формат подтверждён живым прогоном.
const SUPPORTED: [&str; 6] = [
    "claude",
    "codex",
    "copilot",
    "cursor",
    "opencode",
    "antigravity",
];

/// Прописать сервер всем установленным агентам или снять запись у всех.
///
/// Чужой конфиг мог оказаться битым или недоступным — это не повод ронять
/// запуск: без записи агент просто не увидит инструментов.
pub fn apply(app: &tauri::AppHandle, enabled: bool) {
    let (Some(home), Some(exe)) = (home_dir(app), std::env::current_exe().ok()) else {
        return;
    };
    for agent in SUPPORTED {
        // Не установлен — нечего и трогать: создав ему конфиг, мы завели бы
        // папку агента, которого у человека нет.
        if !agent_home(agent, &home).is_some_and(|dir| dir.is_dir()) {
            continue;
        }
        let Some(path) = config_path(agent, &home) else {
            continue;
        };
        let _ = if enabled {
            register(agent, &path, &exe)
        } else {
            unregister(agent, &path)
        };
    }
}

/// Где у агента лежит список серверов.
///
/// Все пути пользовательские, а не проектные: сервер один на приложение, и
/// заводить его копию в каждом проекте человека — мусорить в его репозиториях.
fn config_path(agent: &str, home: &Path) -> Option<PathBuf> {
    match agent {
        "claude" => Some(home.join(".claude.json")),
        "codex" => Some(home.join(".codex/config.toml")),
        "copilot" => Some(home.join(".copilot/mcp-config.json")),
        "cursor" => Some(home.join(".cursor/mcp.json")),
        "opencode" => Some(home.join(".config/opencode/opencode.json")),
        "antigravity" => Some(home.join(".gemini/config/mcp_config.json")),
        _ => None,
    }
}

/// Вписать свою запись, не тронув остальные.
fn register(agent: &str, path: &Path, exe: &Path) -> Result<(), String> {
    if agent == "codex" {
        return register_toml(path, exe);
    }
    let mut config = read_json(path)?;
    let (section, entry) = json_entry(agent, exe);
    let stale = former_names_in(&config, &section);
    if stale.is_empty() && config.pointer(&format!("/{section}/{SERVER}")) == Some(&entry) {
        return Ok(());
    }
    back_up_once(path);
    if !config.is_object() {
        config = Value::Object(Default::default());
    }
    let root = config.as_object_mut().expect("объект гарантирован выше");
    let servers = root
        .entry(section)
        .or_insert_with(|| Value::Object(Default::default()));
    if !servers.is_object() {
        *servers = Value::Object(Default::default());
    }
    let servers = servers.as_object_mut().expect("объект гарантирован выше");
    for name in stale {
        servers.remove(&name);
    }
    servers.insert(SERVER.to_string(), entry);
    write_json_atomically(path, &config)
}

/// Снять свою запись, не тронув остальные.
fn unregister(agent: &str, path: &Path) -> Result<(), String> {
    if agent == "codex" {
        return unregister_toml(path);
    }
    if !path.exists() {
        return Ok(());
    }
    let mut config = read_json(path)?;
    let (section, _) = json_entry(agent, Path::new(""));
    let Some(servers) = config.get_mut(&section).and_then(Value::as_object_mut) else {
        return Ok(());
    };
    let mut changed = servers.remove(SERVER).is_some();
    for name in FORMER_NAMES {
        changed |= servers.remove(name).is_some();
    }
    if !changed {
        return Ok(());
    }
    write_json_atomically(path, &config)
}

/// Раздел конфига и сама запись — у каждого агента свои.
fn json_entry(agent: &str, exe: &Path) -> (String, Value) {
    match agent {
        // Список команды, а не строка с аргументами: у opencode это `mcp`, и
        // запись у него своя — с типом и выключателем.
        "opencode" => (
            "mcp".to_string(),
            json!({
                "type": "local",
                "command": [exe.to_string_lossy(), STDIO_FLAG],
                "enabled": true,
            }),
        ),
        // Общий для остальных вид из спецификации MCP.
        _ => (
            "mcpServers".to_string(),
            json!({
                "command": exe.to_string_lossy(),
                "args": [STDIO_FLAG],
            }),
        ),
    }
}

/// Какие из прежних имён лежат в конфиге сейчас.
fn former_names_in(config: &Value, section: &str) -> Vec<String> {
    FORMER_NAMES
        .iter()
        .filter(|name| config.pointer(&format!("/{section}/{name}")).is_some())
        .map(|name| (*name).to_string())
        .collect()
}

/// Метка нашего блока в TOML: по ней он находится, чтобы не вписаться дважды и
/// чтобы было что снять.
const TOML_MARKER: &str = "# modelcrew: браузер проекта";

/// У codex конфиг в TOML, и разбирать его целиком мы не станем: это чужой файл
/// с комментариями и порядком, который человек ставил руками. Дописываем свой
/// блок в конец — новая таблица закрывает предыдущую, поэтому соседям всё
/// равно, — и снимаем его целиком.
fn register_toml(path: &Path, exe: &Path) -> Result<(), String> {
    let current = std::fs::read_to_string(path).unwrap_or_default();
    let block = toml_block(exe);
    if current.contains(&block) {
        return Ok(());
    }
    back_up_once(path);
    // Прошлая запись могла остаться от другого пути к приложению — снимаем её,
    // иначе у агента станет два сервера с одним именем.
    let body = strip_toml_block(&current);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    std::fs::write(path, format!("{body}{block}"))
        .map_err(|error| format!("{}: {error}", path.display()))
}

fn unregister_toml(path: &Path) -> Result<(), String> {
    let Ok(current) = std::fs::read_to_string(path) else {
        return Ok(());
    };
    let body = strip_toml_block(&current);
    if body == current {
        return Ok(());
    }
    std::fs::write(path, body).map_err(|error| format!("{}: {error}", path.display()))
}

fn toml_block(exe: &Path) -> String {
    format!(
        "\n{TOML_MARKER}\n[mcp_servers.{SERVER}]\ncommand = {}\nargs = [{}]\n",
        toml_string(&exe.to_string_lossy()),
        toml_string(STDIO_FLAG),
    )
}

/// Строка в TOML: путь к приложению может содержать что угодно, включая
/// кавычки и обратные слэши Windows.
fn toml_string(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// Вырезать наш блок — от метки до следующей таблицы или конца файла.
fn strip_toml_block(text: &str) -> String {
    let Some(start) = text.find(TOML_MARKER) else {
        return text.to_string();
    };
    // Следующую таблицу ищем после своей: сразу за меткой стоит наш же
    // заголовок, и без этого шага мы бы приняли его за границу блока.
    let after_marker = start + TOML_MARKER.len();
    let ours = text[after_marker..]
        .find('[')
        .map_or(after_marker, |offset| after_marker + offset);
    let end = text[ours + 1..]
        .find("\n[")
        .map_or(text.len(), |offset| ours + 1 + offset + 1);
    let head = text[..start].trim_end_matches('\n');
    let rest = &text[end..];
    if rest.is_empty() {
        return format!("{head}\n");
    }
    format!("{head}\n{rest}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exe() -> PathBuf {
        // Настоящий путь на macOS — внутри бандла, с пробелом.
        PathBuf::from("/Applications/ModelCrew.app/Contents/MacOS/ModelCrew")
    }

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn a_fresh_agent_gets_the_server_written_the_way_the_protocol_says() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        register("claude", &path, &exe()).unwrap();

        let config = read_json(&path).unwrap();
        assert_eq!(
            config["mcpServers"][SERVER],
            json!({
                "command": "/Applications/ModelCrew.app/Contents/MacOS/ModelCrew",
                "args": ["--mcp-stdio"],
            })
        );
    }

    #[test]
    fn what_the_person_set_up_himself_survives_our_edit() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            ".claude.json",
            r#"{"theme":"dark","mcpServers":{"github":{"command":"gh-mcp"}}}"#,
        );

        register("claude", &path, &exe()).unwrap();
        let config = read_json(&path).unwrap();
        assert_eq!(config["theme"], "dark");
        assert_eq!(config["mcpServers"]["github"]["command"], "gh-mcp");
        assert!(config["mcpServers"][SERVER].is_object());

        unregister("claude", &path).unwrap();
        let config = read_json(&path).unwrap();
        assert_eq!(config["theme"], "dark");
        assert_eq!(config["mcpServers"]["github"]["command"], "gh-mcp");
        assert!(config["mcpServers"][SERVER].is_null());
    }

    #[test]
    fn the_record_under_the_old_name_goes_away_with_the_rename() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            ".claude.json",
            r#"{"mcpServers":{"modelcrew":{"command":"/old","args":["--mcp-stdio"]},"github":{"command":"gh"}}}"#,
        );

        register("claude", &path, &exe()).unwrap();

        let config = read_json(&path).unwrap();
        let servers = config["mcpServers"].as_object().unwrap();
        assert!(!servers.contains_key("modelcrew"), "старое имя должно уйти");
        assert!(servers.contains_key(SERVER));
        assert!(servers.contains_key("github"), "чужое трогать нельзя");
    }

    #[test]
    fn writing_twice_leaves_one_record() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".cursor/mcp.json");
        register("cursor", &path, &exe()).unwrap();
        register("cursor", &path, &exe()).unwrap();

        let config = read_json(&path).unwrap();
        assert_eq!(config["mcpServers"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn opencode_gets_its_own_shape_and_not_the_common_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.json");
        register("opencode", &path, &exe()).unwrap();

        let config = read_json(&path).unwrap();
        assert_eq!(
            config["mcp"][SERVER],
            json!({
                "type": "local",
                "command": [
                    "/Applications/ModelCrew.app/Contents/MacOS/ModelCrew",
                    "--mcp-stdio",
                ],
                "enabled": true,
            })
        );
    }

    #[test]
    fn codex_keeps_the_file_it_had_and_gets_a_block_at_the_end() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            ".codex/config.toml",
            "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other\"\n",
        );

        register("codex", &path, &exe()).unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.starts_with("model = \"gpt-5\""));
        assert!(body.contains("[mcp_servers.other]"));
        assert!(body.contains("[mcp_servers.modelcrew-browser]"));
        assert!(body.contains("command = \"/Applications/ModelCrew.app/Contents/MacOS/ModelCrew\""));

        unregister("codex", &path).unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(!body.contains("modelcrew"));
        assert!(body.contains("[mcp_servers.other]"));
    }

    #[test]
    fn a_moved_application_does_not_leave_a_second_block_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".codex/config.toml");
        register("codex", &path, Path::new("/old/ModelCrew")).unwrap();
        register("codex", &path, &exe()).unwrap();

        let body = std::fs::read_to_string(&path).unwrap();
        assert_eq!(body.matches("[mcp_servers.modelcrew-browser]").count(), 1);
        assert!(!body.contains("/old/ModelCrew"));
    }

    #[test]
    fn a_block_in_the_middle_is_cut_without_taking_the_neighbour() {
        let text = concat!(
            "model = \"x\"\n",
            "\n# modelcrew: браузер проекта\n",
            "[mcp_servers.modelcrew-browser]\ncommand = \"a\"\nargs = [\"--mcp-stdio\"]\n",
            "\n[other]\nkey = 1\n",
        );
        let stripped = strip_toml_block(text);
        assert!(!stripped.contains("modelcrew"));
        assert!(stripped.contains("[other]"));
        assert!(stripped.contains("key = 1"));
    }

    #[test]
    fn a_path_with_quotes_does_not_break_the_toml() {
        assert_eq!(
            toml_string(r#"C:\Program "Files"\a"#),
            r#""C:\\Program \"Files\"\\a""#
        );
    }

    #[test]
    fn removing_from_an_agent_who_never_had_us_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        unregister("claude", &path).unwrap();
        assert!(!path.exists());
    }
}
