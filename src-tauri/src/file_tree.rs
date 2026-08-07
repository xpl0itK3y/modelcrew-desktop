//! Дерево проекта: один каталог за раз.
//!
//! Целиком дерево не обходится намеренно. В обычном фронтенд-проекте
//! `node_modules` — это сотни тысяч файлов, и один рекурсивный обход отдал бы
//! webview список, который тот будет рисовать секундами. Раскрытая папка
//! спрашивается отдельно, ровно когда пользователь её раскрыл.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::command_error::{CommandError, CommandResult, ErrorCode};
use crate::workspace_roots::WorkspaceRoots;

/// Сколько записей одного каталога отдаём. Каталог с сотней тысяч файлов
/// встречается (кеши сборки, выгрузки), и рисовать его целиком незачем: увидеть
/// столько нельзя, а список подвесит окно.
const MAX_ENTRIES: usize = 5_000;

/// Границы те же, что у правки файла в панели изменений: открыть в дереве и
/// открыть в изменениях — одно и то же действие для человека, и вести себя оно
/// должно одинаково.
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_WRITE_BYTES: usize = 5 * 1024 * 1024;

#[derive(Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    /// Имя, как его показывать.
    pub name: String,
    /// Путь от корня проекта. Всегда через `/`, в том числе на Windows: он
    /// уезжает в webview и обратно, и разделитель там должен быть один.
    pub path: String,
    /// Каталог ли. У каталога есть раскрытие, у файла — открытие.
    pub is_dir: bool,
}

#[derive(Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreeListing {
    pub entries: Vec<TreeEntry>,
    /// Список обрезан: показать всё нельзя, и молчать об этом нельзя тем более
    /// — иначе пропавший файл выглядит как пропавший файл, а не как обрезка.
    pub truncated: bool,
}

/// Путь внутри проекта, пришедший из webview. Пустой — сам корень.
fn is_safe_tree_path(path: &str) -> bool {
    path.is_empty() || crate::git_changes::is_safe_repo_path(path)
}

/// Путь внутри проекта, проверенный дважды: как написанный и как развёрнутый.
///
/// Одной проверки написанного мало — `..` мы отсекаем, а символическую ссылку
/// нет, и через неё дерево показало бы чужие файлы, а открытие дало бы их
/// прочитать. Разворачиваем ближайшего существующего предка: у создаваемого
/// файла своего пути на диске ещё нет, а предок есть всегда — хотя бы корень.
pub(crate) fn resolve_inside(root: &Path, path: &str) -> CommandResult<PathBuf> {
    if !is_safe_tree_path(path) {
        return Err(
            CommandError::new(ErrorCode::WorkspacePathUnsupported).with_context("path", path)
        );
    }
    let full = if path.is_empty() {
        root.to_path_buf()
    } else {
        root.join(path)
    };
    let Ok(base) = root.canonicalize() else {
        return Err(
            CommandError::new(ErrorCode::WorkspaceRootUnavailable).with_context("path", path)
        );
    };
    let mut ancestor = full.as_path();
    let inside =
        loop {
            if let Ok(resolved) = ancestor.canonicalize() {
                break resolved;
            }
            // Путь не разворачивается, но на диске что-то есть — значит это битая
            // ссылка. Куда она ведёт, мы проверить не можем, а запись по ней
            // пойдёт: пропустив её, мы позволили бы создать файл вне проекта.
            if std::fs::symlink_metadata(ancestor).is_ok() {
                return Err(CommandError::new(ErrorCode::WorkspacePathUnsupported)
                    .with_context("path", path));
            }
            let Some(parent) = ancestor.parent() else {
                return Err(CommandError::new(ErrorCode::WorkspaceRootUnavailable)
                    .with_context("path", path));
            };
            ancestor = parent;
        };
    if !inside.starts_with(&base) {
        return Err(
            CommandError::new(ErrorCode::WorkspacePathUnsupported).with_context("path", path)
        );
    }
    Ok(full)
}

pub fn read_dir(root: &Path, path: &str) -> CommandResult<TreeListing> {
    read_dir_within(root, path, MAX_ENTRIES)
}

/// Граница отдельным доводом, чтобы её проверяли на трёх файлах, а не на пяти
/// тысячах: настоящий каталог такого размера заводится секундами и раскачивает
/// соседние проверки, которые ждут ответа по времени.
fn read_dir_within(root: &Path, path: &str, limit: usize) -> CommandResult<TreeListing> {
    let inside = resolve_inside(root, path)?;
    // Каталога может и не быть: развёртывание доходит до существующего предка,
    // а его отсутствие обнаруживает уже чтение.
    let listing = std::fs::read_dir(&inside).map_err(|error| {
        CommandError::new(ErrorCode::WorkspaceRootUnavailable)
            .with_context("path", path)
            .with_debug(error)
    })?;

    let mut entries: Vec<TreeEntry> = Vec::new();
    let mut truncated = false;
    for item in listing.flatten() {
        if entries.len() >= limit {
            truncated = true;
            break;
        }
        let name = item.file_name().to_string_lossy().into_owned();
        // Имя, которое нельзя показать обратно тем же путём, лучше не
        // показывать вовсе: щелчок по нему открыл бы не тот файл.
        if name.is_empty() || name.contains('/') || name.contains('\\') {
            continue;
        }
        // Тип берём с разыменованием ссылки: папка-ссылка должна раскрываться
        // папкой. Уйти наружу она всё равно не даст — проверка выше.
        let is_dir = std::fs::metadata(item.path())
            .map(|meta| meta.is_dir())
            .unwrap_or(false);
        let child = if path.is_empty() {
            name.clone()
        } else {
            format!("{path}/{name}")
        };
        entries.push(TreeEntry {
            name,
            path: child,
            is_dir,
        });
    }

    entries.sort_by(compare_entries);
    Ok(TreeListing { entries, truncated })
}

