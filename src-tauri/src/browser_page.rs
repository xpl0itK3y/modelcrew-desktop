//! Страница внутри приложения: браузер плагина без второй программы.
//!
//! Chrome снаружи — это вторая программа. macOS заводит ей плитку в Dock на
//! каждый запуск, и плитка переживает сам процесс, поэтому они копятся.
//! Спрятать её нечем: своего ключа у Chrome нет, подменить бандл на скрытый
//! нельзя — ломается подпись Google, а запуск без доступа к сеансу Chrome не
//! переживает. Поэтому страницу грузит webview самого ModelCrew: снаружи не
//! появляется ничего, потому что появляться нечему.
//!
//! Окно страницы человеку не показывается, а видит её человек кадром в панели
//! браузера, как и раньше. На macOS и Windows страница — отдельный webview в
//! своём окне за краем экранов. Окно и webview у неё разные: webview можно
//! пересадить в другое окно, и страница при этом не перезагрузится. На Linux
//! так нельзя: Wayland не даёт приложению ставить окна, и композитор вывел бы
//! страницу прямо перед человеком. Там окно Tauri спрятано, а сама страница
//! живёт в окне GTK без экрана.

use std::time::Duration;

use tauri::{AppHandle, Manager, Webview, WebviewUrl};

/// Размер страницы, пока о ней никто не спрашивал. От него зависит вёрстка,
/// которую увидит агент, открывший страницу до того, как человек открыл ящик.
const VIEWPORT: (f64, f64) = (1280.0, 800.0);

/// Меньше этого страницу не сжимаем. Ящик можно ужать до полоски, но вёрстка
/// в полосок шириной с ладонь — это уже не то, что человек хотел посмотреть,
/// и агенту она сказала бы о странице неправду. По ширине предел — самый
/// узкий телефон: ящик показывает страницу и в размер телефона, и кадр с
/// широкой вёрсткой там соврал бы так же.
const MIN_VIEWPORT: (f64, f64) = (320.0, 360.0);

/// Куда убрано окно страницы.
///
/// Спрятанное окно система не рисует, а нам нужен настоящий кадр. Поэтому
/// окно остаётся видимым для системы, но стоит за краем любого экрана.
const OFFSCREEN: (f64, f64) = (-31_000.0, -31_000.0);

/// Сколько ждать кадр. Снимок делает система и отвечает не сразу; ждать
/// вечно нельзя — на том конце живой агент.
const SNAPSHOT_WAIT: Duration = Duration::from_secs(5);

/// Сколько ждать, пока переход вообще начнётся: до этого страница честно
/// отвечает «не гружусь» — про прошлую страницу, а не про новую.
const LOAD_START: Duration = Duration::from_millis(150);

/// Как часто переспрашивать, догрузилась ли страница.
const LOAD_POLL: Duration = Duration::from_millis(100);

/// С чего начинается метка страницы: по нему они находятся среди webview
/// самого приложения.
const LABEL_PREFIX: &str = "page-";

/// С чего начинается метка окна, в котором живёт страница.
#[cfg(not(target_os = "linux"))]
const HOST_PREFIX: &str = "pagehost-";

/// Запись консоли: ставится в каждую страницу раньше её собственных скриптов.
const CONSOLE_SCRIPT: &str = include_str!("browser_console.js");

/// Новые окна страницы открываются в ней же: вкладок у браузера проекта нет.
const SAME_PAGE_SCRIPT: &str = include_str!("browser_same_page.js");

/// Забрать записанное. Отвечает строкой JSON, а если записи на странице нет —
/// `null`: подделать читателя страница не может, но и поставить его могло не
/// успеть.
const READ_CONSOLE: &str = concat!(
    "(() => { try { const read = window.__modelcrewConsole; ",
    "return typeof read === \"function\" ? read() : null; } ",
    "catch (_) { return null; } })()",
);

/// Метка окна страницы проекта.
///
/// Метка — отпечаток корня, а не сам путь: в пути есть разделители, пробелы и
/// юникод, а метка окна должна быть простой и устойчивой — один и тот же
/// проект после перезапуска находит своё окно.
pub fn label_for(root: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(root.as_bytes());
    let name: String = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{LABEL_PREFIX}{name}")
}

/// Метка окна, в котором живёт страница.
#[cfg(not(target_os = "linux"))]
fn host_label(label: &str) -> String {
    format!("{HOST_PREFIX}{}", label.trim_start_matches(LABEL_PREFIX))
}

/// Плагин приложения, чей скрипт не попадает в страницы проекта.
///
/// Скрипты плагинов Tauri ставит в каждый webview, и в страницу проекта тоже.
/// Команд плагина страница не вызовет — права на них только у окна
/// приложения. Скрипт уведомлений с порога спрашивает разрешение, получает
/// отказ и пишет его в консоль страницы: человек и агент видят ошибку, которой
/// у проекта нет. Скрипт ссылок перехватывает ссылку в новое окно раньше
/// страницы, а открыть её не может — щелчок пропадает.
///
/// Метку webview Tauri выставляет раньше скриптов плагинов — по ней скрипт
/// узнаёт, куда попал. Скрипт идёт только в главную рамку, как и у самих
/// плагинов приложения: иначе Tauri его не ставит, а тип с этим признаком
/// наружу он не отдаёт.
pub struct AppOnly<P>(pub P);

