//! Браузер проекта: один процесс Chrome на воркспейс.
//!
//! Ключ изоляции — проект, а не панель. Внутри проекта агентам нужен общий
//! профиль: один залогинился в тестовый стенд — остальные уже внутри. Между
//! проектами общего быть не должно ничего, поэтому у каждого свой каталог
//! профиля и свой процесс.
//!
//! Устройство повторяет `PtyManager`: реестр под мьютексом, ленивый запуск по
//! первому обращению, уборка при выходе. Порт не назначаем сами
//! (`--remote-debugging-port=0`) — свободный выбирает система, а Chrome
//! называет его в stderr. Занятый порт иначе означал бы, что браузер молча не
//! поднялся у того, у кого уже что-то слушает на 9222.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::command_error::{CommandError, CommandResult, ErrorCode};

/// Сколько ждём строки с портом. Chrome печатает её сразу после старта;
/// дольше — значит он не поднялся, и держать агента незачем.
const PORT_WAIT: Duration = Duration::from_secs(10);

/// Сколько ждём отклика с порта уже поднятого браузера. Он свой, локальный:
/// не ответил быстро — значит его нет.
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

/// Файл, в который Chrome сам записывает порт своего CDP. Лежит в каталоге
/// профиля и переживает падение приложения — по нему и находится браузер,
/// оставшийся без хозяина.
const PORT_FILE: &str = "DevToolsActivePort";

/// Живой браузер одного проекта.
///
/// Каталог профиля здесь не хранится намеренно: он однозначно считается из
/// корня проекта функцией `profile_dir`, и вторая копия того же значения
/// рано или поздно разошлась бы с первой.
pub struct BrowserInstance {
    /// Порт CDP, выбранный системой.
    pub port: u16,
    /// Пусто у подобранного браузера: его запустил не этот запуск приложения,
    /// дескриптора процесса у нас нет и убить его нечем.
    child: Option<Child>,
}

impl BrowserInstance {
    pub fn started(port: u16, child: Child) -> Self {
        Self {
            port,
            child: Some(child),
        }
    }

    /// Браузер, оставшийся от прошлого запуска: см. `adopt`.
    pub fn adopted(port: u16) -> Self {
        Self { port, child: None }
    }

    /// Процесс мог умереть сам: пользователь закрыл окно, система убила по
    /// памяти. Мёртвый экземпляр в реестре хуже отсутствующего — на него
    /// будут звонить, а он не ответит.
    ///
    /// У своего спрашиваем сам процесс, у подобранного — порт: другого способа
    /// узнать про чужой процесс у нас нет.
    fn is_alive(&mut self) -> bool {
        match &mut self.child {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => port_answers(self.port),
        }
    }

    fn kill(&mut self) {
        let Some(child) = &mut self.child else {
            return;
        };
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Отвечает ли кто-нибудь на порту CDP.
fn port_answers(port: u16) -> bool {
    use std::net::{Ipv4Addr, SocketAddr, TcpStream};
    TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        PROBE_TIMEOUT,
    )
    .is_ok()
}

#[derive(Default)]
pub struct BrowserHost {
    // Проект → его браузер. Ключ — корень воркспейса, как в `CrewRegistry`:
    // у панелей разных проектов общих браузеров нет по построению.
    instances: Mutex<HashMap<String, BrowserInstance>>,
}

impl BrowserHost {
    /// Браузер проекта: существующий или поднятый только что.
    ///
    /// Запуск передаётся снаружи, а не зашит внутрь: так реестр — переиспользование,
    /// развод по проектам, замена умершего — проверяется без настоящего Chrome.
    pub fn ensure<F>(&self, key: &str, launch: F) -> CommandResult<u16>
    where
        F: FnOnce() -> CommandResult<BrowserInstance>,
    {
        let mut instances = self.instances.lock().unwrap();
        if let Some(existing) = instances.get_mut(key) {
            if existing.is_alive() {
                return Ok(existing.port);
            }
            // Умер — убираем и поднимаем заново, вместо того чтобы вернуть
            // порт, на котором уже никого нет.
            instances.remove(key);
        }
        let instance = launch()?;
        let port = instance.port;
        instances.insert(key.to_string(), instance);
        Ok(port)
    }

    /// Закрыть браузер проекта: проект закрыли или отвязали папку.
    pub fn close(&self, key: &str) {
        if let Some(mut instance) = self.instances.lock().unwrap().remove(key) {
            instance.kill();
        }
    }

