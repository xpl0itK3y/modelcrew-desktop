//! Дать агенту наш MCP-сервер — но только внутри панели.
//!
//! Инструменты бесполезны, пока агент о них не знает, а узнаёт он только из
//! своего конфига. Общий конфиг для этого не годится: сервер появился бы и в
//! агенте, запущенном в обычном терминале, где панели нет и браузер всё равно
//! недоступен. Внутреннему плагину незачем торчать наружу.
//!
//! Поэтому конфиг у нас свой и лежит рядом с приложением, а панель запускает
//! агента через обёртку: она находит настоящий CLI в `PATH` и добавляет ему
//! один флаг. Вне панели обёртки нет — и сервера у агента тоже нет.
//!
//! Здесь же снимается запись из общих конфигов: она успела там появиться, и
//! оставить её значило бы оставить ровно то, от чего уходим.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::agent_hooks::{agent_home, home_dir, read_json, write_json_atomically};

/// Имя сервера у всех агентов одно: по нему человек узнаёт нас в их списках,
/// и по нему же мы находим свою запись, чтобы снять её и не тронуть чужие.
/// Названо по делу: сервер даёт браузер, а не «всё приложение».
const SERVER: &str = "modelcrew-browser";

/// Как сервер звался раньше. Запись под старым именем осталась у тех, кому мы
/// успели прописаться, и снимать надо оба имени.
const FORMER_NAMES: [&str; 1] = ["modelcrew"];

/// Ключ запуска: приложение зовёт само себя, и по этому ключу узнаёт, что его
/// позвали как мост к серверу, а не как приложение.
const STDIO_FLAG: &str = "--mcp-stdio";

/// Каталог обёрток внутри данных приложения.
const SHIMS_DIR: &str = "agent-shims";

/// Наш конфиг серверов: свой файл, а не строка в командной строке — путь к
/// приложению содержит пробелы, а у человека может содержать что угодно.
const CONFIG_FILE: &str = "mcp.json";

/// Чьи общие конфиги мы когда-то правили и теперь чистим.
const SUPPORTED: [&str; 6] = [
    "claude",
    "codex",
    "copilot",
    "cursor",
    "opencode",
    "antigravity",
];

/// Агенты, которым обёртка умеет передать сервер флагом при запуске.
///
/// opencode здесь нет и не нужно: он читает конфиг прямо из окружения, и
/// обёртка ему ни к чему — см. `opencode_config`. Остальные — cursor, grok —
/// читают только свои файлы, а писать в них значит опять вылезти наружу. Им
/// плагин пока недоступен, и это честнее, чем сервер, висящий у человека в
/// общем списке.
const WRAPPED: [&str; 3] = ["claude", "codex", "copilot"];

/// Переменная окружения opencode: конфиг в ней лежит строкой, целиком.
pub const OPENCODE_ENV: &str = "OPENCODE_CONFIG_CONTENT";

/// Схема конфига opencode. Не проверка, а подсказка редактору, — но раз она
/// стоит в их собственных примерах, пусть стоит и у нас.
const OPENCODE_SCHEMA: &str = "https://opencode.ai/config.json";

// ---------------------------------------------------------------------------
// Внутрь: обёртки для панели.