impl<R: tauri::Runtime, P: tauri::plugin::Plugin<R>> tauri::plugin::Plugin<R> for AppOnly<P> {
    fn name(&self) -> &'static str {
        self.0.name()
    }

    fn initialize(
        &mut self,
        app: &AppHandle<R>,
        config: serde_json::Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.0.initialize(app, config)
    }

    fn initialization_script(&self) -> Option<String> {
        self.0
            .initialization_script()
            .map(|script| outside_pages(&script))
    }

    fn window_created(&mut self, window: tauri::Window<R>) {
        self.0.window_created(window)
    }

    fn webview_created(&mut self, webview: Webview<R>) {
        self.0.webview_created(webview)
    }

    fn on_navigation(&mut self, webview: &Webview<R>, url: &tauri::Url) -> bool {
        self.0.on_navigation(webview, url)
    }

    fn on_page_load(
        &mut self,
        webview: &Webview<R>,
        payload: &tauri::webview::PageLoadPayload<'_>,
    ) {
        self.0.on_page_load(webview, payload)
    }

    fn on_event(&mut self, app: &AppHandle<R>, event: &tauri::RunEvent) {
        self.0.on_event(app, event)
    }

    fn extend_api(&mut self, invoke: tauri::ipc::Invoke<R>) -> bool {
        self.0.extend_api(invoke)
    }
}

/// Скрипт, который в странице проекта не делает ничего. Перенос строки перед
/// скобкой — на случай, если скрипт кончается строчным комментарием.
fn outside_pages(script: &str) -> String {
    format!(
        "if (!String(window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label ?? \"\")\
         .startsWith({prefix})) {{\n{script}\n}}",
        prefix = serde_json::to_string(LABEL_PREFIX).expect("строка всегда пишется в JSON"),
    )
}

/// Открыть страницу проекта или перевести уже открытую на новый адрес.
pub fn open(app: &AppHandle, root: &str, url: &str) -> Result<(), String> {
    let target: tauri::Url = url
        .parse()
        .map_err(|_| format!("адрес не разобрать: {url}"))?;
    let label = label_for(root);
    if let Some(page) = app.get_webview(&label) {
        return page
            .navigate(target)
            .map_err(|error| format!("страница не перешла по адресу: {error}"));
    }
    create(app, &label, target)?;
    // Пока страница открыта, она идёт следом за правками в проекте.
    crate::browser_auto_reload::start(app, root);
    Ok(())
}

/// Новая страница: webview в своём окне за краем экранов.
#[cfg(not(target_os = "linux"))]
fn create(app: &AppHandle, label: &str, target: tauri::Url) -> Result<(), String> {
    let host = make_host(app, &host_label(label))
        .map_err(|error| format!("страница не открылась: {error}"))?;
    let page = tauri::webview::WebviewBuilder::new(label, WebviewUrl::External(target))
        // Консоль страницы не узнать задним числом: писать за ней надо с
        // первой её строчки.
        .initialization_script(CONSOLE_SCRIPT)
        .initialization_script(SAME_PAGE_SCRIPT)
        // Файл, брошенный на страницу, — для сайта: так в него загружают.
        // Перехвати его Tauri, сайт бы его не увидел, а нам он здесь ни к
        // чему — терминалы ловят файлы в своём webview.
        .disable_drag_drop_handler();
    #[cfg(windows)]
    let page = system::watch_loading(page, label);
    let placed = host.add_child(
        page,
        tauri::LogicalPosition::new(0.0, 0.0),
        tauri::LogicalSize::new(VIEWPORT.0, VIEWPORT.1),
    );
    if let Err(error) = placed {
        // Пустое окно за краем экрана держало бы память, а показать его
        // некому.
        let _ = host.destroy();
        return Err(format!("страница не открылась: {error}"));
    }
    Ok(())
}

/// Новая страница: окно Tauri, чей webview уезжает в окно GTK без экрана.
#[cfg(target_os = "linux")]
fn create(app: &AppHandle, label: &str, target: tauri::Url) -> Result<(), String> {
    let page = tauri::WebviewWindowBuilder::new(app, label, WebviewUrl::External(target))
        .title("ModelCrew")
        .inner_size(VIEWPORT.0, VIEWPORT.1)
        .position(OFFSCREEN.0, OFFSCREEN.1)
        .decorations(false)
        .skip_taskbar(true)
        .focused(false)
        // Консоль страницы не узнать задним числом: писать за ней надо с
        // первой её строчки.
        .initialization_script(CONSOLE_SCRIPT)
        .initialization_script(SAME_PAGE_SCRIPT)
        .visible(false)
        .build()
        .map_err(|error| format!("страница не открылась: {error}"))?;
    // Спрятанное окно WebKitGTK не снимает, поэтому страница переезжает в
    // окно без экрана, а окно Tauri так и не покажется.
    system::move_offscreen(&page)
}

/// Окно за краем экранов, в котором страница живёт, пока её не показывают.
#[cfg(not(target_os = "linux"))]
fn make_host(app: &AppHandle, label: &str) -> tauri::Result<tauri::Window> {
    tauri::window::WindowBuilder::new(app, label)
        .title("ModelCrew")
        .inner_size(VIEWPORT.0, VIEWPORT.1)
        .position(OFFSCREEN.0, OFFSCREEN.1)
        .decorations(false)
        .skip_taskbar(true)
        .focused(false)
        .build()
}

/// Страница проекта, если она открыта.
fn find(app: &AppHandle, root: &str) -> Result<Webview, String> {
    app.get_webview(&label_for(root))
        .ok_or_else(|| "страница ещё не открыта".to_string())
}

