use crate::command_error::{CommandError, CommandResult, ErrorCode};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Вывод копится и уходит во фронт пачками: либо раз в BATCH_WINDOW,
/// либо при достижении MAX_BATCH_BYTES. Побайтовая отправка через IPC —
/// главный источник лагов.
const BATCH_WINDOW: Duration = Duration::from_millis(8);
const MAX_BATCH_BYTES: usize = 32 * 1024;
const READ_BUF_BYTES: usize = 8 * 1024;
const KILL_ALL_TIMEOUT: Duration = Duration::from_secs(5);

/// Каталог событий агентов: один на процесс, задаётся при старте приложения.
/// Хук агента запускается внутри панели и берёт путь из окружения.
static AGENT_EVENTS_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_agent_events_dir(dir: PathBuf) {
    let _ = AGENT_EVENTS_DIR.set(dir);
}

pub struct SpawnOptions {
    pub id: String,
    pub shell: Option<String>,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    // Папка изолированной истории команд панели (ZDOTDIR/HISTFILE);
    // None — общесистемная история.
    pub history_dir: Option<PathBuf>,
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    // PID корневого процесса (шелла): Windows ищет foreground обходом дерева
    // потомков; unix берёт лидера группы напрямую у PTY.
    #[allow(dead_code)]
    child_pid: Option<u32>,
    // child.wait() подтверждает через этот канал, что процесс уже завершился.
    // Одного успешного killer.kill() недостаточно перед установкой обновления.
    exit_rx: mpsc::Receiver<Result<(), String>>,
    // Поколение сессии под этим id. Растёт при каждом spawn, чтобы
    // exit-хендлер вытесненной сессии узнал, что его уже заменили.
    epoch: u64,
    // Корень проекта панели. Агент может уйти в подкаталог, а заявки на файлы
    // считаются от корня — иначе один и тот же файл выглядел бы разными
    // путями из разных панелей.
    root: PathBuf,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    epochs: AtomicU64,
}

impl PtyManager {
    pub fn spawn(
        &self,
        opts: SpawnOptions,
        on_output: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> CommandResult<String> {
        // Один id — один живой терминал. Reload webview поднимает фронт
        // заново с теми же id, пока backend-процесс ещё жив: не конфликтуем,
        // а заменяем прежнюю сессию свежей (сессии перезагрузку не переживают).
        // Замену делаем ниже, после успешного spawn, чтобы неудачный запуск
        // не оставил панель вообще без терминала.
        let epoch = self.epochs.fetch_add(1, Ordering::Relaxed);

        let pty = native_pty_system()
            .openpty(PtySize {
                rows: opts.rows.max(2),
                cols: opts.cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| {
                terminal_error(ErrorCode::TerminalPtyOpenFailed, &opts.id).with_debug(error)
            })?;

        let shell = opts.shell.unwrap_or_else(default_shell);
        // fork/exec не сообщает об отсутствии бинарника синхронно — проверяем сами,
        // чтобы фронт получил внятный Err, а не мгновенно «умерший» терминал.
        if !shell_exists(&shell) {
            return Err(terminal_error(ErrorCode::TerminalShellNotFound, &opts.id)
                .with_context("shell", &shell));
        }
        let mut cmd = CommandBuilder::new(&shell);
        // Логин-шелл на macOS, иначе PATH из LaunchServices без Homebrew и пр.
        #[cfg(target_os = "macos")]
        cmd.arg("-l");
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Терминал должен выглядеть как свежая пользовательская сессия. Если
        // само приложение запущено из-под CLI-агента (например, Claude Code),
        // его служебные маркеры протекают в PTY, и агенты внутри считают себя
        // «вложенными» — Claude Code, в частности, перестаёт сохранять сессию.
        for (key, _) in std::env::vars() {
            if key == "CLAUDECODE" || key == "CLAUDE_EFFORT" || key.starts_with("CLAUDE_CODE_") {
                cmd.env_remove(&key);
            }
        }
        // Своя история команд у каждой панели. macOS /etc/zshrc жёстко ставит
        // HISTFILE=$ZDOTDIR/.zsh_history — поэтому подменяем ZDOTDIR (внутри
        // папки симлинки на реальные дотфайлы пользователя). bash уважает
        // HISTFILE из окружения, fish — имя сессии в fish_history.
        if let Some(history) = &opts.history_dir {
            cmd.env("ZDOTDIR", history);
            cmd.env("HISTFILE", history.join("shell_history"));
            // bash пишет историю только на выходе — history -a после каждой
            // команды спасает её при принудительном завершении приложения.
            cmd.env("PROMPT_COMMAND", "history -a");
            let fish_name: String = opts
                .id
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric())
                .collect::<String>()
                .to_ascii_lowercase();
            cmd.env("fish_history", format!("mc{fish_name}"));
        }
        // Хук агента запускается внутри панели и про неё ничего не знает:
        // отдаём id панели и каталог событий через окружение, иначе
        // уведомление некуда привязать.
        cmd.env("MODELCREW_PANEL_ID", &opts.id);
        if let Some(events) = AGENT_EVENTS_DIR.get() {
            cmd.env("MODELCREW_EVENTS_DIR", events);
            for (key, value) in crate::agent_hooks::env_hooks(events) {
                cmd.env(key, value);
            }
        }
        // cwd обязателен и уже разрешён backend-реестром по workspace_id.
        // Повторная проверка закрывает гонку между resolve и spawn.
        if !opts.cwd.is_dir() {
            return Err(terminal_error(ErrorCode::TerminalCwdUnavailable, &opts.id)
                .with_context("path", opts.cwd.display()));
        }
        cmd.cwd(&opts.cwd);

        let mut child = pty.slave.spawn_command(cmd).map_err(|error| {
            terminal_error(ErrorCode::TerminalSpawnFailed, &opts.id)
                .with_context("shell", &shell)
                .with_debug(error)
        })?;
        let child_pid = child.process_id();
        // Слейв закрываем сразу: EOF ридера тогда означает завершение шелла.
        drop(pty.slave);

        let killer = child.clone_killer();
        let mut reader = pty.master.try_clone_reader().map_err(|error| {
            terminal_error(ErrorCode::TerminalOutputStreamFailed, &opts.id).with_debug(error)
        })?;
        let writer = pty.master.take_writer().map_err(|error| {
            terminal_error(ErrorCode::TerminalInputStreamFailed, &opts.id).with_debug(error)
        })?;
        let (process_exit_tx, process_exit_rx) = mpsc::channel::<Result<(), String>>();

        let previous = self.sessions.lock().unwrap().insert(
            opts.id.clone(),
            PtySession {
                master: pty.master,
                writer,
                killer,
                child_pid,
                exit_rx: process_exit_rx,
                epoch,
                root: opts.cwd.clone(),
            },
        );
        // Свежая сессия уже в карте — гасим прежний процесс того же id.
        // Его exit-хендлер увидит чужой epoch и промолчит (см. ниже).
        if let Some(mut previous) = previous {
            let _ = previous.killer.kill();
        }

        let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<u8>>();

        std::thread::spawn(move || {
            let mut buf = [0u8; READ_BUF_BYTES];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if chunk_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        std::thread::spawn(move || {
            let mut pending: Vec<u8> = Vec::new();
            loop {
                match chunk_rx.recv_timeout(BATCH_WINDOW) {
                    Ok(chunk) => {
                        pending.extend_from_slice(&chunk);
                        if pending.len() >= MAX_BATCH_BYTES {
                            on_output(std::mem::take(&mut pending));
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if !pending.is_empty() {
                            on_output(std::mem::take(&mut pending));
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        if !pending.is_empty() {
                            on_output(pending);
                        }
                        break;
                    }
                }
            }
        });

        let exit_sessions = Arc::clone(&self.sessions);
        let exit_id = opts.id.clone();
        std::thread::spawn(move || {
            let status = match child.wait() {
                Ok(status) => status,
                Err(error) => {
                    // Не выдаём ошибку wait() за завершение процесса. Сессию
                    // оставляем в реестре, поэтому updater останется fail-closed.
                    let _ = process_exit_tx.send(Err(error.to_string()));
                    return;
                }
            };
            let code = Some(status.exit_code() as i32);
            // Подтверждение отправляем до блокировки sessions: kill_all держит
            // её, пока ждёт завершения каждого дочернего процесса.
            let _ = process_exit_tx.send(Ok(()));
            // Молчим, только если нас вытеснила новая сессия того же id
            // (reload). Своё завершение снимаем сами; при явном kill / kill_all
            // сессии в карте уже нет — тогда тоже сообщаем.
            let superseded = {
                let mut sessions = exit_sessions.lock().unwrap();
                match sessions.get(&exit_id) {
                    Some(session) if session.epoch != epoch => true,
                    Some(_) => {
                        sessions.remove(&exit_id);
                        false
                    }
                    None => false,
                }
            };
            if !superseded {
                on_exit(code);
            }
        });

        // Возвращаем именно фактически разрешённую оболочку. Фронтенду больше
        // не нужно ждать первый тик process watcher, чтобы заменить временное
        // «терминал» на zsh/bash/PowerShell.
        Ok(shell)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> CommandResult<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| terminal_error(ErrorCode::TerminalNotFound, id))?;
        session
            .writer
            .write_all(data)
            .map_err(|error| terminal_error(ErrorCode::TerminalWriteFailed, id).with_debug(error))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> CommandResult<()> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(id)
            .ok_or_else(|| terminal_error(ErrorCode::TerminalNotFound, id))?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| terminal_error(ErrorCode::TerminalResizeFailed, id).with_debug(error))
    }

    /// Убивает процесс и снимает сессию. Закрытие мастера обрывает ридер.
    pub fn kill(&self, id: &str) -> CommandResult<()> {
        let session = self.sessions.lock().unwrap().remove(id);
        match session {
            Some(mut session) => {
                let _ = session.killer.kill();
                Ok(())
            }
            None => Err(terminal_error(ErrorCode::TerminalNotFound, id)),
        }
    }

    /// Корень проекта панели: от него отсчитываются заявки на файлы.
    pub fn session_root(&self, id: &str) -> Option<PathBuf> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|session| session.root.clone())
    }

    /// PID процесса переднего плана каждого живого терминала (для имён панелей).
    #[cfg(unix)]
    pub fn foreground_processes(&self) -> Vec<(String, i32)> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .iter()
            .filter_map(|(id, session)| {
                session
                    .master
                    .process_group_leader()
                    .map(|pid| (id.clone(), pid))
            })
            .collect()
    }

