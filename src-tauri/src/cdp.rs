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
    let stream = TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        CONNECT_TIMEOUT,
    )
    .map_err(|error| CommandError::new(ErrorCode::BrowserNotConnected).with_debug(error))?;
    // Без таймаута зависший браузер держал бы поток агента вечно.
    let _ = stream.set_read_timeout(Some(CALL_TIMEOUT));
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

/// Маленький GET по localhost.
///
/// Своими руками, а не готовым клиентом: тот в этом проекте асинхронный, а
/// здесь всё синхронное, и ради одного запроса известной формы к своему же
/// порту тащить сюда рантайм незачем.
fn fetch(port: u16, path: &str) -> CommandResult<Value> {
    let mut stream = connect_stream(port)?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|error| CommandError::new(ErrorCode::BrowserNotConnected).with_debug(error))?;

    let mut raw = String::new();
    stream
        .read_to_string(&mut raw)
        .map_err(|error| CommandError::new(ErrorCode::BrowserNotConnected).with_debug(error))?;

    body_of(&raw)
        .and_then(|body| serde_json::from_str(body).ok())
        .ok_or_else(|| {
            CommandError::new(ErrorCode::BrowserNotConnected)
                .with_context("reason", "браузер ответил не тем, чем ожидалось")
        })
}

/// Тело ответа после пустой строки, отделяющей заголовки.
fn body_of(raw: &str) -> Option<&str> {
    raw.split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .or_else(|| raw.split_once("\n\n").map(|(_, body)| body))
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
            body_of("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n[]"),
            Some("[]")
        );
        // Некоторые сборки отвечают с переводами строк без возврата каретки.
        assert_eq!(
            body_of("HTTP/1.1 200 OK\nContent-Type: x\n\n[]"),
            Some("[]")
        );
        assert_eq!(body_of("совсем не ответ"), None);
    }
}