/// Подогнать страницу под то место, где её показывают.
///
/// Ящик и страница должны совпадать: иначе кадр 1280×800 растягивается по
/// ширине ящика, снизу остаётся чёрная полоса, а агент видит вёрстку, которой
/// перед человеком нет.
pub fn fit(app: &AppHandle, root: &str, width: f64, height: f64) -> Result<(), String> {
    let page = find(app, root)?;
    let wanted = (width.max(MIN_VIEWPORT.0), height.max(MIN_VIEWPORT.1));
    // На Linux размер страницы знает только окно без экрана: спрятанному
    // окну Tauri система о его размере не сообщает.
    #[cfg(target_os = "linux")]
    return system::resize(&page, wanted.0, wanted.1);
    #[cfg(not(target_os = "linux"))]
    {
        // В панели размер страницы задаёт сама панель, вместе с местом.
        if sits_in_main(&page) {
            return Ok(());
        }
        // Кадр просят раз в секунду, а перерисовка страницы стоит времени:
        // меняем размер, только когда он и правда разъехался с местом.
        if let Some(current) = logical_size(&page) {
            if (current.0 - wanted.0).abs() < 1.0 && (current.1 - wanted.1).abs() < 1.0 {
                return Ok(());
            }
        }
        let size = tauri::LogicalSize::new(wanted.0, wanted.1);
        // Окно растёт вместе со страницей: что вылезло за его край, система
        // может и не рисовать.
        if let Some(host) = app.get_window(&host_label(page.label())) {
            host.set_size(size)
                .map_err(|error| format!("страницу не изменить в размере: {error}"))?;
        }
        page.set_size(size)
            .map_err(|error| format!("страницу не изменить в размере: {error}"))
    }
}

/// Размер страницы в тех же единицах, в которых его задают, — точках, а не
/// пикселях устройства.
fn logical_size(page: &Webview) -> Option<(f64, f64)> {
    let scale = page.window().scale_factor().ok()?;
    let size = page.size().ok()?;
    (scale > 0.0).then(|| {
        (
            f64::from(size.width) / scale,
            f64::from(size.height) / scale,
        )
    })
}

