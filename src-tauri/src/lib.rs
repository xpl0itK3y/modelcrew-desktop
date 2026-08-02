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

mod agent_hooks;
mod agent_sessions;
mod clipboard_images;
mod command_error;
mod crew;
mod git_branches;
mod git_changes;
mod git_history;
mod git_log;
mod git_sync;
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
use clipboard_images::terminal_clipboard_image_save;
use command_error::{CommandError, CommandResult, ErrorCode};
use crew::crew_claims;
use git_branches::{
    git_branches, git_create_branch, git_delete_branch, git_merge_ref, git_rebase_onto,
    git_rename_branch, git_switch_branch,
};
use git_changes::{
    git_changes_summary, git_changes_unwatch, git_changes_watch, git_commit, git_file_diff,
    git_read_file, git_revert_file, git_write_file, GitWatchState,
};
use git_history::{
    git_amend_commit, git_commit_action, git_commit_patch, git_compare_file_diff,
    git_compare_files, git_create_tag, git_delete_tag, git_drop_commit, git_reset_to_commit,
    git_reword_commit, git_save_commit_patch, git_squash_commit,
};
use git_log::{git_commit_file_diff, git_commit_files, git_log};
use git_sync::{
    git_fetch_upstream, git_publish_branch, git_pull, git_pull_rebase, git_push,
    git_reset_to_upstream,
};
use github_auth::{
    github_auth_available, github_commit_avatars, github_commit_url, github_current_user,
    github_device_poll, github_device_start, github_logout,
};
use linux_updater::{
    updater_install_linux_package, updater_install_target, updater_prepare_linux_package,
    LinuxUpdaterState,
};
use pty::{GitBashAvailability, PtyManager, ShellInfo, SpawnOptions};
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

// Аргументы приходят от веб-вью по одному: четыре первых Tauri подставляет
// сам, остальные — параметры вызова. Свернуть их в структуру значит поменять
// контракт IPC ради тишины линтера, а сигнатуру команды всё равно сторожит
// отдельный тест.
#[allow(clippy::too_many_arguments)]
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
fn git_bash_status(window: tauri::WebviewWindow) -> CommandResult<GitBashAvailability> {
    ensure_main_window(&window)?;
    Ok(pty::git_bash_availability())
}

#[tauri::command]
async fn git_bash_install(window: tauri::WebviewWindow) -> CommandResult<ShellInfo> {
    ensure_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(pty::install_git_bash)
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitBashInstallFailed).with_debug(error))?
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
// иконках доков Linux (KDE, GNOME с доком, Cinnamon, Unity); на Windows
// числовых бейджей нет — красная точка поверх иконки в панели задач.
#[tauri::command]
fn app_set_badge(window: tauri::WebviewWindow, count: Option<i64>) -> CommandResult<()> {
    ensure_main_window(&window)?;
    let count = count.filter(|value| *value > 0);

    #[cfg(target_os = "windows")]
    {
        let icon = count.map(|value| {
            let rgba = draw_badge_overlay(&badge_text(value));
            tauri::image::Image::new_owned(rgba, BADGE_SIZE as u32, BADGE_SIZE as u32)
        });
        window.set_overlay_icon(icon).map_err(|error| {
            CommandError::new(ErrorCode::AppBadgeUpdateFailed).with_debug(error)
        })?;
    }

    #[cfg(target_os = "macos")]
    {
        window.set_badge_count(count).map_err(|error| {
            CommandError::new(ErrorCode::AppBadgeUpdateFailed).with_debug(error)
        })?;
    }

    // На Linux Tauri зовёт libunity и молчит, если Unity не запущен, — на KDE и
    // GNOME значка нет. Шлём тот же сигнал сами: его слушают все популярные
    // доки. Значок цепляется к нашему .desktop по productName.
    #[cfg(target_os = "linux")]
    {
        let desktop = window
            .app_handle()
            .config()
            .product_name
            .clone()
            .unwrap_or_else(|| "ModelCrew".to_string());
        emit_unity_badge(count, badge_app_uri(&desktop));
    }

    Ok(())
}

// Windows не рисует числовые бейджи сам, поэтому оверлей-иконку в углу значка
// на панели задач мы рисуем вручную. Число — как в вебе: до 9, дальше «9+».
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn badge_text(count: i64) -> String {
    if count > 9 {
        "9+".to_string()
    } else {
        count.to_string()
    }
}

// Размер оверлея. Windows показывает его крошечным в углу, поэтому мельчить
// незачем — берём кратно шрифту (5×7), чтобы цифры оставались чёткими.
#[cfg(target_os = "windows")]
const BADGE_SIZE: usize = 32;