/// Папки сверху, дальше по имени без учёта регистра: так список читается
/// глазами, а не в порядке, в котором файловая система их отдала.
fn compare_entries(left: &TreeEntry, right: &TreeEntry) -> Ordering {
    right
        .is_dir
        .cmp(&left.is_dir)
        .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        // Регистр решает лишь спор одинаковых имён — иначе `A` и `a` встали бы
        // в порядке, зависящем от файловой системы.
        .then_with(|| left.name.cmp(&right.name))
}

/// Содержимое файла в том же виде, в каком его отдаёт панель изменений: у
/// webview один тип на оба источника, и расходиться им незачем.
#[derive(Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub is_binary: bool,
    pub too_large: bool,
    pub exists: bool,
}

/// Читает файл проекта напрямую, не спрашивая git.
///
/// Панель изменений читает через `repo_toplevel`, и это верно для неё: она и
/// показывает git. Дереву же git не нужен вовсе — папка без репозитория
/// остаётся папкой с файлами, и открывать их в ней надо так же.
pub fn read_file(root: &Path, path: &str) -> CommandResult<FileContent> {
    let full = resolve_inside(root, path)?;
    let Ok(metadata) = std::fs::metadata(&full) else {
        // Удалённый файл открывается пустым: сохранение его воссоздаст.
        return Ok(FileContent {
            content: String::new(),
            is_binary: false,
            too_large: false,
            exists: false,
        });
    };
    if !metadata.is_file() {
        return Err(
            CommandError::new(ErrorCode::WorkspacePathUnsupported).with_context("path", path)
        );
    }
    if metadata.len() > MAX_READ_BYTES {
        return Ok(FileContent {
            content: String::new(),
            is_binary: false,
            too_large: true,
            exists: true,
        });
    }
    let bytes = std::fs::read(&full).map_err(|error| {
        CommandError::new(ErrorCode::WorkspaceRootUnavailable)
            .with_context("path", path)
            .with_debug(error)
    })?;
    // Не UTF-8 — тоже «показать нечем». Раньше здесь стояло `from_utf8_lossy`:
    // каждый непонятый байт становился ромбом с вопросом, а сохранение
    // записывало эти ромбы поверх файла. Так уничтожался любой текст в
    // Windows-1251 — нулевого байта в нём нет, и двоичным он не выглядит.
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Ok(FileContent {
            content: String::new(),
            is_binary: true,
            too_large: false,
            exists: true,
        });
    };
    if looks_binary(&bytes) {
        return Ok(FileContent {
            content: String::new(),
            is_binary: true,
            too_large: false,
            exists: true,
        });
    }
    Ok(FileContent {
        content: text.to_owned(),
        is_binary: false,
        too_large: false,
        exists: true,
    })
}

pub fn write_file(root: &Path, path: &str, content: &str) -> CommandResult<()> {
    if path.is_empty() {
        return Err(CommandError::new(ErrorCode::WorkspacePathUnsupported).with_context("path", ""));
    }
    if content.len() > MAX_WRITE_BYTES {
        return Err(
            CommandError::new(ErrorCode::WorkspacePathUnsupported).with_context("reason", "size")
        );
    }
    let full = resolve_inside(root, path)?;
    // Каталог под новый файл заводим сами: иначе «создать» из дерева работало
    // бы только там, где папка уже есть.
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            CommandError::new(ErrorCode::WorkspaceRootUnavailable)
                .with_context("path", path)
                .with_debug(error)
        })?;
    }
    std::fs::write(&full, content).map_err(|error| {
        CommandError::new(ErrorCode::WorkspaceRootUnavailable)
            .with_context("path", path)
            .with_debug(error)
    })
}

/// Двоичным считаем файл с нулевым байтом в начале: так же решает git, и для
/// показа этого достаточно — текст с нулём внутри всё равно не текст.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8_000).any(|byte| *byte == 0)
}

/// Создать, переименовать, удалить — то же, что делают в файловом менеджере.
///
/// Всё идёт через `resolve_inside`: и цель, и, где надо, источник. Без этого
/// переименование стало бы дырой шире открытия — «переименовать» в путь
/// наружу означает вынести файл из проекта.
pub fn create_entry(root: &Path, path: &str, is_dir: bool) -> CommandResult<()> {
    let full = resolve_inside(root, path)?;
    if path.is_empty() {
        return Err(CommandError::new(ErrorCode::WorkspacePathUnsupported).with_context("path", ""));
    }
    // Занятое имя не перезаписываем молча: под ним лежит чужая работа.
    if full.exists() {
        return Err(CommandError::new(ErrorCode::WorkspacePathTaken).with_context("path", path));
    }
    let made = if is_dir {
        std::fs::create_dir_all(&full)
    } else {
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                CommandError::new(ErrorCode::WorkspaceRootUnavailable)
                    .with_context("path", path)
                    .with_debug(error)
            })?;
        }
        std::fs::write(&full, "")
    };
    made.map_err(|error| {
        CommandError::new(ErrorCode::WorkspaceRootUnavailable)
            .with_context("path", path)
            .with_debug(error)
    })
}

pub fn rename_entry(root: &Path, from: &str, to: &str) -> CommandResult<()> {
    if from.is_empty() || to.is_empty() {
        return Err(
            CommandError::new(ErrorCode::WorkspacePathUnsupported).with_context("path", from)
        );
    }
    let source = resolve_inside(root, from)?;
    let target = resolve_inside(root, to)?;
    if !source.exists() {
        return Err(
            CommandError::new(ErrorCode::WorkspaceRootUnavailable).with_context("path", from)
        );
    }
    // На файловых системах, не различающих регистр, `Файл` и `файл` — один и
    // тот же путь, и проверка на занятость сорвала бы обычное переименование
    // ради регистра. Сверяем развёрнутые пути.
    let same = source
        .canonicalize()
        .ok()
        .zip(target.canonicalize().ok())
        .is_some_and(|(left, right)| left == right);
    if target.exists() && !same {
        return Err(CommandError::new(ErrorCode::WorkspacePathTaken).with_context("path", to));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            CommandError::new(ErrorCode::WorkspaceRootUnavailable)
                .with_context("path", to)
                .with_debug(error)
        })?;
    }
    std::fs::rename(&source, &target).map_err(|error| {
        CommandError::new(ErrorCode::WorkspaceRootUnavailable)
            .with_context("path", to)
            .with_debug(error)
    })
}

