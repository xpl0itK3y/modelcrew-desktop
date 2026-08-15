//! MCP-сервер приложения: канал, которым агент зовёт нас сам.
//!
//! Хуки (`agent_hook_cli.rs`) — это перехват: приложение вклинивается в вызов,
//! который агент и так делает. Здесь обратное направление, тяга: агент сам
//! просит инструмент. Браузеру нужно именно это — «открой страницу» никакой
//! перехват не заменит, потому что перехватывать нечего.
//!
//! Устройство повторяет уже работающую схему хуков. Панель получает в
//! окружение путь до сокета рядом с `MODELCREW_PANEL_ID` (`pty.rs`), агент
//! запускает шим — то же самое приложение с флагом `--mcp-stdio`, — и шим
//! наследует номер панели. Поэтому приложение знает, **кто** позвал, и берёт
//! корень проекта из `PtyManager`, а не из аргументов вызова.
//!
//! Почему не HTTP на localhost: порт доступен любому процессу в системе,
//! привязки к панели у него нет, и это ломает нынешний периметр безопасности.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Версия протокола, о которой договариваемся в `initialize`.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// Первый аргумент шима. Как и `--agent-hook`, проверяется до подъёма окна:
/// шиму не нужно ни окна, ни трея.
pub const STDIO_FLAG: &str = "--mcp-stdio";

/// Переменная окружения панели с путём до сокета.
pub const SOCK_ENV: &str = "MODELCREW_MCP_SOCK";

/// Имя файла сокета в каталоге данных приложения.
#[cfg(unix)]
const SOCK_NAME: &str = "mcp.sock";

/// Длина `sun_path` в `sockaddr_un`: 104 на macOS, 108 на Linux. Берём
/// меньшее и с запасом — длинное имя пользователя способно вытолкнуть путь
/// за предел, и тогда bind падает с невнятной ошибкой.
#[cfg(unix)]
const SOCK_PATH_LIMIT: usize = 100;

/// Кого обслуживаем на этом соединении.
///
/// Корень — не то, что прислал агент, а то, с чем реально запущена его панель.
/// Подменить его вызовом нельзя: в запросе его попросту нет.
pub struct PanelContext {
    pub panel_id: String,
    pub root: Option<PathBuf>,
}

impl PanelContext {
    pub fn new(panel_id: String, root: Option<PathBuf>) -> Self {
        Self { panel_id, root }
    }
}

/// То, что инструменты умеют делать по-настоящему.
///
/// Отдельно от разбора протокола: сам разбор ничего не запускает и не знает
/// ни про Chrome, ни про Tauri, поэтому проверяется без них обоих.
pub trait Tools: Send + Sync {
    /// Поднять браузер проекта или убедиться, что он уже поднят.
    /// Текст ошибки уходит агенту дословно — он должен быть ему понятен.
    fn open_browser(&self, root: &Path) -> Result<(), String>;

    /// Открыть страницу в браузере проекта. Возвращает заголовок страницы —
    /// по нему агент понимает, что попал куда хотел.
    fn navigate(&self, root: &Path, url: &str) -> Result<String, String>;
}

/// Один запрос JSON-RPC → одна строка ответа.
///
/// `None` — отвечать не нужно: это уведомление (у него нет `id`), и ответ на
/// него был бы нарушением протокола.
pub fn dispatch(ctx: &PanelContext, tools: &dyn Tools, line: &str) -> Option<String> {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        // Разобрать не смогли — `id` взять неоткуда, отвечаем нулевым по
        // требованию JSON-RPC.
        Err(_) => return Some(error(Value::Null, -32700, "разбор JSON не удался")),
    };

    let method = value.get("method").and_then(Value::as_str).unwrap_or("");
    let id = value.get("id").cloned();

    // Уведомление: никакого ответа. `notifications/initialized` приходит
    // сразу после рукопожатия и молчание — правильная на него реакция.
    let id = id?;

    Some(match method {
        "initialize" => result(id, initialize_result()),
        // Проверка живости из самого протокола: пустой результат.
        "ping" => result(id, json!({})),
        "tools/list" => result(id, json!({ "tools": tool_list() })),
        "tools/call" => call_tool(ctx, tools, id, value.get("params")),
        "" => error(id, -32600, "в запросе нет метода"),
        other => error(id, -32601, &format!("метод «{other}» неизвестен")),
    })
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": "modelcrew",
            "version": env!("CARGO_PKG_VERSION"),
        },
    })
}

