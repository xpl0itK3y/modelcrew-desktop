//! Страница проекта следом за его файлами.
//!
//! Агент правит код, а страница в ящике остаётся прежней: сервер без горячей
//! перезагрузки сам её не обновит, и человек смотрит на старую версию, не
//! зная, что она старая. Поэтому, пока страница проекта открыта, за файлами
//! проекта следим и после правки обновляем её. Только свою — на localhost:
//! чужой сайт от правок в проекте не меняется, а обновлять его значит терять
//! то, что человек на нём набрал.
//!
//! Обновляем не на каждый шорох:
//! - серия правок — одно обновление: ждём, пока станет тихо;
//! - служебное (`.git`, `node_modules`, `target`, сборка, кэши) и всё, что
//!   проект сам вычеркнул в `.gitignore`, не в счёт: это не правки;
//! - страница, которая сама пишет в проект на каждую загрузку — журнал, база,
//!   — не уходит в вечное обновление: её файлы после нескольких таких кругов
//!   перестают считаться.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::AppHandle;

/// Тихое окно: правки одна за другой — одно обновление.
const QUIET: Duration = Duration::from_millis(500);

/// Сколько ждать загрузку обновлённой страницы.
const LOAD_WAIT: Duration = Duration::from_secs(15);

/// Правка так скоро после загрузки могла быть делом самой страницы: сервер
/// пишет журнал или базу на каждый запрос.
const ECHO: Duration = Duration::from_millis(1_500);

/// Сколько обновлений подряд по таким правкам терпим, прежде чем признать
/// их файлы шумом. Одно-два бывают и от агента, который правит быстро.
const ECHO_LIMIT: u32 = 3;

/// Больше путей за раз git не спрашиваем: столько меняет сборка или смена
/// ветки, и правка среди них найдётся и в первых.
const ASK_GIT_AT_MOST: usize = 2_000;

/// Каталоги, правки в которых — не правки: зависимости, сборка, кэши.
/// Скрытые (`.git`, `.next`, `.venv`…) отсекаются и без списка.
const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    "__pycache__",
    "venv",
];

/// Файлы, которые пишет не человек и не агент: временные файлы редакторов,
/// журналы, базы.
const SKIPPED_ENDINGS: &[&str] = &[
    "~", ".swp", ".swx", ".swo", ".tmp", ".log", ".db", ".sqlite", ".sqlite3", "-journal", "-wal",
    "-shm",
];

/// Обновлять ли страницы по правкам. Выключатель — в ящике браузера.
static ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// Наблюдатели за проектами, по метке страницы. Убрать наблюдателя — значит
/// закрыть его канал: поток тихого окна заканчивается сам.
fn followers() -> &'static Mutex<HashMap<String, notify::RecommendedWatcher>> {
    static FOLLOWERS: OnceLock<Mutex<HashMap<String, notify::RecommendedWatcher>>> =
        OnceLock::new();
    FOLLOWERS.get_or_init(Default::default)
}

/// Начать следить за файлами проекта, чья страница только что открылась.
///
/// Не вышло — страница просто не будет обновляться сама: огромное дерево
/// упирается в лимит наблюдателей системы, а браузер работает и без этого.
pub fn start(app: &AppHandle, root: &str) {
    let label = crate::browser_page::label_for(root);
    let Ok(mut followers) = followers().lock() else {
        return;
    };
    if followers.contains_key(&label) {
        return;
    }
    if let Ok(watcher) = spawn(app.clone(), root.to_string()) {
        followers.insert(label, watcher);
    }
}

/// Страница закрыта — следить больше не за чем.
pub fn stop(label: &str) {
    if let Ok(mut followers) = followers().lock() {
        followers.remove(label);
    }
}

fn spawn(app: AppHandle, root: String) -> Result<notify::RecommendedWatcher, notify::Error> {
    use notify::Watcher;

    let given = PathBuf::from(&root);
    // Система сообщает пути без ссылок (`/private/tmp` вместо `/tmp` на
    // macOS), а корень мог прийти и с ними: сверяем с обоими.
    let mut roots = vec![given.clone()];
    if let Ok(real) = std::fs::canonicalize(&given) {
        if real != given {
            roots.push(real);
        }
    }
    let (sender, receiver) = std::sync::mpsc::channel::<Vec<PathBuf>>();
    let filter_roots = roots.clone();
    let mut watcher =
        notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            let Ok(event) = event else {
                return;
            };
            // Чтение файла — не правка, а читают их постоянно: сборщики,
            // индексаторы, тот же git.
            if matches!(event.kind, notify::EventKind::Access(_)) {
                return;
            }
            let edits: Vec<PathBuf> = event
                .paths
                .into_iter()
                .filter(|path| filter_roots.iter().any(|root| is_edit(root, path)))
                .collect();
            if !edits.is_empty() {
                let _ = sender.send(edits);
            }
        })?;
    watcher.watch(&given, notify::RecursiveMode::Recursive)?;
    std::thread::spawn(move || follow(app, root, receiver));
    Ok(watcher)
}