/// Разложить обёртки и наш конфиг; при выключенном плагине — убрать их.
///
/// Возвращает каталог, который панель добавит себе в начало `PATH`. `None` —
/// раскладывать было некуда или незачем: панель тогда запускает агента как
/// обычно, без нашего сервера.
pub fn shims(app: &tauri::AppHandle, enabled: bool) -> Option<PathBuf> {
    use tauri::Manager;

    let dir = app.path().app_data_dir().ok()?.join(SHIMS_DIR);
    if !enabled {
        let _ = std::fs::remove_dir_all(&dir);
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    write_shims(&dir, &exe).ok()?;
    Some(dir)
}

/// Конфиг opencode с нашим сервером — тем же слоем, что и всё остальное.
///
/// Обёртки opencode не нужны вовсе: он берёт конфиг из окружения, а панель
/// окружение и так задаёт. Наружу это не вылезает по самому устройству —
/// переменная живёт ровно столько, сколько панель, и в обычном терминале
/// пользователя её нет.
///
/// Значение накладывается последним слоем поверх глобального и проектного
/// конфигов, а не вместо них (так это описано у самого opencode). Поэтому и
/// здесь: то, что уже стояло в окружении, мы дополняем, а не затираем.
pub fn opencode_config(exe: &Path, inherited: Option<&str>) -> String {
    let mut document = match inherited.and_then(|text| serde_json::from_str::<Value>(text).ok()) {
        Some(Value::Object(map)) => map,
        // Своего значения не было — или было, да не разобралось. Чинить чужое
        // не нам: такое opencode всё равно не прочтёт.
        _ => serde_json::Map::new(),
    };
    document
        .entry("$schema")
        .or_insert_with(|| json!(OPENCODE_SCHEMA));
    let servers = document.entry("mcp").or_insert_with(|| json!({}));
    let ours = json!({
        "type": "local",
        "command": [exe.to_string_lossy(), STDIO_FLAG],
        "enabled": true,
    });
    match servers.as_object_mut() {
        Some(servers) => {
            servers.insert(SERVER.to_string(), ours);
        }
        // На месте списка серверов оказалось не пойми что. Оставить как есть
        // значило бы отдать opencode заведомо битый конфиг.
        None => *servers = json!({ SERVER: ours }),
    }
    Value::Object(document).to_string()
}

#[cfg(unix)]
fn write_shims(dir: &Path, exe: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(CONFIG_FILE), format!("{}\n", config_body(exe)))?;
    for agent in WRAPPED {
        let path = dir.join(agent);
        std::fs::write(&path, shim_body(agent, exe))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

/// На Windows обёртки ещё нет: там и `PATH` панели, и сами оболочки устроены
/// иначе, а делать это вслепую — хуже, чем не делать.
#[cfg(not(unix))]
fn write_shims(_dir: &Path, _exe: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "обёртки агентов пока только для unix",
    ))
}

/// Наш конфиг серверов в том виде, как его читают claude и copilot.
fn config_body(exe: &Path) -> String {
    json!({
        "mcpServers": {
            SERVER: {
                "command": exe.to_string_lossy(),
                "args": [STDIO_FLAG],
            }
        }
    })
    .to_string()
}

/// Тело обёртки.
///
/// Настоящий CLI ищется в `PATH` мимо самой обёртки: она лежит там же и первой,
/// поэтому обычный поиск нашёл бы её саму и агент запустил бы сам себя. Не
/// нашли — говорим словами и уходим с кодом «команды нет», как сделала бы
/// оболочка.
fn shim_body(agent: &str, exe: &Path) -> String {
    let flags = shim_flags(agent, exe);
    format!(
        r#"#!/bin/sh
# Создано ModelCrew. Браузер проекта доступен агенту только здесь, в панели:
# наружу, в общий конфиг агента, приложение не пишет.
self=$(cd "$(dirname "$0")" && pwd)
real=''
saved_ifs=$IFS
IFS=:
for dir in $PATH; do
  [ -n "$dir" ] || dir=.
  [ "$dir" = "$self" ] && continue
  if [ -x "$dir/{agent}" ]; then real="$dir/{agent}"; break; fi
done
IFS=$saved_ifs
if [ -z "$real" ]; then
  echo "ModelCrew: {agent} не найден в PATH" >&2
  exit 127
fi
exec "$real" {flags} "$@"
"#
    )
}

/// Чем каждому агенту передаётся сервер. Все трое читают его при запуске, но
/// каждый по-своему: файлом, строкой или парой ключей настройки.
fn shim_flags(agent: &str, exe: &Path) -> String {
    match agent {
        // Файлом, и обязательно через «=»: без него claude считает своим
        // значением и всё, что идёт следом, — команда `claude mcp list` через
        // обёртку падала с «файл mcp не найден».
        "claude" => format!("--mcp-config=\"$self/{CONFIG_FILE}\""),
        // Строкой: файла он не принимает, поэтому подаём его же содержимое.
        "copilot" => format!("--additional-mcp-config=\"$(cat \"$self/{CONFIG_FILE}\")\""),
        // Ключами настройки: у codex конфиг в TOML, и значения тоже в TOML.
        "codex" => format!(
            "-c {} -c {}",
            sh_quote(&format!(
                "mcp_servers.{SERVER}.command={}",
                toml_string(&exe.to_string_lossy())
            )),
            sh_quote(&format!(
                "mcp_servers.{SERVER}.args=[{}]",
                toml_string(STDIO_FLAG)
            )),
        ),
        _ => String::new(),
    }
}