fn tool_list() -> Value {
    json!([
        {
            // Служебный: проверяет, что труба проложена, а агент и его проект
            // опознаны. Инструмент работы, а не диагностики, — следующий.
            "name": "crew_ping",
            "description": concat!(
                "Проверка связи с ModelCrew. Возвращает номер панели, из которой ",
                "запущен агент, и корень проекта этой панели.",
            ),
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false,
            },
        },
        {
            "name": "browser_open",
            "description": concat!(
                "Поднять браузер этого проекта, если он ещё не запущен. ",
                "Браузер общий для всех агентов проекта: профиль и вход в ",
                "тестовые стенды у вас общие. У другого проекта браузер свой. ",
                "Своего окна у него нет — страницу видно в самом ModelCrew.",
            ),
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false,
            },
        },
        {
            "name": "browser_navigate",
            "description": concat!(
                "Открыть страницу в браузере проекта и дождаться загрузки. ",
                "Это единственный способ посмотреть страницу в этом проекте: ",
                "то, что откроешь, человек увидит в окне ModelCrew. ",
                "Годятся только http и https.",
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Адрес страницы, http или https.",
                    },
                },
                "required": ["url"],
                "additionalProperties": false,
            },
        },
    ])
}

fn call_tool(ctx: &PanelContext, tools: &dyn Tools, id: Value, params: Option<&Value>) -> String {
    let name = params
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let arguments = params.and_then(|params| params.get("arguments"));
    match name {
        "crew_ping" => result(id, text_content(&ping_text(ctx))),
        "browser_open" => result(id, open_browser(ctx, tools)),
        "browser_navigate" => result(id, navigate(ctx, tools, arguments)),
        // Ошибка инструмента — не ошибка протокола: агент должен прочитать
        // причину и продолжить, а не считать сервер сломанным.
        other => result(
            id,
            json!({
                "content": [{ "type": "text", "text": format!("инструмент «{other}» неизвестен") }],
                "isError": true,
            }),
        ),
    }
}

fn ping_text(ctx: &PanelContext) -> String {
    match &ctx.root {
        Some(root) => format!(
            "ModelCrew на связи. Панель: {}. Проект: {}",
            ctx.panel_id,
            root.display()
        ),
        // Панель не нашлась: агент запущен не из терминала ModelCrew либо
        // панель уже закрыта. Молчать нельзя — иначе это выглядит как
        // «инструмент не работает».
        None => format!(
            "ModelCrew на связи, но панель {} не найдена: \
             агент запущен не из терминала ModelCrew или панель уже закрыта.",
            ctx.panel_id
        ),
    }
}

/// Браузер поднимается для проекта панели, а не для того, что назвал агент:
/// параметра с путём у инструмента нет и быть не должно.
fn open_browser(ctx: &PanelContext, tools: &dyn Tools) -> Value {
    let Some(root) = &ctx.root else {
        return error_content(&ping_text(ctx));
    };
    match tools.open_browser(root) {
        Ok(()) => text_content(&format!("Браузер проекта {} готов.", root.display())),
        Err(reason) => error_content(&reason),
    }
}

fn navigate(ctx: &PanelContext, tools: &dyn Tools, arguments: Option<&Value>) -> Value {
    let Some(root) = &ctx.root else {
        return error_content(&ping_text(ctx));
    };
    let url = arguments
        .and_then(|arguments| arguments.get("url"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if url.is_empty() {
        return error_content("Не сказано, что открывать: нужен параметр url.");
    }
    match tools.navigate(root, url) {
        // Заголовок — то, по чему агент понимает, что попал куда хотел:
        // «страница открыта» одинаково звучит и для формы входа, и для 404.
        Ok(title) => text_content(&format!("Открыто: {url}\nЗаголовок страницы: {title}")),
        Err(reason) => error_content(&reason),
    }
}

fn text_content(text: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": false,
    })
}