    /// Погасить всё: выход из приложения и обновление. Оставленный процесс
    /// Chrome пережил бы приложение и остался бы висеть без хозяина.
    pub fn close_all(&self) {
        let mut instances = self.instances.lock().unwrap();
        for (_, mut instance) in instances.drain() {
            instance.kill();
        }
    }
}

/// Где искать браузер. Порядок — от предпочтительного к запасному: обычный
/// Chrome, затем Chromium и сборки для разработчиков.
#[cfg(target_os = "macos")]
const CANDIDATES: [&str; 4] = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

#[cfg(target_os = "linux")]
const CANDIDATES: [&str; 5] = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
];

#[cfg(target_os = "windows")]
const CANDIDATES: [&str; 3] = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
];

pub fn chrome_program() -> Option<PathBuf> {
    first_existing(&CANDIDATES)
}

fn first_existing(candidates: &[&str]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

/// Каталог профиля проекта.
///
/// Имя — отпечаток корня, а не сам путь: в пути есть разделители, пробелы и
/// юникод, а рядом лежат каталоги других проектов. Отпечаток заодно
/// устойчив — один и тот же проект после перезапуска попадает в свой профиль
/// и находит там свои логины.
pub fn profile_dir(base: &Path, root: &str) -> PathBuf {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(root.as_bytes());
    let name: String = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    base.join("browser-profiles").join(name)
}

/// Размер окна страницы. От него зависит вёрстка, которую увидят и агент, и
/// человек, поэтому он задан явно, а не отдан на волю системы.
const VIEWPORT: (u32, u32) = (1280, 800);

/// Аргументы запуска. Порт нулевой намеренно — см. заголовок модуля.
fn launch_args(profile: &Path) -> Vec<String> {
    vec![
        // Своего окна у браузера нет: страницу показывает само приложение,
        // как в Claude Code desktop. Всплывающее поверх ModelCrew окно Chrome
        // было бы не инструментом внутри приложения, а вторым приложением.
        "--headless=new".to_string(),
        format!("--window-size={},{}", VIEWPORT.0, VIEWPORT.1),
        "--remote-debugging-port=0".to_string(),
        format!("--user-data-dir={}", profile.display()),
        // Первый запуск иначе съедает окно мастером настройки, а нам нужен
        // сразу управляемый браузер.
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        // Свой профиль на проект уже разводит состояние; ещё и общий сервис
        // синхронизации притащил бы в тестовый браузер личные вкладки.
        "--disable-sync".to_string(),
        "about:blank".to_string(),
    ]
}

/// Порт браузера, оставшегося от прошлого запуска приложения.
///
/// Если приложение сняли не по-хорошему — SIGTERM, падение, — Chrome остаётся
/// жить и держит каталог профиля. Запустить второй с тем же профилем нельзя:
/// он передаёт управление первому и молча выходит, не назвав порта, а мы
/// видим только «браузер не поднялся».
///
/// Поэтому не убиваем, а подбираем: у пользователя целы вкладки и логины, а
/// плагин работает дальше. Порт Chrome кладёт в профиль сам.
fn adopt(profile: &Path) -> Option<u16> {
    let raw = std::fs::read_to_string(profile.join(PORT_FILE)).ok()?;
    // Первая строка — порт, дальше путь к веб-сокету.
    let port: u16 = raw.lines().next()?.trim().parse().ok()?;
    // Файл переживает и сам браузер: чистого выхода могло не быть, и тогда
    // порт в нём указывает в пустоту.
    port_answers(port).then_some(port)
}

/// Поднять браузер для проекта или подобрать уже поднятый.
pub fn launch(program: &Path, profile: &Path) -> CommandResult<BrowserInstance> {
    std::fs::create_dir_all(profile).map_err(|error| {
        CommandError::new(ErrorCode::BrowserLaunchFailed)
            .with_context("profile", profile.display())
            .with_debug(error)
    })?;

    if let Some(port) = adopt(profile) {
        return Ok(BrowserInstance::adopted(port));
    }

    let mut child = Command::new(program)
        .args(launch_args(profile))
        .stdout(Stdio::null())
        // Порт Chrome называет именно в stderr — там его и ждём.
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            CommandError::new(ErrorCode::BrowserLaunchFailed)
                .with_context("program", program.display())
                .with_debug(error)
        })?;

    let Some(stderr) = child.stderr.take() else {
        child.kill().ok();
        return Err(
            CommandError::new(ErrorCode::BrowserLaunchFailed).with_context("reason", "нет stderr")
        );
    };

    match read_port(stderr, PORT_WAIT) {
        Some(port) => Ok(BrowserInstance::started(port, child)),
        None => {
            // Порт не назвался — процесс бесполезен, и оставлять его висеть
            // нельзя: следующий запуск поднял бы второй такой же.
            let _ = child.kill();
            let _ = child.wait();
            Err(CommandError::new(ErrorCode::BrowserPortUnavailable)
                .with_context("program", program.display()))
        }
    }
}