    /// Windows: у ConPTY нет группы переднего плана, поэтому foreground —
    /// самый свежий «листовой» потомок корневого процесса шелла.
    #[cfg(windows)]
    pub fn foreground_processes(&self) -> Vec<(String, i32)> {
        let roots: Vec<(String, u32)> = {
            let sessions = self.sessions.lock().unwrap();
            sessions
                .iter()
                .filter_map(|(id, session)| session.child_pid.map(|pid| (id.clone(), pid)))
                .collect()
        };
        if roots.is_empty() {
            return Vec::new();
        }
        let procs = crate::win_proc::snapshot();
        let edges: Vec<(u32, u32)> = procs.iter().map(|p| (p.pid, p.parent)).collect();
        roots
            .into_iter()
            .map(|(id, root)| {
                let leaves = descendant_leaves(root, &edges);
                let pid = pick_foreground(&leaves, crate::win_proc::creation_time);
                (id, pid as i32)
            })
            .collect()
    }

    /// Завершает все PTY и возвращается только после подтверждения child.wait().
    /// При ошибке незавершённые сессии остаются в реестре, чтобы штатная уборка
    /// при выходе приложения могла повторить попытку.
    pub fn kill_all(&self) -> CommandResult<()> {
        let deadline = Instant::now() + KILL_ALL_TIMEOUT;
        let mut sessions = self.sessions.lock().unwrap();
        let ids = sessions.keys().cloned().collect::<Vec<_>>();
        let mut kill_errors = HashMap::<String, String>::new();

        for id in &ids {
            if let Some(session) = sessions.get_mut(id) {
                if let Err(error) = session.killer.kill() {
                    kill_errors.insert(id.clone(), error.to_string());
                }
            }
        }

        let mut stopped = Vec::with_capacity(ids.len());
        let mut failures = Vec::new();
        for id in ids {
            let Some(session) = sessions.get(&id) else {
                continue;
            };
            let remaining = deadline.saturating_duration_since(Instant::now());
            let exit_result = if remaining.is_zero() {
                Err(RecvTimeoutError::Timeout)
            } else {
                session.exit_rx.recv_timeout(remaining)
            };
            match exit_result {
                Ok(Ok(())) => stopped.push(id),
                Ok(Err(wait_error)) => {
                    let reason = match kill_errors.remove(&id) {
                        Some(kill_error) => {
                            format!("kill failed: {kill_error}; child.wait failed: {wait_error}")
                        }
                        None => format!("child.wait failed: {wait_error}"),
                    };
                    failures.push(format!("{id}: {reason}"));
                }
                Err(wait_error) => {
                    let reason = kill_errors.remove(&id).unwrap_or_else(|| match wait_error {
                        RecvTimeoutError::Timeout => {
                            "timed out waiting for the process to exit".to_string()
                        }
                        RecvTimeoutError::Disconnected => {
                            "process exit watcher disconnected".to_string()
                        }
                    });
                    failures.push(format!("{id}: {reason}"));
                }
            }
        }

        for id in stopped {
            sessions.remove(&id);
        }
        drop(sessions);

        if failures.is_empty() {
            Ok(())
        } else {
            Err(CommandError::new(ErrorCode::TerminalKillFailed)
                .with_context("failed", failures.len())
                .with_debug(failures.join("; ")))
        }
    }
}

/// Листья поддерева процессов: потомки root (включая его самого, если
/// потомков нет), у которых нет собственных детей. Чистая функция — логика
/// Windows-детекции тестируется на любой платформе.
#[cfg_attr(not(windows), allow(dead_code))]
fn descendant_leaves(root: u32, edges: &[(u32, u32)]) -> Vec<u32> {
    use std::collections::{HashMap, HashSet};
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, parent) in edges {
        children.entry(*parent).or_default().push(*pid);
    }
    let mut leaves = Vec::new();
    let mut stack = vec![root];
    let mut visited = HashSet::new();
    while let Some(pid) = stack.pop() {
        // PID в снапшоте могут переиспользоваться — защищаемся от циклов.
        if !visited.insert(pid) {
            continue;
        }
        match children.get(&pid) {
            Some(kids) if !kids.is_empty() => stack.extend(kids.iter().copied()),
            _ => leaves.push(pid),
        }
    }
    if leaves.is_empty() {
        leaves.push(root);
    }
    leaves
}

/// Из листьев выбирается самый свежий по времени создания: это то, что
/// пользователь запустил последним (агент поверх шелла, vim поверх агента…).
#[cfg_attr(not(windows), allow(dead_code))]
fn pick_foreground(leaves: &[u32], creation_time: impl Fn(u32) -> Option<u64>) -> u32 {
    leaves
        .iter()
        .copied()
        .max_by_key(|pid| creation_time(*pid).unwrap_or(0))
        .unwrap_or(0)
}

fn terminal_error(code: ErrorCode, terminal_id: &str) -> CommandError {
    CommandError::new(code).with_context("terminalId", terminal_id)
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/bash".to_string()
            }
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ShellInfo {
    pub id: String,
    pub label: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(not(windows), allow(dead_code))]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GitBashAvailability {
    Unsupported,
    Installed { shell: ShellInfo },
    Installable,
    Manual,
}

