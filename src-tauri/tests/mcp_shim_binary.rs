//! Шим MCP запускается как настоящая программа — здесь это и проверяется.
//!
//! Разбор протокола и разговор на сокете покрыты юнит-тестами, но они зовут
//! функции внутри процесса. Агент же запускает собранный бинарь: с флагом из
//! своего конфига, адресом сокета и пропуском панели в окружении, с запросами
//! на stdin и ответами со stdout. Ломается обычно именно этот стык — потерянное
//! рукопожатие или молчание вместо ответа выглядят точно так же, как «агент не
//! видит инструментов».

#![cfg(any(unix, windows))]

use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use app::Listener;

const APP: &str = env!("CARGO_BIN_EXE_modelcrew-desktop");

/// Приложение на том конце — без приложения: только вход, через который к нему
/// приходит шим. Свой адрес каждому тесту: тесты идут параллельно.
#[cfg(unix)]
mod app {
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};

    pub fn address(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("mc-shim-{name}-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    /// Файл сокета переживает слушателя — убираем сами.
    pub fn forget(address: &Path) {
        let _ = std::fs::remove_file(address);
    }

    pub struct Listener(UnixListener);

    impl Listener {
        pub fn bind(address: &Path) -> Self {
            Self(UnixListener::bind(address).unwrap())
        }

        /// Одно соединение, и больше слушатель не нужен: уходя, он закрывает
        /// вход, и следующий стук шима получает отказ.
        pub fn accept(self) -> UnixStream {
            self.0.accept().unwrap().0
        }
    }
}

/// На Windows вход — именованный канал. Свой, а не тот, что поднимает
/// приложение: тест проверяет шим, и сервер на том конце должен быть
/// простейшим. Пускать ли шим, решает уже шим: он сверяет, что канал держит
/// процесс того же пользователя, — тест им и является.
#[cfg(windows)]
mod app {
    use std::fs::File;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::{Path, PathBuf};
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    pub fn address(name: &str) -> PathBuf {
        PathBuf::from(format!(
            r"\\.\pipe\com.modelcrew.desktop.test.shim-{name}-{}",
            std::process::id()
        ))
    }

    /// Канал исчезает с последним дескриптором — убирать нечего.
    pub fn forget(_address: &Path) {}

    /// Единственный экземпляр канала. Другого нет, и когда этот закроется,
    /// следующий стук шима услышит «канала нет» — как от закрытого приложения.
    pub struct Listener(OwnedHandle);

    impl Listener {
        pub fn bind(address: &Path) -> Self {
            let name: Vec<u16> = address.as_os_str().encode_wide().chain([0]).collect();
            let handle = unsafe {
                CreateNamedPipeW(
                    name.as_ptr(),
                    PIPE_ACCESS_DUPLEX,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                    1,
                    64 * 1024,
                    64 * 1024,
                    0,
                    null(),
                )
            };
            assert_ne!(
                handle,
                INVALID_HANDLE_VALUE,
                "{}",
                std::io::Error::last_os_error()
            );
            Self(unsafe { OwnedHandle::from_raw_handle(handle) })
        }

        pub fn accept(self) -> File {
            if unsafe { ConnectNamedPipe(self.0.as_raw_handle(), null_mut()) } == 0 {
                // Шим успел соединиться раньше, чем мы начали ждать.
                let error = std::io::Error::last_os_error();
                assert_eq!(
                    error.raw_os_error(),
                    Some(ERROR_PIPE_CONNECTED as i32),
                    "{error}"
                );
            }
            File::from(self.0)
        }
    }
}

fn shim(socket: &PathBuf, token: Option<&str>) -> std::process::Child {
    let mut command = Command::new(APP);
    command
        .arg("--mcp-stdio")
        .env("MODELCREW_MCP_SOCK", socket)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match token {
        Some(token) => command.env("MODELCREW_MCP_TOKEN", token),
        // Не `remove_env`: переменная могла достаться нам от запускающей
        // панели, и тогда шим взял бы чужой пропуск вместо никакого.
        None => command.env("MODELCREW_MCP_TOKEN", ""),
    };
    command
        .spawn()
        .expect("шим обязан запускаться как программа")
}

/// Подставной домашний каталог с сокетом там, где его кладёт приложение.
/// Короткий и в `/tmp` намеренно: `sun_path` — 104 байта на macOS, а обычный
/// временный каталог там начинается с `/var/folders/…` и один только префикс
/// съедает половину.
#[cfg(unix)]
fn fake_home(name: &str) -> PathBuf {
    let home = PathBuf::from(format!("/tmp/mc-home-{name}-{}", std::process::id()));
    let data = home
        .join(if cfg!(target_os = "macos") {
            "Library/Application Support"
        } else {
            ".local/share"
        })
        .join("com.modelcrew.desktop");
    std::fs::create_dir_all(&data).unwrap();
    home
}

#[cfg(unix)]
fn well_known_socket(home: &Path) -> PathBuf {
    home.join(if cfg!(target_os = "macos") {
        "Library/Application Support"
    } else {
        ".local/share"
    })
    .join("com.modelcrew.desktop")
    .join("mcp.sock")
}

// Только unix: на Windows известный адрес — канал, общий на всю машину, и
// запущенный рядом ModelCrew ответил бы шиму вместо теста.
#[cfg(unix)]
#[test]
fn finds_the_socket_itself_when_nobody_told_it_the_address() {
    // cursor чистит окружение перед запуском MCP-сервера: ни адреса, ни
    // пропуска шим не получает. Адрес он обязан вычислить сам, иначе
    // постоянная регистрация у такого агента не заработает вовсе.
    let home = fake_home("plain");
    let socket = well_known_socket(&home);
    let _ = std::fs::remove_file(&socket);
    let listener = Listener::bind(&socket);

    let served = std::thread::spawn(move || {
        let stream = listener.accept();
        let mut out = stream.try_clone().unwrap();
        let mut lines = BufReader::new(stream).lines();
        let handshake = lines.next().unwrap().unwrap();
        let _request = lines.next().unwrap().unwrap();
        out.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n")
            .unwrap();
        out.flush().unwrap();
        handshake
    });

    let mut child = Command::new(APP)
        .arg("--mcp-stdio")
        .env("HOME", &home)
        .env_remove("XDG_DATA_HOME")
        .env_remove("MODELCREW_MCP_SOCK")
        .env("MODELCREW_MCP_TOKEN", "pass-of-panel-a")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n")
        .unwrap();
    stdin.flush().unwrap();

    let answer = BufReader::new(child.stdout.take().unwrap())
        .lines()
        .next()
        .expect("шим обязан вернуть ответ на stdout")
        .unwrap();
    drop(stdin);
    child.wait().unwrap();

    assert_eq!(served.join().unwrap(), r#"{"token":"pass-of-panel-a"}"#);
    assert!(answer.contains("\"ok\":true"), "{answer}");

    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn carries_the_pass_of_its_panel_and_brings_the_answer_back() {
    let socket = app::address("ok");
    let listener = Listener::bind(&socket);

    // Приложение на том конце: читает рукопожатие, затем запросы.
    let served = std::thread::spawn(move || {
        let stream = listener.accept();
        let mut out = stream.try_clone().unwrap();
        let mut lines = BufReader::new(stream).lines();
        let handshake = lines.next().unwrap().unwrap();
        let request = lines.next().unwrap().unwrap();
        out.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n")
            .unwrap();
        out.flush().unwrap();
        (handshake, request)
    });

    let mut child = shim(&socket, Some("pass-of-panel-a"));
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n")
        .unwrap();
    stdin.flush().unwrap();

    let answer = BufReader::new(child.stdout.take().unwrap())
        .lines()
        .next()
        .expect("шим обязан вернуть ответ на stdout")
        .unwrap();
    drop(stdin);
    let status = child.wait().unwrap();

    let (handshake, request) = served.join().unwrap();
    // Первая строка — пропуск панели, а не её имя: по нему приложение и
    // находит, чей это агент.
    assert_eq!(handshake, r#"{"token":"pass-of-panel-a"}"#);
    assert!(request.contains("initialize"), "{request}");
    assert!(answer.contains("\"ok\":true"), "{answer}");
    assert_eq!(status.code(), Some(0));

    app::forget(&socket);
}

#[test]
fn says_out_loud_that_it_was_not_let_in() {
    let socket = app::address("closed");
    let listener = Listener::bind(&socket);

    // Приложение закрывает соединение сразу: пропуск ни с одной панелью не
    // сошёлся — ровно то, что видит агент чужой или закрытой панели. Второго
    // соединения оно уже не примет: слушатель уходит вместе с потоком.
    let served = std::thread::spawn(move || {
        let stream = listener.accept();
        drop(stream);
    });

    let mut child = shim(&socket, Some("pass-nobody-knows"));
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(
            concat!(
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n",
                "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",",
                "\"params\":{\"name\":\"browser_navigate\",",
                "\"arguments\":{\"url\":\"http://localhost:1420\"}}}\n",
            )
            .as_bytes(),
        )
        .unwrap();
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    served.join().unwrap();

    // Ненулевой код клиент читает как «сервер сломался» и больше к нему не
    // возвращается. Сломаться здесь может только связь, и о ней шим говорит
    // словами — в ответе на вызов.
    assert_eq!(out.status.code(), Some(0));
    let answers: Vec<serde_json::Value> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(answers.len(), 2, "на каждый запрос — ответ: {answers:?}");

    // Рукопожатие шим держит сам: сессия не должна умирать оттого, что
    // приложение не пустило.
    assert_eq!(answers[0]["id"], 1);
    assert!(answers[0]["result"]["protocolVersion"].is_string(), "{}", answers[0]);

    // Вызов — отказ инструмента с причиной, а не тишина и не поломка протокола.
    assert_eq!(answers[1]["id"], 2);
    assert_eq!(answers[1]["result"]["isError"], true, "{}", answers[1]);
    let reason = answers[1]["result"]["content"][0]["text"].as_str().unwrap();
    assert!(reason.contains("ModelCrew сейчас недоступен"), "{reason}");

    app::forget(&socket);
}

#[test]
fn goes_on_without_a_pass_and_lets_the_application_work_out_who_called() {
    // Пропуска нет — так приходит агент, которому вычистили окружение
    // (cursor), и так же будет приходить любой при постоянной регистрации:
    // конфиг один на проект, а панелей у проекта много. Падать здесь значит
    // не дать приложению даже попытаться опознать звонящего по процессам.
    let socket = app::address("nopass");
    let listener = Listener::bind(&socket);

    let served = std::thread::spawn(move || {
        let stream = listener.accept();
        let mut out = stream.try_clone().unwrap();
        let mut lines = BufReader::new(stream).lines();
        let handshake = lines.next().unwrap().unwrap();
        let _request = lines.next().unwrap().unwrap();
        out.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n")
            .unwrap();
        out.flush().unwrap();
        handshake
    });

    let mut child = shim(&socket, None);
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n")
        .unwrap();
    stdin.flush().unwrap();

    let answer = BufReader::new(child.stdout.take().unwrap())
        .lines()
        .next()
        .expect("шим обязан вернуть ответ на stdout")
        .unwrap();
    drop(stdin);
    let status = child.wait().unwrap();

    // Рукопожатие всё равно есть, просто пустое: приложение по нему видит,
    // что пропуска нет, и переходит к опознанию по родне процессов.
    assert_eq!(served.join().unwrap(), r#"{"token":""}"#);
    assert!(answer.contains("\"ok\":true"), "{answer}");
    assert_eq!(status.code(), Some(0));

    app::forget(&socket);
}