/// Неудача инструмента — не поломка сервера: агент читает причину и решает
/// сам, а сессия продолжается.
fn error_content(text: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": true,
    })
}

fn result(id: Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn error(id: Value, code: i64, message: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
    .to_string()
}

/// Рукопожатие шима: первой строкой он называет свою панель.
///
/// Отдельной строкой, а не полем каждого запроса: шим — глупая труба, он не
/// разбирает JSON-RPC и не должен, иначе протокол пришлось бы поддерживать
/// в двух местах.
pub fn panel_of_handshake(line: &str) -> Option<String> {
    let value: Value = serde_json::from_str(line).ok()?;
    let panel = value.get("panelId")?.as_str()?;
    (!panel.is_empty()).then(|| panel.to_string())
}

pub fn handshake(panel_id: &str) -> String {
    json!({ "panelId": panel_id }).to_string()
}

// ---------------------------------------------------------------------------
// Сторона приложения: слушаем сокет.

/// Боевые инструменты: те же действия, но через состояние приложения.
struct AppTools {
    app: tauri::AppHandle,
}

impl Tools for AppTools {
    fn open_browser(&self, root: &Path) -> Result<(), String> {
        browser_port(&self.app, root).map(|_port| ())
    }

    fn navigate(&self, root: &Path, url: &str) -> Result<String, String> {
        let port = browser_port(&self.app, root)?;
        let mut cdp = crate::cdp::Cdp::connect(port)
            .map_err(|error| format!("не удалось связаться с браузером: {}", excuse(&error)))?;
        cdp.navigate(url).map_err(|error| match error.code {
            crate::command_error::ErrorCode::BrowserUrlUnsupported => {
                "Такой адрес открывать нельзя: годятся только http и https.".to_string()
            }
            _ => format!("страница не открылась: {}", excuse(&error)),
        })?;
        // Заголовок читаем после загрузки: до неё он пустой или ещё от
        // прошлой страницы.
        Ok(cdp
            .location()
            .map(|(_url, title)| title)
            .unwrap_or_default())
    }
}

/// Причина отказа словами, а не кодом.
///
/// Читает это агент: по коду вроде `BrowserNotConnected` он ничего сделать не
/// может, а по причине — иногда может, и человеку её же и покажет.
fn excuse(error: &crate::command_error::CommandError) -> String {
    match error.context.get("reason") {
        Some(reason) => format!("{reason} ({:?})", error.code),
        None => format!("{:?}", error.code),
    }
}

/// Поднять браузер проекта и вернуть его порт.
///
/// Ошибки здесь — фразой, а не кодом: их читает агент и показывает человеку.
pub fn browser_port(app: &tauri::AppHandle, root: &Path) -> Result<u16, String> {
    use tauri::Manager;

    let Some(program) = crate::browser_host::chrome_program() else {
        return Err("Chrome не найден. Плагин браузера без него не работает: \
             поставьте Google Chrome или Chromium."
            .to_string());
    };
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("некуда положить профиль браузера: {error}"))?;
    let key = root.to_string_lossy().to_string();
    let profile = crate::browser_host::profile_dir(&base, &key);

    app.state::<crate::browser_host::BrowserHost>()
        .ensure(&key, || crate::browser_host::launch(&program, &profile))
        .map_err(|error| format!("браузер не запустился: {:?}", error.code))
}

/// Путь сокета. Рядом с каталогом событий хуков — то же место, та же уборка.
#[cfg(unix)]
pub fn socket_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let path = app.path().app_data_dir().ok()?.join(SOCK_NAME);
    if path.as_os_str().len() <= SOCK_PATH_LIMIT {
        return Some(path);
    }
    // Каталог данных оказался слишком глубоким для `sun_path` — уходим во
    // временный, он короткий на всех системах. Своё имя процесса в нём, чтобы
    // две копии приложения не дрались за один файл.
    Some(std::env::temp_dir().join(format!("modelcrew-{}.sock", std::process::id())))
}

