//! Шим: агент говорит с ним по stdio, он передаёт всё в сокет приложения —
//! на Windows в именованный канал.
//!
//! Это то же самое приложение, запущенное с `--mcp-stdio`, — ровно тот приём,
//! которым уже работают хуки на Windows: exe запускает любая оболочка, а
//! отдельный бинарник пришлось бы собирать, подписывать и класть в пакет.
//!
//! Шим намеренно глуп: разбор JSON-RPC живёт в `mcp.rs`, здесь его нет — иначе
//! протокол пришлось бы поддерживать в двух местах, и они разъехались бы при
//! первой же правке. Своё у него ровно одно — рукопожатие: первой строкой он
//! предъявляет пропуск панели, из окружения которой запущен.
//!
//! И одно свойство, ради которого он написан именно так: **шим не уходит**.
//! Сервер MCP клиент запускает один раз за сессию агента и заново его не
//! поднимает. Вышедший шим — это сервер, пропавший для агента навсегда, и
//! щелчок выключателя обратно уже ничего не вернёт; живьём это выглядело как
//! «выключил плагин, включил — клод его больше не видит». Поэтому связь с
//! приложением здесь не постоянная, а восстанавливаемая: каждый запрос либо
//! доходит до приложения, либо получает ответ от самого шима, а следующий
//! пробует связаться заново.

use std::io::{BufRead, BufReader, Write};

use crate::mcp;

/// Запуск шимом. `None` — запуск обычный, приложение должно подниматься.
pub fn run_if_shim() -> Option<i32> {
    if !is_shim(std::env::args()) {
        return None;
    }
    Some(run())
}

fn is_shim<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .nth(1)
        .is_some_and(|arg| arg.as_ref() == mcp::STDIO_FLAG)
}

#[cfg(any(unix, windows))]
fn run() -> i32 {
    // Окружение — первый и точный источник: только оно знает адрес, если сокет
    // ушёл во временный каталог. Но полагаться на него одно нельзя: cursor
    // чистит окружение перед запуском MCP-сервера, и тогда адрес приходится
    // вычислять самим.
    let path = std::env::var_os(mcp::SOCK_ENV)
        .map(std::path::PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(mcp::well_known_socket_path);
    if path.is_none() {
        // Не смертельно: разговор состоится и без приложения, просто целиком
        // нашими силами. Но строка в журнале — единственный способ для
        // человека узнать, почему инструменты молчат при любом выключателе.
        eprintln!(
            "ModelCrew MCP: {} не задана, а свой адрес вычислить не вышло — стучаться некуда.",
            mcp::SOCK_ENV
        );
    }
    // Пропуска может и не быть: cursor чистит окружение перед запуском
    // MCP-сервера, а при постоянной регистрации конфиг один на проект, и
    // пропуск конкретной панели туда класть некуда. Тогда приложение узнаёт
    // панель по тому, из кого мы выросли, — падать здесь значило бы не дать
    // ему даже попробовать.
    let token = std::env::var(mcp::TOKEN_ENV).unwrap_or_default();
    let mut bridge = Bridge::new(path, token);
    pump(
        &mut bridge,
        BufReader::new(std::io::stdin()),
        std::io::stdout(),
    )
}

#[cfg(not(any(unix, windows)))]
fn run() -> i32 {
    eprintln!("ModelCrew MCP: на этой платформе плагин пока не поддержан.");
    1
}

/// Разговор с агентом: строка за строкой, пока он не закончит.
///
/// Ответ на каждый запрос обязателен. Без ответа клиент ждёт до собственного
/// тайм-аута — живьём это две минуты тишины и вызов, ушедший в фон, — поэтому
/// на то, до чего приложение не донесло, отвечает сам шим.
///
/// Уходим всегда нулём: ненулевой код клиент читает как «сервер сломался» и
/// больше к нему не возвращается, а сломаться здесь может только связь.
#[cfg(any(unix, windows))]
fn pump<R: BufRead, W: Write>(bridge: &mut Bridge, input: R, mut output: W) -> i32 {
    for line in input.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Some(ours) = mcp::offline_answer(&line, mcp::UNREACHABLE) else {
            // Уведомление: ответа не ждут. Донесём, если связь уже есть, и
            // пойдём дальше.
            bridge.tell(&line);
            continue;
        };
        let answer = bridge.ask(&line).unwrap_or(ours);
        if output
            .write_all(answer.as_bytes())
            .and_then(|()| output.write_all(b"\n"))
            .and_then(|()| output.flush())
            .is_err()
        {
            // Клиент закрыл трубу: сессия окончена, отвечать больше некому.
            return 0;
        }
    }
    0
}