pub fn delete_entry(root: &Path, path: &str) -> CommandResult<()> {
    if path.is_empty() {
        return Err(CommandError::new(ErrorCode::WorkspacePathUnsupported).with_context("path", ""));
    }
    let full = resolve_inside(root, path)?;
    // Символическую ссылку удаляем как ссылку, а не как то, куда она ведёт:
    // `metadata` пошло бы по ней и увело в чужой каталог.
    let meta = std::fs::symlink_metadata(&full).map_err(|error| {
        CommandError::new(ErrorCode::WorkspaceRootUnavailable)
            .with_context("path", path)
            .with_debug(error)
    })?;
    let removed = if meta.is_dir() {
        std::fs::remove_dir_all(&full)
    } else {
        std::fs::remove_file(&full)
    };
    removed.map_err(|error| {
        CommandError::new(ErrorCode::WorkspaceRootUnavailable)
            .with_context("path", path)
            .with_debug(error)
    })
}

/// Полный путь для показа в файловом менеджере системы.
pub fn absolute_path(root: &Path, path: &str) -> CommandResult<String> {
    let full = resolve_inside(root, path)?;
    if !full.exists() {
        return Err(
            CommandError::new(ErrorCode::WorkspaceRootUnavailable).with_context("path", path)
        );
    }
    Ok(full.display().to_string())
}

#[tauri::command]
pub async fn workspace_create_entry(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    path: String,
    is_dir: bool,
) -> CommandResult<()> {
    crate::ensure_main_window(&window)?;
    let root: PathBuf = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || create_entry(&root, &path, is_dir))
        .await
        .map_err(|error| CommandError::new(ErrorCode::WorkspaceRootUnavailable).with_debug(error))?
}

#[tauri::command]
pub async fn workspace_rename_entry(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    from: String,
    to: String,
) -> CommandResult<()> {
    crate::ensure_main_window(&window)?;
    let root: PathBuf = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || rename_entry(&root, &from, &to))
        .await
        .map_err(|error| CommandError::new(ErrorCode::WorkspaceRootUnavailable).with_debug(error))?
}

#[tauri::command]
pub async fn workspace_delete_entry(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    path: String,
) -> CommandResult<()> {
    crate::ensure_main_window(&window)?;
    let root: PathBuf = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || delete_entry(&root, &path))
        .await
        .map_err(|error| CommandError::new(ErrorCode::WorkspaceRootUnavailable).with_debug(error))?
}

/// Показывает файл в проводнике системы. Путь наружу webview не отдаём: он
/// собирается здесь и здесь же уходит в системный вызов.
#[tauri::command]
pub async fn workspace_reveal_entry(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    path: String,
) -> CommandResult<()> {
    crate::ensure_main_window(&window)?;
    let root: PathBuf = roots.resolve(&workspace_id)?;
    let full = absolute_path(&root, &path)?;
    tauri_plugin_opener::reveal_item_in_dir(&full).map_err(|error| {
        CommandError::new(ErrorCode::WorkspaceRootUnavailable)
            .with_context("path", &path)
            .with_debug(error)
    })
}

/// Сколько находок отдаём поиску. Больше человек всё равно не просмотрит, а
/// обход при этом можно оборвать — он и стоит дорого.
const MAX_MATCHES: usize = 200;

/// Куда не заходим при поиске. Это не «скрыть от глаз»: в дереве эти папки
/// видны и раскрываются. Но обходить `node_modules` целиком ради поиска по
/// именам значит ждать секунды там, где ждут мгновение.
const SKIPPED: [&str; 6] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    ".venv",
    "__pycache__",
];

/// Ищет по именам файлов и папок вглубь всего проекта.
///
/// По именам, а не по содержимому: содержимое ищут `rg` и агенты, у них это
/// выходит лучше, а дереву нужно «где лежит файл, который я помню по имени».
pub fn search(root: &Path, query: &str) -> CommandResult<TreeListing> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(TreeListing {
            entries: Vec::new(),
            truncated: false,
        });
    }
    let base = resolve_inside(root, "")?;
    let mut entries: Vec<TreeEntry> = Vec::new();
    let mut truncated = false;
    let mut queue: std::collections::VecDeque<(PathBuf, String)> =
        std::collections::VecDeque::new();
    queue.push_back((base, String::new()));

    // Обход в ширину: находки поближе к корню обычно и есть искомые, а
    // обрывать список на глубине честнее, чем на середине первого уровня.
    'walk: while let Some((dir, prefix)) = queue.pop_front() {
        let Ok(listing) = std::fs::read_dir(&dir) else {
            continue;
        };
        for item in listing.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if name.is_empty() || name.contains('/') || name.contains('\\') {
                continue;
            }
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            // Тип для показа — с разыменованием, как в самом дереве: ссылка на
            // папку и выглядит папкой.
            let is_dir = std::fs::metadata(item.path())
                .map(|meta| meta.is_dir())
                .unwrap_or(false);
            if name.to_lowercase().contains(&needle) {
                if entries.len() >= MAX_MATCHES {
                    // Обрываем здесь, а не на следующем каталоге: очередь может
                    // на нём и кончиться, и тогда обрезанный список уехал бы
                    // как полный.
                    truncated = true;
                    break 'walk;
                }
                entries.push(TreeEntry {
                    name: name.clone(),
                    path: path.clone(),
                    is_dir,
                });
            }
            // А вглубь идём только по настоящим каталогам. Ссылка `latest -> ..`
            // замкнула бы обход в кольцо — выхода из него нет вовсе, если
            // находок не набирается, — а `link -> /Users/denis` вывела бы поиск
            // из проекта и перечислила бы чужие файлы в webview.
            let real_dir = item.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            if real_dir && !SKIPPED.contains(&name.as_str()) {
                queue.push_back((item.path(), path));
            }
        }
    }

    // Порядок один и для полного списка, и для обрезанного: иначе запрос,
    // сузившийся на символ, вдруг оказывался бы отсортированным.
    entries.sort_by(compare_entries);
    Ok(TreeListing { entries, truncated })
}