/// Адрес, по которому странице можно ходить.
///
/// Всё остальное — `file://`, `javascript:` и прочее — это уже не «сходи
/// посмотри страницу», а доступ к машине руками агента.
pub fn is_web(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Шаг страницы по просьбе человека — кнопки над ней в панели.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Step {
    Back,
    Forward,
    Reload,
    /// Бросить загрузку: сервер завис, а ждать его человек не хочет.
    Stop,
}

/// Назад, вперёд или заново.
///
/// История у страницы своя, и ходить по ней проще всего её же руками: так шаг
/// одинаков во всех трёх webview, без кода под каждую систему. Пустая история
/// — не ошибка: страница просто останется где была, как и в браузере.
pub fn step(app: &AppHandle, root: &str, step: Step) -> Result<(), String> {
    let page = find(app, root)?;
    let done = match step {
        Step::Back => page.eval("history.back()"),
        Step::Forward => page.eval("history.forward()"),
        Step::Reload => page.reload(),
        // Тем же путём, что и браузер по Esc: и для начатого перехода, и для
        // картинок со скриптами, что ещё догружаются.
        Step::Stop => page.eval("window.stop()"),
    };
    done.map_err(|error| format!("до страницы не достучаться: {error}"))
}

/// Грузится ли страница проекта. Не ответила — считаем, что нет: полоса
/// загрузки, застрявшая навсегда, хуже пропавшей на миг.
pub fn is_loading(app: &AppHandle, root: &str) -> bool {
    system::is_loading(app, root).unwrap_or(false)
}

/// Открыта ли страница проекта.
pub fn is_open(app: &AppHandle, root: &str) -> bool {
    app.get_webview(&label_for(root)).is_some()
}

/// Закрыть страницу проекта.
pub fn close(app: &AppHandle, root: &str) {
    remove(app, &label_for(root));
}

/// Закрыть все страницы: выход из приложения и выключенный плагин.
///
/// Без этого окна остались бы висеть за краем экрана: человеку их не видно,
/// а память и загруженные страницы они держат.
pub fn close_all(app: &AppHandle) {
    for label in app.webviews().into_keys() {
        if label.starts_with(LABEL_PREFIX) {
            remove(app, &label);
        }
    }
    // Окно, чья страница не открылась или уже закрыта, тоже никому не нужно.
    #[cfg(not(target_os = "linux"))]
    for (label, host) in app.windows() {
        if label.starts_with(HOST_PREFIX) {
            let _ = host.destroy();
        }
    }
}

/// Убрать страницу вместе с её окном.
///
/// `destroy`, а не `close`: закрытие окна — это просьба, её слушает
/// обработчик окон и её можно отменить. Здесь просьб не место: страницы быть
/// не должно.
fn remove(app: &AppHandle, label: &str) {
    crate::browser_auto_reload::stop(label);
    #[cfg(target_os = "linux")]
    if let Some(window) = app.get_window(label) {
        let _ = window.destroy();
    }
    #[cfg(not(target_os = "linux"))]
    {
        // Сначала сама страница: окно уносит с собой лишь те webview, что
        // сидят в нём сейчас.
        if let Some(page) = app.get_webview(label) {
            let _ = page.close();
        }
        if let Some(host) = app.get_window(&host_label(label)) {
            let _ = host.destroy();
        }
    }
}

/// Метка главного окна: в нём страницу показывают живой.
const MAIN_WINDOW: &str = "main";

/// Где показать страницу: точки от левого верхнего угла главного окна.
#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub struct Place {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Умеет ли эта система показать страницу живой, а не кадром.
///
/// На Linux страница живёт в окне GTK без экрана, и пересадить её в главное
/// окно нельзя: там её показывают кадром.
pub const CAN_DOCK: bool = cfg!(not(target_os = "linux"));

/// Стоит ли страница проекта сейчас в главном окне.
pub fn is_docked(app: &AppHandle, root: &str) -> bool {
    app.get_webview(&label_for(root))
        .is_some_and(|page| sits_in_main(&page))
}

fn sits_in_main(page: &Webview) -> bool {
    page.window().label() == MAIN_WINDOW
}

/// Все открытые страницы.
fn pages(app: &AppHandle) -> Vec<Webview> {
    app.webviews()
        .into_iter()
        .filter(|(label, _)| label.starts_with(LABEL_PREFIX))
        .map(|(_, page)| page)
        .collect()
}

/// Показать страницу живой: пересадить её в главное окно, поверх панели
/// браузера.
///
/// Там она остаётся собой: щелчки, ввод и прокрутка идут прямо в неё, а
/// рисует её система в полном разрешении экрана. Место задаёт панель, в
/// точках от угла окна: главный webview занимает окно целиком, и его вёрстка
/// меряется в них же.
#[cfg(not(target_os = "linux"))]
pub fn dock(app: &AppHandle, root: &str, place: Place) -> Result<(), String> {
    let page = find(app, root)?;
    let bounds = tauri::Rect {
        position: tauri::LogicalPosition::new(place.x, place.y).into(),
        size: tauri::LogicalSize::new(place.width.max(1.0), place.height.max(1.0)).into(),
    };
    let misplaced = |error: tauri::Error| format!("страницу не поставить в панель: {error}");
    if sits_in_main(&page) {
        return page.set_bounds(bounds).map_err(misplaced);
    }
    let main = app
        .get_window(MAIN_WINDOW)
        .ok_or_else(|| "главного окна нет".to_string())?;
    // Место в панели одно: страница другого проекта уходит к себе.
    for other in pages(app) {
        if other.label() != page.label() && sits_in_main(&other) {
            send_home(app, &other)?;
        }
    }
    // Пересаженная страница стоит там же, где стояла дома, — в углу окна и
    // в размер дома. Пока её не поставили на место, её не видно, иначе она
    // на миг закрыла бы собой всё окно.
    page.hide().map_err(misplaced)?;
    page.reparent(&main).map_err(misplaced)?;
    page.set_bounds(bounds).map_err(misplaced)?;
    page.show().map_err(misplaced)
}

#[cfg(target_os = "linux")]
pub fn dock(_app: &AppHandle, _root: &str, _place: Place) -> Result<(), String> {
    Err("здесь страницу показывают только кадром".to_string())
}

/// Вернуть страницу проекта из панели в её окно.
pub fn undock(app: &AppHandle, root: &str) -> Result<(), String> {
    match app.get_webview(&label_for(root)) {
        Some(page) => send_home(app, &page),
        None => Ok(()),
    }
}

/// Вернуть в свои окна все страницы: главное окно прячут.
///
/// В спрятанном окне страница перестала бы рисоваться, и агент, попросив
/// снимок, получил бы пустоту.
pub fn undock_all(app: &AppHandle) {
    for page in pages(app) {
        let _ = send_home(app, &page);
    }
}

/// Вернуть страницу в её окно за краем экранов.
#[cfg(not(target_os = "linux"))]
fn send_home(app: &AppHandle, page: &Webview) -> Result<(), String> {
    if !sits_in_main(page) {
        return Ok(());
    }
    let unplaced = |error: tauri::Error| format!("страницу не убрать из панели: {error}");
    let label = host_label(page.label());
    let host = match app.get_window(&label) {
        Some(host) => host,
        None => make_host(app, &label).map_err(unplaced)?,
    };
    // Размер страница уносит с собой: агент, снявший её дома, увидит ту же
    // вёрстку, что видел человек.
    let (width, height) = logical_size(page).unwrap_or(VIEWPORT);
    let size = tauri::LogicalSize::new(width, height);
    host.set_size(size).map_err(unplaced)?;
    page.reparent(&host).map_err(unplaced)?;
    page.set_bounds(tauri::Rect {
        position: tauri::LogicalPosition::new(0.0, 0.0).into(),
        size: size.into(),
    })
    .map_err(unplaced)
}

#[cfg(target_os = "linux")]
fn send_home(_app: &AppHandle, _page: &Webview) -> Result<(), String> {
    Ok(())
}

/// Кадр страницы проекта, PNG.
pub fn snapshot(app: &AppHandle, root: &str) -> Result<Vec<u8>, String> {
    let page = find(app, root)?;
    // Ширину снимка берём у самой страницы: она меняется вместе с ящиком, и
    // постоянная здесь означала бы кадр не того размера, что показывают.
    let width = logical_size(&page).map_or(VIEWPORT.0, |size| size.0) as u32;
    let scale = page.window().scale_factor().unwrap_or(1.0);
    let (sender, receiver) = std::sync::mpsc::channel();
    page.with_webview(move |platform| {
        // Снимок начинает система и отвечает позже своим вызовом, поэтому
        // ответ уходит в канал, а не возвращается отсюда.
        system::snapshot(&platform, width, scale, sender);
    })
    .map_err(|error| format!("до страницы не достучаться: {error}"))?;
    match receiver.recv_timeout(SNAPSHOT_WAIT) {
        Ok(result) => result,
        Err(_) => Err("страница не отдала кадр".to_string()),
    }
}

/// Адрес и заголовок страницы — то, чем она подписывается агенту.
pub fn info(app: &AppHandle, root: &str) -> Result<(String, String), String> {
    ask(app, root, system::info)
}

/// Что страница написала в консоль с тех пор, как загрузилась.
#[derive(Debug, Default, PartialEq, serde::Deserialize)]
pub struct ConsoleLog {
    pub messages: Vec<ConsoleMessage>,
    /// Сколько ранних сообщений вытеснено новыми.
    #[serde(default)]
    pub dropped: u64,
    /// Когда страница начала запись, в миллисекундах эпохи. Сменилась —
    /// значит, страницу загрузили заново и счёт пошёл с нуля.
    #[serde(default)]
    pub started: f64,
}

#[derive(Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct ConsoleMessage {
    /// Метод console — log, info, warn, error, debug, — либо то, что страница
    /// не писала сама: exception, rejection, resource.
    pub level: String,
    pub text: String,
}

