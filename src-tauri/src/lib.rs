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
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

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