/// Bash из установки Git for Windows. Искать его только в PATH бесполезно:
/// установщик по умолчанию добавляет туда каталог с `git.exe`, а `bash.exe`
/// лежит рядом, в `bin`. Поэтому у большинства пользователей bash установлен,
/// но обычным поиском не находится. Принимает корни установки Git — то есть
/// каталоги, внутри которых лежит `bin`.
#[cfg_attr(not(windows), allow(dead_code))]
fn bash_in_git_root(roots: &[PathBuf]) -> Option<PathBuf> {
    roots
        .iter()
        .map(|root| root.join("bin").join("bash.exe"))
        .find(|candidate| candidate.is_file())
}

#[cfg(windows)]
fn windows_git_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    // Git мог быть поставлен куда угодно — хоть на другой диск. Его корень
    // вычисляется от самого git.exe: тот лежит в <корень>\cmd, а bash — в
    // <корень>\bin. Этот путь надёжнее всех остальных, поэтому идёт первым.
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            if dir.join("git.exe").is_file() {
                if let Some(root) = dir.parent() {
                    roots.push(root.to_path_buf());
                }
            }
        }
    }
    // ProgramW6432 указывает на 64-битный Program Files даже из 32-битного
    // процесса; остальные покрывают обычную и 32-битную установки.
    for variable in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(value) = std::env::var_os(variable) {
            roots.push(PathBuf::from(value).join("Git"));
        }
    }
    // Установка «только для меня» кладёт Git в профиль пользователя.
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Programs").join("Git"));
    }
    roots
}

#[cfg(windows)]
fn git_bash_shell() -> Option<ShellInfo> {
    bash_in_git_root(&windows_git_roots()).map(|path| ShellInfo {
        id: "bash".to_string(),
        label: "Git Bash".to_string(),
        command: path.display().to_string(),
    })
}

#[cfg(windows)]
fn command_in_path(command: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;

    std::env::split_paths(&paths)
        .map(|dir| dir.join(command))
        .find(|candidate| candidate.is_file())
}

pub fn git_bash_availability() -> GitBashAvailability {
    #[cfg(windows)]
    {
        if let Some(shell) = git_bash_shell() {
            return GitBashAvailability::Installed { shell };
        }
        if command_in_path("winget.exe").is_some() {
            GitBashAvailability::Installable
        } else {
            GitBashAvailability::Manual
        }
    }
    #[cfg(not(windows))]
    {
        GitBashAvailability::Unsupported
    }
}

/// Установка всегда запускается по явному действию пользователя и остаётся
/// видимой в отдельной консоли. WinGet сам показывает соглашения и UAC; мы не
/// принимаем их за пользователя и не скачиваем исполняемые файлы напрямую.
pub fn install_git_bash() -> CommandResult<ShellInfo> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        if let Some(shell) = git_bash_shell() {
            return Ok(shell);
        }
        let winget = command_in_path("winget.exe")
            .ok_or_else(|| CommandError::new(ErrorCode::GitBashInstallerUnavailable))?;
        let status = std::process::Command::new(&winget)
            .args(["install", "--id", "Git.Git", "-e", "--source", "winget"])
            .creation_flags(0x0000_0010) // CREATE_NEW_CONSOLE
            .status()
            .map_err(|error| {
                CommandError::new(ErrorCode::GitBashInstallFailed).with_debug(error)
            })?;
        if !status.success() {
            return Err(CommandError::new(ErrorCode::GitBashInstallFailed)
                .with_context("exitCode", status.code().unwrap_or(-1)));
        }
        git_bash_shell().ok_or_else(|| {
            CommandError::new(ErrorCode::GitBashInstallFailed)
                .with_debug("Git Bash was not found after WinGet completed")
        })
    }
    #[cfg(not(windows))]
    {
        Err(CommandError::new(ErrorCode::GitBashInstallUnsupported))
    }
}

/// Оболочки, реально доступные на этой ОС — фронт покажет только их, чтобы
/// пользователь не выбрал отсутствующую. Кроссплатформенно: unix и windows
/// перебирают разные наборы.
pub fn available_shells() -> Vec<ShellInfo> {
    #[cfg(windows)]
    let candidates: &[(&str, &str, &str)] = &[
        ("powershell", "PowerShell", "powershell.exe"),
        ("pwsh", "PowerShell 7", "pwsh.exe"),
        ("cmd", "Command Prompt", "cmd.exe"),
    ];
    #[cfg(not(windows))]
    let candidates: &[(&str, &str, &str)] = &[
        ("zsh", "Zsh", "zsh"),
        ("bash", "Bash", "bash"),
        ("sh", "Sh", "sh"),
        ("fish", "Fish", "fish"),
    ];
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut shells: Vec<ShellInfo> = candidates
        .iter()
        .filter(|(_, _, command)| shell_exists(command))
        .map(|(id, label, command)| ShellInfo {
            id: (*id).to_string(),
            label: (*label).to_string(),
            command: (*command).to_string(),
        })
        .collect();

    #[cfg(windows)]
    {
        // Полный путь, а не имя: PATH до него всё равно не доведёт. Если Git
        // не установлен, остаётся обычный поиск — он найдёт bash из WSL или
        // поставленный вручную.
        let shell = match git_bash_shell() {
            Some(shell) => shell,
            None if shell_exists("bash.exe") => ShellInfo {
                id: "bash".to_string(),
                label: "Bash".to_string(),
                command: "bash.exe".to_string(),
            },
            None => return shells,
        };
        shells.push(shell);
    }
    shells
}