// Пиксельный шрифт 5×7 для цифр и «+»: подключать настоящий шрифт ради
// одного-двух знаков — лишняя зависимость и путь к файлу в рантайме.
#[cfg(target_os = "windows")]
fn badge_glyph(symbol: char) -> [u8; 7] {
    match symbol {
        '0' => [
            0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
        ],
        '1' => [
            0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ],
        '2' => [
            0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
        ],
        '3' => [
            0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110,
        ],
        '4' => [
            0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
        ],
        '5' => [
            0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110,
        ],
        '6' => [
            0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
        ],
        '7' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
        ],
        '8' => [
            0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
        ],
        '9' => [
            0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100,
        ],
        '+' => [
            0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000,
        ],
        _ => [0; 7],
    }
}

// Красный кружок с белым числом по центру, RGBA. Масштаб шрифта подбираем так,
// чтобы надпись целиком помещалась в круг с полями.
#[cfg(target_os = "windows")]
fn draw_badge_overlay(text: &str) -> Vec<u8> {
    const GLYPH_W: usize = 5;
    const GLYPH_H: usize = 7;
    const GAP: usize = 1;
    let mut rgba = vec![0_u8; BADGE_SIZE * BADGE_SIZE * 4];
    let center = (BADGE_SIZE as f32 - 1.0) / 2.0;

    // Красный круг во всю иконку.
    for y in 0..BADGE_SIZE {
        for x in 0..BADGE_SIZE {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            if (dx * dx + dy * dy).sqrt() <= center {
                let index = (y * BADGE_SIZE + x) * 4;
                rgba[index] = 0xe0;
                rgba[index + 1] = 0x4c;
                rgba[index + 2] = 0x4c;
                rgba[index + 3] = 0xff;
            }
        }
    }

    let glyphs: Vec<[u8; 7]> = text.chars().map(badge_glyph).collect();
    if glyphs.is_empty() {
        return rgba;
    }
    let cells = glyphs.len() * GLYPH_W + (glyphs.len() - 1) * GAP;
    // Самый крупный масштаб, при котором надпись влезает в ~70% ширины круга.
    let budget = (BADGE_SIZE as f32 * 0.7) as usize;
    let scale = (budget / cells).min(budget / GLYPH_H).max(1);
    let text_w = cells * scale;
    let text_h = GLYPH_H * scale;
    let start_x = (BADGE_SIZE - text_w) / 2;
    let start_y = (BADGE_SIZE - text_h) / 2;

    let mut pen_x = start_x;
    for glyph in glyphs {
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..GLYPH_W {
                // Скобки обязательны: у `&` приоритет ниже, чем у `==`.
                if (*bits & (1u8 << (GLYPH_W - 1 - col))) == 0 {
                    continue;
                }
                // Один «пиксель» шрифта — квадрат scale×scale белым.
                for sy in 0..scale {
                    for sx in 0..scale {
                        let px = pen_x + col * scale + sx;
                        let py = start_y + row * scale + sy;
                        if px < BADGE_SIZE && py < BADGE_SIZE {
                            let index = (py * BADGE_SIZE + px) * 4;
                            rgba[index] = 0xff;
                            rgba[index + 1] = 0xff;
                            rgba[index + 2] = 0xff;
                            rgba[index + 3] = 0xff;
                        }
                    }
                }
            }
        }
        pen_x += (GLYPH_W + GAP) * scale;
    }
    rgba
}

// URI приложения для сигнала Unity: имя установленного .desktop-файла.
#[cfg(target_os = "linux")]
fn badge_app_uri(product_name: &str) -> String {
    format!("application://{product_name}.desktop")
}

// Широковещательный сигнал com.canonical.Unity.LauncherEntry.Update — тот же,
// что шлёт libunity, но без её проверки «запущен ли Unity», из-за которой
// значок не появлялся на KDE/GNOME. Отправка — из отдельного потока: zbus
// блокирует, а внутри tokio-рантайма Tauri это паникует; значок best-effort,
// ждать его незачем.
#[cfg(target_os = "linux")]
fn emit_unity_badge(count: Option<i64>, app_uri: String) {
    std::thread::spawn(move || {
        if let Err(error) = send_unity_badge(count, &app_uri) {
            log::debug!("unity launcher badge: {error}");
        }
    });
}

