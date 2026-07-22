// Без фичи `custom-protocol` tauri оставляет приложение в dev-режиме: окно
// грузит devUrl (http://localhost:1420), а в упакованном виде там никто не
// слушает — пользователь видит чёрный экран с «Connection refused». Обычно
// фичу включает CLI `tauri build`, поэтому голый `cargo build --release`
// молча собирал бы нерабочий пакет. Ловим это на компиляции.
#[cfg(all(not(debug_assertions), dev))]
compile_error!(
    "release build without the `custom-protocol` feature would load devUrl \
     instead of the embedded frontend — build through `tauri build`"
);

mod agent_sessions;
mod command_error;
mod git_changes;
mod github_auth;
#[cfg_attr(not(target_os = "linux"), allow(dead_code, unused_imports))]
mod linux_updater;
mod pty;
mod terminal_snapshots;
mod update_cache;
#[cfg(windows)]
mod win_proc;
mod workspace_roots;

use agent_sessions::agent_session_locate;
use command_error::{CommandError, CommandResult, ErrorCode};
use git_changes::{
    git_amend_commit, git_branches, git_changes_summary, git_changes_unwatch, git_changes_watch,
    git_commit, git_commit_action, git_commit_files, git_commit_patch, git_compare_file_diff,
    git_compare_files, git_create_branch, git_create_tag, git_delete_branch, git_delete_tag,
    git_drop_commit, git_fetch_upstream, git_file_diff, git_log, git_merge_ref, git_publish_branch,
    git_pull, git_pull_rebase, git_push, git_read_file, git_rebase_onto, git_rename_branch,
    git_reset_to_commit, git_reset_to_upstream, git_revert_file, git_reword_commit,
    git_save_commit_patch, git_squash_commit, git_switch_branch, git_write_file, GitWatchState,
};
use github_auth::{
    github_auth_available, github_commit_avatars, github_commit_url, github_current_user,
    github_device_poll, github_device_start, github_logout,
};
use linux_updater::{
    updater_install_linux_package, updater_install_target, updater_prepare_linux_package,
    LinuxUpdaterState,
};
use pty::{PtyManager, ShellInfo, SpawnOptions};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_dialog::DialogExt;
use terminal_snapshots::{
    terminal_snapshot_delete, terminal_snapshot_load, terminal_snapshot_save,
    terminal_snapshots_prune,
};
use update_cache::{updater_install_self_update, updater_prepare_self_update, SelfUpdaterState};
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
#[serde(rename_all = "camelCase")]
struct PtyCreateResult {
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