#[cfg(not(unix))]
pub fn socket_path(_app: &tauri::AppHandle) -> Option<PathBuf> {
    // На Windows нужен именованный канал: у него другое API и другая модель
    // доступа. Пока труба там не проложена, окружение панели остаётся без
    // переменной — агент просто не увидит инструмента, вместо того чтобы
    // видеть его и упираться в мёртвый сокет.
    None
}

/// Поднимает слушателя. Ошибки не фатальны: без MCP приложение работает как
/// работало, просто агенты не видят инструментов.
#[cfg(unix)]
pub fn serve(app: tauri::AppHandle) {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    let Some(path) = socket_path(&app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Файл прошлого запуска: bind поверх него не встанет, а живого слушателя
    // за ним нет — процесс, который его создал, уже мёртв.
    let _ = std::fs::remove_file(&path);

    let Ok(listener) = UnixListener::bind(&path) else {
        return;
    };
    // Сокет — вход в приложение: доступ только владельцу.
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    // Панели узнают адрес только теперь, когда слушатель уже стоит: иначе
    // агент, запущенный сразу после старта, постучался бы в пустоту.
    crate::pty::set_mcp_socket(path);

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            // Поток на соединение: сессия агента живёт, пока жив он сам, и
            // одна панель не должна ждать другую.
            std::thread::spawn(move || {
                let tools = AppTools { app: app.clone() };
                serve_connection(stream, &tools, &|panel_id| panel_root(&app, panel_id));
            });
        }
    });
}

#[cfg(not(unix))]
pub fn serve(_app: tauri::AppHandle) {}

/// Разговор на одном соединении.
///
/// Корень панели берётся через переданную функцию, а не напрямую из
/// `PtyManager`: так весь путь — рукопожатие, разбор строк, ответы — проверяется
/// на живом сокете без поднятого приложения.
#[cfg(unix)]
fn serve_connection(
    stream: std::os::unix::net::UnixStream,
    tools: &dyn Tools,
    root_of: &dyn Fn(&str) -> Option<PathBuf>,
) {
    use std::io::{BufRead, BufReader, Write};

    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let mut out = write_half;
    let mut lines = BufReader::new(stream).lines();

    // Первая строка — рукопожатие. Без неё неизвестно, кого обслуживаем, и
    // разговор дальше не имеет смысла.
    let Some(Ok(first)) = lines.next() else {
        return;
    };
    let Some(panel_id) = panel_of_handshake(&first) else {
        return;
    };

    for line in lines.map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        // Корень перечитываем на каждый запрос, а не держим с рукопожатия:
        // панель могли закрыть посреди сессии агента, и отвечать по
        // устаревшему корню значило бы работать в чужом каталоге.
        let ctx = PanelContext::new(panel_id.clone(), root_of(&panel_id));
        let Some(answer) = dispatch(&ctx, tools, &line) else {
            continue;
        };
        if out.write_all(answer.as_bytes()).is_err()
            || out.write_all(b"\n").is_err()
            || out.flush().is_err()
        {
            return;
        }
    }
}