#[cfg(target_os = "linux")]
fn send_unity_badge(count: Option<i64>, app_uri: &str) -> Result<(), zbus::Error> {
    use std::collections::HashMap;
    use zbus::blocking::Connection;
    use zbus::zvariant::Value;

    let mut properties: HashMap<&str, Value> = HashMap::new();
    properties.insert("count", Value::I64(count.unwrap_or(0)));
    properties.insert("count-visible", Value::Bool(count.is_some()));

    Connection::session()?.emit_signal(
        None::<&str>,
        "/com/canonical/unity/launcherentry/modelcrew",
        "com.canonical.Unity.LauncherEntry",
        "Update",
        &(app_uri, properties),
    )
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

    // Окно закрывается в трей, а не завершает приложение. Без защиты от второго
    // экземпляра каждый повторный запуск поднимал бы ещё один процесс со своей
    // иконкой в трее — пользователь получал бы их пачку, не понимая откуда.
    // Плагин должен идти первым: он перехватывает запуск до создания окна.
    // macOS не даёт запустить вторую копию сам, поэтому там он не нужен.
    let builder = tauri::Builder::default();
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        show_main_window(app);
    }));

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            spawn_title_watcher(app.handle().clone());
            agent_hooks::install(app.handle());
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
        .manage(crew::CrewRegistry::default())
        .invoke_handler(tauri::generate_handler![
            pty_create,
            list_shells,
            git_bash_status,
            git_bash_install,
            pty_write,
            pty_resize,
            pty_kill,
            pty_kill_all,
            terminal_snapshot_save,
            terminal_snapshot_load,
            terminal_snapshot_delete,
            terminal_snapshots_prune,
            terminal_clipboard_image_save,
            agent_session_locate,
            crew_claims,
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
            git_commit_file_diff,
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

    const LIB_RS: &str = include_str!("lib.rs");
    const CAPABILITY_JSON: &str = include_str!("../capabilities/default.json");
    const TAURI_CONF_JSON: &str = include_str!("../tauri.conf.json");
    const COMMAND_ATTRIBUTE: &str = "#[tauri::command]";

    // Все модули бэкенда. Полнота списка проверяется отдельным тестом по
    // объявлениям `mod` — иначе новый модуль с командами тихо выпал бы из
    // проверок ниже.
    const MODULE_SOURCES: &[(&str, &str)] = &[
        ("lib.rs", LIB_RS),
        ("agent_hooks.rs", include_str!("agent_hooks.rs")),
        ("agent_sessions.rs", include_str!("agent_sessions.rs")),
        ("clipboard_images.rs", include_str!("clipboard_images.rs")),
        ("command_error.rs", include_str!("command_error.rs")),
        ("crew.rs", include_str!("crew.rs")),
        ("git_branches.rs", include_str!("git_branches.rs")),
        ("git_changes.rs", include_str!("git_changes.rs")),
        ("git_history.rs", include_str!("git_history.rs")),
        ("git_log.rs", include_str!("git_log.rs")),
        ("git_sync.rs", include_str!("git_sync.rs")),
        ("github_auth.rs", include_str!("github_auth.rs")),
        ("linux_updater.rs", include_str!("linux_updater.rs")),
        ("pty.rs", include_str!("pty.rs")),
        (
            "terminal_snapshots.rs",
            include_str!("terminal_snapshots.rs"),
        ),
        ("update_cache.rs", include_str!("update_cache.rs")),
        ("win_proc.rs", include_str!("win_proc.rs")),
        ("workspace_roots.rs", include_str!("workspace_roots.rs")),
    ];

    // Полный список команд, доступных веб-вью. Снимок, а не вычисление:
    // добавление команды обязано быть отдельной осознанной правкой теста.
    const EXPECTED_COMMANDS: &[&str] = &[
        "agent_session_locate",
        "app_set_badge",
        "app_set_locale",
        "crew_claims",
        "git_amend_commit",
        "git_bash_install",
        "git_bash_status",
        "git_branches",
        "git_changes_summary",
        "git_changes_unwatch",
        "git_changes_watch",
        "git_commit",
        "git_commit_action",
        "git_commit_file_diff",
        "git_commit_files",
        "git_commit_patch",
        "git_compare_file_diff",
        "git_compare_files",
        "git_create_branch",
        "git_create_tag",
        "git_delete_branch",
        "git_delete_tag",
        "git_drop_commit",
        "git_fetch_upstream",
        "git_file_diff",
        "git_log",
        "git_merge_ref",
        "git_publish_branch",
        "git_pull",
        "git_pull_rebase",
        "git_push",
        "git_read_file",
        "git_rebase_onto",
        "git_rename_branch",
        "git_reset_to_commit",
        "git_reset_to_upstream",
        "git_revert_file",
        "git_reword_commit",
        "git_save_commit_patch",
        "git_squash_commit",
        "git_switch_branch",
        "git_write_file",
        "github_auth_available",
        "github_commit_avatars",
        "github_commit_url",
        "github_current_user",
        "github_device_poll",
        "github_device_start",
        "github_logout",
        "list_shells",
        "pty_create",
        "pty_kill",
        "pty_kill_all",
        "pty_resize",
        "pty_write",
        "terminal_clipboard_image_save",
        "terminal_snapshot_delete",
        "terminal_snapshot_load",
        "terminal_snapshot_save",
        "terminal_snapshots_prune",
        "updater_install_linux_package",
        "updater_install_self_update",
        "updater_install_target",
        "updater_prepare_linux_package",
        "updater_prepare_self_update",
        "workspace_pick_root",
        "workspace_reconcile_roots",
        "workspace_register_root",
        "workspace_unregister_root",
        "workspace_validate_root",
    ];

    struct IpcCommand {
        module: &'static str,
        name: String,
        signature: String,
        body: String,
    }

    /// Исходник модуля без его собственного `mod tests`: иначе строковые
    /// литералы из проверок ниже находили бы сами себя.
    fn production_source(source: &str) -> &str {
        source.split("#[cfg(test)]").next().unwrap()
    }

    /// Разбор `#[tauri::command]` по исходникам: имя, сигнатура и тело до
    /// закрывающей скобки на нулевом отступе (весь код прогнан rustfmt).
    fn ipc_commands() -> Vec<IpcCommand> {
        let mut commands = Vec::new();
        for (module, source) in MODULE_SOURCES.iter() {
            let lines: Vec<&str> = source.lines().collect();
            let mut index = 0;
            while index < lines.len() {
                if lines[index].trim() != COMMAND_ATTRIBUTE {
                    index += 1;
                    continue;
                }
                let mut cursor = index + 1;
                // Между атрибутом команды и fn могут стоять #[cfg(...)].
                while cursor < lines.len() && lines[cursor].trim_start().starts_with("#[") {
                    cursor += 1;
                }
                let name = lines
                    .get(cursor)
                    .and_then(|line| line.split("fn ").nth(1))
                    .and_then(|rest| rest.split('(').next())
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let mut signature = String::new();
                while cursor < lines.len() {
                    signature.push_str(lines[cursor]);
                    signature.push('\n');
                    if lines[cursor].trim_end().ends_with('{') {
                        break;
                    }
                    cursor += 1;
                }
                cursor += 1;
                let mut body = String::new();
                while cursor < lines.len() && lines[cursor] != "}" {
                    body.push_str(lines[cursor]);
                    body.push('\n');
                    cursor += 1;
                }
                commands.push(IpcCommand {
                    module,
                    name,
                    signature,
                    body,
                });
                index = cursor + 1;
            }
        }
        commands
    }

    fn command_body(name: &str) -> String {
        ipc_commands()
            .into_iter()
            .find(|command| command.name == name)
            .unwrap_or_else(|| panic!("{name} is no longer an IPC command"))
            .body
    }

    /// Тело функции верхнего уровня по началу её сигнатуры.
    fn function_body(source: &str, signature_start: &str) -> String {
        // include_str! читает checkout как есть; Windows Git обычно оставляет
        // здесь CRLF. Нормализуем только тестовую копию исходника, чтобы
        // security-проверка тела функции была одинаковой на всех раннерах.
        let source = source.replace("\r\n", "\n");
        let after = source
            .split_once(signature_start)
            .unwrap_or_else(|| panic!("{signature_start} is gone"))
            .1;
        after
            .split_once("\n}\n")
            .unwrap_or_else(|| panic!("{signature_start} has no closing brace"))
            .0
            .to_string()
    }

    fn csp_directives(csp: &str) -> std::collections::BTreeMap<&str, Vec<&str>> {
        csp.split(';')
            .filter_map(|directive| {
                let mut tokens = directive.split_whitespace();
                let name = tokens.next()?;
                Some((name, tokens.collect::<Vec<_>>()))
            })
            .collect()
    }

    #[test]
    fn ensure_main_window_matches_the_label_exactly() {
        let body = function_body(LIB_RS, "fn ensure_main_window(");

        // Единственная допустимая проверка — точное равенство: с
        // `starts_with` окно с меткой «main-2» или «mainx» прошло бы охрану.
        assert!(
            body.contains("window.label() == \"main\""),
            "ensure_main_window no longer compares the label exactly: {body}"
        );
        for loose in [
            "starts_with",
            "ends_with",
            "contains",
            "to_lowercase",
            "to_uppercase",
            "trim",
            "!=",
        ] {
            assert!(
                !body.contains(loose),
                "ensure_main_window matches the label loosely via {loose}: {body}"
            );
        }
        assert!(body.contains("ErrorCode::MainWindowOnly"), "{body}");

        // Код отказа — часть контракта IPC: фронт по нему различает «не то
        // окно» и настоящую ошибку операции.
        assert_eq!(
            serde_json::to_value(CommandError::new(ErrorCode::MainWindowOnly)).unwrap(),
            serde_json::json!({ "code": "main_window_only" })
        );
    }

    #[test]
    fn every_ipc_command_is_restricted_to_the_main_window() {
        // Единственные команды без охраны: список установленных оболочек и
        // «собран ли OAuth-клиент». Ни одна ничего не читает, не пишет и не
        // запускает. Третья запись здесь — сознательная правка, а не случай.
        const UNGUARDED: &[&str] = &["github_auth_available", "list_shells"];

        let commands = ipc_commands();
        assert_eq!(
            commands.len(),
            EXPECTED_COMMANDS.len(),
            "the source scan missed some commands"
        );

        let unguarded: Vec<String> = commands
            .iter()
            .filter(|command| !command.body.contains("ensure_main_window(&window)"))
            .map(|command| format!("{}::{}", command.module, command.name))
            .collect();
        let expected: Vec<String> = commands
            .iter()
            .filter(|command| UNGUARDED.contains(&command.name.as_str()))
            .map(|command| format!("{}::{}", command.module, command.name))
            .collect();

        assert_eq!(expected.len(), UNGUARDED.len(), "stale allowlist entry");
        assert_eq!(
            unguarded.join("\n"),
            expected.join("\n"),
            "a command reachable from a non-main webview window"
        );

        // Охрана должна стоять до любой работы: первая исполняемая строка
        // (локальные `use` и комментарии кода не выполняют).
        for command in &commands {
            if UNGUARDED.contains(&command.name.as_str()) {
                continue;
            }
            let first = command
                .body
                .lines()
                .map(str::trim)
                .find(|line| {
                    !line.is_empty() && !line.starts_with("//") && !line.starts_with("use ")
                })
                .unwrap_or_default();
            assert!(
                first.contains("ensure_main_window(&window)?"),
                "{}::{} does something before checking the window: {first}",
                command.module,
                command.name
            );
        }
    }

    #[test]
    fn the_registered_command_surface_is_pinned() {
        let list = production_source(LIB_RS)
            .split_once("tauri::generate_handler![")
            .expect("invoke handler is gone")
            .1
            .split_once(']')
            .expect("unterminated invoke handler")
            .0;
        let mut registered: Vec<&str> = list
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect();
        registered.sort_unstable();

        assert_eq!(
            registered.join("\n"),
            EXPECTED_COMMANDS.join("\n"),
            "the IPC surface exposed to the webview changed"
        );

        // Обратная сторона: команда, объявленная, но не зарегистрированная,
        // — мёртвый код, который легко «оживить» одной строкой.
        let mut defined: Vec<String> = ipc_commands()
            .into_iter()
            .map(|command| command.name)
            .collect();
        defined.sort();
        assert_eq!(defined.join("\n"), EXPECTED_COMMANDS.join("\n"));
    }

    #[test]
    fn the_ipc_scan_covers_every_backend_module() {
        let mut declared: Vec<String> = production_source(LIB_RS)
            .lines()
            .map(str::trim)
            .filter_map(|line| {
                let name = line.strip_prefix("mod ")?.strip_suffix(';')?;
                Some(format!("{name}.rs"))
            })
            .collect();
        declared.push("lib.rs".to_string());
        declared.sort();

        let mut scanned: Vec<String> = MODULE_SOURCES
            .iter()
            .map(|(module, _)| (*module).to_string())
            .collect();
        scanned.sort();

        assert_eq!(
            scanned.join("\n"),
            declared.join("\n"),
            "a backend module is not covered by the IPC source scan"
        );
    }

    #[test]
    fn commands_reach_the_disk_only_through_workspace_roots() {
        // Команды жизненного цикла реестра: они и есть привязка/отвязка, а
        // git_changes_unwatch только снимает вотчер и к диску не ходит.
        const REGISTRY_LIFECYCLE: &[&str] = &[
            "git_changes_unwatch",
            "workspace_pick_root",
            "workspace_register_root",
            "workspace_unregister_root",
        ];

        let commands = ipc_commands();
        for command in &commands {
            if !command.signature.contains("workspace_id: String")
                || REGISTRY_LIFECYCLE.contains(&command.name.as_str())
            {
                continue;
            }
            assert!(
                command.body.contains("roots.resolve(&workspace_id)")
                    || command.body.contains("state.resolve(&workspace_id)"),
                "{}::{} uses a workspace id without resolving it through WorkspaceRoots",
                command.module,
                command.name
            );
        }

        // Ни одна команда в lib.rs, кроме привязки корня, не принимает путь
        // от веб-вью: cwd терминала берётся только из реестра.
        let with_raw_paths: Vec<&str> = commands
            .iter()
            .filter(|command| command.module == "lib.rs")
            .filter(|command| {
                command.signature.contains("path: String")
                    || command.signature.contains("cwd: String")
                    || command.signature.contains("PathBuf")
            })
            .map(|command| command.name.as_str())
            .collect();
        assert_eq!(with_raw_paths, ["workspace_register_root"]);

        // pty_create получает cwd из реестра, а не из аргументов.
        let pty_create_body = command_body("pty_create");
        assert!(
            pty_create_body.contains("roots.resolve(&workspace_id)?"),
            "{pty_create_body}"
        );
    }

    #[test]
    fn pty_events_are_delivered_only_to_the_main_window() {
        // Вывод терминала и заголовки панелей — самый чувствительный поток:
        // широковещательный emit доставил бы его любому будущему веб-вью.
        let dense: String = production_source(LIB_RS)
            .chars()
            .filter(|symbol| !symbol.is_whitespace())
            .collect();
        let broadcast = format!(".{}(", "emit");
        assert!(
            !dense.contains(&broadcast),
            "lib.rs broadcasts an event to every window"
        );
        assert_eq!(
            dense.matches("emit_to(").count(),
            dense.matches("emit_to(\"main\",").count(),
            "an event is emitted to a window other than main"
        );
    }

    #[test]
    fn app_locale_rejects_hostile_locale_strings() {
        // Локаль уходит в заголовок нативного диалога выбора папки и в сборку
        // меню macOS, поэтому принимаются ровно два известных значения.
        for locale in [
            "",
            " ",
            "RU",
            "EN",
            "ru ",
            " ru",
            "ru\n",
            "ru\u{0}",
            "ru-RU",
            "en_US",
            "../../../etc/passwd",
            "/etc/passwd",
            "..\\..\\windows\\system32",
            "ru; rm -rf /",
            "\u{1b}]0;pwn\u{7}",
            "\u{202e}ne",
            "рус",
            "en\u{200b}",
        ] {
            let error = AppLocale::parse(locale).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidLocale, "{locale:?}");
            assert_eq!(error.context["locale"], locale, "{locale:?}");
        }

        let absurd = "e".repeat(4096);
        let error = AppLocale::parse(&absurd).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidLocale);
        assert_eq!(error.context["locale"].len(), 4096);

        assert_eq!(AppLocale::parse("ru").unwrap(), AppLocale::Ru);
        assert_eq!(AppLocale::parse("en").unwrap(), AppLocale::En);
    }

    #[test]
    fn an_already_open_folder_is_never_reported_as_a_fresh_binding() {
        // Папка уже открыта другим воркспейсом: фронт обязан увидеть чужой id,
        // иначе два воркспейса разделили бы один корень и его git-состояние.
        let value = serde_json::to_value(WorkspaceRootResult::from(BindOutcome::AlreadyOpen(
            WorkspaceRootBinding {
                workspace_id: "workspace-owner".into(),
                path: "/projects/secret".into(),
            },
        )))
        .unwrap();
        assert_eq!(value["status"], "alreadyOpen");
        assert_eq!(value["workspaceId"], "workspace-owner");

        // Отменённый выбор не отдаёт путь наружу вообще.
        let cancelled = serde_json::to_value(WorkspaceRootResult::Cancelled).unwrap();
        assert_eq!(cancelled, serde_json::json!({ "status": "cancelled" }));
    }

    #[test]
    fn friendly_name_never_leaks_a_path_or_a_flag_into_the_panel_title() {
        // comm и argv приходят из чужого процесса — его мог запустить код из
        // открытого репозитория, а имя становится подписью панели.
        let hostile: Vec<(&str, Vec<&str>)> = vec![
            ("/usr/bin/evil", vec![]),
            ("node", vec!["node", "/etc/../etc/passwd"]),
            ("node", vec!["node", "/"]),
            ("node", vec!["node", "--inspect=0.0.0.0:9229"]),
            ("-node", vec!["-node"]),
            ("---", vec!["---"]),
            ("node", vec!["node", "C:\\Windows\\System32\\cmd.exe"]),
            ("python3.13", vec!["python3.13", "-m", "http.server"]),
            ("node", vec!["node", ".js"]),
            ("node", vec!["node", "/tmp/пример.js"]),
        ];
        for (comm, argv) in hostile {
            let name = friendly_name(comm, &argv);
            assert!(
                !name.contains('/') && !name.contains('\\'),
                "{comm:?} {argv:?} -> {name:?} leaks a path"
            );
            assert!(
                !name.starts_with('-'),
                "{comm:?} {argv:?} -> {name:?} starts with a flag dash"
            );
        }

        assert_eq!(
            friendly_name("node", &["node", "/etc/../etc/passwd"]),
            "passwd"
        );
        assert_eq!(
            friendly_name("node", &["node", "C:\\Windows\\System32\\cmd.exe"]),
            "cmd.exe"
        );
        // Расширение не срезается в пустоту — панель не должна остаться без
        // подписи из-за процесса, названного «.js».
        assert_eq!(friendly_name("node", &["node", ".js"]), ".js");
        // Флаг интерпретатора не становится заголовком.
        assert_eq!(
            friendly_name("node", &["node", "--inspect=0.0.0.0:9229"]),
            "node"
        );
        // Многобайтовое имя произвольной длины: режем по символам, не по байтам.
        let huge = format!("/tmp/{}.js", "п".repeat(4096));
        assert_eq!(
            friendly_name("node", &["node", huge.as_str()]),
            "п".repeat(4096)
        );
    }

    #[test]
    fn a_hostile_badge_count_never_reaches_the_native_renderer() {
        // count приходит из веб-вью как i64. Отрицательные и ноль гасят бейдж,
        // иначе badge_text(-1) дал бы многознаковую надпись, а на Windows —
        // отрисовку '-' по нулевой битовой маске глифа.
        let body = command_body("app_set_badge");
        assert!(
            body.contains("count.filter(|value| *value > 0)"),
            "app_set_badge no longer drops non-positive counts: {body}"
        );
    }

    #[test]
    fn the_capability_allowlist_stays_minimal() {
        let capability: serde_json::Value = serde_json::from_str(CAPABILITY_JSON).unwrap();

        assert_eq!(capability["windows"], serde_json::json!(["main"]));

        // Точный список: любая новая привилегия должна пройти через правку
        // теста, потому что capability обходит охрану #[tauri::command].
        let permissions: Vec<&str> = capability["permissions"]
            .as_array()
            .expect("permissions must be an array")
            .iter()
            .map(|value| value.as_str().expect("permission must be a string"))
            .collect();
        assert_eq!(
            permissions,
            [
                "core:default",
                "core:window:allow-start-dragging",
                "core:window:allow-set-background-color",
                "core:window:allow-set-theme",
                "opener:default",
                "dialog:default",
                "notification:default",
                "updater:allow-check",
                "updater:allow-download",
                "updater:allow-install",
                "process:allow-restart",
            ]
        );
        for permission in &permissions {
            for forbidden in ["fs:", "shell:", "http:", "allow-execute", "webview-window"] {
                assert!(
                    !permission.contains(forbidden),
                    "{permission} grants the webview direct {forbidden} reach"
                );
            }
        }

        // Второй файл в каталоге — ещё одна capability, которую никто не
        // проверяет: Tauri применяет их все.
        let mut files: Vec<String> = std::fs::read_dir(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities"),
        )
        .expect("capabilities directory")
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| {
            name.ends_with(".json") || name.ends_with(".json5") || name.ends_with(".toml")
        })
        .collect();
        files.sort();
        assert_eq!(files, ["default.json"]);
    }

    #[test]
    fn the_release_csp_stays_locked_down() {
        let config: serde_json::Value = serde_json::from_str(TAURI_CONF_JSON).unwrap();
        let security = &config["app"]["security"];

        // Никаких dangerous*-ключей: они снимают CSP или открывают IPC чужим
        // origin'ам.
        let mut keys: Vec<&str> = security
            .as_object()
            .expect("app.security must exist")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["csp", "devCsp"]);
        assert!(config["app"].get("withGlobalTauri").is_none());

        let csp = security["csp"].as_str().expect("release csp is missing");
        assert!(
            !csp.contains('*'),
            "wildcard source in the release CSP: {csp}"
        );
        assert!(!csp.contains("unsafe-eval"), "{csp}");

        // Панель Git рисует имена и содержимое файлов из враждебного
        // репозитория, а opener:default даёт канал наружу — CSP здесь
        // последний рубеж.
        let directives = csp_directives(csp);
        for (name, expected) in [
            ("default-src", "'self'"),
            ("script-src", "'self'"),
            ("object-src", "'none'"),
            ("frame-src", "'none'"),
            ("base-uri", "'self'"),
            ("form-action", "'none'"),
            ("font-src", "'self'"),
        ] {
            assert_eq!(
                directives.get(name),
                Some(&vec![expected]),
                "{name} in the release CSP"
            );
        }
        assert_eq!(
            directives.get("connect-src"),
            Some(&vec!["'self'", "ipc:", "http://ipc.localhost"]),
            "connect-src must stay limited to the Tauri IPC origins"
        );
        // Аватары GitHub — единственный внешний источник, и только по https.
        for source in directives.get("img-src").expect("img-src") {
            assert!(
                *source == "'self'" || *source == "data:" || source.starts_with("https://"),
                "plaintext image source in the CSP: {source}"
            );
        }

        // Ровно одно окно: и capability, и ensure_main_window опираются на то,
        // что метка веб-вью — «main».
        let windows = config["app"]["windows"]
            .as_array()
            .expect("app.windows must exist");
        assert_eq!(windows.len(), 1);
        assert!(matches!(
            windows[0].get("label").and_then(serde_json::Value::as_str),
            None | Some("main")
        ));
    }

    #[test]
    fn the_updater_only_trusts_signed_artifacts_over_https() {
        let config: serde_json::Value = serde_json::from_str(TAURI_CONF_JSON).unwrap();
        let updater = &config["plugins"]["updater"];

        assert!(
            updater["pubkey"]
                .as_str()
                .is_some_and(|key| !key.is_empty()),
            "without a pubkey the updater accepts unsigned packages"
        );
        assert!(updater.get("dangerousInsecureTransportProtocol").is_none());
        assert_eq!(config["bundle"]["createUpdaterArtifacts"], true);

        for endpoint in updater["endpoints"].as_array().expect("endpoints") {
            let endpoint = endpoint.as_str().expect("endpoint must be a string");
            assert!(
                endpoint.starts_with("https://"),
                "update metadata fetched over a plaintext channel: {endpoint}"
            );
        }
    }

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
            assert_eq!(
                dmabuf_choice(Some(value)),
                DmabufChoice::Restore,
                "{value:?}"
            );
        }
        for value in ["1", "true", "yes"] {
            assert_eq!(dmabuf_choice(Some(value)), DmabufChoice::Keep, "{value:?}");
        }
    }
}

