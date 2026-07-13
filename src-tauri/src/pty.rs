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
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
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
    ) -> CommandResult<()> {
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

        Ok(())
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

    /// Windows пока не запрашивает имена foreground-процессов: реализация
    /// process_names на этой платформе всё равно возвращает пустой набор.
    #[cfg(not(unix))]
    pub fn foreground_processes(&self) -> Vec<(String, i32)> {
        Vec::new()
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

/// Оболочки, реально доступные на этой ОС — фронт покажет только их, чтобы
/// пользователь не выбрал отсутствующую. Кроссплатформенно: unix и windows
/// перебирают разные наборы.
pub fn available_shells() -> Vec<ShellInfo> {
    #[cfg(windows)]
    let candidates: &[(&str, &str, &str)] = &[
        ("powershell", "PowerShell", "powershell.exe"),
        ("pwsh", "PowerShell 7", "pwsh.exe"),
        ("cmd", "Command Prompt", "cmd.exe"),
        ("bash", "Bash", "bash.exe"),
    ];
    #[cfg(not(windows))]
    let candidates: &[(&str, &str, &str)] = &[
        ("zsh", "Zsh", "zsh"),
        ("bash", "Bash", "bash"),
        ("sh", "Sh", "sh"),
        ("fish", "Fish", "fish"),
    ];
    candidates
        .iter()
        .filter(|(_, _, command)| shell_exists(command))
        .map(|(id, label, command)| ShellInfo {
            id: (*id).to_string(),
            label: (*label).to_string(),
            command: (*command).to_string(),
        })
        .collect()
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

    fn test_cwd() -> PathBuf {
        std::env::current_dir().expect("тестам нужна текущая папка")
    }

    fn wait_for_output(
        rx: &mpsc::Receiver<Vec<u8>>,
        needle: &str,
        timeout: Duration,
    ) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        let mut collected = String::new();
        while Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                collected.push_str(&String::from_utf8_lossy(&chunk));
                if collected.contains(needle) {
                    return Ok(collected);
                }
            }
        }
        Err(format!("не дождались «{needle}», получено: {collected:?}"))
    }

    #[test]
    fn shell_roundtrip_and_exit() {
        let manager = PtyManager::default();
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
        let (exit_tx, exit_rx) = mpsc::channel::<Option<i32>>();

        manager
            .spawn(
                SpawnOptions {
                    id: "t1".into(),
                    shell: Some("/bin/sh".into()),
                    cwd: test_cwd(),
                    cols: 80,
                    rows: 24,
                },
                move |bytes| {
                    let _ = out_tx.send(bytes);
                },
                move |code| {
                    let _ = exit_tx.send(code);
                },
            )
            .expect("шелл должен запуститься");

        manager
            .write("t1", b"echo MARKER_$((40 + 2))\n")
            .expect("запись в PTY");
        let output =
            wait_for_output(&out_rx, "MARKER_42", Duration::from_secs(10)).expect("эхо из шелла");
        assert!(output.contains("MARKER_42"));

        manager.resize("t1", 100, 30).expect("ресайз живого PTY");

        manager.write("t1", b"exit 7\n").expect("запись exit");
        let code = exit_rx
            .recv_timeout(Duration::from_secs(10))
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
                    shell: Some("/bin/sh".into()),
                    cwd: test_cwd(),
                    cols: 80,
                    rows: 24,
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
                    shell: Some("/bin/sh".into()),
                    cwd: test_cwd(),
                    cols: 80,
                    rows: 24,
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
                    shell: Some("/bin/sh".into()),
                    cwd: test_cwd(),
                    cols: 80,
                    rows: 24,
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
        manager
            .write("r1", b"echo AGAIN_$((1 + 1))\n")
            .expect("запись в заменённую сессию");
        wait_for_output(&fresh_out_rx, "AGAIN_2", Duration::from_secs(10))
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
    fn fifty_megabytes_arrive_batched() {
        const PAYLOAD: usize = 50 * 1024 * 1024;

        let manager = PtyManager::default();
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();

        manager
            .spawn(
                SpawnOptions {
                    id: "stress".into(),
                    shell: Some("/bin/sh".into()),
                    cwd: test_cwd(),
                    cols: 120,
                    rows: 40,
                },
                move |bytes| {
                    let _ = out_tx.send(bytes);
                },
                |_| {},
            )
            .expect("шелл должен запуститься");

        // Маркер вычисляется шеллом, иначе он поймается в эхе самой команды.
        manager
            .write(
                "stress",
                format!(
                    "dd if=/dev/zero bs=1048576 count={} 2>/dev/null; echo STRESS_$((1300 + 37))\n",
                    PAYLOAD / 1048576
                )
                .as_bytes(),
            )
            .expect("запись команды");

        let deadline = Instant::now() + Duration::from_secs(60);
        let mut total = 0usize;
        let mut chunks = 0usize;
        let mut tail: Vec<u8> = Vec::new();
        loop {
            assert!(Instant::now() < deadline, "50 МБ не дошли за 60 секунд");
            let Ok(chunk) = out_rx.recv_timeout(Duration::from_secs(5)) else {
                panic!(
                    "поток вывода заглох (получено {total} байт), хвост: {:?}",
                    String::from_utf8_lossy(&tail)
                );
            };
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
                        shell: Some("/bin/sh".into()),
                        cwd: test_cwd(),
                        cols: 80,
                        rows: 24,
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
            manager
                .write(
                    &format!("s{index}"),
                    format!("echo PING_$(({index} + 100))\n").as_bytes(),
                )
                .expect("запись в сессию");
            wait_for_output(
                out_rx,
                &format!("PING_{}", index + 100),
                Duration::from_secs(10),
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
                shell: Some("/bin/sh".into()),
                cwd: PathBuf::from("/nonexistent/workspace/folder"),
                cols: 80,
                rows: 24,
            },
            |_| {},
            |_| {},
        );
        let error = result.expect_err("несуществующая папка должна давать ошибку");
        assert_eq!(error.code, ErrorCode::TerminalCwdUnavailable);
        assert_eq!(error.context["terminalId"], "cwd");
        assert_eq!(error.context["path"], "/nonexistent/workspace/folder");
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