/// Обновлять страницу проекта после правок, пока наблюдатель жив.
fn follow(app: AppHandle, root: String, edits: Receiver<Vec<PathBuf>>) {
    let label = crate::browser_page::label_for(&root);
    let mut echo = Echo::default();
    // Ошибка приёма — наблюдателя убрали вместе со страницей.
    while let Ok(first) = edits.recv() {
        let mut changed: HashSet<PathBuf> = first.into_iter().collect();
        while let Ok(more) = edits.recv_timeout(QUIET) {
            changed.extend(more);
        }
        if !ENABLED.load(Ordering::Relaxed) {
            continue;
        }
        // Страницу закрыли мимо `stop` — следить больше не за чем.
        if !crate::browser_page::is_open(&app, &root) {
            stop(&label);
            break;
        }
        let url = crate::browser_page::info(&app, &root)
            .map(|(url, _)| url)
            .unwrap_or_default();
        if !is_local(&url) {
            continue;
        }
        let changed: Vec<PathBuf> = changed
            .into_iter()
            .filter(|path| !echo.is_noise(path))
            .collect();
        let changed = unignored(Path::new(&root), changed);
        if changed.is_empty() || !echo.allows(changed) {
            continue;
        }
        if crate::browser_page::step(&app, &root, crate::browser_page::Step::Reload).is_err() {
            continue;
        }
        crate::browser_page::wait_ready(&app, &root, LOAD_WAIT);
        echo.loaded(Instant::now());
    }
}

/// Отличает правки агента от того, что страница пишет в проект сама, пока
/// грузится: иначе журнал запросов обновлял бы страницу, а она — журнал.
#[derive(Default)]
struct Echo {
    loaded_at: Option<Instant>,
    rounds: u32,
    noise: HashSet<PathBuf>,
}

impl Echo {
    fn is_noise(&self, path: &Path) -> bool {
        self.noise.contains(path)
    }

    fn loaded(&mut self, at: Instant) {
        self.loaded_at = Some(at);
    }

    /// Обновлять ли по этим правкам. Правки сразу после загрузки — по кругу
    /// уже несколько раз — признаются шумом и дальше не считаются.
    fn allows(&mut self, changed: Vec<PathBuf>) -> bool {
        self.allows_at(changed, Instant::now())
    }

    fn allows_at(&mut self, changed: Vec<PathBuf>, now: Instant) -> bool {
        let right_after_load = self
            .loaded_at
            .is_some_and(|at| now.saturating_duration_since(at) < ECHO);
        if !right_after_load {
            self.rounds = 0;
            return true;
        }
        self.rounds += 1;
        if self.rounds < ECHO_LIMIT {
            return true;
        }
        self.rounds = 0;
        self.noise.extend(changed);
        false
    }
}

/// Правка ли это — по одному имени. Что скажет git, узнаём потом, разом за
/// всю серию.
fn is_edit(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let parts: Vec<String> = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    let Some((name, dirs)) = parts.split_last() else {
        return false;
    };
    if parts.iter().any(|part| part.starts_with('.')) {
        return false;
    }
    if dirs.iter().any(|dir| SKIPPED_DIRS.contains(&dir.as_str())) {
        return false;
    }
    !SKIPPED_ENDINGS.iter().any(|ending| name.ends_with(ending))
}

/// Страница самого проекта: сервер на этой машине, а не сайт в сети.
fn is_local(url: &str) -> bool {
    let Ok(url) = url.parse::<tauri::Url>() else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return ip.is_loopback() || ip.is_unspecified();
    }
    let host = host.to_ascii_lowercase();
    host == "localhost" || host.ends_with(".localhost")
}