#[cfg(test)]
mod badge_tests {
    use super::badge_text;

    #[test]
    fn badge_caps_the_overlay_text_at_nine_plus() {
        assert_eq!(badge_text(1), "1");
        assert_eq!(badge_text(9), "9");
        // Больше одной цифры в углу значка не читается — как «9+» в вебе.
        assert_eq!(badge_text(10), "9+");
        assert_eq!(badge_text(42), "9+");
    }

    #[test]
    fn badge_text_stays_bounded_for_any_webview_supplied_count() {
        // Счётчик приходит из веб-вью как i64; app_set_badge пропускает в
        // отрисовку только положительные значения.
        for count in [1_i64, 9, 10, 1_000_000, i64::MAX] {
            let text = badge_text(count);
            assert!(text.len() <= 2, "{count} -> {text:?}");
            assert!(
                text.chars()
                    .all(|symbol| symbol.is_ascii_digit() || symbol == '+'),
                "{count} -> {text:?}"
            );
        }
    }

    // Оверлей рисуется в буфер фиксированного размера по индексам, посчитанным
    // из длины надписи: счётчик из веб-вью не должен выводить их за границы.
    #[cfg(target_os = "windows")]
    #[test]
    fn badge_overlay_stays_inside_its_buffer() {
        use super::{draw_badge_overlay, BADGE_SIZE};

        for count in [1_i64, 2, 9, 10, 99, i64::MAX] {
            let rgba = draw_badge_overlay(&badge_text(count));
            assert_eq!(rgba.len(), BADGE_SIZE * BADGE_SIZE * 4, "count {count}");
            assert!(
                rgba.chunks(4).any(|pixel| pixel[3] == 0xff),
                "count {count} produced a fully transparent overlay"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn badge_uri_points_at_the_installed_desktop_file() {
        // Значок Unity цепляется к приложению по имени .desktop-файла, а его
        // ставят по productName — «ModelCrew», не по имени пакета.
        assert_eq!(
            super::badge_app_uri("ModelCrew"),
            "application://ModelCrew.desktop"
        );
    }
}
