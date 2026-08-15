//! Разговор с браузером по Chrome DevTools Protocol.
//!
//! Браузер запущен без окна (`browser_host`), поэтому единственный способ и
//! увидеть страницу, и что-то с ней сделать — этот протокол. Картинка снимается
//! кадром и уходит в приложение: страницу показывает ModelCrew, а не Chrome.
//!
//! Синхронно и в потоке вызывающего, как всё остальное в этом бэкенде: сессия
//! агента и так живёт в своём потоке, а тащить сюда асинхронный рантайм ради
//! одного сокета — менять устройство всего слоя ради одной функции.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

use serde_json::{json, Value};

use crate::command_error::{CommandError, CommandResult, ErrorCode};

/// Сколько ждём ответа на команду. Навигация укладывается с запасом, а
/// зависший браузер не должен держать агента дольше.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);

/// Сколько ждём отклика от самого порта.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Схемы, по которым браузеру разрешено ходить.
///
/// `file://` здесь нет намеренно: через него агент прочитал бы любой файл на
/// диске мимо всех проверок пути. Браузер — окно в сеть, а не второй способ
/// читать файлы.
const ALLOWED_SCHEMES: [&str; 2] = ["http://", "https://"];

pub struct Cdp {
    socket: tungstenite::WebSocket<std::net::TcpStream>,
    next_id: u64,
}

impl Cdp {
    /// Подключиться к первой странице браузера.
    pub fn connect(port: u16) -> CommandResult<Self> {
        let targets = fetch(port, "/json/list")?;
        let ws_url = page_socket(&targets).ok_or_else(|| {
            CommandError::new(ErrorCode::BrowserNotConnected)
                .with_context("reason", "у браузера нет ни одной страницы")
        })?;

        let stream = connect_stream(port)?;
        let (socket, _) = tungstenite::client::client(&ws_url, stream)
            .map_err(|error| CommandError::new(ErrorCode::BrowserNotConnected).with_debug(error))?;

        let mut cdp = Self { socket, next_id: 0 };
        // Без этого страница не присылает событий загрузки, и навигация не с
        // чем было бы сопоставить.
        cdp.call("Page.enable", json!({}))?;
        Ok(cdp)
    }

    /// Открыть страницу и дождаться, пока она загрузится.
    pub fn navigate(&mut self, url: &str) -> CommandResult<()> {
        let url = checked_url(url)?;
        let answer = self.call("Page.navigate", json!({ "url": url }))?;
        // Chrome отвечает успехом и на страницу, которая не открылась: сам
        // отказ лежит внутри ответа.
        if let Some(error) = answer.get("errorText").and_then(Value::as_str) {
            return Err(CommandError::new(ErrorCode::BrowserCommandFailed)
                .with_context("url", url)
                .with_context("reason", error));
        }
        self.await_event("Page.loadEventFired")
    }

    /// Кадр страницы: PNG в base64, как его отдаёт сам протокол.
    pub fn screenshot(&mut self) -> CommandResult<String> {
        let answer = self.call("Page.captureScreenshot", json!({ "format": "png" }))?;
        answer
            .get("data")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                CommandError::new(ErrorCode::BrowserCommandFailed)
                    .with_context("reason", "в ответе нет кадра")
            })
    }

    /// Адрес и заголовок текущей страницы — чтобы человеку было видно, где он.
    pub fn location(&mut self) -> CommandResult<(String, String)> {
        let answer = self.call(
            "Runtime.evaluate",
            json!({
                "expression": "JSON.stringify({url: location.href, title: document.title})",
                "returnByValue": true,
            }),
        )?;
        let raw = answer
            .pointer("/result/value")
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let parsed: Value = serde_json::from_str(raw).unwrap_or_else(|_| json!({}));
        Ok((
            parsed["url"].as_str().unwrap_or_default().to_string(),
            parsed["title"].as_str().unwrap_or_default().to_string(),
        ))
    }

    fn call(&mut self, method: &str, params: Value) -> CommandResult<Value> {
        self.next_id += 1;
        let id = self.next_id;
        let request = json!({ "id": id, "method": method, "params": params }).to_string();
        self.socket
            .send(tungstenite::Message::Text(request.into()))
            .map_err(|error| {
                CommandError::new(ErrorCode::BrowserCommandFailed)
                    .with_context("method", method)
                    .with_debug(error)
            })?;

        // В сокет валятся и события, и ответы на другие команды: ждём свой id.
        loop {
            let message = self.read()?;
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(CommandError::new(ErrorCode::BrowserCommandFailed)
                    .with_context("method", method)
                    .with_context("reason", error.to_string()));
            }
            return Ok(message.get("result").cloned().unwrap_or_else(|| json!({})));
        }
    }

    fn await_event(&mut self, name: &str) -> CommandResult<()> {
        loop {
            let message = self.read()?;
            if message.get("method").and_then(Value::as_str) == Some(name) {
                return Ok(());
            }
        }
    }

    fn read(&mut self) -> CommandResult<Value> {
        loop {
            let message = self.socket.read().map_err(|error| {
                CommandError::new(ErrorCode::BrowserNotConnected).with_debug(error)
            })?;
            match message {
                tungstenite::Message::Text(text) => {
                    return serde_json::from_str(&text).map_err(|error| {
                        CommandError::new(ErrorCode::BrowserCommandFailed).with_debug(error)
                    })
                }
                // Ping/pong и двоичные кадры к протоколу отношения не имеют.
                tungstenite::Message::Close(_) => {
                    return Err(CommandError::new(ErrorCode::BrowserNotConnected)
                        .with_context("reason", "браузер закрыл соединение"))
                }
                _ => continue,
            }
        }
    }
}