    fn tray_show_title(self) -> &'static str {
        match self {
            Self::Ru => "Показать ModelCrew",
            Self::En => "Show ModelCrew",
        }
    }

    fn tray_quit_title(self) -> &'static str {
        match self {
            Self::Ru => "Выход",
            Self::En => "Quit",
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

/// Имена процессов по PID из Toolhelp-снапшота (Windows). Агентские CLI на
/// Windows — нативные exe (claude.exe, codex.exe…), поэтому достаточно имени
/// файла без расширения; для node-шимов сработает откат friendly_name.
#[cfg(windows)]
fn process_names(pids: &[i32]) -> std::collections::HashMap<i32, String> {
    let mut names = std::collections::HashMap::new();
    if pids.is_empty() {
        return names;
    }
    for entry in win_proc::snapshot() {
        let pid = entry.pid as i32;
        if !pids.contains(&pid) {
            continue;
        }
        let stem = entry
            .name
            .strip_suffix(".exe")
            .or_else(|| entry.name.strip_suffix(".EXE"))
            .unwrap_or(&entry.name)
            .to_ascii_lowercase();
        let name = friendly_name(&stem, &[]);
        if !name.is_empty() {
            names.insert(pid, name);
        }
    }
    names
}

#[cfg(not(any(unix, windows)))]
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
    isolated_history: Option<bool>,
    on_output: Channel<InvokeResponseBody>,
) -> CommandResult<PtyCreateResult> {
    ensure_main_window(&window)?;
    let cwd = roots.resolve(&workspace_id)?;
    // Своя история команд у каждой панели (по умолчанию включено).
    let history_dir = if isolated_history.unwrap_or(true) {
        let home = app.path().home_dir().map_err(|error| {
            CommandError::new(ErrorCode::TerminalSnapshotStorageFailed).with_debug(error)
        })?;
        Some(terminal_snapshots::prepare_panel_history(
            &terminal_snapshots::history_base(&app)?,
            &id,
            &home,
        )?)
    } else {
        None
    };
    let exit_app = app.clone();
    let exit_id = id.clone();
    let shell = state.spawn(
        SpawnOptions {
            id,
            // Пусто/None — оболочка по умолчанию для ОС (см. default_shell).
            shell: shell.filter(|value| !value.trim().is_empty()),
            cwd,
            cols,
            rows,
            history_dir,
        },
        move |bytes| {
            let _ = on_output.send(InvokeResponseBody::Raw(bytes));
        },
        move |code| {
            // Снятие сессии из карты берёт на себя PtyManager (по epoch),
            // чтобы вытеснённый reload'ом терминал не «завершил» новый.
            let _ = exit_app.emit_to("main", "pty-exit", PtyExitPayload { id: exit_id, code });
        },
    )?;
    Ok(PtyCreateResult {
        title: friendly_name(&shell, &[]),
    })
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

/// Явно завершает все PTY перед установкой обновления. Раскладка к этому
/// моменту уже сохранена frontend-ом; команда не закрывает само окно, чтобы
/// updater мог завершить установку и контролируемый relaunch.
#[tauri::command]
fn pty_kill_all(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PtyManager>,
) -> CommandResult<()> {
    ensure_main_window(&window)?;
    state.kill_all()
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

// Бейдж непрочитанного на иконке приложения: счётчик в Dock (macOS) и на
// иконках доков Linux; на Windows числовых бейджей нет — красная точка
// поверх иконки в панели задач.
#[tauri::command]
fn app_set_badge(window: tauri::WebviewWindow, count: Option<i64>) -> CommandResult<()> {
    ensure_main_window(&window)?;
    let count = count.filter(|value| *value > 0);

    #[cfg(target_os = "windows")]
    {
        let icon = count.map(|_| {
            const SIZE: usize = 32;
            let mut rgba = vec![0_u8; SIZE * SIZE * 4];
            let center = (SIZE as f32 - 1.0) / 2.0;
            for y in 0..SIZE {
                for x in 0..SIZE {
                    let dx = x as f32 - center;
                    let dy = y as f32 - center;
                    if (dx * dx + dy * dy).sqrt() <= center {
                        let index = (y * SIZE + x) * 4;
                        rgba[index] = 0xe0;
                        rgba[index + 1] = 0x4c;
                        rgba[index + 2] = 0x4c;
                        rgba[index + 3] = 0xff;
                    }
                }
            }
            tauri::image::Image::new_owned(rgba, SIZE as u32, SIZE as u32)
        });
        window.set_overlay_icon(icon).map_err(|error| {
            CommandError::new(ErrorCode::AppBadgeUpdateFailed).with_debug(error)
        })?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        window.set_badge_count(count).map_err(|error| {
            CommandError::new(ErrorCode::AppBadgeUpdateFailed).with_debug(error)
        })?;
    }
    Ok(())
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

#[cfg(desktop)]
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// Трей на всех десктопах: логотип приложения в системном лотке, меню
// «Показать/Выход», клик ЛКМ разворачивает спрятанное окно.
#[cfg(desktop)]
fn setup_tray<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let locale = AppLocale::Ru;
    let show = MenuItem::with_id(
        app,
        "tray_show",
        locale.tray_show_title(),
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "tray_quit",
        locale.tray_quit_title(),
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("ModelCrew")
        .menu(&menu)
        // Меню — по правой кнопке (на macOS по клику), ЛКМ разворачивает окно.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_show" => show_main_window(app),
            "tray_quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// WebKitGTK 2.42+ рисует окно через DMABUF. На части Linux-систем (в первую
// очередь Arch с системным WebKitGTK) этот путь даёт полностью чёрное окно:
// процесс жив, но ни один кадр не доходит до экрана. Отключаем DMABUF до
// инициализации WebKit — иначе переменную он уже не прочитает. Явное значение
// пользователя не трогаем: на исправных системах DMABUF быстрее.
#[cfg(target_os = "linux")]
fn disable_dmabuf_renderer_by_default() {
    const KEY: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    // Вызывается первой строкой run(), до старта любых потоков, поэтому гонки
    // за окружение здесь нет.
    match dmabuf_choice(std::env::var(KEY).ok().as_deref()) {
        DmabufChoice::Disable => std::env::set_var(KEY, "1"),
        DmabufChoice::Restore => std::env::remove_var(KEY),
        DmabufChoice::Keep => {}
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
enum DmabufChoice {
    Disable,
    Restore,
    Keep,
}

// WebKit смотрит на само наличие переменной, а не на её значение: оставленный
// `=0` отключил бы DMABUF ровно так же, как `=1`. Поэтому «верни как было»
// можно выразить только удалением переменной.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn dmabuf_choice(current: Option<&str>) -> DmabufChoice {
    match current {
        None => DmabufChoice::Disable,
        Some(value) if matches!(value.trim(), "" | "0" | "false") => DmabufChoice::Restore,
        Some(_) => DmabufChoice::Keep,
    }
}

pub fn run() {
    #[cfg(target_os = "linux")]
    disable_dmabuf_renderer_by_default();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            spawn_title_watcher(app.handle().clone());
            #[cfg(desktop)]
            setup_tray(app)?;
            Ok(())
        });

    // На macOS Tauri ставит дефолтное меню, чей пункт Close Window съедает
    // Cmd+W раньше веб-вью. Собираем своё меню без Close/New, оставляя
    // системные роли редактирования — без них в веб-вью не работают Cmd+C/V/A.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|handle| build_macos_menu(handle, AppLocale::Ru));

    builder
        .on_window_event(|window, event| {
            // Закрытие окна не выходит из приложения — прячем в трей (фон).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .manage(PtyManager::default())
        .manage(WorkspaceRoots::default())
        .manage(LinuxUpdaterState::default())
        .manage(SelfUpdaterState::default())
        .manage(GitWatchState::default())
        .invoke_handler(tauri::generate_handler![
            pty_create,
            list_shells,
            pty_write,
            pty_resize,
            pty_kill,
            pty_kill_all,
            terminal_snapshot_save,
            terminal_snapshot_load,
            terminal_snapshot_delete,
            terminal_snapshots_prune,
            agent_session_locate,
            git_changes_summary,
            git_file_diff,
            git_changes_watch,
            git_changes_unwatch,
            git_commit,
            git_revert_file,
            git_read_file,
            git_write_file,
            git_branches,
            git_switch_branch,
            git_create_branch,
            git_rename_branch,
            git_delete_branch,
            git_log,
            git_commit_files,
            git_fetch_upstream,
            git_pull,
            git_push,
            git_pull_rebase,
            git_reset_to_upstream,
            git_commit_action,
            git_amend_commit,
            git_reset_to_commit,
            git_squash_commit,
            git_drop_commit,
            git_create_tag,
            git_delete_tag,
            git_commit_patch,
            git_compare_files,
            git_compare_file_diff,
            git_merge_ref,
            git_rebase_onto,
            git_publish_branch,
            git_save_commit_patch,
            github_commit_url,
            git_reword_commit,
            workspace_reconcile_roots,
            workspace_register_root,
            workspace_validate_root,
            workspace_pick_root,
            workspace_unregister_root,
            app_set_locale,
            app_set_badge,
            github_auth_available,
            github_device_start,
            github_device_poll,
            github_current_user,
            github_logout,
            github_commit_avatars,
            updater_install_target,
            updater_prepare_linux_package,
            updater_install_linux_package,
            updater_prepare_self_update,
            updater_install_self_update
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Гарантированная уборка шеллов при любом пути выхода — иначе зомби.
            RunEvent::Exit => {
                let _ = app.state::<PtyManager>().kill_all();
            }
            // Клик по иконке в доке (macOS) при спрятанном окне — вернуть его.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main_window(app),
            _ => {}
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
        // pty_create получает полный путь фактически запущенной оболочки.
        assert_eq!(friendly_name("/bin/zsh", &[]), "zsh");
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

#[cfg(test)]
mod dmabuf_tests {
    use super::{dmabuf_choice, DmabufChoice};

    #[test]
    fn dmabuf_workaround_can_be_turned_off_by_the_user() {
        assert_eq!(dmabuf_choice(None), DmabufChoice::Disable);
        // Явный отказ от обхода: переменную надо убрать, а не оставить «0».
        for value in ["0", "false", "", "  "] {
            assert_eq!(dmabuf_choice(Some(value)), DmabufChoice::Restore, "{value:?}");
        }
        for value in ["1", "true", "yes"] {
            assert_eq!(dmabuf_choice(Some(value)), DmabufChoice::Keep, "{value:?}");
        }
    }
}