/// Консоль страницы проекта.
///
/// Платформенного кода здесь нет: спросить страницу и получить ответ JSON
/// умеют все три webview, и Tauri даёт это одним вызовом.
pub fn console(app: &AppHandle, root: &str) -> Result<ConsoleLog, String> {
    let page = find(app, root)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    page.eval_with_callback(READ_CONSOLE, move |answer| {
        let _ = sender.send(answer);
    })
    .map_err(|error| format!("до страницы не достучаться: {error}"))?;
    // До первой загрузки wry держит скрипт в очереди и ответа не будет вовсе.
    let answer = receiver
        .recv_timeout(SNAPSHOT_WAIT)
        .map_err(|_| "страница не ответила".to_string())?;
    console_of(&answer)
}

/// Ответ страницы — JSON того, что вернул читатель: строка с записанным или
/// пусто, если записи нет. Исключение WebKit отдаёт пустой строкой, а
/// WebView2 — `null`.
fn console_of(answer: &str) -> Result<ConsoleLog, String> {
    let recorded = serde_json::from_str::<Option<String>>(answer)
        .ok()
        .flatten()
        .ok_or_else(|| {
            "страница не отдала консоль: запись ставится при загрузке, откройте страницу заново"
                .to_string()
        })?;
    serde_json::from_str(&recorded).map_err(|_| "консоль страницы не разобрать".to_string())
}

/// Дождаться, пока страница догрузится.
///
/// Возвращает `false`, если не дождались: это не повод для отказа — кадр
/// недогруженной страницы честнее, чем ошибка вместо кадра.
pub fn wait_ready(app: &AppHandle, root: &str, wait: Duration) -> bool {
    // Сразу после перехода загрузка ещё не началась, и `is_loading` соврал бы
    // «готово». Поэтому сперва даём ей начаться.
    std::thread::sleep(LOAD_START);
    let deadline = std::time::Instant::now() + wait;
    while std::time::Instant::now() < deadline {
        match system::is_loading(app, root) {
            Ok(false) => return true,
            // Окна нет — ждать нечего.
            Err(_) => return false,
            Ok(true) => std::thread::sleep(LOAD_POLL),
        }
    }
    false
}

/// Спросить у webview то, что знает только он сам.
///
/// Отвечает он на главном потоке, а спрашивают с чужого, поэтому ответ
/// возвращается каналом.
fn ask<T: Send + 'static>(
    app: &AppHandle,
    root: &str,
    probe: fn(&tauri::webview::PlatformWebview) -> Result<T, String>,
) -> Result<T, String> {
    let page = find(app, root)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    page.with_webview(move |platform| {
        let _ = sender.send(probe(&platform));
    })
    .map_err(|error| format!("до страницы не достучаться: {error}"))?;
    match receiver.recv_timeout(SNAPSHOT_WAIT) {
        Ok(result) => result,
        Err(_) => Err("страница не ответила".to_string()),
    }
}

/// Куда уходит готовый кадр: система снимает не сразу и отвечает своим
/// вызовом.
type Frame = std::sync::mpsc::Sender<Result<Vec<u8>, String>>;

/// macOS: страница — это WKWebView.
#[cfg(target_os = "macos")]
mod system {
    use objc2_web_kit::WKWebView;
    use tauri::{webview::PlatformWebview, AppHandle};

    /// Указатель отдаёт сам Tauri, и отдаёт его на главном потоке — там же,
    /// где живёт webview. Ничего другого по этому адресу быть не может.
    fn webview(platform: &PlatformWebview) -> &WKWebView {
        unsafe { &*(platform.inner() as *mut WKWebView) }
    }

    /// Адрес и заголовок глазами системы.
    pub fn info(platform: &PlatformWebview) -> Result<(String, String), String> {
        let webview = webview(platform);
        let url = unsafe { webview.URL() }
            .and_then(|url| url.absoluteString())
            .map(|text| text.to_string())
            .unwrap_or_default();
        let title = unsafe { webview.title() }
            .map(|text| text.to_string())
            .unwrap_or_default();
        Ok((url, title))
    }

    /// Идёт ли ещё загрузка.
    pub fn is_loading(app: &AppHandle, root: &str) -> Result<bool, String> {
        super::ask(app, root, |platform| {
            Ok(unsafe { webview(platform).isLoading() })
        })
    }