#[tauri::command]
pub async fn workspace_search_tree(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    query: String,
) -> CommandResult<TreeListing> {
    crate::ensure_main_window(&window)?;
    let root: PathBuf = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || search(&root, &query))
        .await
        .map_err(|error| CommandError::new(ErrorCode::WorkspaceRootUnavailable).with_debug(error))?
}

// ---------- Слежение за деревом ----------

/// Тихое окно: `npm install` или генерация кода дают тысячи событий подряд, и
/// перечитывать каталог на каждое — значит не показать ничего до самого конца.
const TREE_DEBOUNCE_MS: u64 = 250;

/// Но ждать тишины бесконечно нельзя: события идут сплошным потоком всё время,
/// пока работает установка пакетов или сборка.
const TREE_MAX_WAIT_MS: u64 = 1_000;

/// Сколько каталогов называем в одном событии. Больше — и проще перечитать
/// раскрытое целиком, чем разбирать список.
const MAX_CHANGED_DIRS: usize = 64;

#[derive(Default)]
pub struct TreeWatchState {
    watchers: std::sync::Mutex<TreeWatchers>,
}

/// Один вотчер на проект и счёт тех, кто его держит.
///
/// Держат его не только деревом: каждый открытый файл слушает те же события,
/// чтобы заметить правку агента под своим редактором. Без счёта первая же
/// закрытая вкладка снимала бы вотчер со всего проекта, и дерево рядом
/// переставало бы обновляться — молча, до перезапуска.
#[derive(Default)]
struct TreeWatchers {
    live: std::collections::HashMap<String, TreeWatchHandle>,
    holders: std::collections::HashMap<String, usize>,
}

/// Ещё один подписчик на этот проект.
fn take_hold(holders: &mut std::collections::HashMap<String, usize>, workspace_id: &str) {
    *holders.entry(workspace_id.to_owned()).or_insert(0) += 1;
}

/// Подписчик ушёл. `true` — он был последним, вотчер пора снимать.
fn drop_hold(holders: &mut std::collections::HashMap<String, usize>, workspace_id: &str) -> bool {
    let Some(count) = holders.get_mut(workspace_id) else {
        return true;
    };
    *count = count.saturating_sub(1);
    if *count == 0 {
        holders.remove(workspace_id);
        return true;
    }
    false
}

struct TreeWatchHandle {
    _watcher: notify::RecommendedWatcher,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeChangedEvent<'a> {
    workspace_id: &'a str,
    /// Каталоги, чьё содержимое изменилось, путями от корня проекта. Пустая
    /// строка — сам корень.
    dirs: Vec<String>,
    /// Каталогов оказалось больше, чем мы называем: перечитывать надо всё
    /// раскрытое, а не только названное.
    partial: bool,
}

/// Каталог, который затронуло событие, путём от корня проекта.
///
/// Берём именно родителя: изменился файл — перечитать надо папку, в которой он
/// лежит, а не его самого.
fn changed_dir(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let parent = relative.parent()?;
    let mut parts: Vec<String> = Vec::new();
    for part in parent.components() {
        let std::path::Component::Normal(name) = part else {
            return None;
        };
        let name = name.to_string_lossy();
        // Возня внутри тяжёлых папок — не новость для дерева. `.git` переписывает
        // ссылки на каждой команде, сборка перекладывает тысячи файлов в
        // `target`, установка пакетов — в `node_modules`. Событий оттуда идёт
        // столько, что список изменённых папок каждый раз переполняется, окно
        // получает «перечитай всё раскрытое» — и перечитывает, пока агент
        // работает. Смотреть там всё равно не на что: содержимое этих папок в
        // дереве никто не разглядывает, а сами они видны и раскрываются.
        if SKIPPED.contains(&name.as_ref()) {
            return None;
        }
        parts.push(name.into_owned());
    }
    Some(parts.join("/"))
}

fn spawn_tree_watch(
    app: tauri::AppHandle,
    workspace_id: String,
    root: PathBuf,
) -> Result<TreeWatchHandle, notify::Error> {
    use notify::Watcher;

    let (sender, receiver) = std::sync::mpsc::channel::<String>();
    let filter_root = root.clone();
    let mut watcher =
        notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            let Ok(event) = event else {
                return;
            };
            for path in &event.paths {
                if let Some(dir) = changed_dir(&filter_root, path) {
                    let _ = sender.send(dir);
                }
            }
        })?;
    watcher.watch(&root, notify::RecursiveMode::Recursive)?;

    std::thread::spawn(move || {
        while let Ok(first) = receiver.recv() {
            let mut dirs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
            let mut partial = false;
            let mut insert = |dir: String, dirs: &mut std::collections::BTreeSet<String>| {
                if dirs.len() >= MAX_CHANGED_DIRS && !dirs.contains(&dir) {
                    // Дальше копить незачем: список всё равно поедет обрезанным,
                    // а под `node_modules` это десятки тысяч строк в памяти.
                    partial = true;
                    return;
                }
                dirs.insert(dir);
            };
            insert(first, &mut dirs);
            // У тишины есть потолок: `npm install` сыплет событиями без пауз
            // минуту, и ожидание тишины заморозило бы дерево ровно тогда, когда
            // оно меняется сильнее всего.
            let until =
                std::time::Instant::now() + std::time::Duration::from_millis(TREE_MAX_WAIT_MS);
            while let Some(left) = until.checked_duration_since(std::time::Instant::now()) {
                let quiet = std::time::Duration::from_millis(TREE_DEBOUNCE_MS);
                let Ok(next) = receiver.recv_timeout(left.min(quiet)) else {
                    break;
                };
                insert(next, &mut dirs);
            }
            let named: Vec<String> = dirs.into_iter().collect();
            use tauri::Emitter;
            let _ = app.emit(
                "workspace-tree",
                TreeChangedEvent {
                    workspace_id: &workspace_id,
                    dirs: named,
                    partial,
                },
            );
        }
    });

    Ok(TreeWatchHandle { _watcher: watcher })
}