fn shell_exists(shell: &str) -> bool {
    let path = std::path::Path::new(shell);
    if path.is_absolute() || shell.contains(std::path::MAIN_SEPARATOR) {
        return path.exists();
    }
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| {
        let candidate = dir.join(shell);
        #[cfg(windows)]
        let found = candidate.exists()
            || candidate.with_extension("exe").exists()
            || candidate.with_extension("cmd").exists();
        #[cfg(not(windows))]
        let found = candidate.exists();
        found
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    // Тесты поднимают настоящий шелл через PTY, а шеллы на разных системах
    // разные. Различать вывод шелла и эхо набранной команды тоже приходится
    // по-разному, поэтому платформенные особенности собраны здесь, а сами
    // тесты остаются про поведение PTY, а не про синтаксис оболочки.
    struct Shell;

    impl Shell {
        fn path() -> String {
            if cfg!(windows) {
                "cmd.exe".to_string()
            } else {
                "/bin/sh".to_string()
            }
        }

        // Enter в терминале — это возврат каретки; POSIX-шеллы принимают и
        // перевод строки, ConPTY ждёт именно \r.
        fn line(command: &str) -> Vec<u8> {
            if cfg!(windows) {
                format!("{command}\r\n").into_bytes()
            } else {
                format!("{command}\n").into_bytes()
            }
        }

        // Команда, чей вывод невозможно спутать с эхом ввода: шелл обязан
        // что-то вычислить. На Unix это арифметика, в cmd — подстановка
        // переменной, которой в набранной строке нет.
        fn evaluated(index: usize) -> (Vec<u8>, String) {
            if cfg!(windows) {
                (Self::line("echo PING_%RANDOM%_DONE"), "_DONE".to_string())
            } else {
                (
                    Self::line(&format!("echo PING_$(({index} + 100))")),
                    format!("PING_{}", index + 100),
                )
            }
        }

        fn exit(code: i32) -> Vec<u8> {
            Self::line(&format!("exit {code}"))
        }

        fn missing_directory() -> PathBuf {
            if cfg!(windows) {
                PathBuf::from(r"C:\nonexistent\workspace\folder")
            } else {
                PathBuf::from("/nonexistent/workspace/folder")
            }
        }

        // Проба окружения. Маркер собирается шеллом, а в наборе команды его
        // нет: на Unix кавычки рвут его в эхе, в cmd он живёт в переменной,
        // которая подставляется только во второй строке.
        fn env_probe() -> Vec<Vec<u8>> {
            if cfg!(windows) {
                vec![
                    Self::line("set MARK=PROBE_%CLAUDECODE%_%CLAUDE_CODE_SESSION_ID%"),
                    Self::line("echo %MARK%"),
                ]
            } else {
                vec![Self::line(
                    "echo PRO\"BE\"_${CLAUDECODE:-clean}_${CLAUDE_CODE_SESSION_ID:-clean}",
                )]
            }
        }

        // Выливает файл в терминал и печатает маркер конца. Маркер обязан
        // собираться шеллом: написанный в команде целиком, он немедленно
        // нашёлся бы в эхе ввода, и тест закончился бы на первом же чанке.
        fn dump_file(path: &std::path::Path) -> Vec<Vec<u8>> {
            let path = path.display().to_string();
            if cfg!(windows) {
                // Собираем маркер из двух половин: cmd отражает набранное, и
                // `set MARK=STRESS_1337` отдал бы готовый маркер прямо в эхе
                // ввода — цикл вышел бы, не дождавшись ни байта файла.
                vec![
                    Self::line("set PART=1337"),
                    Self::line(&format!("type \"{path}\" & echo STRESS_%PART%")),
                ]
            } else {
                vec![Self::line(&format!(
                    "cat '{path}'; echo STRESS_$((1300 + 37))"
                ))]
            }
        }

        // Маркер пробы окружения. В набранной строке его нет ни на одной
        // платформе — он собирается шеллом, поэтому эхо ввода не сойдёт за
        // результат подстановки.
        const EVALUATED_PROBE: &'static str = "PROBE_OK_";

        // Проба произвольных переменных окружения: печатает EVALUATED_PROBE
        // и значения (или «clean», если переменной нет).
        fn evaluated_env_probe(names: &[&str]) -> Vec<Vec<u8>> {
            if cfg!(windows) {
                let refs = names
                    .iter()
                    .map(|name| format!("%{name}%"))
                    .collect::<Vec<_>>()
                    .join("_");
                vec![
                    Self::line("set PART=OK"),
                    Self::line(&format!("echo PROBE_%PART%_{refs}")),
                ]
            } else {
                let refs = names
                    .iter()
                    .map(|name| format!("${{{name}:-clean}}"))
                    .collect::<Vec<_>>()
                    .join("_");
                vec![Self::line(&format!("echo PRO\"BE\"_OK_{refs}"))]
            }
        }

        // Печатает файл из текущей папки процесса. Маркер лежит в файле, а не
        // в набранной строке, поэтому эхо ввода его подделать не может.
        fn print_local_file(name: &str) -> Vec<u8> {
            if cfg!(windows) {
                Self::line(&format!("type {name}"))
            } else {
                Self::line(&format!("cat {name}"))
            }
        }

        // Строка-пустышка примерно в 60 байт: шелл её принимает и ничего не
        // делает. Нужна, чтобы собрать одну крупную запись из целых строк.
        fn padding_line() -> Vec<u8> {
            let pad = "a".repeat(56);
            if cfg!(windows) {
                Self::line(&format!("rem {pad}"))
            } else {
                Self::line(&format!(": {pad}"))
            }
        }

        // Путь с NUL внутри: и unix, и Windows обязаны отвергнуть такой шелл,
        // а не обрезать строку по нулевому байту.
        fn nul_path() -> String {
            if cfg!(windows) {
                "C:\\Windows\\System32\\cmd.exe\0evil".to_string()
            } else {
                "/bin/sh\0evil".to_string()
            }
        }

        // Строки, которыми фронт может попробовать протащить вторую команду:
        // метасимволы, подстановка, путь с дописанным аргументом. Ни одна не
        // должна дойти до интерпретатора — canary создаётся только если её
        // содержимое кто-то выполнил.
        fn injection_attempts(canary: &std::path::Path) -> Vec<String> {
            let canary = canary.display().to_string();
            let mut attempts = vec![
                "echo pwned; id".to_string(),
                "sh -c \"id\"".to_string(),
                "cmd /c whoami".to_string(),
                "$(id)".to_string(),
                "`id`".to_string(),
            ];
            if cfg!(windows) {
                attempts.push(format!(
                    "C:\\Windows\\System32\\cmd.exe /c echo pwned > \"{canary}\""
                ));
                attempts.push(format!(
                    "C:\\Windows\\System32\\cmd.exe&echo pwned>\"{canary}\""
                ));
            } else {
                attempts.push(format!("/bin/sh -c 'touch {canary}'"));
                attempts.push(format!("/bin/sh; touch {canary}"));
                attempts.push(format!("/bin/sh -l | touch {canary}"));
            }
            attempts
        }

        // ConPTY при старте сессии спрашивает позицию курсора (DSR) и ждёт
        // ответа, прежде чем выполнять что-либо ещё. В приложении отвечает
        // xterm.js — это работа эмулятора терминала, и в PTY-слое ей не место.
        // В тестах эмулятора нет, поэтому его роль исполняет харнесс, иначе
        // шелл замирает на первом же запросе.
        const CURSOR_QUERY: &'static [u8] = b"\x1b[6n";
        const CURSOR_REPLY: &'static [u8] = b"\x1b[1;1R";
    }

    // Отвечает на запросы позиции курсора по ходу потока. Поток не копит: в
    // стресс-тесте через харнесс проходит 50 МБ. Между чанками переносится
    // только хвост короче самого запроса — на случай, если запрос разорвало
    // на границе.
    struct CursorResponder {
        carry: Vec<u8>,
    }

    impl CursorResponder {
        fn new() -> Self {
            Self { carry: Vec::new() }
        }

        // Чистая часть: сколько запросов пришло. Вынесена отдельно, потому
        // что склейку на границе чанков иначе исполняет только Windows, то
        // есть ровно та система, где её не проверить локально.
        fn count(&mut self, chunk: &[u8]) -> usize {
            let mut window = std::mem::take(&mut self.carry);
            window.extend_from_slice(chunk);
            let queries = window
                .windows(Shell::CURSOR_QUERY.len())
                .filter(|candidate| *candidate == Shell::CURSOR_QUERY)
                .count();
            let keep = window.len().min(Shell::CURSOR_QUERY.len() - 1);
            self.carry = window.split_off(window.len() - keep);
            queries
        }

        fn feed(&mut self, manager: &PtyManager, id: &str, chunk: &[u8]) {
            for _ in 0..self.count(chunk) {
                let _ = manager.write(id, Shell::CURSOR_REPLY);
            }
        }
    }

    #[test]
    fn cursor_responder_counts_queries_split_across_chunks() {
        let mut responder = CursorResponder::new();
        assert_eq!(responder.count(b"hello"), 0);
        // Запрос разорван границей чанка, но он один.
        assert_eq!(responder.count(b"tail\x1b["), 0);
        assert_eq!(responder.count(b"6nrest"), 1);
        // Два запроса в одном чанке — два ответа.
        assert_eq!(responder.count(b"\x1b[6nmid\x1b[6n"), 2);
        // Перенесённый хвост не считается второй раз.
        assert_eq!(responder.count(b"quiet"), 0);
    }

    fn test_cwd() -> PathBuf {
        std::env::current_dir().expect("тестам нужна текущая папка")
    }

    // Харнесс здесь не только ждёт текст, но и играет роль фронтенда: на
    // запрос позиции курсора надо ответить, иначе шелл не дойдёт до команды.
    fn wait_for_output(
        manager: &PtyManager,
        id: &str,
        rx: &mpsc::Receiver<Vec<u8>>,
        needle: &str,
        timeout: Duration,
    ) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        let mut collected = String::new();
        let mut cursor = CursorResponder::new();
        while Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                cursor.feed(manager, id, &chunk);
                collected.push_str(&String::from_utf8_lossy(&chunk));
                if collected.contains(needle) {
                    return Ok(collected);
                }
            }
        }
        Err(format!("не дождались «{needle}», получено: {collected:?}"))
    }

    // То же самое для ожидания завершения: пока процесс не отчитался, поток
    // надо продолжать разбирать, иначе запрос курсора остаётся без ответа.
    fn wait_for_exit(
        manager: &PtyManager,
        id: &str,
        out_rx: &mpsc::Receiver<Vec<u8>>,
        exit_rx: &mpsc::Receiver<Option<i32>>,
        timeout: Duration,
    ) -> Result<Option<i32>, String> {
        let deadline = Instant::now() + timeout;
        let mut cursor = CursorResponder::new();
        while Instant::now() < deadline {
            if let Ok(code) = exit_rx.recv_timeout(Duration::from_millis(50)) {
                return Ok(code);
            }
            while let Ok(chunk) = out_rx.try_recv() {
                cursor.feed(manager, id, &chunk);
            }
        }
        Err("процесс не завершился за отведённое время".to_string())
    }

    #[test]
    fn shell_roundtrip_and_exit() {
        let manager = PtyManager::default();
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
        let (exit_tx, exit_rx) = mpsc::channel::<Option<i32>>();

        let spawned_shell = manager
            .spawn(
                SpawnOptions {
                    id: "t1".into(),
                    shell: Some(Shell::path()),
                    cwd: test_cwd(),
                    cols: 80,
                    rows: 24,
                    history_dir: None,
                },
                move |bytes| {
                    let _ = out_tx.send(bytes);
                },
                move |code| {
                    let _ = exit_tx.send(code);
                },
            )
            .expect("шелл должен запуститься");
        assert_eq!(spawned_shell, Shell::path());

        let (command, needle) = Shell::evaluated(0);
        manager.write("t1", &command).expect("запись в PTY");
        let output = wait_for_output(&manager, "t1", &out_rx, &needle, Duration::from_secs(20))
            .expect("эхо из шелла");
        assert!(output.contains(&needle));

        manager.resize("t1", 100, 30).expect("ресайз живого PTY");

        manager.write("t1", &Shell::exit(7)).expect("запись exit");
        // Ждём завершения, не переставая отвечать на запросы курсора: иначе
        // шелл замрёт на очередном запросе и до `exit` просто не дойдёт.
        let code = wait_for_exit(&manager, "t1", &out_rx, &exit_rx, Duration::from_secs(10))
            .expect("процесс должен завершиться");
        assert_eq!(code, Some(7));
    }

    #[test]
    fn kill_terminates_process() {
        let manager = PtyManager::default();
        let (exit_tx, exit_rx) = mpsc::channel::<Option<i32>>();

        manager
            .spawn(
                SpawnOptions {
                    id: "t2".into(),
                    shell: Some(Shell::path()),
                    cwd: test_cwd(),
                    cols: 80,
                    rows: 24,
                    history_dir: None,
                },
                |_| {},
                move |code| {
                    let _ = exit_tx.send(code);
                },
            )
            .expect("шелл должен запуститься");

        manager.kill("t2").expect("kill живого терминала");
        exit_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("после kill процесс должен завершиться");
        assert!(
            manager.write("t2", b"x").is_err(),
            "сессия должна быть снята"
        );
    }

    /// Reload webview: фронт поднимается заново с тем же id, пока прежний
    /// процесс ещё жив. Повторный spawn обязан заменить сессию, а не упасть
    /// с «терминал уже существует», и хендлер вытеснённой сессии не должен
    /// «завершить» уже новый терминал.
    #[test]
    fn respawn_same_id_replaces_session() {
        let manager = PtyManager::default();
        let (stale_out_tx, _stale_out_rx) = mpsc::channel::<Vec<u8>>();
        let (stale_exit_tx, stale_exit_rx) = mpsc::channel::<Option<i32>>();

        manager
            .spawn(
                SpawnOptions {
                    id: "r1".into(),
                    shell: Some(Shell::path()),
                    cwd: test_cwd(),
                    cols: 80,
                    rows: 24,
                    history_dir: None,
                },
                move |bytes| {
                    let _ = stale_out_tx.send(bytes);
                },
                move |code| {
                    let _ = stale_exit_tx.send(code);
                },
            )
            .expect("первая сессия должна подняться");

        let (fresh_out_tx, fresh_out_rx) = mpsc::channel::<Vec<u8>>();
        let (fresh_exit_tx, fresh_exit_rx) = mpsc::channel::<Option<i32>>();
        manager
            .spawn(
                SpawnOptions {
                    id: "r1".into(),
                    shell: Some(Shell::path()),
                    cwd: test_cwd(),
                    cols: 80,
                    rows: 24,
                    history_dir: None,
                },
                move |bytes| {
                    let _ = fresh_out_tx.send(bytes);
                },
                move |code| {
                    let _ = fresh_exit_tx.send(code);
                },
            )
            .expect("повторный spawn того же id должен заменить сессию, а не упасть");

        // Вытеснённая сессия завершилась (её убили), но во фронт это уходить
        // не должно — иначе новый терминал сразу помечается «завершён».
        assert!(
            stale_exit_rx.recv_timeout(Duration::from_secs(3)).is_err(),
            "exit вытесненной сессии не должен всплывать"
        );

        // Новая сессия — живая и отвечает своим каналом.
        let (command, needle) = Shell::evaluated(1);
        manager
            .write("r1", &command)
            .expect("запись в заменённую сессию");
        wait_for_output(
            &manager,
            "r1",
            &fresh_out_rx,
            &needle,
            Duration::from_secs(20),
        )
        .expect("ответ от новой сессии");

        // Явный kill новой сессии по-прежнему сообщается во фронт.
        manager.kill("r1").expect("kill заменённой сессии");
        fresh_exit_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("новая сессия должна завершиться по kill");
    }

    /// Стресс приёмки: 50 МБ сплошного вывода не должны идти по байту —
    /// батчер обязан отдавать крупные куски, и весь объём должен дойти.
    #[test]
    fn descendant_leaves_walks_the_process_tree() {
        // shell(1) → agent(2) → tool(3); отдельная ветка shell(1) → job(4).
        let edges = [(2, 1), (3, 2), (4, 1), (99, 98)];
        let mut leaves = descendant_leaves(1, &edges);
        leaves.sort_unstable();
        assert_eq!(leaves, vec![3, 4]);
        // Без потомков корень сам себе foreground.
        assert_eq!(descendant_leaves(7, &edges), vec![7]);
        // Цикл в снапшоте (переиспользованные PID) не зацикливает обход:
        // настоящих листьев нет — безопасно откатываемся к корню.
        let cyclic = [(2, 1), (1, 2)];
        assert_eq!(descendant_leaves(1, &cyclic), vec![1]);
    }

    #[test]
    fn pick_foreground_prefers_the_newest_leaf() {
        let times = |pid: u32| match pid {
            3 => Some(100),
            4 => Some(500),
            _ => None,
        };
        assert_eq!(pick_foreground(&[3, 4], times), 4);
        // Без времён берётся детерминированный кандидат (последний из равных).
        assert_eq!(pick_foreground(&[9, 8], |_| None), 8);
    }

    #[test]
    fn agent_launcher_markers_do_not_leak_into_terminals() {
        // Приложение может быть запущено из-под CLI-агента; его маркеры не
        // должны доставаться пользовательским терминалам (см. spawn).
        std::env::set_var("CLAUDECODE", "1");
        std::env::set_var("CLAUDE_CODE_SESSION_ID", "leak-test");

        let manager = PtyManager::default();
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
        manager
            .spawn(
                SpawnOptions {
                    id: "t-env".into(),
                    shell: Some(Shell::path()),
                    cwd: test_cwd(),
                    cols: 80,
                    rows: 24,
                    history_dir: None,
                },
                move |bytes| {
                    let _ = out_tx.send(bytes);
                },
                |_| {},
            )
            .expect("шелл должен запуститься");

        for line in Shell::env_probe() {
            manager.write("t-env", &line).expect("запись в PTY");
        }
        let output = wait_for_output(
            &manager,
            "t-env",
            &out_rx,
            "PROBE_",
            Duration::from_secs(20),
        )
        .expect("эхо из шелла");
        // Главное — значения переменных запускавшего агента не видны терминалу.
        assert!(
            !output.contains("leak-test"),
            "маркеры агента протекли в терминал: {output}"
        );
        #[cfg(unix)]
        assert!(
            output.contains("PROBE_clean_clean"),
            "шелл должен видеть переменные пустыми: {output}"
        );
        let _ = manager.kill("t-env");
    }

    #[test]
    fn bulk_output_arrives_batched() {
        // ConPTY на Windows заметно медленнее unix-псевдотерминала, поэтому
        // объём там меньше: проверяется склейка в крупные куски, а не скорость.
        const PAYLOAD: usize = if cfg!(windows) {
            8 * 1024 * 1024
        } else {
            50 * 1024 * 1024
        };

        let manager = PtyManager::default();
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();

        manager
            .spawn(
                SpawnOptions {
                    id: "stress".into(),
                    shell: Some(Shell::path()),
                    cwd: test_cwd(),
                    cols: 120,
                    rows: 40,
                    history_dir: None,
                },
                move |bytes| {
                    let _ = out_tx.send(bytes);
                },
                |_| {},
            )
            .expect("шелл должен запуститься");

        // Файл готовим сами: так не нужен ни dd, ни его отсутствующий на
        // Windows аналог, и объём точно одинаков на всех системах.
        let payload_dir = tempfile::tempdir().expect("временная папка");
        let payload_path = payload_dir.path().join("payload.bin");
        std::fs::write(&payload_path, vec![b'.'; PAYLOAD]).expect("подготовка данных");
        for line in Shell::dump_file(&payload_path) {
            manager.write("stress", &line).expect("запись команды");
        }

        let deadline = Instant::now() + Duration::from_secs(120);
        let mut total = 0usize;
        let mut chunks = 0usize;
        let mut tail: Vec<u8> = Vec::new();
        // Поток читаем своим циклом, а не wait_for_output, поэтому за роль
        // эмулятора здесь отвечаем сами: без ответа на запрос курсора шелл
        // не дойдёт даже до начала выдачи файла.
        let mut cursor = CursorResponder::new();
        loop {
            assert!(
                Instant::now() < deadline,
                "{PAYLOAD} байт не дошли за отведённое время"
            );
            let Ok(chunk) = out_rx.recv_timeout(Duration::from_secs(5)) else {
                panic!(
                    "поток вывода заглох (получено {total} байт), хвост: {:?}",
                    String::from_utf8_lossy(&tail)
                );
            };
            cursor.feed(&manager, "stress", &chunk);
            total += chunk.len();
            chunks += 1;
            // Проверяем на склейке «хвост + чанк» ДО усечения: иначе маркер,
            // за которым в том же чанке пришёл длинный промпт, вытесняется
            // из окна раньше, чем мы его увидим.
            tail.extend_from_slice(&chunk);
            if String::from_utf8_lossy(&tail).contains("STRESS_1337") {
                break;
            }
            let keep = tail.len().min(64);
            tail = tail.split_off(tail.len() - keep);
        }

        assert!(total >= PAYLOAD, "дошло только {total} байт");
        let avg = total / chunks.max(1);
        assert!(
            avg >= 4 * 1024,
            "вывод идёт мелкими кусками: {chunks} чанков, средний {avg} байт"
        );

        manager.kill("stress").expect("kill после стресса");
    }

    /// Дюжина живых сессий одновременно: все отвечают, kill_all всех убирает.
    #[test]
    fn dozen_concurrent_sessions() {
        const SESSIONS: usize = 12;

        let manager = PtyManager::default();
        let mut outputs = Vec::new();
        let (exit_tx, exit_rx) = mpsc::channel::<()>();

        for index in 0..SESSIONS {
            let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
            let exit_tx = exit_tx.clone();
            manager
                .spawn(
                    SpawnOptions {
                        id: format!("s{index}"),
                        shell: Some(Shell::path()),
                        cwd: test_cwd(),
                        cols: 80,
                        rows: 24,
                        history_dir: None,
                    },
                    move |bytes| {
                        let _ = out_tx.send(bytes);
                    },
                    move |_| {
                        let _ = exit_tx.send(());
                    },
                )
                .expect("сессия должна подняться");
            outputs.push(out_rx);
        }

        for (index, out_rx) in outputs.iter().enumerate() {
            let (command, needle) = Shell::evaluated(index);
            manager
                .write(&format!("s{index}"), &command)
                .expect("запись в сессию");
            wait_for_output(
                &manager,
                &format!("s{index}"),
                out_rx,
                &needle,
                Duration::from_secs(20),
            )
            .expect("сессия должна ответить");
        }

        manager
            .kill_all()
            .expect("kill_all должен дождаться завершения всех сессий");
        for _ in 0..SESSIONS {
            exit_rx
                .recv_timeout(Duration::from_secs(10))
                .expect("после kill_all каждая сессия должна завершиться");
        }
    }

    #[test]
    fn spawn_in_missing_cwd_fails() {
        let manager = PtyManager::default();
        let result = manager.spawn(
            SpawnOptions {
                id: "cwd".into(),
                shell: Some(Shell::path()),
                cwd: Shell::missing_directory(),
                cols: 80,
                rows: 24,
                history_dir: None,
            },
            |_| {},
            |_| {},
        );
        let error = result.expect_err("несуществующая папка должна давать ошибку");
        assert_eq!(error.code, ErrorCode::TerminalCwdUnavailable);
        assert_eq!(error.context["terminalId"], "cwd");
        assert_eq!(
            error.context["path"],
            Shell::missing_directory().display().to_string()
        );
    }

    #[test]
    fn finds_bash_inside_a_git_installation() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("Program Files (x86)").join("Git");
        let installed = dir.path().join("Program Files").join("Git");
        let bash = installed.join("bin").join("bash.exe");
        std::fs::create_dir_all(bash.parent().unwrap()).unwrap();
        std::fs::write(&bash, b"").unwrap();

        // Несуществующий корень пропускается, а не обрывает поиск: у
        // пользователя обычно есть и Program Files, и Program Files (x86).
        assert_eq!(bash_in_git_root(&[missing.clone(), installed]), Some(bash));
        assert_eq!(bash_in_git_root(&[missing]), None);
    }

    #[test]
    fn spawn_bad_shell_fails() {
        let manager = PtyManager::default();
        let result = manager.spawn(
            SpawnOptions {
                id: "t3".into(),
                shell: Some("/nonexistent/shell".into()),
                cwd: test_cwd(),
                cols: 80,
                rows: 24,
                history_dir: None,
            },
            |_| {},
            |_| {},
        );
        let error = result.expect_err("несуществующий шелл должен давать ошибку");
        assert_eq!(error.code, ErrorCode::TerminalShellNotFound);
        assert_eq!(error.context["terminalId"], "t3");
        assert_eq!(error.context["shell"], "/nonexistent/shell");
    }

    #[test]
    fn missing_terminal_has_stable_code() {
        let manager = PtyManager::default();

        let write_error = manager.write("missing", b"x").unwrap_err();
        assert_eq!(write_error.code, ErrorCode::TerminalNotFound);
        assert_eq!(write_error.context["terminalId"], "missing");

        let resize_error = manager.resize("missing", 80, 24).unwrap_err();
        assert_eq!(resize_error.code, ErrorCode::TerminalNotFound);

        let kill_error = manager.kill("missing").unwrap_err();
        assert_eq!(kill_error.code, ErrorCode::TerminalNotFound);
    }

    /// Строка shell приходит из webview. Она обязана оставаться именем одной
    /// программы: ни `;`, ни `&`, ни подстановка, ни дописанный аргумент не
    /// должны исполниться — иначе фронт получает произвольный запуск кода.
    #[test]
    fn spawn_never_runs_the_shell_string_through_an_interpreter() {
        let canary_dir = tempfile::tempdir().expect("временная папка");
        let canary = canary_dir.path().join("pwned.txt");
        let manager = PtyManager::default();

        for attempt in Shell::injection_attempts(&canary) {
            let result = manager.spawn(
                SpawnOptions {
                    id: "inject".into(),
                    shell: Some(attempt.clone()),
                    cwd: test_cwd(),
                    cols: 80,
                    rows: 24,
                    history_dir: None,
                },
                |_| {},
                |_| {},
            );
            let error = result.expect_err(&format!("«{attempt}» не должна запускаться"));
            assert_eq!(error.code, ErrorCode::TerminalShellNotFound, "{attempt}");
            assert_eq!(error.context["shell"], attempt);
            assert_eq!(error.context["terminalId"], "inject");
            assert!(
                manager.write("inject", b"x").is_err(),
                "неудачный spawn не должен оставлять сессию: {attempt}"
            );
        }

        assert!(
            !canary.exists(),
            "часть строки shell выполнилась: {}",
            canary.display()
        );
    }

    /// Папка проходит проверку существования, но программой не является:
    /// запуск обязан провалиться с внятным кодом, а не «умереть» терминалом.
    #[test]
    fn spawn_rejects_a_shell_path_that_is_a_directory() {
        let dir = tempfile::tempdir().expect("временная папка");
        let shell = dir.path().display().to_string();
        let manager = PtyManager::default();

        let result = manager.spawn(
            SpawnOptions {
                id: "dir".into(),
                shell: Some(shell.clone()),
                cwd: test_cwd(),
                cols: 80,
                rows: 24,
                history_dir: None,
            },
            |_| {},
            |_| {},
        );
        let error = result.expect_err("папка не должна запускаться как шелл");
        assert_eq!(error.code, ErrorCode::TerminalSpawnFailed);
        assert_eq!(error.context["shell"], shell);
        assert_eq!(error.context["terminalId"], "dir");
        assert!(manager.write("dir", b"x").is_err(), "сессии быть не должно");
    }

    /// Пустая строка и пробелы не должны молча превращаться в оболочку по
    /// умолчанию: подмену шелла фронт обязан увидеть как ошибку.
    #[test]
    fn spawn_rejects_a_blank_shell_without_falling_back_to_the_default() {
        let manager = PtyManager::default();

        for shell in ["", "   ", "\t"] {
            let result = manager.spawn(
                SpawnOptions {
                    id: "blank".into(),
                    shell: Some(shell.to_string()),
                    cwd: test_cwd(),
                    cols: 80,
                    rows: 24,
                    history_dir: None,
                },
                |_| {},
                |_| {},
            );
            let error = result.expect_err(&format!("«{shell:?}» не должна запускать шелл"));
            // Пустая строка отсекается на разных этапах в зависимости от ОС;
            // важно, что запуска не происходит ни на одной.
            assert!(
                matches!(
                    error.code,
                    ErrorCode::TerminalShellNotFound | ErrorCode::TerminalSpawnFailed
                ),
                "неожиданный код для {shell:?}: {:?}",
                error.code
            );
            assert_eq!(error.context["terminalId"], "blank");
            assert!(
                manager.write("blank", b"x").is_err(),
                "неудачный spawn не должен оставлять сессию: {shell:?}"
            );
        }
    }

    #[test]
    fn spawn_rejects_a_shell_path_with_an_embedded_nul() {
        let manager = PtyManager::default();
        let shell = Shell::nul_path();

        let result = manager.spawn(
            SpawnOptions {
                id: "nul".into(),
                shell: Some(shell.clone()),
                cwd: test_cwd(),
                cols: 80,
                rows: 24,
                history_dir: None,
            },
            |_| {},
            |_| {},
        );
        let error = result.expect_err("путь с NUL не должен запускаться");
        assert_eq!(error.code, ErrorCode::TerminalShellNotFound);
        assert_eq!(error.context["shell"], shell);
        assert!(manager.write("nul", b"x").is_err(), "сессии быть не должно");
    }

    /// Фронт выбирает шелл только из этого списка и возвращает command обратно
    /// в pty_create. Значит, каждый элемент обязан проходить ту же проверку
    /// существования, что и spawn, иначе пользователь получит мёртвый пункт.
    #[test]
    fn available_shells_only_offers_resolvable_commands() {
        let shells = available_shells();
        assert!(!shells.is_empty(), "нужен хотя бы один рабочий шелл");

        let mut seen_ids: Vec<String> = Vec::new();
        for shell in &shells {
            assert!(
                !seen_ids.contains(&shell.id),
                "дубликат id в списке: {}",
                shell.id
            );
            seen_ids.push(shell.id.clone());
            assert!(!shell.id.trim().is_empty(), "пустой id");
            assert!(!shell.label.trim().is_empty(), "пустая подпись");
            assert!(!shell.command.trim().is_empty(), "пустая команда");
            assert!(
                !shell.command.contains('\0') && !shell.command.contains('\n'),
                "команда с управляющими символами: {:?}",
                shell.command
            );
            assert!(
                shell_exists(&shell.command),
                "команда не резолвится: {}",
                shell.command
            );
            let path = std::path::Path::new(&shell.command);
            if path.is_absolute() {
                assert!(path.is_file(), "абсолютный путь не файл: {}", shell.command);
            }
        }
    }

    #[test]
    fn git_bash_is_resolved_from_a_git_installation_root() {
        let root = tempfile::tempdir().expect("временная установка Git");
        let bin = root.path().join("bin");
        std::fs::create_dir(&bin).expect("bin");
        let bash = bin.join("bash.exe");
        std::fs::write(&bash, b"placeholder").expect("bash.exe");

        assert_eq!(bash_in_git_root(&[root.path().to_path_buf()]), Some(bash));
    }

    #[cfg(not(windows))]
    #[test]
    fn git_bash_install_flow_is_explicitly_unsupported_off_windows() {
        assert_eq!(git_bash_availability(), GitBashAvailability::Unsupported);
        let error = install_git_bash().expect_err("установщик только для Windows");
        assert_eq!(error.code, ErrorCode::GitBashInstallUnsupported);
    }

    /// Процесс обязан стартовать ровно в выданной backend-реестром папке:
    /// именно она — граница, за которую терминал не должен выходить сам.
    #[test]
    fn spawn_starts_the_process_in_the_requested_cwd() {
        let dir = tempfile::tempdir().expect("временная папка");
        std::fs::write(dir.path().join("cwd_probe.txt"), b"CWD_9137_OK\n").expect("маркер");

        let manager = PtyManager::default();
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
        manager
            .spawn(
                SpawnOptions {
                    id: "cwd-probe".into(),
                    shell: Some(Shell::path()),
                    cwd: dir.path().to_path_buf(),
                    cols: 80,
                    rows: 24,
                    history_dir: None,
                },
                move |bytes| {
                    let _ = out_tx.send(bytes);
                },
                |_| {},
            )
            .expect("шелл должен запуститься");

        manager
            .write("cwd-probe", &Shell::print_local_file("cwd_probe.txt"))
            .expect("запись в PTY");
        wait_for_output(
            &manager,
            "cwd-probe",
            &out_rx,
            "CWD_9137_OK",
            Duration::from_secs(20),
        )
        .expect("файл виден только из выданной папки");

        let _ = manager.kill("cwd-probe");
    }

    /// Операции по чужому/несуществующему id не должны задевать живую сессию:
    /// скомпрометированный фронт не может погасить соседний терминал опечаткой.
    #[test]
    fn unknown_terminal_operations_never_touch_a_live_session() {
        let manager = PtyManager::default();
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
        let (exit_tx, exit_rx) = mpsc::channel::<Option<i32>>();
        manager
            .spawn(
                SpawnOptions {
                    id: "live".into(),
                    shell: Some(Shell::path()),
                    cwd: test_cwd(),
                    cols: 80,
                    rows: 24,
                    history_dir: None,
                },
                move |bytes| {
                    let _ = out_tx.send(bytes);
                },
                move |code| {
                    let _ = exit_tx.send(code);
                },
            )
            .expect("шелл должен запуститься");

        for ghost in ["", "live ", "LIVE", "../live", "live\0", "l"] {
            assert_eq!(
                manager.write(ghost, b"exit\n").unwrap_err().code,
                ErrorCode::TerminalNotFound,
                "{ghost:?}"
            );
            assert_eq!(
                manager.resize(ghost, 10, 10).unwrap_err().code,
                ErrorCode::TerminalNotFound,
                "{ghost:?}"
            );
            let kill_error = manager.kill(ghost).unwrap_err();
            assert_eq!(kill_error.code, ErrorCode::TerminalNotFound, "{ghost:?}");
            assert_eq!(kill_error.context["terminalId"], ghost);
        }

        assert!(
            exit_rx.try_recv().is_err(),
            "живая сессия не должна была завершиться"
        );
        let (command, needle) = Shell::evaluated(2);
        manager
            .write("live", &command)
            .expect("запись в живую сессию");
        wait_for_output(&manager, "live", &out_rx, &needle, Duration::from_secs(20))
            .expect("живая сессия должна ответить");

        manager.kill("live").expect("kill живой сессии");
        exit_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("после kill процесс должен завершиться");
        // Повторный kill — стабильная ошибка, а не паника и не чужая сессия.
        assert_eq!(
            manager.kill("live").unwrap_err().code,
            ErrorCode::TerminalNotFound
        );
    }

    /// Размеры приходят из webview. Ноль и предельное значение не должны ни
    /// ронять spawn/resize, ни оставлять сессию неуправляемой.
    #[test]
    fn absurd_terminal_dimensions_never_panic_or_wedge_the_session() {
        let manager = PtyManager::default();
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
        manager
            .spawn(
                SpawnOptions {
                    id: "dim".into(),
                    shell: Some(Shell::path()),
                    cwd: test_cwd(),
                    cols: 0,
                    rows: 0,
                    history_dir: None,
                },
                move |bytes| {
                    let _ = out_tx.send(bytes);
                },
                |_| {},
            )
            .expect("нулевой размер должен поджиматься, а не ронять spawn");

        manager
            .resize("dim", 0, 0)
            .expect("нулевой ресайз поджимается до минимума");
        // Верхнюю границу PTY-слой не задаёт: unix такой размер принимает,
        // ConPTY отвергает. Важно, что ни то, ни другое не рвёт сессию.
        let _ = manager.resize("dim", u16::MAX, u16::MAX);
        manager
            .resize("dim", 80, 24)
            .expect("после абсурдных размеров сессия должна остаться живой");

        let (command, needle) = Shell::evaluated(3);
        manager
            .write("dim", &command)
            .expect("запись после ресайзов");
        wait_for_output(&manager, "dim", &out_rx, &needle, Duration::from_secs(20))
            .expect("шелл должен отвечать после абсурдных размеров");

        manager.kill("dim").expect("kill после ресайзов");
    }

    /// Вставка большого куска — одна запись из множества целых строк. Объём
    /// держим в пределах буфера ввода tty: write держит общий мьютекс сессий,
    /// и на большем куске тест проверял бы уже не доставку, а блокировку.
    #[test]
    fn a_paste_sized_write_reaches_the_shell_without_breaking_it() {
        const LINES: usize = if cfg!(windows) { 20 } else { 48 };

        let manager = PtyManager::default();
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
        manager
            .spawn(
                SpawnOptions {
                    id: "paste".into(),
                    shell: Some(Shell::path()),
                    cwd: test_cwd(),
                    cols: 120,
                    rows: 40,
                    history_dir: None,
                },
                move |bytes| {
                    let _ = out_tx.send(bytes);
                },
                |_| {},
            )
            .expect("шелл должен запуститься");

        let (command, needle) = Shell::evaluated(4);
        let mut payload = Vec::new();
        for _ in 0..LINES {
            payload.extend_from_slice(&Shell::padding_line());
        }
        payload.extend_from_slice(&command);
        assert!(
            payload.len() > 1000,
            "кусок должен быть заметно больше одной строки"
        );

        manager
            .write("paste", &payload)
            .expect("одна крупная запись должна дойти целиком");
        wait_for_output(&manager, "paste", &out_rx, &needle, Duration::from_secs(60))
            .expect("хвост крупной вставки должен исполниться");

        // Сессия не «съехала»: следующая команда исполняется как обычно.
        let (next, next_needle) = Shell::evaluated(5);
        manager.write("paste", &next).expect("запись после вставки");
        wait_for_output(
            &manager,
            "paste",
            &out_rx,
            &next_needle,
            Duration::from_secs(20),
        )
        .expect("сессия должна остаться рабочей");

        manager.kill("paste").expect("kill после вставки");
    }

    /// Маркеры запускавшего агента вычищаются по точному имени и по префиксу
    /// (см. spawn). Проверяем обе ветки правила, а не только CLAUDECODE.
    #[test]
    fn agent_effort_and_prefixed_markers_never_reach_the_terminal() {
        std::env::set_var("CLAUDE_EFFORT", "leak-effort");
        std::env::set_var("CLAUDE_CODE_MC_PROBE", "leak-probe");

        let manager = PtyManager::default();
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
        manager
            .spawn(
                SpawnOptions {
                    id: "t-env2".into(),
                    shell: Some(Shell::path()),
                    cwd: test_cwd(),
                    cols: 80,
                    rows: 24,
                    history_dir: None,
                },
                move |bytes| {
                    let _ = out_tx.send(bytes);
                },
                |_| {},
            )
            .expect("шелл должен запуститься");

        for line in Shell::evaluated_env_probe(&["CLAUDE_EFFORT", "CLAUDE_CODE_MC_PROBE"]) {
            manager.write("t-env2", &line).expect("запись в PTY");
        }
        let output = wait_for_output(
            &manager,
            "t-env2",
            &out_rx,
            Shell::EVALUATED_PROBE,
            Duration::from_secs(20),
        )
        .expect("эхо из шелла");

        assert!(
            !output.contains("leak-effort") && !output.contains("leak-probe"),
            "маркеры агента протекли в терминал: {output}"
        );
        #[cfg(unix)]
        assert!(
            output.contains("PROBE_OK_clean_clean"),
            "шелл должен видеть обе переменные пустыми: {output}"
        );

        let _ = manager.kill("t-env2");
    }

    /// id панели приходит из webview и попадает в значение переменной
    /// fish_history. В окружение он обязан уходить только алфавитно-цифровым:
    /// иначе туда уезжают метасимволы и подстановки.
    #[test]
    fn hostile_terminal_id_reaches_the_shell_environment_sanitized() {
        let history = tempfile::tempdir().expect("временная папка");
        let manager = PtyManager::default();
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
        manager
            .spawn(
                SpawnOptions {
                    id: "p1/../$(id)".into(),
                    shell: Some(Shell::path()),
                    cwd: test_cwd(),
                    cols: 80,
                    rows: 24,
                    history_dir: Some(history.path().to_path_buf()),
                },
                move |bytes| {
                    let _ = out_tx.send(bytes);
                },
                |_| {},
            )
            .expect("шелл должен запуститься");

        for line in Shell::evaluated_env_probe(&["fish_history"]) {
            manager.write("p1/../$(id)", &line).expect("запись в PTY");
        }
        let output = wait_for_output(
            &manager,
            "p1/../$(id)",
            &out_rx,
            Shell::EVALUATED_PROBE,
            Duration::from_secs(20),
        )
        .expect("эхо из шелла");

        assert!(
            output.contains("PROBE_OK_mcp1id"),
            "id попал в окружение неочищенным: {output}"
        );
        #[cfg(unix)]
        assert!(
            !output.contains("uid="),
            "подстановка из id выполнилась шеллом: {output}"
        );

        let _ = manager.kill("p1/../$(id)");
    }
}