    /// Снимок средствами системы.
    pub fn snapshot(platform: &PlatformWebview, width: u32, scale: f64, sender: super::Frame) {
        use block2::RcBlock;
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSImage;
        use objc2_foundation::{NSError, NSNumber};
        use objc2_web_kit::WKSnapshotConfiguration;

        // Tauri зовёт нас на главном потоке — там же, где живёт webview и куда
        // AppKit пускает только оттуда. Если это вдруг не так, снимка не будет.
        let Some(main_thread) = MainThreadMarker::new() else {
            let _ = sender.send(Err("снимок просят не с главного потока".to_string()));
            return;
        };

        let config = unsafe { WKSnapshotConfiguration::new(main_thread) };
        // Ширину снимка система меряет в точках и отдаёт кадр в пикселях
        // экрана: на ретине их вдвое больше по каждой стороне. Агенту кадр
        // уходит картинкой в ответе, поэтому просим столько точек, чтобы
        // пикселей вышло ровно по ширине страницы: вчетверо меньше байт при
        // той же вёрстке.
        let points = f64::from(width) / if scale > 0.0 { scale } else { 1.0 };
        unsafe { config.setSnapshotWidth(Some(&NSNumber::new_f64(points))) };
        let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let _ = sender.send(unsafe { png_of(image, error) });
        });
        unsafe {
            webview(platform)
                .takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler)
        };
    }

    /// Ответ системы на снимок: картинка или беда.
    unsafe fn png_of(
        image: *mut objc2_app_kit::NSImage,
        error: *mut objc2_foundation::NSError,
    ) -> Result<Vec<u8>, String> {
        use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
        use objc2_foundation::NSDictionary;

        if let Some(error) = unsafe { error.as_ref() } {
            return Err(format!(
                "снимок не удался: {}",
                error.localizedDescription()
            ));
        }
        let image = unsafe { image.as_ref() }.ok_or_else(|| "снимка нет".to_string())?;
        let tiff = image
            .TIFFRepresentation()
            .ok_or_else(|| "кадр пуст".to_string())?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff)
            .ok_or_else(|| "кадр не разобрать".to_string())?;
        let png = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
        }
        .ok_or_else(|| "PNG не собрался".to_string())?;
        Ok(png.to_vec())
    }
}

/// Linux: страница — это WebKitGTK.
#[cfg(target_os = "linux")]
mod system {
    use cairo::{Context, Format, ImageSurface};
    use gtk::prelude::*;
    use tauri::{webview::PlatformWebview, AppHandle};
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

    /// Переселить страницу из окна Tauri в окно без экрана.
    ///
    /// Окно без экрана GTK рисует в память: композитор о нём не знает и
    /// показать его не может, а страница в нём рисуется и снимается так же,
    /// как в настоящем окне.
    pub fn move_offscreen(window: &tauri::WebviewWindow) -> Result<(), String> {
        window
            .with_webview(|platform| {
                let webview = platform.inner();
                if let Some(parent) = webview.parent() {
                    if let Ok(parent) = parent.downcast::<gtk::Container>() {
                        parent.remove(&webview);
                    }
                }
                let page = gtk::OffscreenWindow::new();
                page.set_default_size(super::VIEWPORT.0 as i32, super::VIEWPORT.1 as i32);
                page.add(&webview);
                page.show_all();
                // Закрывая окно, Tauri уничтожает webview, но не знает про
                // окно без экрана — его убираем следом сами.
                let page = page.downgrade();
                webview.connect_destroy(move |_| {
                    if let Some(page) = page.upgrade() {
                        unsafe { page.destroy() };
                    }
                });
            })
            .map_err(|error| format!("страницу не убрать с экрана: {error}"))
    }

    /// Подогнать окно без экрана под размер страницы.
    ///
    /// Не дожидаясь ответа: зовут нас с рантайма команд, а размер меняется на
    /// главном потоке. Тот же размер повторно не ставится — иначе страница
    /// перекладывалась бы при каждом кадре.
    pub fn resize(page: &tauri::Webview, width: f64, height: f64) -> Result<(), String> {
        let wanted = (width.round() as i32, height.round() as i32);
        page.with_webview(move |platform| {
            let Some(page) = offscreen(&platform.inner()) else {
                return;
            };
            if page.default_size() != wanted {
                page.set_default_size(wanted.0, wanted.1);
            }
        })
        .map_err(|error| format!("страницу не изменить в размере: {error}"))
    }

    fn offscreen(webview: &webkit2gtk::WebView) -> Option<gtk::OffscreenWindow> {
        webview.toplevel()?.downcast::<gtk::OffscreenWindow>().ok()
    }

    /// Адрес и заголовок глазами системы.
    pub fn info(platform: &PlatformWebview) -> Result<(String, String), String> {
        let webview = platform.inner();
        let url = webview
            .uri()
            .map(|text| text.to_string())
            .unwrap_or_default();
        let title = webview
            .title()
            .map(|text| text.to_string())
            .unwrap_or_default();
        Ok((url, title))
    }

    /// Идёт ли ещё загрузка.
    pub fn is_loading(app: &AppHandle, root: &str) -> Result<bool, String> {
        super::ask(app, root, |platform| Ok(platform.inner().is_loading()))
    }

