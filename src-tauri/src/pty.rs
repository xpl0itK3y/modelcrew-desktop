use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;

/// Вывод копится и уходит во фронт пачками: либо раз в BATCH_WINDOW,
/// либо при достижении MAX_BATCH_BYTES. Побайтовая отправка через IPC —
/// главный источник лагов.
const BATCH_WINDOW: Duration = Duration::from_millis(8);
const MAX_BATCH_BYTES: usize = 32 * 1024;
const READ_BUF_BYTES: usize = 8 * 1024;

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
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyManager {
    pub fn spawn(
        &self,
        opts: SpawnOptions,
        on_output: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> Result<(), String> {
        {
            let sessions = self.sessions.lock().unwrap();
            if sessions.contains_key(&opts.id) {
                return Err(format!("терминал {} уже существует", opts.id));
            }
        }

        let pty = native_pty_system()
            .openpty(PtySize {
                rows: opts.rows.max(2),
                cols: opts.cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("не удалось открыть PTY: {e}"))?;

        let shell = opts.shell.unwrap_or_else(default_shell);
        // fork/exec не сообщает об отсутствии бинарника синхронно — проверяем сами,
        // чтобы фронт получил внятный Err, а не мгновенно «умерший» терминал.
        if !shell_exists(&shell) {
            return Err(format!("шелл не найден: {shell}"));
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
            return Err(format!("папка недоступна: {}", opts.cwd.display()));
        }
        cmd.cwd(&opts.cwd);

        let mut child = pty
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("не удалось запустить {shell}: {e}"))?;
        // Слейв закрываем сразу: EOF ридера тогда означает завершение шелла.
        drop(pty.slave);

        let killer = child.clone_killer();
        let mut reader = pty
            .master
            .try_clone_reader()
            .map_err(|e| format!("не удалось получить поток вывода: {e}"))?;
        let writer = pty
            .master
            .take_writer()
            .map_err(|e| format!("не удалось получить поток ввода: {e}"))?;

        self.sessions.lock().unwrap().insert(
            opts.id.clone(),
            PtySession {
                master: pty.master,
                writer,
                killer,
            },
        );

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

        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code() as i32);
            on_exit(code);
        });

        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| format!("терминал {id} не найден"))?;
        session
            .writer
            .write_all(data)
            .map_err(|e| format!("ошибка записи в терминал {id}: {e}"))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(id)
            .ok_or_else(|| format!("терминал {id} не найден"))?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("ошибка ресайза терминала {id}: {e}"))
    }

    /// Убивает процесс и снимает сессию. Закрытие мастера обрывает ридер.
    pub fn kill(&self, id: &str) -> Result<(), String> {
        let session = self.sessions.lock().unwrap().remove(id);
        match session {
            Some(mut session) => {
                let _ = session.killer.kill();
                Ok(())
            }
            None => Err(format!("терминал {id} не найден")),
        }
    }

    /// Уборка после самостоятельного завершения процесса.
    pub fn remove(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
    }

    /// PID процесса переднего плана каждого живого терминала (для имён панелей).
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

    pub fn kill_all(&self) {
        let sessions: Vec<PtySession> = {
            let mut map = self.sessions.lock().unwrap();
            map.drain().map(|(_, s)| s).collect()
        };
        for mut session in sessions {
            let _ = session.killer.kill();
        }
    }
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
        assert!(manager.write("t2", b"x").is_err(), "сессия должна быть снята");
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

        manager.kill_all();
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
        assert!(error.contains("папка недоступна"), "ошибка: {error}");
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
        assert!(result.is_err());
    }
}