#[cfg(unix)]
fn panel_root(app: &tauri::AppHandle, panel_id: &str) -> Option<PathBuf> {
    use tauri::Manager;
    app.state::<crate::pty::PtyManager>().session_root(panel_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn ctx() -> PanelContext {
        PanelContext::new("panel-a".into(), Some(PathBuf::from("/w/project")))
    }

    #[test]
    fn tells_the_agent_the_reason_and_not_only_the_code() {
        use crate::command_error::{CommandError, ErrorCode};

        // Живой случай: «не удалось связаться с браузером: BrowserNotConnected»
        // — всё, что видел агент, и делать с этим было нечего.
        let with_reason = CommandError::new(ErrorCode::BrowserNotConnected)
            .with_context("reason", "у браузера нет ни одной страницы");
        assert_eq!(
            excuse(&with_reason),
            "у браузера нет ни одной страницы (BrowserNotConnected)"
        );

        // Причины может и не быть — тогда остаётся код, и это лучше пустоты.
        assert_eq!(
            excuse(&CommandError::new(ErrorCode::BrowserLaunchFailed)),
            "BrowserLaunchFailed"
        );
    }

    /// Инструменты, которые ничего не запускают, но помнят, о чём их просили.
    struct StubTools {
        answer: Result<(), String>,
        asked_for: Mutex<Vec<PathBuf>>,
        opened: Mutex<Vec<String>>,
    }

    impl StubTools {
        fn working() -> Self {
            Self {
                answer: Ok(()),
                asked_for: Mutex::new(Vec::new()),
                opened: Mutex::new(Vec::new()),
            }
        }

        fn failing(reason: &str) -> Self {
            Self {
                answer: Err(reason.to_string()),
                asked_for: Mutex::new(Vec::new()),
                opened: Mutex::new(Vec::new()),
            }
        }
    }

    impl Tools for StubTools {
        fn open_browser(&self, root: &Path) -> Result<(), String> {
            self.asked_for.lock().unwrap().push(root.to_path_buf());
            self.answer.clone()
        }

        fn navigate(&self, root: &Path, url: &str) -> Result<String, String> {
            self.asked_for.lock().unwrap().push(root.to_path_buf());
            self.opened.lock().unwrap().push(url.to_string());
            self.answer
                .clone()
                .map(|()| "Тестовая страница".to_string())
        }
    }

    fn parse(raw: &str) -> Value {
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn agrees_on_the_protocol_and_names_itself() {
        let answer = dispatch(
            &ctx(),
            &StubTools::working(),
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
        )
        .unwrap();
        let answer = parse(&answer);

        assert_eq!(answer["id"], 1);
        assert_eq!(answer["result"]["protocolVersion"], PROTOCOL_VERSION);
        // Без объявленной способности `tools` клиент за списком не придёт.
        assert!(answer["result"]["capabilities"]["tools"].is_object());
        assert_eq!(answer["result"]["serverInfo"]["name"], "modelcrew");
    }

    #[test]
    fn keeps_quiet_about_a_notification() {
        // У уведомления нет `id`, и ответ на него — нарушение протокола:
        // клиенту некуда его отнести.
        assert!(dispatch(
            &ctx(),
            &StubTools::working(),
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        )
        .is_none());
    }

    #[test]
    fn shows_the_agent_what_it_can_call() {
        let answer = dispatch(
            &ctx(),
            &StubTools::working(),
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        )
        .unwrap();
        let answer = parse(&answer);

        let tools = answer["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["crew_ping", "browser_open", "browser_navigate"]);
        // Схему клиент показывает модели: без неё инструмент не вызвать.
        for tool in tools {
            assert_eq!(tool["inputSchema"]["type"], "object", "{tool}");
            // Описание — единственное, по чему модель решает, звать ли его.
            assert!(
                tool["description"]
                    .as_str()
                    .is_some_and(|text| !text.is_empty()),
                "инструмент без описания: {tool}"
            );
        }
    }

    #[test]
    fn tells_the_agent_which_panel_it_speaks_from() {
        let answer = dispatch(
            &ctx(),
            &StubTools::working(),
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"crew_ping"}}"#,
        )
        .unwrap();
        let answer = parse(&answer);

        let text = answer["result"]["content"][0]["text"].as_str().unwrap();
        // Ради этих двух строк всё и затевалось: труба доказана только тогда,
        // когда на том конце знают панель и её проект.
        assert!(text.contains("panel-a"), "нет панели: {text}");
        assert!(text.contains("/w/project"), "нет корня: {text}");
        assert_eq!(answer["result"]["isError"], false);
    }

    #[test]
    fn says_plainly_when_the_panel_is_gone() {
        let orphan = PanelContext::new("panel-gone".into(), None);
        let answer = dispatch(
            &orphan,
            &StubTools::working(),
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"crew_ping"}}"#,
        )
        .unwrap();
        let answer = parse(&answer);

        // Не ошибка протокола: сервер жив, это панели нет. Агент должен
        // прочитать причину, а не решить, что инструмент сломан.
        assert!(answer["error"].is_null());
        let text = answer["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("panel-gone"), "{text}");
    }

    #[test]
    fn refuses_an_unknown_tool_without_breaking_the_session() {
        let answer = dispatch(
            &ctx(),
            &StubTools::working(),
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"browser_navigate"}}"#,
        )
        .unwrap();
        let answer = parse(&answer);

        assert_eq!(answer["result"]["isError"], true);
        assert!(answer["error"].is_null());
    }

    #[test]
    fn answers_an_unknown_method_by_the_protocol() {
        let answer = dispatch(
            &ctx(),
            &StubTools::working(),
            r#"{"jsonrpc":"2.0","id":6,"method":"resources/list"}"#,
        )
        .unwrap();
        let answer = parse(&answer);

        // -32601 — «метода нет»; по нему клиент понимает, что способности нет,
        // и больше не спрашивает.
        assert_eq!(answer["error"]["code"], -32601);
    }

    #[test]
    fn survives_a_broken_line() {
        // Мусор в трубе не должен ронять сессию: отвечаем и слушаем дальше.
        let answer = dispatch(&ctx(), &StubTools::working(), "{это не json").unwrap();
        let answer = parse(&answer);

        assert_eq!(answer["error"]["code"], -32700);
        assert!(answer["id"].is_null());
    }

    #[test]
    fn echoes_the_id_as_it_came() {
        // id по спецификации бывает и строкой; вернув число, мы бы разошлись
        // с клиентом, и он не нашёл бы свой ответ.
        let answer = dispatch(
            &ctx(),
            &StubTools::working(),
            r#"{"jsonrpc":"2.0","id":"a-1","method":"ping"}"#,
        )
        .unwrap();
        assert_eq!(parse(&answer)["id"], "a-1");
    }

    /// Живой сокет целиком: рукопожатие, две команды подряд, ответы построчно.
    ///
    /// Юнит-тесты выше проверяют разбор, но не трубу. А ломается обычно она:
    /// потерянный перевод строки или неотданное рукопожатие выглядят точно
    /// так же, как «агент не видит инструмента».
    #[cfg(unix)]
    #[test]
    fn carries_a_whole_conversation_over_a_real_socket() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::{UnixListener, UnixStream};

        let path = std::env::temp_dir().join(format!("mc-mcp-test-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();

        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            serve_connection(stream, &StubTools::working(), &|panel| {
                (panel == "panel-a").then(|| PathBuf::from("/w/project"))
            });
        });

        let client = UnixStream::connect(&path).unwrap();
        let mut out = client.try_clone().unwrap();
        let mut back = BufReader::new(client).lines();

        let say = |out: &mut UnixStream, line: &str| {
            out.write_all(line.as_bytes()).unwrap();
            out.write_all(b"\n").unwrap();
            out.flush().unwrap();
        };

        say(&mut out, &handshake("panel-a"));
        say(
            &mut out,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
        );
        say(
            &mut out,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"crew_ping"}}"#,
        );

        let first: Value = serde_json::from_str(&back.next().unwrap().unwrap()).unwrap();
        assert_eq!(first["id"], 1);
        assert_eq!(first["result"]["protocolVersion"], PROTOCOL_VERSION);

        // Второй ответ приходит следующей строкой — значит, разделитель на
        // месте и клиент не склеит два ответа в один.
        let second: Value = serde_json::from_str(&back.next().unwrap().unwrap()).unwrap();
        assert_eq!(second["id"], 2);
        let text = second["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("/w/project"), "корень не дошёл: {text}");

        // Именно shutdown, а не drop: `out` — клон, и пока читающая половина
        // жива, сокет открыт, сервер ждёт следующую строку, а join висит.
        out.shutdown(std::net::Shutdown::Write).unwrap();
        server.join().unwrap();
        let _ = std::fs::remove_file(&path);
    }

    /// Соединение без рукопожатия обслуживать некого: закрываем и не отвечаем.
    #[cfg(unix)]
    #[test]
    fn drops_a_connection_that_never_said_who_it_is() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::{UnixListener, UnixStream};

        let path = std::env::temp_dir().join(format!("mc-mcp-nohand-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();

        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            serve_connection(stream, &StubTools::working(), &|_| {
                Some(PathBuf::from("/w/project"))
            });
        });

        let mut client = UnixStream::connect(&path).unwrap();
        // Сразу запрос, минуя рукопожатие.
        client
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n")
            .unwrap();
        client.flush().unwrap();

        let answer = BufReader::new(client.try_clone().unwrap()).lines().next();
        assert!(answer.is_none(), "ответили тому, кто не представился");

        server.join().unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn opens_the_browser_of_the_panel_project() {
        let tools = StubTools::working();
        let answer = dispatch(
            &ctx(),
            &tools,
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"browser_open"}}"#,
        )
        .unwrap();

        // Проект берётся у панели. У инструмента нет параметра с путём, и это
        // не упущение: иначе агент открыл бы браузер чужому проекту.
        assert_eq!(
            *tools.asked_for.lock().unwrap(),
            vec![PathBuf::from("/w/project")]
        );
        assert_eq!(parse(&answer)["result"]["isError"], false);
    }

    #[test]
    fn passes_the_browser_failure_on_to_the_agent() {
        // Причина уходит агенту дословно: он покажет её человеку, и по ней же
        // решит, стоит ли пробовать снова.
        let tools = StubTools::failing("Chrome не найден.");
        let answer = dispatch(
            &ctx(),
            &tools,
            r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"browser_open"}}"#,
        )
        .unwrap();
        let answer = parse(&answer);

        assert_eq!(answer["result"]["isError"], true);
        assert_eq!(answer["result"]["content"][0]["text"], "Chrome не найден.");
        // Сессия при этом цела: это ошибка инструмента, а не протокола.
        assert!(answer["error"].is_null());
    }

    #[test]
    fn refuses_to_open_a_browser_for_a_panel_that_is_gone() {
        let tools = StubTools::working();
        let orphan = PanelContext::new("panel-gone".into(), None);
        let answer = dispatch(
            &orphan,
            &tools,
            r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"browser_open"}}"#,
        )
        .unwrap();

        // Без панели неизвестен проект, а браузер заводится на проект: поднять
        // его «куда-нибудь» хуже, чем не поднять вовсе.
        assert!(tools.asked_for.lock().unwrap().is_empty());
        assert_eq!(parse(&answer)["result"]["isError"], true);
    }

    #[test]
    fn opens_the_page_the_agent_asked_for() {
        let tools = StubTools::working();
        let answer = dispatch(
            &ctx(),
            &tools,
            r#"{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"http://localhost:1420/"}}}"#,
        )
        .unwrap();
        let answer = parse(&answer);

        assert_eq!(
            *tools.opened.lock().unwrap(),
            vec!["http://localhost:1420/"]
        );
        assert_eq!(answer["result"]["isError"], false);
        // Заголовок в ответе: «страница открыта» одинаково звучит и для формы
        // входа, и для 404, а заголовок говорит, куда агент попал на самом деле.
        let text = answer["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("Тестовая страница"), "{text}");
    }

    #[test]
    fn says_what_is_missing_when_no_address_was_given() {
        let tools = StubTools::working();
        for call in [
            r#"{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"browser_navigate"}}"#,
            r#"{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"browser_navigate","arguments":{}}}"#,
            r#"{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":""}}}"#,
        ] {
            let answer = parse(&dispatch(&ctx(), &tools, call).unwrap());
            assert_eq!(answer["result"]["isError"], true, "вызов {call}");
        }
        // Никуда не пошли: без адреса открывать нечего.
        assert!(tools.opened.lock().unwrap().is_empty());
    }

    #[test]
    fn reads_the_panel_from_the_handshake() {
        assert_eq!(
            panel_of_handshake(&handshake("panel-b")).as_deref(),
            Some("panel-b")
        );
        // Пустое и битое рукопожатие — не панель: обслуживать некого.
        assert!(panel_of_handshake(r#"{"panelId":""}"#).is_none());
        assert!(panel_of_handshake("").is_none());
        assert!(panel_of_handshake(r#"{"other":1}"#).is_none());
    }
}
