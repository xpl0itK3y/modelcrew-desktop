use crate::command_error::{CommandError, CommandResult, ErrorCode};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Вывод копится и уходит во фронт пачками: либо раз в BATCH_WINDOW,
/// либо при достижении MAX_BATCH_BYTES. Побайтовая отправка через IPC —
/// главный источник лагов.
const BATCH_WINDOW: Duration = Duration::from_millis(8);
const MAX_BATCH_BYTES: usize = 32 * 1024;
const READ_BUF_BYTES: usize = 8 * 1024;
const KILL_ALL_TIMEOUT: Duration = Duration::from_secs(5);

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
                    .map(|pid| (id.clone(), pid as i32))
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct ShellInfo {
    pub id: String,
    pub label: String,
    pub command: String,
}

/// Bash из установки Git for Windows. Искать его только в PATH бесполезно:
/// установщик по умолчанию добавляет туда каталог с `git.exe`, а `bash.exe`
/// лежит рядом, в `bin`. Поэтому у большинства пользователей bash установлен,
/// но обычным поиском не находится.
#[cfg_attr(not(windows), allow(dead_code))]
fn bash_in_git_install(roots: &[PathBuf]) -> Option<PathBuf> {
    roots
        .iter()
        .map(|root| root.join("Git").join("bin").join("bash.exe"))
        .find(|candidate| candidate.is_file())
}

#[cfg(windows)]
fn windows_git_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    // ProgramW6432 указывает на 64-битный Program Files даже из 32-битного
    // процесса; остальные покрывают обычную и 32-битную установки.
    for variable in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(value) = std::env::var_os(variable) {
            roots.push(PathBuf::from(value));
        }
    }
    // Установка «только для меня» кладёт Git в профиль пользователя.
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Programs"));
    }
    roots
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
        let (label, command) = match bash_in_git_install(&windows_git_roots()) {
            Some(path) => ("Git Bash", path.display().to_string()),
            None if shell_exists("bash.exe") => ("Bash", "bash.exe".to_string()),
            None => return shells,
        };
        shells.push(ShellInfo {
            id: "bash".to_string(),
            label: label.to_string(),
            command,
        });
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
        let without_git = dir.path().join("empty");
        std::fs::create_dir_all(&without_git).unwrap();
        let program_files = dir.path().join("Program Files");
        let bash = program_files.join("Git").join("bin").join("bash.exe");
        std::fs::create_dir_all(bash.parent().unwrap()).unwrap();
        std::fs::write(&bash, b"").unwrap();

        // Корень без Git пропускается, а не обрывает поиск: у пользователя
        // обычно есть и Program Files, и Program Files (x86).
        assert_eq!(
            bash_in_git_install(&[without_git.clone(), program_files]),
            Some(bash)
        );
        assert_eq!(bash_in_git_install(&[without_git]), None);
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
}