    /// Снимок средствами системы.
    pub fn snapshot(platform: &PlatformWebview, _width: u32, _scale: f64, sender: super::Frame) {
        let webview = platform.inner();
        // Ширину берём у самой страницы: окно Tauri спрятано, и его размер
        // система не обновляет.
        let width = u32::try_from(webview.allocated_width()).unwrap_or(0);
        // Видимая часть, а не вся страница: агент должен увидеть то же, что
        // показывают человеку в ящике.
        webview.snapshot(
            SnapshotRegion::Visible,
            SnapshotOptions::NONE,
            None::<&webkit2gtk::gio::Cancellable>,
            move |result| {
                let _ = sender.send(match result {
                    Ok(surface) => png_of(surface, width),
                    Err(error) => Err(format!("снимок не удался: {error}")),
                });
            },
        );
    }

    /// Ответ системы на снимок — в PNG.
    fn png_of(surface: cairo::Surface, width: u32) -> Result<Vec<u8>, String> {
        let frame = ImageSurface::try_from(surface).map_err(|_| "кадр не картинка".to_string())?;
        let frame = narrowed(frame, width)?;
        let mut png = Vec::new();
        frame
            .write_to_png(&mut png)
            .map_err(|error| format!("PNG не собрался: {error}"))?;
        Ok(png)
    }

    /// Кадр шириной со страницу.
    ///
    /// На экране с увеличением система снимает в пикселях устройства, и кадр
    /// выходит вдвое больше страницы. Агенту он уходит картинкой в ответе —
    /// лишние пиксели здесь только лишние байты.
    fn narrowed(frame: ImageSurface, width: u32) -> Result<ImageSurface, String> {
        let width = i32::try_from(width).unwrap_or(i32::MAX);
        if width <= 0 || frame.width() <= width {
            return Ok(frame);
        }
        let factor = f64::from(width) / f64::from(frame.width());
        let height = ((f64::from(frame.height()) * factor).round() as i32).max(1);
        let small = ImageSurface::create(Format::ARgb32, width, height)
            .map_err(|error| format!("кадр не уменьшить: {error}"))?;
        // Увеличение уже сидит в самом кадре: оставь его — и cairo уменьшит
        // кадр второй раз сам.
        frame.set_device_scale(1.0, 1.0);
        let context =
            Context::new(&small).map_err(|error| format!("кадр не уменьшить: {error}"))?;
        context.scale(factor, factor);
        context
            .set_source_surface(&frame, 0.0, 0.0)
            .and_then(|()| context.paint())
            .map_err(|error| format!("кадр не уменьшить: {error}"))?;
        drop(context);
        Ok(small)
    }
}

/// Windows: страница — это WebView2.
#[cfg(windows)]
mod system {
    use std::collections::BTreeSet;
    use std::sync::Mutex;

    use tauri::webview::{PageLoadEvent, PlatformWebview, WebviewBuilder};
    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    };
    use webview2_com::{take_pwstr, CapturePreviewCompletedHandler};
    use windows::core::PWSTR;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};

    /// Страницы, у которых переход начался и ещё не закончился.
    ///
    /// Спросить у WebView2 «грузишься?» нельзя — такого вопроса у него нет,
    /// о загрузке он только сообщает событиями. Их и запоминаем. Закрытую
    /// страницу отсюда не вычёркиваем: о закрытой не спрашивают, а новая
    /// страница того же проекта сама отметит свой переход.
    static LOADING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

    fn mark(label: &str, loading: bool) {
        let mut pages = LOADING
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if loading {
            pages.insert(label.to_string());
        } else {
            pages.remove(label);
        }
    }

    /// Следить за переходами страницы: начало — по запросу перехода, конец —
    /// по его завершению, удачному или нет.
    pub fn watch_loading(
        builder: WebviewBuilder<tauri::Wry>,
        label: &str,
    ) -> WebviewBuilder<tauri::Wry> {
        let started = label.to_string();
        builder
            .on_navigation(move |_| {
                mark(&started, true);
                true
            })
            .on_page_load(|page, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    mark(page.label(), false);
                }
            })
    }

    /// Идёт ли ещё загрузка.
    pub fn is_loading(app: &AppHandle, root: &str) -> Result<bool, String> {
        let label = super::label_for(root);
        if app.get_webview(&label).is_none() {
            return Err("страница ещё не открыта".to_string());
        }
        let pages = LOADING
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(pages.contains(&label))
    }

    fn webview(platform: &PlatformWebview) -> Result<ICoreWebView2, String> {
        unsafe { platform.controller().CoreWebView2() }
            .map_err(|error| format!("до страницы не достучаться: {error}"))
    }

    /// Адрес и заголовок глазами системы.
    pub fn info(platform: &PlatformWebview) -> Result<(String, String), String> {
        let webview = webview(platform)?;
        let mut text = PWSTR::null();
        unsafe { webview.Source(&mut text) }
            .map_err(|error| format!("адрес страницы не узнать: {error}"))?;
        let url = take_pwstr(text);
        let mut text = PWSTR::null();
        unsafe { webview.DocumentTitle(&mut text) }
            .map_err(|error| format!("заголовок страницы не узнать: {error}"))?;
        Ok((url, take_pwstr(text)))
    }

    /// Снимок средствами системы.
    ///
    /// Ширину WebView2 не принимает: кадр выходит в пикселях устройства, и на
    /// экране с увеличением он больше страницы. Вёрстка в нём та же.
    pub fn snapshot(platform: &PlatformWebview, _width: u32, _scale: f64, sender: super::Frame) {
        if let Err(error) = capture(platform, sender.clone()) {
            let _ = sender.send(Err(error));
        }
    }

    fn capture(platform: &PlatformWebview, sender: super::Frame) -> Result<(), String> {
        let webview = webview(platform)?;
        // Поток в памяти: система пишет в него PNG, а мы читаем, когда она
        // скажет, что дописала.
        let stream = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) }
            .map_err(|error| format!("кадру некуда лечь: {error}"))?;
        let written = stream.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
            let _ = sender.send(
                result
                    .map_err(|error| format!("снимок не удался: {error}"))
                    .and_then(|()| read_all(&written)),
            );
            Ok(())
        }));
        unsafe {
            webview.CapturePreview(
                COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                &stream,
                &handler,
            )
        }
        .map_err(|error| format!("снимок не начался: {error}"))
    }

    fn read_all(stream: &IStream) -> Result<Vec<u8>, String> {
        let broken = |error: windows::core::Error| format!("кадр не прочитать: {error}");
        let mut stat = STATSTG::default();
        unsafe { stream.Stat(&mut stat, STATFLAG_NONAME) }.map_err(broken)?;
        unsafe { stream.Seek(0, STREAM_SEEK_SET, None) }.map_err(broken)?;
        let mut png = vec![0u8; usize::try_from(stat.cbSize).unwrap_or(0)];
        let mut filled = 0;
        while filled < png.len() {
            let rest = &mut png[filled..];
            let mut read = 0u32;
            unsafe {
                stream.Read(
                    rest.as_mut_ptr().cast(),
                    u32::try_from(rest.len()).unwrap_or(u32::MAX),
                    Some(&mut read),
                )
            }
            .ok()
            .map_err(broken)?;
            if read == 0 {
                break;
            }
            filled += read as usize;
        }
        png.truncate(filled);
        if png.is_empty() {
            return Err("кадр пуст".to_string());
        }
        Ok(png)
    }
}

