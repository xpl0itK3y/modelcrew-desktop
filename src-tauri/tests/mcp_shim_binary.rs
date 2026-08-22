//! Шим MCP запускается как настоящая программа — здесь это и проверяется.
//!
//! Разбор протокола и разговор на сокете покрыты юнит-тестами, но они зовут
//! функции внутри процесса. Агент же запускает собранный бинарь: с флагом из
//! своего конфига, адресом сокета и пропуском панели в окружении, с запросами
//! на stdin и ответами со stdout. Ломается обычно именно этот стык — потерянное
//! рукопожатие или нулевой код возврата выглядят точно так же, как «агент не
//! видит инструментов».

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const APP: &str = env!("CARGO_BIN_EXE_modelcrew-desktop");

fn socket_path(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("mc-shim-{name}-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    path
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

fn well_known_socket(home: &Path) -> PathBuf {
    home.join(if cfg!(target_os = "macos") {
        "Library/Application Support"
    } else {
        ".local/share"
    })
    .join("com.modelcrew.desktop")
    .join("mcp.sock")
}

#[test]
fn finds_the_socket_itself_when_nobody_told_it_the_address() {
    // cursor чистит окружение перед запуском MCP-сервера: ни адреса, ни
    // пропуска шим не получает. Адрес он обязан вычислить сам, иначе
    // постоянная регистрация у такого агента не заработает вовсе.
    let home = fake_home("plain");
    let socket = well_known_socket(&home);
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).unwrap();

    let served = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
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
    let socket = socket_path("ok");
    let listener = UnixListener::bind(&socket).unwrap();

    // Приложение на том конце: читает рукопожатие, затем запросы.
    let served = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
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

    let _ = std::fs::remove_file(&socket);
}

#[test]
fn says_out_loud_that_it_was_not_let_in() {
    let socket = socket_path("closed");
    let listener = UnixListener::bind(&socket).unwrap();

    // Приложение закрывает соединение сразу: пропуск ни с одной панелью не
    // сошёлся — ровно то, что видит агент чужой или закрытой панели.
    let served = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        drop(stream);
    });

    let mut child = shim(&socket, Some("pass-nobody-knows"));
    let mut stdin = child.stdin.take().unwrap();
    // Пишем, пока пишется: разорванное соединение шим обязан заметить сам.
    for _ in 0..50 {
        if stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n")
            .and_then(|()| stdin.flush())
            .is_err()
        {
            break;
        }
    }
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    served.join().unwrap();

    // Ноль здесь означал бы «сервер завершился успешно и молча»: агент решил
    // бы, что инструментов просто нет, и причины не узнал бы никто.
    assert_ne!(out.status.code(), Some(0));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("ModelCrew MCP"), "{stderr}");
    assert!(out.stdout.is_empty(), "в stdout попало лишнее");

    let _ = std::fs::remove_file(&socket);
}

#[test]
fn goes_on_without_a_pass_and_lets_the_application_work_out_who_called() {
    // Пропуска нет — так приходит агент, которому вычистили окружение
    // (cursor), и так же будет приходить любой при постоянной регистрации:
    // конфиг один на проект, а панелей у проекта много. Падать здесь значит
    // не дать приложению даже попытаться опознать звонящего по процессам.
    let socket = socket_path("nopass");
    let listener = UnixListener::bind(&socket).unwrap();

    let served = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
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

    let _ = std::fs::remove_file(&socket);
}
