mod pty;

use pty::{PtyManager, SpawnOptions};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Emitter, Manager, RunEvent};

#[derive(Clone, Serialize)]
struct PtyExitPayload {
    id: String,
    code: Option<i32>,
}

#[derive(Clone, Serialize)]
struct PtyTitlePayload {
    id: String,
    title: String,
}

/// Имена процессов по PID одним вызовом ps (macOS/Linux).
#[cfg(unix)]
fn process_names(pids: &[i32]) -> std::collections::HashMap<i32, String> {
    let mut names = std::collections::HashMap::new();
    if pids.is_empty() {
        return names;
    }
    let list = pids
        .iter()
        .map(|pid| pid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let Ok(output) = std::process::Command::new("ps")
        .args(["-o", "pid=,comm=", "-p", &list])
        .output()
    else {
        return names;
    };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Some((pid_str, comm)) = line.trim().split_once(char::is_whitespace) else {
            continue;
        };
        let Ok(pid) = pid_str.trim().parse::<i32>() else {
            continue;
        };
        let comm = comm.trim();
        let name = comm.rsplit('/').next().unwrap_or(comm);
        // Логин-шелл представляется как "-zsh".
        let name = name.trim_start_matches('-');
        if !name.is_empty() {
            names.insert(pid, name.to_string());
        }
    }
    names
}

#[cfg(not(unix))]
fn process_names(_pids: &[i32]) -> std::collections::HashMap<i32, String> {
    std::collections::HashMap::new()
}

/// Раз в ~1.5 с смотрим, что крутится в каждом PTY, и шлём во фронт
/// событие только при смене — панель подписывает себя именем программы.
fn spawn_title_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last: std::collections::HashMap<String, String> = Default::default();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let procs = app.state::<PtyManager>().foreground_processes();
            if procs.is_empty() {
                last.clear();
                continue;
            }
            let pids: Vec<i32> = procs.iter().map(|(_, pid)| *pid).collect();
            let names = process_names(&pids);
            last.retain(|id, _| procs.iter().any(|(pid_id, _)| pid_id == id));
            for (id, pid) in &procs {
                let Some(name) = names.get(pid) else { continue };
                if last.get(id) != Some(name) {
                    last.insert(id.clone(), name.clone());
                    let _ = app.emit(
                        "pty-title",
                        PtyTitlePayload {
                            id: id.clone(),
                            title: name.clone(),
                        },
                    );
                }
            }
        }
    });
}

#[tauri::command]
fn pty_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyManager>,
    id: String,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let exit_app = app.clone();
    let exit_id = id.clone();
    state.spawn(
        SpawnOptions {
            id,
            shell,
            cwd,
            cols,
            rows,
        },
        move |bytes| {
            let _ = on_output.send(InvokeResponseBody::Raw(bytes));
        },
        move |code| {
            exit_app.state::<PtyManager>().remove(&exit_id);
            let _ = exit_app.emit("pty-exit", PtyExitPayload { id: exit_id, code });
        },
    )
}

#[tauri::command]
fn pty_write(state: tauri::State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    state.write(&id, data.as_bytes())
}

#[tauri::command]
fn pty_resize(
    state: tauri::State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&id, cols, rows)
}

#[tauri::command]
fn pty_kill(state: tauri::State<'_, PtyManager>, id: String) -> Result<(), String> {
    state.kill(&id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    // На macOS Tauri ставит дефолтное меню, чей пункт Close Window съедает
    // Cmd+W раньше веб-вью. Собираем своё меню без Close/New, оставляя
    // системные роли редактирования — без них в веб-вью не работают Cmd+C/V/A.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|handle| {
        use tauri::menu::{AboutMetadata, MenuBuilder, SubmenuBuilder};

        let app_menu = SubmenuBuilder::new(handle, "ModelCrew")
            .about(Some(AboutMetadata::default()))
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        let edit_menu = SubmenuBuilder::new(handle, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;
        let window_menu = SubmenuBuilder::new(handle, "Window")
            .minimize()
            .fullscreen()
            .build()?;

        MenuBuilder::new(handle)
            .items(&[&app_menu, &edit_menu, &window_menu])
            .build()
    });

    builder
        .manage(PtyManager::default())
        .setup(|app| {
            spawn_title_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_create, pty_write, pty_resize, pty_kill
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Гарантированная уборка шеллов при любом пути выхода — иначе зомби.
            if let RunEvent::Exit = event {
                app.state::<PtyManager>().kill_all();
            }
        });
}