/// Связь с приложением: не постоянная, а восстанавливаемая.
#[cfg(any(unix, windows))]
struct Bridge {
    /// `None` — адрес сокета не вычислился. Такой шим работает целиком сам:
    /// сессию он держит, но инструменты у него не работают никогда.
    path: Option<std::path::PathBuf>,
    token: String,
    link: Option<Link>,
}

#[cfg(any(unix, windows))]
impl Bridge {
    fn new(path: Option<std::path::PathBuf>, token: String) -> Self {
        Self {
            path,
            token,
            link: None,
        }
    }

    /// Один запрос — один ответ приложения. `None` — оно не ответило, и
    /// отвечать придётся самому шиму.
    fn ask(&mut self, line: &str) -> Option<String> {
        let reused = self.link.is_some();
        match self.attempt(line) {
            Reply::Answer(answer) => Some(answer),
            // Запрос ушёл, а ответ — нет. Повторять нельзя: приложение могло
            // успеть его выполнить и закрыться уже после, а второй
            // browser_navigate открыл бы страницу дважды.
            Reply::Lost => {
                self.link = None;
                None
            }
            // До отправки дело не дошло. Если связь досталась от прошлого
            // запроса, она могла умереть в любой момент между ними — пробуем
            // заново, уже по свежей.
            Reply::Unsent => {
                self.link = None;
                if reused {
                    self.attempt(line).answer()
                } else {
                    None
                }
            }
        }
    }

    /// Уведомление: ответа на него не ждут, и связь ради него не поднимаем —
    /// донесётся, если она уже есть.
    fn tell(&mut self, line: &str) {
        if let Some(link) = self.link.as_mut() {
            if link.send(line).is_err() {
                self.link = None;
            }
        }
    }

    fn attempt(&mut self, line: &str) -> Reply {
        let Some(link) = self.link_or_open() else {
            return Reply::Unsent;
        };
        if link.send(line).is_err() {
            return Reply::Unsent;
        }
        match link.receive() {
            Some(answer) => Reply::Answer(answer),
            None => Reply::Lost,
        }
    }

    fn link_or_open(&mut self) -> Option<&mut Link> {
        // Мёртвую связь важно распознать до отправки, а не после: не ушедший
        // запрос можно повторить, а ушедший — уже нет.
        if self.link.as_ref().is_some_and(|link| !link.is_alive()) {
            self.link = None;
        }
        if self.link.is_none() {
            self.link = Link::open(self.path.as_deref()?, &self.token);
        }
        self.link.as_mut()
    }
}

/// Чем кончилась попытка донести запрос.
#[cfg(any(unix, windows))]
enum Reply {
    /// Приложение ответило.
    Answer(String),
    /// Запрос ушёл, ответ — нет: связь оборвалась уже после отправки.
    Lost,
    /// Запрос не ушёл вовсе: связи нет или она оборвалась на отправке.
    Unsent,
}

#[cfg(any(unix, windows))]
impl Reply {
    fn answer(self) -> Option<String> {
        match self {
            Reply::Answer(answer) => Some(answer),
            _ => None,
        }
    }
}

/// Одно живое соединение с приложением.
///
/// Ответ читается тут же, в том же потоке, а не отдельным. Соединение
/// обслуживает один цикл: приложение отвечает по строке на запрос, в том же
/// порядке, и само по себе не заговаривает. Отдельный поток дал бы здесь одно
/// — возможность не заметить, что ответа уже не будет.
#[cfg(any(unix, windows))]
struct Link {
    out: Stream,
    back: BufReader<Stream>,
}

/// Труба к приложению.
#[cfg(unix)]
type Stream = std::os::unix::net::UnixStream;

#[cfg(windows)]
type Stream = std::fs::File;

#[cfg(unix)]
fn connect(path: &std::path::Path) -> Option<Stream> {
    std::os::unix::net::UnixStream::connect(path).ok()
}

/// Канал занят, только пока приложение выставляет следующий экземпляр, —
/// мгновения. Дольше — значит, оно не отвечает, и честнее ответить самим.
#[cfg(windows)]
const BUSY_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

#[cfg(windows)]
fn connect(path: &std::path::Path) -> Option<Stream> {
    crate::pipe::connect(path, BUSY_WAIT).ok()
}

