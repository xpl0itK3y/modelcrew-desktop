mod command_error;
mod pty;
mod workspace_roots;

use command_error::{CommandError, CommandResult, ErrorCode};
use pty::{PtyManager, ShellInfo, SpawnOptions};
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AppLocale {
    Ru,
    En,
}

impl AppLocale {
    fn parse(locale: &str) -> CommandResult<Self> {
        match locale {
            "ru" => Ok(Self::Ru),
            "en" => Ok(Self::En),
            _ => Err(CommandError::new(ErrorCode::InvalidLocale).with_context("locale", locale)),
        }
    }

    fn project_picker_title(self) -> &'static str {
        match self {
            Self::Ru => "Папка проекта для воркспейса",
            Self::En => "Project folder for workspace",
        }
    }

    #[cfg(target_os = "macos")]
    fn edit_menu_title(self) -> &'static str {
        match self {
            Self::Ru => "Правка",
            Self::En => "Edit",
        }
    }

    #[cfg(target_os = "macos")]
    fn window_menu_title(self) -> &'static str {
        match self {
            Self::Ru => "Окно",
            Self::En => "Window",
        }
    }
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

fn ensure_main_window(window: &tauri::WebviewWindow) -> CommandResult<()> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(CommandError::new(ErrorCode::MainWindowOnly))
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
        .args(["-ww", "-o", "pid=,comm=,command=", "-p", &list])
        .output()
    else {
        return names;
    };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        // Колонки: pid, comm (один токен), затем argv процесса.
        let mut tokens = line.split_whitespace();
        let (Some(pid_str), Some(comm)) = (tokens.next(), tokens.next()) else {
            continue;
        };
        let Ok(pid) = pid_str.parse::<i32>() else {
            continue;
        };
        let argv: Vec<&str> = tokens.collect();
        let name = friendly_name(comm, &argv);
        if !name.is_empty() {
            names.insert(pid, name);
        }
    }
    names
}

/// Имя для подписи панели. Обычно это basename исполняемого файла, но для
/// интерпретаторов (node/python/…) реальный инструмент прячется в argv:
/// запущенный codex — это `node …/codex`, и без разбора аргументов панель
/// подписалась бы «node». Достаём первый значимый токен argv.
fn friendly_name(comm: &str, argv: &[&str]) -> String {
    let comm_base = basename(comm).trim_start_matches('-');
    if !is_interpreter(comm_base) {
        return comm_base.to_string();
    }
    for arg in argv {
        if arg.starts_with('-') {
            continue; // флаг интерпретатора: -e, -m, --inspect …
        }
        let base = basename(arg).trim_start_matches('-');
        if base.is_empty() || is_interpreter(base) {
            continue; // сам путь к node/python — пропускаем
        }
        return strip_script_ext(base).to_string();
    }
    comm_base.to_string()
}

fn basename(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn is_interpreter(name: &str) -> bool {
    matches!(
        name,
        "node" | "deno" | "bun" | "ruby" | "perl" | "php" | "python" | "python2" | "python3"
    ) || name.starts_with("python2.")
        || name.starts_with("python3.")
}

fn strip_script_ext(name: &str) -> &str {
    for ext in [".js", ".mjs", ".cjs", ".ts", ".py", ".rb", ".pl", ".php"] {
        if let Some(stem) = name.strip_suffix(ext) {
            if !stem.is_empty() {
                return stem;
            }
        }
    }
    name
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
    shell: Option<String>,
    on_output: Channel<InvokeResponseBody>,
) -> CommandResult<()> {
    ensure_main_window(&window)?;
    let cwd = roots.resolve(&workspace_id)?;
    let exit_app = app.clone();
    let exit_id = id.clone();
    state.spawn(
        SpawnOptions {
            id,
            // Пусто/None — оболочка по умолчанию для ОС (см. default_shell).
            shell: shell.filter(|value| !value.trim().is_empty()),
            cwd,
            cols,
            rows,
        },
        move |bytes| {
            let _ = on_output.send(InvokeResponseBody::Raw(bytes));
        },
        move |code| {
            // Снятие сессии из карты берёт на себя PtyManager (по epoch),
            // чтобы вытеснённый reload'ом терминал не «завершил» новый.
            let _ = exit_app.emit_to("main", "pty-exit", PtyExitPayload { id: exit_id, code });
        },
    )
}

#[tauri::command]
fn list_shells() -> Vec<ShellInfo> {
    pty::available_shells()
}

#[tauri::command]
fn pty_write(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PtyManager>,
    id: String,
    data: String,
) -> CommandResult<()> {
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
) -> CommandResult<()> {
    ensure_main_window(&window)?;
    state.resize(&id, cols, rows)
}

#[tauri::command]
fn pty_kill(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PtyManager>,
    id: String,
) -> CommandResult<()> {
    ensure_main_window(&window)?;
    state.kill(&id)
}

#[tauri::command]
fn workspace_register_root(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    path: String,
) -> CommandResult<WorkspaceRootResult> {
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
) -> CommandResult<()> {
    ensure_main_window(&window)?;
    state.retain_only(&workspace_ids)
}

#[tauri::command]
fn workspace_validate_root(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
) -> CommandResult<String> {
    ensure_main_window(&window)?;
    state.resolve(&workspace_id).and_then(|path| {
        path.to_str().map(str::to_owned).ok_or_else(|| {
            CommandError::new(ErrorCode::WorkspacePathUnsupported)
                .with_context("path", path.to_string_lossy())
        })
    })
}

#[tauri::command]
async fn workspace_pick_root(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    locale: String,
) -> CommandResult<WorkspaceRootResult> {
    ensure_main_window(&window)?;
    let locale = AppLocale::parse(&locale)?;
    let selected = window
        .dialog()
        .file()
        .set_title(locale.project_picker_title())
        .blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(WorkspaceRootResult::Cancelled);
    };
    let path = selected.into_path().map_err(|error| {
        CommandError::new(ErrorCode::WorkspacePickerPathInvalid).with_debug(error)
    })?;
    state
        .bind_user_selected(&workspace_id, &path)
        .map(Into::into)
}