/// Строка для оболочки: одинарные кавычки закрывают всё, кроме самой одинарной
/// кавычки, — её приходится выносить наружу.
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Строка в TOML: путь к приложению может содержать кавычки и слэши.
fn toml_string(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

// ---------------------------------------------------------------------------
// Наружу: уборка за прежними версиями.

/// Убрать нашу запись из общих конфигов агентов.
///
/// Зовётся при каждом запуске, а не однажды: запись могла остаться от прежней
/// версии приложения, и человек об этом не узнает, пока не увидит наш сервер
/// там, где его быть не должно.
pub fn clean_shared_configs(app: &tauri::AppHandle) {
    let Some(home) = home_dir(app) else {
        return;
    };
    for agent in SUPPORTED {
        if !agent_home(agent, &home).is_some_and(|dir| dir.is_dir()) {
            continue;
        }
        let Some(path) = config_path(agent, &home) else {
            continue;
        };
        // Чужой конфиг мог оказаться битым или недоступным — это не повод
        // ронять запуск приложения.
        let _ = unregister(agent, &path);
    }
}

/// Где у агента лежит список серверов.
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

/// Раздел, в котором агент держит серверы. У opencode он свой.
fn section_of(agent: &str) -> &'static str {
    match agent {
        "opencode" => "mcp",
        _ => "mcpServers",
    }
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
    let Some(servers) = config
        .get_mut(section_of(agent))
        .and_then(Value::as_object_mut)
    else {
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

/// Метка нашего блока в TOML: по ней он находится, чтобы было что снять.
const TOML_MARKER: &str = "# modelcrew: браузер проекта";

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
    fn opencode_gets_the_server_without_any_wrapper() {
        let config: Value = serde_json::from_str(&opencode_config(&exe(), None)).unwrap();
        let ours = &config["mcp"][SERVER];
        assert_eq!(ours["type"], "local");
        assert_eq!(ours["enabled"], true);
        // Путь и ключ — одним массивом, а не строкой: в пути есть пробел, и
        // строкой opencode разобрал бы его на два слова.
        assert_eq!(
            ours["command"],
            json!([exe().to_string_lossy(), STDIO_FLAG])
        );
    }

    #[test]
    fn what_the_person_already_had_in_the_environment_survives() {
        // Значение накладывается последним слоем поверх остальных конфигов, а
        // не вместо них. Затри мы чужое — человек внутри панели молча лишился
        // бы собственных серверов и настроек.
        let theirs = r#"{"model":"anthropic/claude","mcp":{"их-сервер":{"type":"local"}}}"#;
        let config: Value = serde_json::from_str(&opencode_config(&exe(), Some(theirs))).unwrap();
        assert_eq!(config["model"], "anthropic/claude");
        assert_eq!(config["mcp"]["их-сервер"]["type"], "local");
        assert!(config["mcp"][SERVER].is_object());
    }

    #[test]
    fn a_broken_value_in_the_environment_does_not_break_ours() {
        // Чужое значение оказалось не JSON или не тем JSON. Чинить его не нам:
        // opencode такое всё равно не прочтёт, а вот отдать ему битый конфиг
        // из-за этого нельзя — тогда он не прочтёт и наш сервер.
        for text in ["", "{", "[]", "\"строка\"", r#"{"mcp":"не список"}"#] {
            let config: Value = serde_json::from_str(&opencode_config(&exe(), Some(text)))
                .unwrap_or_else(|error| panic!("не JSON при {text:?}: {error}"));
            assert!(config["mcp"][SERVER].is_object(), "{text:?}");
        }
    }

    #[test]
    fn the_wrapper_runs_the_real_agent_and_not_itself() {
        let body = shim_body("claude", &exe());
        // Поиск идёт по PATH мимо собственного каталога — иначе обёртка нашла
        // бы себя и запустила рекурсию вместо агента.
        assert!(body.contains(r#"[ "$dir" = "$self" ] && continue"#));
        assert!(body.contains(r#"exec "$real""#));
    }

    #[test]
    fn each_agent_gets_the_flag_it_understands() {
        // Именно «=»: без него значением флага становятся и аргументы
        // человека, идущие следом.
        assert!(shim_flags("claude", &exe()).starts_with("--mcp-config="));
        assert!(shim_flags("copilot", &exe()).starts_with("--additional-mcp-config="));
        let codex = shim_flags("codex", &exe());
        assert!(codex.contains("mcp_servers.modelcrew-browser.command="));
        assert!(codex.contains("--mcp-stdio"));
    }

    #[test]
    fn a_path_with_a_quote_does_not_break_the_wrapper() {
        let flags = shim_flags("codex", Path::new("/Users/o'brien/ModelCrew"));
        // Одинарная кавычка в пути обязана остаться внутри строки оболочки, а
        // не закрыть её и превратить остаток в отдельные слова.
        assert!(flags.contains(r#"'\''"#));
        assert!(flags.starts_with("-c '"));
    }

    #[test]
    fn the_config_says_what_the_protocol_expects() {
        let config: Value = serde_json::from_str(&config_body(&exe())).unwrap();
        assert_eq!(
            config["mcpServers"][SERVER],
            json!({
                "command": "/Applications/ModelCrew.app/Contents/MacOS/ModelCrew",
                "args": ["--mcp-stdio"],
            })
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_wrappers_land_runnable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let shims = dir.path().join(SHIMS_DIR);
        write_shims(&shims, &exe()).unwrap();

        for agent in WRAPPED {
            let path = shims.join(agent);
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "{agent} должен быть исполняемым");
        }
        assert!(shims.join(CONFIG_FILE).exists());
    }

    #[test]
    fn the_shared_config_loses_our_record_and_keeps_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            ".claude.json",
            r#"{"theme":"dark","mcpServers":{"github":{"command":"gh"},"modelcrew-browser":{"command":"x"}}}"#,
        );

        unregister("claude", &path).unwrap();

        let config = read_json(&path).unwrap();
        assert_eq!(config["theme"], "dark");
        assert_eq!(config["mcpServers"]["github"]["command"], "gh");
        assert!(config["mcpServers"][SERVER].is_null());
    }

    #[test]
    fn the_record_under_the_old_name_goes_away_too() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            ".claude.json",
            r#"{"mcpServers":{"modelcrew":{"command":"/old"},"github":{"command":"gh"}}}"#,
        );

        unregister("claude", &path).unwrap();

        let config = read_json(&path).unwrap();
        let servers = config["mcpServers"].as_object().unwrap();
        assert!(!servers.contains_key("modelcrew"), "старое имя должно уйти");
        assert!(servers.contains_key("github"), "чужое трогать нельзя");
    }

    #[test]
    fn codex_loses_our_block_and_keeps_its_neighbour() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            ".codex/config.toml",
            concat!(
                "model = \"gpt-5\"\n",
                "\n# modelcrew: браузер проекта\n",
                "[mcp_servers.modelcrew-browser]\ncommand = \"a\"\nargs = [\"--mcp-stdio\"]\n",
                "\n[mcp_servers.other]\ncommand = \"other\"\n",
            ),
        );

        unregister("codex", &path).unwrap();

        let body = std::fs::read_to_string(&path).unwrap();
        assert!(!body.contains("modelcrew"));
        assert!(body.starts_with("model = \"gpt-5\""));
        assert!(body.contains("[mcp_servers.other]"));
    }

    #[test]
    fn removing_from_an_agent_who_never_had_us_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        unregister("claude", &path).unwrap();
        assert!(!path.exists());
    }
}