fn connect_stream(port: u16) -> CommandResult<TcpStream> {
    connect_within(port, CONNECT_TIMEOUT, CALL_TIMEOUT)
}

fn connect_within(port: u16, connect: Duration, read: Duration) -> CommandResult<TcpStream> {
    let stream =
        TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), connect)
            .map_err(|error| CommandError::new(ErrorCode::BrowserNotConnected).with_debug(error))?;
    // Без таймаута зависший браузер держал бы поток агента вечно.
    let _ = stream.set_read_timeout(Some(read));
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

/// Браузер ли на этом порту.
///
/// Одного «кто-то принял соединение» мало: порт достался нам из файла в
/// профиле, файл переживает сам браузер, а порт за это время могла занять
/// любая программа. Спрашиваем то, на что умеет отвечать только DevTools.
pub fn is_devtools(port: u16, timeout: Duration) -> bool {
    fetch_within(port, "/json/version", timeout).is_ok_and(|answer| answer.get("Browser").is_some())
}

/// Маленький GET по localhost.
///
/// Своими руками, а не готовым клиентом: тот в этом проекте асинхронный, а
/// здесь всё синхронное, и ради одного запроса известной формы к своему же
/// порту тащить сюда рантайм незачем.
fn fetch(port: u16, path: &str) -> CommandResult<Value> {
    fetch_within(port, path, CALL_TIMEOUT)
}

fn fetch_within(port: u16, path: &str, timeout: Duration) -> CommandResult<Value> {
    let mut stream = connect_within(port, timeout, timeout)?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|error| CommandError::new(ErrorCode::BrowserNotConnected).with_debug(error))?;

    // Читаем ровно столько, сколько обещано в заголовке, а не до конца связи:
    // `Connection: close` браузер игнорирует и соединение держит открытым.
    // Чтение «до EOF» упиралось бы в таймаут и всякий раз кончалось отказом,
    // хотя ответ уже пришёл целиком.
    let mut raw = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        if let Some(body) = complete_body(&raw) {
            return serde_json::from_str(body).map_err(|error| {
                CommandError::new(ErrorCode::BrowserNotConnected)
                    .with_context("reason", "браузер ответил не тем, чем ожидалось")
                    .with_debug(error)
            });
        }
        let read = stream
            .read(&mut chunk)
            .map_err(|error| CommandError::new(ErrorCode::BrowserNotConnected).with_debug(error))?;
        if read == 0 {
            return Err(CommandError::new(ErrorCode::BrowserNotConnected)
                .with_context("reason", "браузер оборвал ответ"));
        }
        raw.extend_from_slice(&chunk[..read]);
    }
}

/// Тело ответа, если оно пришло целиком.
///
/// `None` — заголовки ещё не кончились или тела пришло меньше обещанного.
fn complete_body(raw: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(raw).ok()?;
    let (head, body) = split_head(text)?;
    let length = content_length(head)?;
    // `then`, а не `then_some`: срез считается сразу, и на недочитанном теле
    // он бы вышел за границу вместо честного «ещё не всё».
    (body.len() >= length).then(|| &body[..length])
}

/// Заголовки и тело: пустая строка между ними.
fn split_head(raw: &str) -> Option<(&str, &str)> {
    raw.split_once("\r\n\r\n")
        .or_else(|| raw.split_once("\n\n"))
}

/// Длина тела из заголовков.
fn content_length(head: &str) -> Option<usize> {
    head.lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse().ok())
}

