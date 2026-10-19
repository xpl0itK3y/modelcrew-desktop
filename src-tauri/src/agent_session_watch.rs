use crate::command_error::{CommandError, CommandResult, ErrorCode};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

// Панель узнавала свой разговор с опозданием: локатор запускался по таймеру
// после запуска агента и ещё раз на каждое нажатие клавиши. Между «файл
// разговора появился» и «мы про него спросили» помещается целая гонка — успей
// пользователь написать в соседнюю панель раньше, и самым свежим чатом папки
// оказывался её чат, а не свой.
//
// Здесь та же догадка, но по сигналу, а не по будильнику: за хранилищами
// агентов следит notify, и как только там что-то шевельнулось, фронтенд
// перепроверяет только непривязанные панели этого агента. Между появлением
// файла и привязкой остаются миллисекунды, и очередь набора текста перестаёт
// что-либо решать.

const DEBOUNCE_MS: u64 = 250;

// Все четыре агента пишут разговоры в свои каталоги; opencode — в одну базу,
// поэтому у него следим за папкой базы.
const WATCHED_AGENTS: [&str; 4] = ["claude", "codex", "copilot", "opencode"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreChangedEvent<'a> {
    agent: &'a str,
}

struct StoreWatch {
    // Drop наблюдателя закрывает канал — поток дебаунса завершается сам.
    _watcher: notify::RecommendedWatcher,
}

#[derive(Default)]
pub struct AgentStoreWatchState {
    watchers: Mutex<HashMap<String, StoreWatch>>,
}

// Каталог, в котором у агента заводятся разговоры. Пути те же, что читает
// локатор, — иначе следили бы не за тем.
fn store_root(agent: &str, home: &Path) -> Option<PathBuf> {
    let root = match agent {
        "claude" => crate::agent_sessions::claude_config_dir(home).join("projects"),
        "codex" => crate::agent_sessions::codex_home_dir(home).join("sessions"),
        "copilot" => crate::agent_sessions::copilot_home_dir(home).join("session-state"),
        // База целиком переписывается на каждую запись, поэтому следим за
        // папкой: события про сам файл теряются при подмене inode.
        "opencode" => crate::agent_sessions::opencode_db_candidates(home)
            .into_iter()
            .find_map(|db| db.parent().map(Path::to_path_buf))?,
        _ => return None,
    };
    Some(root)
}

fn spawn_watch(
    app: tauri::AppHandle,
    agent: String,
    root: PathBuf,
) -> Result<StoreWatch, notify::Error> {
    use notify::Watcher;

    let (event_sender, event_receiver) = std::sync::mpsc::channel::<()>();
    let mut watcher =
        notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            let Ok(event) = event else {
                return;
            };
            // Создание — это новый разговор, изменение — продолжение старого
            // (например, выбранного в списке диалогов). Оба случая означают
            // «в этой папке кто-то только что заговорил», и оба нам нужны.
            if matches!(
                event.kind,
                notify::EventKind::Create(_) | notify::EventKind::Modify(_)
            ) {
                let _ = event_sender.send(());
            }
        })?;
    watcher.watch(&root, notify::RecursiveMode::Recursive)?;

    std::thread::spawn(move || {
        while event_receiver.recv().is_ok() {
            // Агент пишет разговор потоком: без тихого окна фронтенд получал
            // бы событие на каждый напечатанный агентом токен.
            while event_receiver
                .recv_timeout(std::time::Duration::from_millis(DEBOUNCE_MS))
                .is_ok()
            {}
            use tauri::Emitter;
            let _ = app.emit("agent-session-store", StoreChangedEvent { agent: &agent });
        }
    });

    Ok(StoreWatch { _watcher: watcher })
}

/// Поднимает наблюдение за хранилищами агентов и возвращает тех, за кем
/// действительно следим.
///
/// Идемпотентна и рассчитана на повторные вызовы: у агента, который ещё ни
/// разу не запускался, каталога разговоров нет и следить не за чем. Фронтенд
/// зовёт её снова, когда опознаёт агента в панели, — к этому моменту каталог
/// уже создан самим агентом.
pub fn watch_stores(app: &tauri::AppHandle, home: &Path) -> Vec<String> {
    let state = app.state::<AgentStoreWatchState>();
    let mut watchers = match state.watchers.lock() {
        Ok(watchers) => watchers,
        Err(error) => error.into_inner(),
    };
    for agent in WATCHED_AGENTS {
        if watchers.contains_key(agent) {
            continue;
        }
        let Some(root) = store_root(agent, home) else {
            continue;
        };
        if !root.is_dir() {
            continue;
        }
        if let Ok(watch) = spawn_watch(app.clone(), agent.to_owned(), root) {
            watchers.insert(agent.to_owned(), watch);
        }
    }
    let mut watched: Vec<String> = watchers.keys().cloned().collect();
    watched.sort();
    watched
}

#[tauri::command]
pub fn agent_sessions_watch(
    window: tauri::Webview,
    app: tauri::AppHandle,
) -> CommandResult<Vec<String>> {
    super::ensure_main_window(&window)?;
    let home = app.path().home_dir().map_err(|error| {
        CommandError::new(ErrorCode::AgentSessionLookupFailed).with_debug(error)
    })?;
    let handle = app.clone();
    Ok(watch_stores(&handle, &home))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_watched_agent_knows_where_its_conversations_live() {
        // Список наблюдаемых агентов и адреса их хранилищ обязаны совпадать:
        // агент без адреса молча остался бы без слежения.
        let home = Path::new("/home/someone");
        for agent in WATCHED_AGENTS {
            assert!(
                store_root(agent, home).is_some(),
                "у агента {agent} нет каталога разговоров"
            );
        }
        assert!(store_root("unknown-agent", home).is_none());
    }

    #[test]
    fn watches_the_same_folders_the_locator_reads() {
        // Следить не за тем каталогом — то же самое, что не следить вовсе, а
        // заметно это стало бы только вживую.
        let home = Path::new("/home/someone");
        assert_eq!(
            store_root("claude", home).unwrap(),
            crate::agent_sessions::claude_config_dir(home).join("projects")
        );
        assert_eq!(
            store_root("codex", home).unwrap(),
            crate::agent_sessions::codex_home_dir(home).join("sessions")
        );
        assert_eq!(
            store_root("copilot", home).unwrap(),
            crate::agent_sessions::copilot_home_dir(home).join("session-state")
        );
        assert_eq!(
            store_root("opencode", home).unwrap(),
            crate::agent_sessions::opencode_db_candidates(home)[0]
                .parent()
                .unwrap()
        );
    }
}