/// Остальные системы: страницы плагина там нет.
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod system {
    use tauri::{webview::PlatformWebview, AppHandle};

    pub fn info(_platform: &PlatformWebview) -> Result<(String, String), String> {
        Err("страница здесь не поддержана".to_string())
    }

    /// Ждать нечего — считаем, что уже догрузилась.
    pub fn is_loading(_app: &AppHandle, _root: &str) -> Result<bool, String> {
        Ok(false)
    }

    pub fn snapshot(_platform: &PlatformWebview, _width: u32, _scale: f64, sender: super::Frame) {
        let _ = sender.send(Err("снимок страницы здесь не поддержан".to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_project_always_gets_the_same_window() {
        assert_eq!(label_for("/w/one"), label_for("/w/one"));
    }

    #[test]
    fn different_projects_get_different_windows() {
        assert_ne!(label_for("/w/one"), label_for("/w/two"));
    }

    #[test]
    fn the_label_survives_paths_a_window_label_could_not_carry() {
        let label = label_for("/w/проект с пробелом/и-«кавычками»");
        assert!(
            label
                .trim_start_matches(LABEL_PREFIX)
                .chars()
                .all(|c| c.is_ascii_hexdigit()),
            "метка окна должна остаться простой: {label}"
        );
    }

    #[test]
    fn plugin_scripts_step_aside_in_project_pages() {
        let script = outside_pages("window.ran = true; // конец");
        assert!(
            script.starts_with(
                "if (!String(window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label \
                 ?? \"\").startsWith(\"page-\")) {\n"
            ),
            "{script}"
        );
        // Строчный комментарий в конце не съедает закрывающую скобку.
        assert!(
            script.ends_with("window.ran = true; // конец\n}"),
            "{script}"
        );
    }

    #[test]
    fn steps_come_from_the_panel_by_their_lowercase_names() {
        let steps: Vec<Step> =
            serde_json::from_str(r#"["back","forward","reload","stop"]"#).unwrap();
        assert_eq!(steps, [Step::Back, Step::Forward, Step::Reload, Step::Stop]);
    }

    #[test]
    fn the_console_comes_as_a_string_of_json_inside_json() {
        // Читатель отдаёт строку, а webview — JSON того, что тот вернул.
        let answer =
            serde_json::to_string(r#"{"messages":[{"level":"error","text":"boom"}],"dropped":3}"#)
                .unwrap();
        assert_eq!(
            console_of(&answer),
            Ok(ConsoleLog {
                messages: vec![ConsoleMessage {
                    level: "error".to_string(),
                    text: "boom".to_string(),
                }],
                dropped: 3,
                started: 0.0,
            })
        );
    }

    #[test]
    fn the_console_says_when_the_page_started_writing() {
        let answer =
            serde_json::to_string(r#"{"messages":[],"dropped":0,"started":1760000000000}"#)
                .unwrap();
        assert_eq!(
            console_of(&answer).map(|log| log.started),
            Ok(1_760_000_000_000.0)
        );
    }

    #[test]
    fn a_page_without_the_recorder_is_not_a_page_without_errors() {
        // Пустая консоль сказала бы агенту «ошибок нет», а их могли просто не
        // записать. WebKit на исключение отдаёт пустую строку, WebView2 — null.
        for answer in ["null", "", "42"] {
            let refusal = console_of(answer).unwrap_err();
            assert!(
                refusal.contains("не отдала консоль"),
                "{answer:?}: {refusal}"
            );
        }
    }

    #[test]
    fn a_console_the_page_tampered_with_is_refused() {
        let answer = serde_json::to_string("pwned").unwrap();
        assert!(console_of(&answer).is_err());
    }
}