/// Адрес веб-сокета первой страницы.
///
/// Именно страницы: в списке лежат ещё и служебные цели — сам браузер,
/// расширения, фоновые страницы, — и они не умеют ни навигации, ни кадров.
fn page_socket(targets: &Value) -> Option<String> {
    targets
        .as_array()?
        .iter()
        .find(|target| target.get("type").and_then(Value::as_str) == Some("page"))
        .and_then(|target| target.get("webSocketDebuggerUrl"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Адрес, по которому браузеру можно ходить.
fn checked_url(url: &str) -> CommandResult<&str> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if ALLOWED_SCHEMES
        .iter()
        .any(|scheme| lower.starts_with(scheme))
    {
        return Ok(url);
    }
    Err(CommandError::new(ErrorCode::BrowserUrlUnsupported).with_context("url", url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_page_and_not_the_browser_itself() {
        let targets = json!([
            { "type": "browser", "webSocketDebuggerUrl": "ws://127.0.0.1:1/browser" },
            { "type": "page", "webSocketDebuggerUrl": "ws://127.0.0.1:1/page/a" },
            { "type": "page", "webSocketDebuggerUrl": "ws://127.0.0.1:1/page/b" },
        ]);
        // Служебные цели не умеют ни навигации, ни кадров: взяв первую попавшуюся,
        // мы получили бы соединение, на котором ничего не работает.
        assert_eq!(
            page_socket(&targets).as_deref(),
            Some("ws://127.0.0.1:1/page/a")
        );
    }

    #[test]
    fn survives_a_browser_with_no_pages() {
        assert_eq!(page_socket(&json!([])), None);
        assert_eq!(
            page_socket(&json!([{ "type": "browser", "webSocketDebuggerUrl": "ws://x/" }])),
            None
        );
        // Цель без адреса — тоже не цель.
        assert_eq!(page_socket(&json!([{ "type": "page" }])), None);
        assert_eq!(page_socket(&json!("не список")), None);
    }

    #[test]
    fn refuses_to_read_the_disk_through_the_browser() {
        // Главное здесь: `file://`. Через него агент прочитал бы любой файл
        // мимо всех проверок пути — и мимо заявок на файлы заодно.
        for hostile in [
            "file:///etc/passwd",
            "FILE:///etc/passwd",
            "chrome://settings",
            "devtools://devtools/bundled/inspector.html",
            "javascript:alert(1)",
            "data:text/html,<script>fetch('/etc/passwd')</script>",
            "",
        ] {
            assert!(checked_url(hostile).is_err(), "пропустили {hostile:?}");
        }
    }

    #[test]
    fn lets_the_usual_addresses_through() {
        for fine in [
            "http://localhost:1420/",
            "https://example.com/path?q=1",
            "HTTPS://EXAMPLE.COM",
        ] {
            assert_eq!(checked_url(fine).unwrap(), fine);
        }
        // Пробелы по краям приходят от агента постоянно.
        assert_eq!(
            checked_url("  https://example.com  ").unwrap(),
            "https://example.com"
        );
    }

    #[test]
    fn reads_the_body_after_the_headers() {
        assert_eq!(
            complete_body(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n[]"),
            Some("[]")
        );
        // Некоторые сборки отвечают с переводами строк без возврата каретки.
        assert_eq!(
            complete_body(b"HTTP/1.1 200 OK\nContent-Length: 2\n\n[]"),
            Some("[]")
        );
        // Имена заголовков регистронезависимы, и Chrome пишет их без пробела.
        assert_eq!(
            complete_body(b"HTTP/1.1 200 OK\r\ncontent-length:2\r\n\r\n[]"),
            Some("[]")
        );
        assert_eq!(complete_body("совсем не ответ".as_bytes()), None);
    }

    #[test]
    fn waits_for_the_whole_body() {
        // Соединение браузер держит открытым и `Connection: close` не слушает:
        // дочитав до конца связи, мы упёрлись бы в таймаут при готовом ответе.
        // Признак конца здесь один — обещанная длина.
        let head = b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n";
        assert_eq!(complete_body(head), None);
        assert_eq!(
            complete_body(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n[1,2,3"),
            None
        );
        assert_eq!(
            complete_body(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n[1,2,3,4]\n"),
            Some("[1,2,3,4]\n")
        );
    }

    #[test]
    fn stops_at_the_promised_length() {
        // Chrome умеет прислать следом ответ на следующий запрос по тому же
        // соединению: лишнее в разбор JSON попадать не должно.
        assert_eq!(
            complete_body(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n[]HTTP/1.1 200 OK"),
            Some("[]")
        );
    }

    #[test]
    fn an_answer_without_a_length_is_not_an_answer() {
        // Заголовок обязателен: без него мы не знаем, всё ли пришло, и
        // догадка «пришло всё» рано или поздно отдала бы половину списка.
        assert_eq!(
            complete_body(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n[]"),
            None
        );
    }
}