/// Читает stderr до строки с портом.
fn read_port(stderr: impl std::io::Read, wait: Duration) -> Option<u16> {
    let deadline = Instant::now() + wait;
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        if let Some(port) = devtools_port(&line) {
            return Some(port);
        }
        if Instant::now() >= deadline {
            return None;
        }
    }
    None
}

/// Порт из строки, которую печатает Chrome:
/// `DevTools listening on ws://127.0.0.1:51234/devtools/browser/<uuid>`.
///
/// Разбираем по адресу, а не по тексту сообщения: текст менялся между
/// версиями, а форма адреса — нет.
pub fn devtools_port(line: &str) -> Option<u16> {
    let after = line.split("ws://").nth(1)?;
    let after = after.split('/').next()?;
    after.rsplit(':').next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Сколько проектов держат браузер. Публичного метода нет намеренно:
    /// счётчик понадобится интерфейсу на шаге 4, а заводить его заранее
    /// значит держать в коде мёртвую ветку.
    fn open_projects(host: &BrowserHost) -> usize {
        host.instances.lock().unwrap().len()
    }

    /// Вместо Chrome — процесс, который просто живёт: реестру всё равно, кого
    /// он держит, а проверять он должен настоящий `Child`.
    fn sleeper(port: u16) -> CommandResult<BrowserInstance> {
        let child = Command::new("sleep")
            .arg("30")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        Ok(BrowserInstance::started(port, child))
    }

    #[test]
    fn reads_the_port_chrome_announces() {
        assert_eq!(
            devtools_port("DevTools listening on ws://127.0.0.1:51234/devtools/browser/abc-def"),
            Some(51234)
        );
        // Ipv6 и другой хост встречаются в чужих сборках.
        assert_eq!(
            devtools_port("DevTools listening on ws://[::1]:9333/devtools/browser/x"),
            Some(9333)
        );
    }

    #[test]
    fn ignores_a_line_without_a_port() {
        for noise in [
            "",
            "Fontconfig warning: ignoring UTF-8",
            "DevTools listening on ws://127.0.0.1:/devtools/browser/x",
            "ws://127.0.0.1:notaport/x",
            // Порт вне диапазона: разбор не должен паниковать на переполнении.
            "ws://127.0.0.1:99999/x",
        ] {
            assert_eq!(devtools_port(noise), None, "строка {noise:?}");
        }
    }

    #[test]
    fn one_browser_serves_the_whole_project() {
        let host = BrowserHost::default();

        let first = host.ensure("/w/one", || sleeper(1111)).unwrap();
        // Второй агент того же проекта попадает в тот же браузер — иначе он
        // не увидел бы логина, сделанного соседом.
        let second = host
            .ensure("/w/one", || panic!("подняли второй браузер одному проекту"))
            .unwrap();

        assert_eq!(first, second);
        assert_eq!(open_projects(&host), 1);
        host.close_all();
    }

    #[test]
    fn keeps_projects_apart() {
        let host = BrowserHost::default();

        assert_eq!(host.ensure("/w/one", || sleeper(1111)).unwrap(), 1111);
        assert_eq!(host.ensure("/w/two", || sleeper(2222)).unwrap(), 2222);

        assert_eq!(open_projects(&host), 2);
        host.close_all();
        assert_eq!(open_projects(&host), 0);
    }

    #[test]
    fn replaces_a_browser_that_died_on_its_own() {
        let host = BrowserHost::default();
        host.ensure("/w/one", || sleeper(1111)).unwrap();

        // Пользователь закрыл окно Chrome сам.
        {
            let mut instances = host.instances.lock().unwrap();
            instances.get_mut("/w/one").unwrap().kill();
        }

        // Вернуть порт мёртвого браузера значило бы отправить агента звонить
        // в пустоту; вместо этого поднимаем новый.
        assert_eq!(host.ensure("/w/one", || sleeper(3333)).unwrap(), 3333);
        assert_eq!(open_projects(&host), 1);
        host.close_all();
    }

    #[test]
    fn closing_one_project_leaves_the_other_alone() {
        let host = BrowserHost::default();
        host.ensure("/w/one", || sleeper(1111)).unwrap();
        host.ensure("/w/two", || sleeper(2222)).unwrap();

        host.close("/w/one");

        assert_eq!(open_projects(&host), 1);
        assert_eq!(
            host.ensure("/w/two", || panic!("браузер соседа тоже погасили"))
                .unwrap(),
            2222
        );
        host.close_all();
    }

    #[test]
    fn every_project_gets_its_own_profile() {
        let base = PathBuf::from("/data");
        let one = profile_dir(&base, "/w/one");
        let two = profile_dir(&base, "/w/two");

        assert_ne!(one, two);
        // Тот же проект после перезапуска обязан попасть в свой профиль,
        // иначе логины теряются на каждом запуске.
        assert_eq!(one, profile_dir(&base, "/w/one"));
        assert!(one.starts_with(base.join("browser-profiles")));
        // Имя каталога — отпечаток: ни разделителей, ни пробелов из пути.
        let name = one.file_name().unwrap().to_string_lossy();
        assert!(
            name.chars().all(|ch| ch.is_ascii_hexdigit()),
            "имя профиля {name:?} не отпечаток"
        );
    }

    #[test]
    fn asks_the_system_for_a_free_port() {
        let args = launch_args(Path::new("/data/profile"));
        // Свой номер порта означал бы, что браузер молча не поднимется у
        // того, у кого 9222 уже занят.
        assert!(args.iter().any(|arg| arg == "--remote-debugging-port=0"));
        assert!(args
            .iter()
            .any(|arg| arg == "--user-data-dir=/data/profile"));
    }

    #[test]
    fn shows_no_window_of_its_own() {
        let args = launch_args(Path::new("/data/profile"));
        // Страницу показывает приложение. Окно Chrome поверх ModelCrew было бы
        // вторым приложением, а не инструментом внутри нашего.
        assert!(args.iter().any(|arg| arg == "--headless=new"));
        // Размер задан явно: от него зависит вёрстка, которую увидят и агент,
        // и человек, и она не должна зависеть от машины.
        assert!(args.iter().any(|arg| arg == "--window-size=1280,800"));
    }

    #[test]
    fn finds_nothing_when_no_browser_is_installed() {
        assert_eq!(first_existing(&["/nope/chrome", "/also/nope"]), None);
    }

    /// Приложение сняли не по-хорошему, Chrome остался жив и держит профиль.
    /// Запустить второй с тем же профилем нельзя — он отдаёт управление
    /// первому и выходит, не назвав порта. Поэтому подбираем.
    #[test]
    fn picks_up_a_browser_left_from_a_previous_run() {
        use std::net::{Ipv4Addr, TcpListener};

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();

        let profile = std::env::temp_dir().join(format!("mc-adopt-{}", std::process::id()));
        std::fs::create_dir_all(&profile).unwrap();
        // Ровно в таком виде файл пишет Chrome: порт, затем путь веб-сокета.
        std::fs::write(
            profile.join(PORT_FILE),
            format!("{port}\n/devtools/browser/abc-def\n"),
        )
        .unwrap();

        assert_eq!(adopt(&profile), Some(port));
        let _ = std::fs::remove_dir_all(&profile);
    }

    #[test]
    fn ignores_a_port_file_left_by_a_browser_that_is_gone() {
        let profile = std::env::temp_dir().join(format!("mc-adopt-stale-{}", std::process::id()));
        std::fs::create_dir_all(&profile).unwrap();

        // Файл переживает браузер: после падения он остаётся, а порта нет.
        // Поверив ему, мы отдали бы агенту порт, на котором никого нет.
        std::fs::write(profile.join(PORT_FILE), "1\n/devtools/browser/x\n").unwrap();
        assert_eq!(adopt(&profile), None);

        std::fs::write(profile.join(PORT_FILE), "не число\n").unwrap();
        assert_eq!(adopt(&profile), None);

        std::fs::remove_file(profile.join(PORT_FILE)).unwrap();
        assert_eq!(adopt(&profile), None);

        let _ = std::fs::remove_dir_all(&profile);
    }

    #[test]
    fn an_adopted_browser_is_judged_by_its_port() {
        use std::net::{Ipv4Addr, TcpListener};

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let live = listener.local_addr().unwrap().port();
        assert!(BrowserInstance::adopted(live).is_alive());

        // Свободный порт берём отдельным слушателем, закрытым до единой
        // попытки соединения: подключение к только что закрытому порту
        // система какое-то время ещё принимает, и проверка была бы плавающей.
        let spare = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let dead = spare.local_addr().unwrap().port();
        drop(spare);

        // Браузера на порту нет — экземпляр мёртв, и реестр поднимет новый.
        assert!(!BrowserInstance::adopted(dead).is_alive());
    }
}