#[tauri::command]
fn workspace_unregister_root(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
) -> CommandResult<()> {
    ensure_main_window(&window)?;
    state.unbind(&workspace_id)
}

#[tauri::command]
fn app_set_locale(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    locale: String,
) -> CommandResult<()> {
    ensure_main_window(&window)?;
    let locale = AppLocale::parse(&locale)?;

    #[cfg(target_os = "macos")]
    {
        let menu = build_macos_menu(&app, locale)
            .map_err(|error| CommandError::new(ErrorCode::AppMenuUpdateFailed).with_debug(error))?;
        app.set_menu(menu)
            .map_err(|error| CommandError::new(ErrorCode::AppMenuUpdateFailed).with_debug(error))?;
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (app, locale);

    Ok(())
}

#[cfg(target_os = "macos")]
fn build_macos_menu<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
    locale: AppLocale,
) -> tauri::Result<tauri::menu::Menu<R>> {
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
    let edit_menu = SubmenuBuilder::new(handle, locale.edit_menu_title())
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window_menu = SubmenuBuilder::new(handle, locale.window_menu_title())
        .minimize()
        .fullscreen()
        .build()?;

    MenuBuilder::new(handle)
        .items(&[&app_menu, &edit_menu, &window_menu])
        .build()
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
    let builder = builder.menu(|handle| build_macos_menu(handle, AppLocale::Ru));

    builder
        .manage(PtyManager::default())
        .manage(WorkspaceRoots::default())
        .setup(|app| {
            spawn_title_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_create,
            list_shells,
            pty_write,
            pty_resize,
            pty_kill,
            workspace_reconcile_roots,
            workspace_register_root,
            workspace_validate_root,
            workspace_pick_root,
            workspace_unregister_root,
            app_set_locale
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
    fn friendly_name_unwraps_interpreters() {
        // codex как node-скрипт с shebang: kernel запускает `node <path>/codex`.
        assert_eq!(
            friendly_name("node", &["node", "/opt/homebrew/bin/codex"]),
            "codex"
        );
        // codex, выставивший process.title — argv[0] уже «codex».
        assert_eq!(friendly_name("node", &["codex", "--model", "gpt"]), "codex");
        // node-скрипт с расширением — режем .js.
        assert_eq!(friendly_name("node", &["node", "/app/dist/cli.js"]), "cli");
        // python -m: флаг пропускаем, берём модуль.
        assert_eq!(
            friendly_name("python3", &["python3", "-m", "http.server"]),
            "http.server"
        );
        // Обычный бинарник не трогаем.
        assert_eq!(friendly_name("vim", &["vim", "file.txt"]), "vim");
        // Логин-шелл «-zsh» → zsh.
        assert_eq!(friendly_name("-zsh", &["-zsh"]), "zsh");
        // Голый REPL интерпретатора остаётся собой.
        assert_eq!(friendly_name("node", &["node"]), "node");
    }

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

    #[test]
    fn app_locale_is_strict_and_picker_title_is_localized() {
        assert_eq!(
            AppLocale::parse("ru").unwrap().project_picker_title(),
            "Папка проекта для воркспейса"
        );
        assert_eq!(
            AppLocale::parse("en").unwrap().project_picker_title(),
            "Project folder for workspace"
        );

        let error = AppLocale::parse("ru-RU").unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidLocale);
        assert_eq!(error.context["locale"], "ru-RU");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_menu_titles_follow_app_locale() {
        assert_eq!(AppLocale::Ru.edit_menu_title(), "Правка");
        assert_eq!(AppLocale::Ru.window_menu_title(), "Окно");
        assert_eq!(AppLocale::En.edit_menu_title(), "Edit");
        assert_eq!(AppLocale::En.window_menu_title(), "Window");
    }
}
