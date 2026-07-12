mod pty;
mod workspace_roots;

use pty::{PtyManager, SpawnOptions};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_dialog::DialogExt;
use workspace_roots::{BindOutcome, WorkspaceRootBinding, WorkspaceRoots};

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

#[derive(Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum WorkspaceRootResult {
    Cancelled,
    Bound { workspace_id: String, path: String },
    AlreadyOpen { workspace_id: String, path: String },
}

impl From<BindOutcome> for WorkspaceRootResult {
    fn from(outcome: BindOutcome) -> Self {
        let (already_open, WorkspaceRootBinding { workspace_id, path }) = match outcome {
            BindOutcome::Bound(binding) => (false, binding),
            BindOutcome::AlreadyOpen(binding) => (true, binding),
        };
        if already_open {
            Self::AlreadyOpen { workspace_id, path }
        } else {
            Self::Bound { workspace_id, path }
        }
    }
}

fn ensure_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("эта команда доступна только главному окну".into())
    }
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
                    let _ = app.emit_to(
                        "main",
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
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyManager>,
    roots: tauri::State<'_, WorkspaceRoots>,
    id: String,
    workspace_id: String,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let cwd = roots.resolve(&workspace_id)?;
    let exit_app = app.clone();
    let exit_id = id.clone();
    state.spawn(
        SpawnOptions {
            id,
            shell: None,
            cwd,
            cols,
            rows,
        },
        move |bytes| {
            let _ = on_output.send(InvokeResponseBody::Raw(bytes));
        },
        move |code| {
            exit_app.state::<PtyManager>().remove(&exit_id);
            let _ = exit_app.emit_to(
                "main",
                "pty-exit",
                PtyExitPayload { id: exit_id, code },
            );
        },
    )
}

#[tauri::command]
fn pty_write(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    state.write(&id, data.as_bytes())
}

#[tauri::command]
fn pty_resize(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    state.resize(&id, cols, rows)
}

#[tauri::command]
fn pty_kill(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PtyManager>,
    id: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    state.kill(&id)
}

#[tauri::command]
fn workspace_register_root(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    path: String,
) -> Result<WorkspaceRootResult, String> {
    ensure_main_window(&window)?;
    state
        .bind(&workspace_id, std::path::Path::new(&path))
        .map(Into::into)
}

#[tauri::command]
fn workspace_reconcile_roots(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    workspace_ids: Vec<String>,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    state.retain_only(&workspace_ids)
}

#[tauri::command]
fn workspace_validate_root(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
) -> Result<String, String> {
    ensure_main_window(&window)?;
    state.resolve(&workspace_id).and_then(|path| {
        path.to_str()
            .map(str::to_owned)
            .ok_or_else(|| "путь проекта содержит неподдерживаемые символы".into())
    })
}

#[tauri::command]
async fn workspace_pick_root(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
) -> Result<WorkspaceRootResult, String> {
    ensure_main_window(&window)?;
    let selected = window
        .dialog()
        .file()
        .set_title("Папка проекта для воркспейса")
        .blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(WorkspaceRootResult::Cancelled);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("не удалось прочитать выбранный путь: {error}"))?;
    state
        .bind_user_selected(&workspace_id, &path)
        .map(Into::into)
}

#[tauri::command]
fn workspace_unregister_root(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    state.unbind(&workspace_id)
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
        .manage(WorkspaceRoots::default())
        .setup(|app| {
            spawn_title_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_create,
            pty_write,
            pty_resize,
            pty_kill,
            workspace_reconcile_roots,
            workspace_register_root,
            workspace_validate_root,
            workspace_pick_root,
            workspace_unregister_root
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_root_result_uses_camel_case_ipc_fields() {
        let value = serde_json::to_value(WorkspaceRootResult::Bound {
            workspace_id: "workspace-1".into(),
            path: "/tmp/project".into(),
        })
        .unwrap();

        assert_eq!(value["status"], "bound");
        assert_eq!(value["workspaceId"], "workspace-1");
        assert!(value.get("workspace_id").is_none());
    }
}