/// Возвращает false, если вотчер поднять не удалось — например упёрлись в
/// лимит inotify на огромном дереве. Дерево от этого не ломается: оно просто
/// обновляется по открытию папки, как раньше.
/// Синхронные нарочно, как и у соседнего вотчера изменений. Асинхронные
/// команды Tauri исполняет независимыми задачами, и порядок между ними не
/// обещан: снятие вотчера при смене проекта могло отработать после установки
/// нового, и дерево тихо переставало обновляться.
#[tauri::command]
pub fn workspace_tree_watch(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    roots: tauri::State<'_, WorkspaceRoots>,
    state: tauri::State<'_, TreeWatchState>,
    workspace_id: String,
) -> CommandResult<bool> {
    crate::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    // Отравленный мьютекс — не повод ронять окно паникой из команды.
    let mut watchers = state.watchers.lock().map_err(|error| {
        CommandError::new(ErrorCode::WorkspaceRootUnavailable).with_debug(error)
    })?;
    take_hold(&mut watchers.holders, &workspace_id);
    if watchers.live.contains_key(&workspace_id) {
        return Ok(true);
    }
    match spawn_tree_watch(app, workspace_id.clone(), root) {
        Ok(handle) => {
            watchers.live.insert(workspace_id, handle);
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub fn workspace_tree_unwatch(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, TreeWatchState>,
    workspace_id: String,
) -> CommandResult<()> {
    crate::ensure_main_window(&window)?;
    if let Ok(mut watchers) = state.watchers.lock() {
        if drop_hold(&mut watchers.holders, &workspace_id) {
            watchers.live.remove(&workspace_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn workspace_read_file(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    path: String,
) -> CommandResult<FileContent> {
    crate::ensure_main_window(&window)?;
    let root: PathBuf = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || read_file(&root, &path))
        .await
        .map_err(|error| CommandError::new(ErrorCode::WorkspaceRootUnavailable).with_debug(error))?
}

#[tauri::command]
pub async fn workspace_write_file(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    path: String,
    content: String,
) -> CommandResult<()> {
    crate::ensure_main_window(&window)?;
    let root: PathBuf = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || write_file(&root, &path, &content))
        .await
        .map_err(|error| CommandError::new(ErrorCode::WorkspaceRootUnavailable).with_debug(error))?
}

#[tauri::command]
pub async fn workspace_read_dir(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    path: String,
) -> CommandResult<TreeListing> {
    crate::ensure_main_window(&window)?;
    let root: PathBuf = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || read_dir(&root, &path))
        .await
        .map_err(|error| CommandError::new(ErrorCode::WorkspaceRootUnavailable).with_debug(error))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mc-tree-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(listing: &TreeListing) -> Vec<&str> {
        listing
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect()
    }

    #[test]
    fn folders_come_first_and_then_names_regardless_of_case() {
        let root = sandbox("order");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("Assets")).unwrap();
        std::fs::write(root.join("README.md"), "").unwrap();
        std::fs::write(root.join("index.html"), "").unwrap();
        std::fs::write(root.join(".gitignore"), "").unwrap();

        let listing = read_dir(&root, "").unwrap();

        // Папки сверху, дальше имена без учёта регистра — иначе `README.md`
        // уехал бы выше `index.html` только из-за заглавных букв.
        assert_eq!(
            names(&listing),
            ["Assets", "src", ".gitignore", "index.html", "README.md"]
        );
        assert!(!listing.truncated);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_child_path_is_counted_from_the_project_root() {
        let root = sandbox("paths");
        std::fs::create_dir_all(root.join("src/panels")).unwrap();
        std::fs::write(root.join("src/panels/Tree.tsx"), "").unwrap();

        let listing = read_dir(&root, "src/panels").unwrap();

        // Путь нужен целиком: по нему потом читается файл, и собирать его в
        // webview из имени и родителя значило бы держать это правило дважды.
        assert_eq!(listing.entries[0].path, "src/panels/Tree.tsx");
        assert!(!listing.entries[0].is_dir);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_outside_the_project_can_be_listed() {
        let root = sandbox("escape");
        std::fs::create_dir_all(root.join("src")).unwrap();

        for path in ["..", "../..", "/etc", "src/../..", "-rf"] {
            assert!(read_dir(&root, path).is_err(), "{path}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Ссылка наружу — единственный путь мимо проверки написанного пути: в нём
    /// нет ни `..`, ни ведущего слэша, а ведёт он куда угодно.
    #[cfg(unix)]
    #[test]
    fn a_link_leading_out_of_the_project_is_refused() {
        let base = sandbox("link");
        let root = base.join("проект");
        let outside = base.join("чужое");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(outside.join("секреты")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("наружу")).unwrap();

        assert!(read_dir(&root, "наружу").is_err());
        assert!(read_dir(&root, "наружу/секреты").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_directory_that_is_not_there_is_an_error_not_an_empty_list() {
        let root = sandbox("missing");

        // Пустой список читался бы как «папка есть, и она пуста» — а её нет.
        assert!(read_dir(&root, "нет-такой").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_new_file_and_a_new_folder_appear_where_asked() {
        let root = sandbox("create");

        create_entry(&root, "src/новый.rs", false).unwrap();
        create_entry(&root, "docs/раздел", true).unwrap();

        assert!(root.join("src/новый.rs").is_file());
        assert!(root.join("docs/раздел").is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_occupied_name_is_refused_instead_of_overwritten() {
        let root = sandbox("taken");
        std::fs::write(root.join("есть.txt"), "чужая работа").unwrap();

        assert!(create_entry(&root, "есть.txt", false).is_err());

        // Молчаливая перезапись стоила бы человеку файла, которого он не
        // собирался трогать.
        assert_eq!(
            std::fs::read_to_string(root.join("есть.txt")).unwrap(),
            "чужая работа"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn renaming_moves_the_entry_and_makes_the_way_for_it() {
        let root = sandbox("rename");
        std::fs::write(root.join("было.txt"), "тело").unwrap();

        rename_entry(&root, "было.txt", "папка/стало.txt").unwrap();

        assert!(!root.join("было.txt").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("папка/стало.txt")).unwrap(),
            "тело"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn renaming_onto_someone_else_is_refused() {
        let root = sandbox("rename-taken");
        std::fs::write(root.join("один.txt"), "первый").unwrap();
        std::fs::write(root.join("два.txt"), "второй").unwrap();

        assert!(rename_entry(&root, "один.txt", "два.txt").is_err());

        assert_eq!(
            std::fs::read_to_string(root.join("два.txt")).unwrap(),
            "второй"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_rename_that_only_changes_the_case_still_goes_through() {
        let root = sandbox("case");
        std::fs::write(root.join("файл.txt"), "тело").unwrap();

        // На macOS и Windows файловая система не различает регистр, и `файл`
        // с `Файл` — один и тот же путь. Проверка на занятость не должна
        // срывать обычное переименование ради заглавной буквы.
        rename_entry(&root, "файл.txt", "Файл.txt").unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("Файл.txt")).unwrap(),
            "тело"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_can_be_renamed_out_of_the_project() {
        let root = sandbox("rename-escape");
        std::fs::write(root.join("свой.txt"), "тело").unwrap();

        // Переименование — дыра шире открытия: «переименовать» наружу означает
        // вынести файл из проекта.
        assert!(rename_entry(&root, "свой.txt", "../угнанный.txt").is_err());
        assert!(rename_entry(&root, "../чужой.txt", "свой2.txt").is_err());
        assert!(root.join("свой.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_is_deleted_with_what_is_inside_it() {
        let root = sandbox("delete");
        std::fs::create_dir_all(root.join("папка/вложенная")).unwrap();
        std::fs::write(root.join("папка/вложенная/файл.txt"), "").unwrap();

        delete_entry(&root, "папка").unwrap();

        assert!(!root.join("папка").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Удаление ссылки не должно доставать до того, куда она ведёт.
    #[cfg(unix)]
    #[test]
    fn deleting_a_link_leaves_its_target_alone() {
        let base = sandbox("delete-link");
        let root = base.join("проект");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(base.join("чужая")).unwrap();
        std::fs::write(base.join("чужая/важное.txt"), "чужое").unwrap();
        std::os::unix::fs::symlink(base.join("чужая"), root.join("ссылка")).unwrap();

        // Сама ссылка внутри проекта, и убрать её можно; каталог за ней —
        // снаружи, и он должен остаться.
        let _ = delete_entry(&root, "ссылка");

        assert_eq!(
            std::fs::read_to_string(base.join("чужая/важное.txt")).unwrap(),
            "чужое"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn nothing_outside_the_project_can_be_created_or_deleted() {
        let root = sandbox("ops-escape");

        for path in ["../снаружи.txt", "/tmp/чужой.txt", ""] {
            assert!(create_entry(&root, path, false).is_err(), "создание {path}");
            assert!(delete_entry(&root, path).is_err(), "удаление {path}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_finds_by_a_piece_of_the_name_at_any_depth() {
        let root = sandbox("search");
        std::fs::create_dir_all(root.join("src/panels")).unwrap();
        std::fs::write(root.join("src/panels/FileTree.tsx"), "").unwrap();
        std::fs::write(root.join("src/main.rs"), "").unwrap();

        let found = search(&root, "tree").unwrap();

        // Куском имени, а не началом: файл помнят как «дерево», а не как
        // «эф-ай-эл-и».
        assert_eq!(
            found
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["src/panels/FileTree.tsx"]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_ignores_the_case_of_both_sides() {
        let root = sandbox("search-case");
        std::fs::write(root.join("README.md"), "").unwrap();

        assert_eq!(search(&root, "readme").unwrap().entries.len(), 1);
        assert_eq!(search(&root, "ReAdMe").unwrap().entries.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_finds_folders_too() {
        let root = sandbox("search-dirs");
        std::fs::create_dir_all(root.join("panels")).unwrap();

        let found = search(&root, "panel").unwrap();

        assert!(found.entries[0].is_dir);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_does_not_crawl_into_the_heavy_folders() {
        let root = sandbox("search-skip");
        std::fs::create_dir_all(root.join("node_modules/пакет")).unwrap();
        std::fs::write(root.join("node_modules/пакет/цель.txt"), "").unwrap();
        std::fs::write(root.join("цель.txt"), "").unwrap();

        let found = search(&root, "цель").unwrap();

        // Сама папка в дереве видна и раскрывается; обходить её ради поиска по
        // именам — это секунды ожидания там, где ждут мгновение.
        assert_eq!(
            found
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["цель.txt"]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Ссылка на собственного предка — обычное дело: `docs/latest -> ..`,
    /// `build/current -> ..`. Обход, идущий по ней, ходит по кругу, и выход у
    /// него один — набрать находок под завязку. Запрос с опечаткой не наберёт
    /// их никогда: поток крутится, пока не кончится память.
    #[cfg(unix)]
    #[test]
    fn a_link_back_onto_the_project_does_not_send_the_search_in_circles() {
        let root = sandbox("search-cycle");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/цель.txt"), "").unwrap();
        std::os::unix::fs::symlink(&root, root.join("docs/latest")).unwrap();

        let found = search(&root, "цель").unwrap();

        assert_eq!(
            found
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["docs/цель.txt"]
        );
        assert!(!found.truncated);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Границу проекта держит `resolve_inside`, но поиск спрашивает его один
    /// раз — про корень. Дальше он идёт по каталогам сам, и ссылка наружу
    /// вывела бы его в чужой домашний каталог: открыть найденное там не дадут,
    /// но имена файлов уже перечислены в webview.
    #[cfg(unix)]
    #[test]
    fn the_search_does_not_step_out_of_the_project_through_a_link() {
        let base = sandbox("search-escape");
        let root = base.join("проект");
        let outside = base.join("чужое");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("секрет.txt"), "").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("наружу")).unwrap();

        assert!(search(&root, "секрет").unwrap().entries.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_search_that_had_to_be_cut_says_so_and_stays_in_order() {
        let root = sandbox("search-cut");
        for index in 0..MAX_MATCHES + 20 {
            std::fs::write(root.join(format!("цель-{index:03}.txt")), "").unwrap();
        }

        let found = search(&root, "цель").unwrap();

        // Обрыв случался на следующем каталоге очереди, а в плоской папке его
        // нет: обрезанный список уезжал как полный, без пометки и без порядка.
        assert_eq!(found.entries.len(), MAX_MATCHES);
        assert!(found.truncated);
        assert!(found
            .entries
            .windows(2)
            .all(|pair| pair[0].name <= pair[1].name));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_query_finds_nothing_rather_than_everything() {
        let root = sandbox("search-empty");
        std::fs::write(root.join("файл.txt"), "").unwrap();

        // Пустой запрос — это «я ещё не начал искать», а не «покажи весь
        // проект списком».
        assert!(search(&root, "   ").unwrap().entries.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_project_itself_cannot_be_named_as_a_path() {
        let root = sandbox("dot");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/файл.txt"), "тело").unwrap();

        // `.` разворачивается в сам каталог, и «удалить .» означало бы снести
        // проект целиком — вместе с `.git`. `..` уже отсекался, `.` нет.
        for path in [
            ".",
            "./",
            "src/.",
            "src/./файл.txt",
            "src//файл.txt",
            "src/",
        ] {
            assert!(delete_entry(&root, path).is_err(), "удаление {path:?}");
            assert!(read_dir(&root, path).is_err(), "чтение {path:?}");
        }
        assert!(root.join("src/файл.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Битая ссылка — единственный путь мимо проверки: развернуть её нельзя,
    /// поэтому разбор доходит до её родителя и признаёт путь своим, а запись
    /// потом идёт по ссылке наружу.
    #[cfg(unix)]
    #[test]
    fn a_broken_link_out_of_the_project_cannot_be_written_through() {
        let base = sandbox("broken-link");
        let root = base.join("проект");
        std::fs::create_dir_all(&root).unwrap();
        let outside = base.join("снаружи.txt");
        std::os::unix::fs::symlink(&outside, root.join("ссылка.txt")).unwrap();
        std::os::unix::fs::symlink(base.join("нет-каталога"), root.join("папка")).unwrap();

        assert!(write_file(&root, "ссылка.txt", "чужое").is_err());
        assert!(create_entry(&root, "ссылка.txt", false).is_err());
        // И через битую ссылку-каталог тоже: там разбор поднимался ещё выше.
        assert!(write_file(&root, "папка/внутри.txt", "чужое").is_err());
        assert!(create_entry(&root, "папка/внутри.txt", false).is_err());

        assert!(!outside.exists(), "файл создан вне проекта");
        assert!(!base.join("нет-каталога").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_that_stays_inside_the_project_still_works() {
        let base = sandbox("inside-link");
        let root = base.join("проект");
        std::fs::create_dir_all(root.join("настоящая")).unwrap();
        std::os::unix::fs::symlink(root.join("настоящая"), root.join("ссылка")).unwrap();

        // Запрет касается выхода наружу, а не ссылок вообще: внутри проекта
        // они обычное дело, и ломать их работу незачем.
        write_file(&root, "ссылка/файл.txt", "тело").unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("настоящая/файл.txt")).unwrap(),
            "тело"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_change_points_at_the_folder_that_has_to_be_reread() {
        let root = Path::new("/w/проект");

        // Изменился файл — перечитать надо папку, в которой он лежит, а не его
        // самого: у файла содержимого списка нет.
        assert_eq!(
            changed_dir(root, Path::new("/w/проект/src/main.rs")).as_deref(),
            Some("src")
        );
        assert_eq!(
            changed_dir(root, Path::new("/w/проект/README.md")).as_deref(),
            Some("")
        );
        // Чужой путь не наш: вотчер сторожит один корень, но события приходят
        // и о переименованиях, где второй путь может быть каким угодно.
        assert_eq!(changed_dir(root, Path::new("/иное/файл.rs")), None);
    }

    #[test]
    fn the_churn_inside_git_changes_nothing_that_is_shown() {
        let root = Path::new("/w/проект");

        // `.git` меняется на каждой команде git — от `index.lock` до
        // перезаписи ссылок. В дереве это одна строка, и её содержимое от
        // такой возни не меняется: перечитывать нечего. Раньше каждое такое
        // событие звало перечитать корень, то есть обойти его целиком с
        // `metadata()` на каждую запись.
        for path in [
            "/w/проект/.git/index.lock",
            "/w/проект/.git/refs/heads/main",
            "/w/проект/.git/objects/ab/cdef",
        ] {
            assert_eq!(changed_dir(root, Path::new(path)), None, "{path}");
        }

        // А появление и исчезновение самой папки корень меняет.
        assert_eq!(
            changed_dir(root, Path::new("/w/проект/.git")).as_deref(),
            Some("")
        );
    }

    #[test]
    fn the_churn_of_a_build_does_not_reach_the_window() {
        let root = Path::new("/w/проект");

        // Сборка и установка пакетов перекладывают тысячи файлов. Каждое такое
        // событие называло папку, список изменённых переполнялся, и окно
        // получало «перечитай всё раскрытое» — по нескольку раз в секунду, всё
        // время, пока работает агент. За этим потоком переставал успевать и
        // вывод терминалов: они выглядели замершими.
        for path in [
            "/w/проект/target/debug/deps/крошка.o",
            "/w/проект/node_modules/пакет/index.js",
            "/w/проект/packages/сайт/node_modules/пакет/index.js",
            "/w/проект/dist/bundle.js",
            "/w/проект/.venv/lib/python3.12/site.py",
            "/w/проект/src/__pycache__/модуль.pyc",
        ] {
            assert_eq!(changed_dir(root, Path::new(path)), None, "{path}");
        }

        // Сами папки при этом остаются в дереве, и их появление корень меняет:
        // это не «спрятать от глаз», это «не разглядывать содержимое».
        assert_eq!(
            changed_dir(root, Path::new("/w/проект/target")).as_deref(),
            Some("")
        );
        assert_eq!(
            changed_dir(root, Path::new("/w/проект/src/main.rs")).as_deref(),
            Some("src")
        );
    }

    #[test]
    fn a_file_opens_in_a_folder_that_is_no_repository() {
        let root = sandbox("plain");
        std::fs::write(root.join("заметка.txt"), "привет").unwrap();

        let file = read_file(&root, "заметка.txt").unwrap();

        // Ни `git init`, ни `.git` рядом нет: папка без репозитория остаётся
        // папкой с файлами, и открывать их в ней надо так же.
        assert_eq!(file.content, "привет");
        assert!(file.exists);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_that_is_gone_opens_empty_rather_than_failing() {
        let root = sandbox("gone");

        let file = read_file(&root, "нет.txt").unwrap();

        // Пустым, а не ошибкой: сохранение из редактора его воссоздаст, и это
        // обычный способ завести файл.
        assert!(!file.exists);
        assert_eq!(file.content, "");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_binary_file_is_named_binary_instead_of_being_mangled() {
        let root = sandbox("binary");
        std::fs::write(root.join("icon.png"), [0x89, b'P', 0x00, b'N', b'G']).unwrap();

        let file = read_file(&root, "icon.png").unwrap();

        // Показывать нечего, но и молчать нельзя: пустое поле выглядит как
        // пустой файл, и сохранение затёрло бы картинку.
        assert!(file.is_binary);
        assert_eq!(file.content, "");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_watcher_lives_until_the_last_part_of_the_window_lets_go() {
        let mut holders = std::collections::HashMap::new();
        // Дерево и два открытых файла смотрят за одним проектом.
        take_hold(&mut holders, "w1");
        take_hold(&mut holders, "w1");
        take_hold(&mut holders, "w1");

        assert!(!drop_hold(&mut holders, "w1"));
        assert!(!drop_hold(&mut holders, "w1"));
        // И только когда ушёл последний. Иначе закрытая вкладка снимала бы
        // слежение со всего проекта, и дерево рядом переставало бы обновляться
        // — молча, до перезапуска окна.
        assert!(drop_hold(&mut holders, "w1"));
        assert!(holders.is_empty());
    }

    #[test]
    fn letting_go_of_a_watcher_nobody_holds_is_not_an_error() {
        let mut holders = std::collections::HashMap::new();

        // Отписка без подписки приходит при перезагрузке окна: считать её
        // ошибкой незачем, снимать нечего.
        assert!(drop_hold(&mut holders, "w1"));
        assert!(holders.is_empty());
    }

    #[test]
    fn a_file_that_is_not_utf8_is_refused_rather_than_replaced_by_diamonds() {
        let root = sandbox("cp1251");
        // «привет» в Windows-1251: нулевого байта нет, двоичным такой файл не
        // выглядит, а UTF-8 в нём не читается.
        let bytes = [0xEF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2];
        std::fs::write(root.join("записка.txt"), bytes).unwrap();

        let file = read_file(&root, "записка.txt").unwrap();

        // Показ через `from_utf8_lossy` — это не показ, а подмена: каждый
        // непонятый байт становится ромбом с вопросом, и первое же сохранение
        // записывает эти ромбы поверх текста.
        assert!(file.is_binary);
        assert_eq!(file.content, "");
        assert_eq!(std::fs::read(root.join("записка.txt")).unwrap(), bytes);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_written_file_lands_together_with_the_folders_above_it() {
        let root = sandbox("write");

        write_file(&root, "новый/каталог/файл.txt", "тело").unwrap();

        // Иначе «создать» из дерева работало бы только там, где папка уже есть.
        assert_eq!(
            std::fs::read_to_string(root.join("новый/каталог/файл.txt")).unwrap(),
            "тело"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_outside_the_project_can_be_read_or_written() {
        let root = sandbox("outside");

        for path in ["../чужой.txt", "/etc/passwd", ""] {
            assert!(read_file(&root, path).is_err(), "чтение {path}");
            assert!(write_file(&root, path, "x").is_err(), "запись {path}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Ссылку на файл снаружи написанный путь не выдаёт ничем: в нём нет ни
    /// `..`, ни ведущего слэша.
    #[cfg(unix)]
    #[test]
    fn a_file_behind_a_link_out_of_the_project_stays_unreachable() {
        let base = sandbox("filelink");
        let root = base.join("проект");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(base.join("секрет.txt"), "чужое").unwrap();
        std::os::unix::fs::symlink(base.join("секрет.txt"), root.join("ссылка.txt")).unwrap();

        assert!(read_file(&root, "ссылка.txt").is_err());
        assert!(write_file(&root, "ссылка.txt", "правка").is_err());
        // И содержимое осталось нетронутым.
        assert_eq!(
            std::fs::read_to_string(base.join("секрет.txt")).unwrap(),
            "чужое"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_directory_beyond_the_limit_is_cut_and_says_so() {
        let root = sandbox("huge");
        let big = root.join("много");
        std::fs::create_dir_all(&big).unwrap();
        for index in 0..3 {
            std::fs::write(big.join(format!("файл-{index}")), "").unwrap();
        }

        let listing = read_dir_within(&root, "много", 2).unwrap();

        assert_eq!(listing.entries.len(), 2);
        // Без этого признака обрезанный список выглядит как полный, и
        // пропавший файл ищут в проекте, а не в границе.
        assert!(listing.truncated);

        // А в пределах границы обрезки нет: признак не должен стоять всегда.
        let whole = read_dir_within(&root, "много", 3).unwrap();
        assert_eq!(whole.entries.len(), 3);
        assert!(!whole.truncated);
        let _ = std::fs::remove_dir_all(&root);
    }
}