/// Пути, которых git не вычеркнул: сборка, журналы и базы проекта обычно в
/// `.gitignore`, и обновлять по ним страницу незачем. Не репозиторий или
/// git нет — вычёркивать нечем, правками считается всё.
fn unignored(root: &Path, mut paths: Vec<PathBuf>) -> Vec<PathBuf> {
    use std::io::Write;
    use std::process::Stdio;

    paths.truncate(ASK_GIT_AT_MOST);
    if paths.is_empty() {
        return paths;
    }
    let Ok(mut command) = crate::git_changes::git_command() else {
        return paths;
    };
    command
        .args(["check-ignore", "--stdin", "-z"])
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Ok(mut child) = command.spawn() else {
        return paths;
    };
    let mut input = Vec::new();
    for path in &paths {
        input.extend_from_slice(path.as_os_str().as_encoded_bytes());
        input.push(0);
    }
    // Пишем из своего потока: git отвечает, пока читает, и, упрись его ответ
    // в полную трубу, мы бы ждали друг друга вечно.
    let writer = child.stdin.take().map(|mut stdin| {
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        })
    });
    let output = child.wait_with_output();
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    let Ok(output) = output else {
        return paths;
    };
    // 0 — что-то вычеркнуто, 1 — ничего; прочее — не репозиторий или сбой.
    if output.status.code() != Some(0) {
        return paths;
    }
    let ignored: HashSet<&[u8]> = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .collect();
    paths
        .into_iter()
        .filter(|path| !ignored.contains(path.as_os_str().as_encoded_bytes()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(path: &str) -> bool {
        is_edit(Path::new("/w/shop"), Path::new(path))
    }

    #[test]
    fn counts_source_files_as_edits() {
        assert!(edit("/w/shop/src/App.tsx"));
        assert!(edit("/w/shop/index.html"));
        assert!(edit("/w/shop/app/templates/base.html"));
    }

    #[test]
    fn leaves_out_what_no_one_edits_by_hand() {
        for path in [
            "/w/shop/.git/index",
            "/w/shop/.next/server/page.js",
            "/w/shop/.venv/lib/site.py",
            "/w/shop/node_modules/react/index.js",
            "/w/shop/target/debug/app",
            "/w/shop/dist/index.js",
            "/w/shop/app/__pycache__/views.cpython-312.pyc",
            "/w/shop/src/.App.tsx.swp",
            "/w/shop/src/App.tsx~",
            "/w/shop/server.log",
            "/w/shop/db.sqlite3",
            "/w/shop/db.sqlite3-journal",
            "/w/shop",
            "/elsewhere/src/App.tsx",
        ] {
            assert!(!edit(path), "{path}");
        }
    }

    #[test]
    fn reloads_only_the_project_s_own_pages() {
        for url in [
            "http://localhost:5173/",
            "http://LOCALHOST:3000/x",
            "https://app.localhost/",
            "http://127.0.0.1:8501/",
            "http://127.0.0.2/",
            "http://[::1]:8080/",
            "http://0.0.0.0:8000/",
        ] {
            assert!(is_local(url), "{url}");
        }
        for url in [
            "https://example.com/",
            "http://192.168.1.10:3000/",
            "http://localhost.example.com/",
            "about:blank",
            "file:///w/shop/index.html",
            "",
        ] {
            assert!(!is_local(url), "{url}");
        }
    }

    #[test]
    fn does_not_chase_a_page_that_writes_on_every_load() {
        // Сервер пишет журнал на каждый запрос: обновили — запрос — журнал —
        // снова обновили. Несколько кругов терпим, дальше файл — шум.
        let log = PathBuf::from("/w/shop/requests.txt");
        let mut echo = Echo::default();
        let start = Instant::now();
        assert!(echo.allows_at(vec![log.clone()], start));

        let mut reloads = 1;
        let mut now = start;
        for _ in 0..10 {
            echo.loaded(now);
            now += Duration::from_millis(200);
            if echo.is_noise(&log) {
                break;
            }
            if echo.allows_at(vec![log.clone()], now) {
                reloads += 1;
            }
        }
        assert!(echo.is_noise(&log));
        assert!(reloads <= ECHO_LIMIT as usize, "{reloads}");
    }

    #[test]
    fn follows_an_agent_that_edits_after_a_pause() {
        let mut echo = Echo::default();
        let mut now = Instant::now();
        for _ in 0..10 {
            echo.loaded(now);
            now += ECHO + Duration::from_millis(1);
            assert!(echo.allows_at(vec![PathBuf::from("/w/shop/src/App.tsx")], now));
        }
    }

    #[test]
    fn follows_a_quick_edit_right_after_a_load() {
        // Агент правит два файла подряд: второй может лечь сразу после
        // загрузки по первому — его тоже надо показать.
        let mut echo = Echo::default();
        let now = Instant::now();
        echo.loaded(now);
        assert!(echo.allows_at(
            vec![PathBuf::from("/w/shop/src/b.ts")],
            now + Duration::from_millis(300)
        ));
    }

    #[test]
    #[cfg(unix)]
    fn asks_git_what_the_project_left_out() {
        let dir = std::env::temp_dir().join(format!("mc-auto-reload-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let Ok(mut git) = crate::git_changes::git_command() else {
            return; // git нет — проверять нечем
        };
        let init = git.args(["init", "-q"]).current_dir(&dir).status();
        if !init.is_ok_and(|status| status.success()) {
            return; // git нет — проверять нечем
        }
        std::fs::write(dir.join(".gitignore"), "*.out\n").unwrap();
        let kept = dir.join("src/App.tsx");
        let dropped = dir.join("trace.out");

        assert_eq!(
            unignored(&dir, vec![kept.clone(), dropped]),
            std::slice::from_ref(&kept)
        );
        // Вне репозитория вычёркивать нечем: правка остаётся правкой.
        let _ = std::fs::remove_dir_all(dir.join(".git"));
        assert_eq!(unignored(&dir, vec![kept.clone()]), [kept]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