#[cfg(any(unix, windows))]
impl Link {
    fn open(path: &std::path::Path, token: &str) -> Option<Self> {
        let stream = connect(path)?;
        let back = BufReader::new(stream.try_clone().ok()?);
        let mut link = Self { out: stream, back };
        // Первой строкой — пропуск панели: без него приложение не знает, кого
        // обслуживает, и разговора дальше не будет.
        link.send(&mcp::handshake(token)).ok()?;
        Some(link)
    }

    fn send(&mut self, line: &str) -> std::io::Result<()> {
        self.out.write_all(line.as_bytes())?;
        self.out.write_all(b"\n")?;
        self.out.flush()
    }

    fn receive(&mut self) -> Option<String> {
        let mut line = String::new();
        match self.back.read_line(&mut line) {
            // Ноль байт — конец: приложение положило трубку.
            Ok(0) | Err(_) => None,
            Ok(_) => Some(line.trim_end().to_string()),
        }
    }
}

#[cfg(unix)]
impl Link {
    /// Жив ли тот конец. Спрашиваем у сокета, а не у себя: приложение могло
    /// закрыться когда угодно между запросами, и записи это не видно — она
    /// уходит в буфер ядра и удаётся даже в закрытое соединение.
    ///
    /// Читаем не забирая и не дожидаясь (`MSG_PEEK | MSG_DONTWAIT`).
    /// Единственный интересный ответ здесь — ноль байт: так ядро сообщает,
    /// что тот конец закрылся. Через `std` этого не спросить: `peek` у
    /// `UnixStream` до сих пор нестабилен.
    fn is_alive(&self) -> bool {
        use std::os::fd::AsRawFd;

        let mut byte = 0_u8;
        // SAFETY: живой дескриптор нашего же сокета и буфер на один байт,
        // размер которого мы и передаём.
        let seen = unsafe {
            libc::recv(
                self.out.as_raw_fd(),
                std::ptr::addr_of_mut!(byte).cast(),
                1,
                libc::MSG_PEEK | libc::MSG_DONTWAIT,
            )
        };
        match seen {
            // Конец: приложения на том конце больше нет.
            0 => false,
            // Пусто и ждать нечего — обычное состояние живой связи между
            // запросами. Любая другая беда — уже не связь.
            -1 => matches!(
                std::io::Error::last_os_error().kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
            ),
            _ => true,
        }
    }
}

#[cfg(windows)]
impl Link {
    /// Жив ли тот конец — на Windows. Заглядываем в канал, ничего не забирая
    /// и не дожидаясь: закрытый сервер система называет сразу, а живой, но
    /// молчащий, — пустым каналом.
    fn is_alive(&self) -> bool {
        use std::os::windows::io::AsRawHandle;
        use std::ptr::null_mut;

        // SAFETY: живой дескриптор нашего же канала; буфера нет, и размер его
        // мы передаём нулём.
        let ok = unsafe {
            windows_sys::Win32::System::Pipes::PeekNamedPipe(
                self.out.as_raw_handle(),
                null_mut(),
                0,
                null_mut(),
                null_mut(),
                null_mut(),
            )
        };
        ok != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shim_run_is_told_apart_from_a_normal_one() {
        assert!(is_shim(["ModelCrew", mcp::STDIO_FLAG]));
        // Обычный запуск: окно должно подняться, а не молча закрыться.
        assert!(!is_shim(["ModelCrew"]));
        assert!(!is_shim(["ModelCrew", "--version"]));
        // Флаг не первым аргументом — не наш случай: так его мог передать
        // пользователь чему-то другому.
        assert!(!is_shim(["ModelCrew", "--other", mcp::STDIO_FLAG]));
    }

    #[test]
    fn does_not_collide_with_the_hook_flag() {
        // Оба флага проверяются на одном и том же месте, и спутать их нельзя:
        // хук отвечает и выходит, шим держит сессию.
        assert!(!is_shim(["ModelCrew", crate::agent_hook_cli::HOOK_FLAG]));
        assert!(crate::agent_hook_cli::mode_from_args(["ModelCrew", mcp::STDIO_FLAG]).is_none());
    }

    #[cfg(any(unix, windows))]
    use serde_json::Value;

    /// Приложение на том конце: принимает соединение, читает пропуск и
    /// отвечает по строке на каждый запрос. Отдельным сторожем, а не просто
    /// потоком, ради `stop`: без него «приложение закрылось» не отличить от
    /// «приложение задумалось».
    #[cfg(unix)]
    struct FakeApp {
        path: std::path::PathBuf,
        alive: std::sync::Arc<std::sync::atomic::AtomicBool>,
        open: std::sync::Arc<std::sync::Mutex<Vec<std::os::unix::net::UnixStream>>>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    #[cfg(unix)]
    impl FakeApp {
        fn start(path: &std::path::Path) -> Self {
            use std::sync::atomic::{AtomicBool, Ordering};
            use std::sync::{Arc, Mutex};

            let _ = std::fs::remove_file(path);
            let listener = std::os::unix::net::UnixListener::bind(path).unwrap();
            let alive = Arc::new(AtomicBool::new(true));
            let open = Arc::new(Mutex::new(Vec::new()));
            let serving = Arc::clone(&alive);
            let kept = Arc::clone(&open);
            let thread = std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    if !serving.load(Ordering::SeqCst) {
                        return;
                    }
                    let out = stream.try_clone().unwrap();
                    kept.lock().unwrap().push(stream.try_clone().unwrap());
                    answer_each(stream, out);
                }
            });
            Self {
                path: path.to_path_buf(),
                alive,
                open,
                thread: Some(thread),
            }
        }

        /// Приложение закрылось: слушателя нет, а соединения, открытые до
        /// того, оборваны — ровно то, что делает с ними выход или выключатель.
        fn stop(&mut self) {
            use std::sync::atomic::Ordering;

            self.alive.store(false, Ordering::SeqCst);
            // Разбудить `accept` — так же, как это делает сам выключатель.
            let _ = std::os::unix::net::UnixStream::connect(&self.path);
            for stream in self.open.lock().unwrap().drain(..) {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
            let _ = std::fs::remove_file(&self.path);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// То же приложение на Windows.
    #[cfg(windows)]
    struct FakeApp {
        alive: std::sync::Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    #[cfg(windows)]
    impl FakeApp {
        fn start(path: &std::path::Path) -> Self {
            use std::sync::atomic::{AtomicBool, Ordering};
            use std::sync::Arc;

            let mut listener = crate::pipe::Listener::bind(path).unwrap();
            let alive = Arc::new(AtomicBool::new(true));
            let serving = Arc::clone(&alive);
            let thread = std::thread::spawn(move || {
                while serving.load(Ordering::SeqCst) {
                    let Ok((pipe, _)) = listener.accept() else {
                        continue;
                    };
                    let out = pipe.try_clone().unwrap();
                    answer_each(pipe, out);
                }
            });
            Self {
                alive,
                thread: Some(thread),
            }
        }

        /// Приложение закрылось. Его поток спит в системе — ждёт клиента или
        /// строку от него, — а `shutdown`, как у сокета, у канала нет. Будит
        /// только отмена ожидания. Отменяем, пока поток не выйдет: попади
        /// отмена между двумя ожиданиями, отменять было бы нечего.
        fn stop(&mut self) {
            use std::os::windows::io::AsRawHandle;
            use std::sync::atomic::Ordering;

            self.alive.store(false, Ordering::SeqCst);
            let Some(thread) = self.thread.take() else {
                return;
            };
            while !thread.is_finished() {
                // SAFETY: дескриптор живого потока, который мы сами и подняли.
                unsafe {
                    windows_sys::Win32::System::IO::CancelSynchronousIo(thread.as_raw_handle())
                };
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            let _ = thread.join();
        }
    }

    /// Разговор приложения: пропуск первой строкой, дальше по ответу на
    /// каждый запрос.
    #[cfg(any(unix, windows))]
    fn answer_each(stream: impl std::io::Read, mut out: impl Write) {
        let mut back = BufReader::new(stream).lines();
        // Первая строка — пропуск панели.
        let _pass = back.next();
        for line in back.map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(id) = value.get("id").cloned() else {
                continue;
            };
            let answer = serde_json::json!({"jsonrpc":"2.0","id":id,"result":{"from":"app"}});
            if out
                .write_all(answer.to_string().as_bytes())
                .and_then(|()| out.write_all(b"\n"))
                .and_then(|()| out.flush())
                .is_err()
            {
                break;
            }
        }
    }

    #[cfg(any(unix, windows))]
    impl Drop for FakeApp {
        fn drop(&mut self) {
            self.stop();
        }
    }

    #[cfg(unix)]
    fn sock(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("mc-shim-{name}-{}.sock", std::process::id()))
    }

    #[cfg(windows)]
    fn sock(name: &str) -> std::path::PathBuf {
        crate::pipe::address(&format!(
            "com.modelcrew.desktop.test.shim-{name}-{}",
            std::process::id()
        ))
        .unwrap()
    }

    /// Прогнать через шим готовые строки и разобрать то, что он сказал в ответ.
    #[cfg(any(unix, windows))]
    fn talk(bridge: &mut Bridge, lines: &[String]) -> Vec<Value> {
        let input = lines.join("\n");
        let mut out = Vec::new();
        assert_eq!(
            pump(bridge, BufReader::new(input.as_bytes()), &mut out),
            0,
            "шим ушёл ненулевым кодом — для клиента это сломавшийся сервер"
        );
        String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[cfg(any(unix, windows))]
    fn a_call(id: u32) -> String {
        format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{{"name":"crew_ping"}}}}"#)
    }

    /// Кто ответил на вызов: приложение или сам шим.
    #[cfg(any(unix, windows))]
    fn answered_by(answer: &Value) -> &str {
        if answer["result"]["from"] == "app" {
            "приложение"
        } else if answer["result"]["isError"] == true {
            "шим"
        } else {
            "непонятно кто"
        }
    }

    #[test]
    #[cfg(any(unix, windows))]
    fn a_closed_application_does_not_take_the_session_with_it() {
        // Сокета нет вовсе: приложение закрыто или плагин выключен. Клиент
        // MCP поднимает сервер один раз за сессию — уйди шим отсюда, агент
        // остался бы без инструментов до конца разговора, чем бы ни щёлкали
        // потом в настройках.
        let mut bridge = Bridge::new(Some(sock("gone")), "pass".into());
        let answers = talk(
            &mut bridge,
            &[
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#.to_string(),
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#.to_string(),
                a_call(3),
            ],
        );

        assert_eq!(
            answers.len(),
            3,
            "запрос остался без ответа: клиент будет ждать его до своего тайм-аута"
        );
        assert!(
            answers[0]["result"]["protocolVersion"].is_string(),
            "рукопожатие не состоялось — для клиента это сервер, который не поднялся"
        );
        // Список инструментов спрашивают один раз, сразу после рукопожатия, и
        // урезанный ответ застрял бы у клиента до конца сессии.
        let names: Vec<&str> = answers[1]["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"browser_navigate"), "{names:?}");
        assert_eq!(answered_by(&answers[2]), "шим");
        let text = answers[2]["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("Перезапускать агента не нужно"),
            "отказ звучит как поломка навсегда, и агент больше не вернётся: {text}"
        );
    }

    #[test]
    #[cfg(any(unix, windows))]
    fn comes_back_to_the_application_that_returned() {
        // Тот самый случай: выключил плагин, включил — и агент его больше не
        // видит. Сессия здесь одна и та же от начала до конца, как у живого
        // агента, которого никто не перезапускал.
        let path = sock("return");
        let mut app = FakeApp::start(&path);
        let mut bridge = Bridge::new(Some(path.clone()), "pass".into());

        let first = talk(&mut bridge, &[a_call(1)]);
        assert_eq!(answered_by(&first[0]), "приложение");

        app.stop();
        let while_off = talk(&mut bridge, &[a_call(2)]);
        assert_eq!(answered_by(&while_off[0]), "шим");

        let mut app = FakeApp::start(&path);
        // Первый же вызов после возвращения, а не второй: связь у шима
        // осталась с прошлой жизни приложения, и узнать, что она мертва, он
        // обязан до отправки — иначе этот вызов пропал бы зря.
        let back = talk(&mut bridge, &[a_call(3)]);
        assert_eq!(
            answered_by(&back[0]),
            "приложение",
            "плагин включили обратно, а инструменты так и не вернулись"
        );
        app.stop();
    }

    #[test]
    #[cfg(any(unix, windows))]
    fn keeps_quiet_about_a_notification() {
        // У уведомления нет `id`, ответа на него не ждут, и ответ был бы
        // нарушением протокола. А ждать ответа на него нельзя тем более:
        // приложение молчит, и шим завис бы на первом же рукопожатии.
        let mut bridge = Bridge::new(Some(sock("quiet")), "pass".into());
        let answers = talk(
            &mut bridge,
            &[r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.to_string()],
        );
        assert!(answers.is_empty(), "{answers:?}");
    }
}
