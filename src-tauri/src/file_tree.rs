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

pub fn read_dir(root: &Path, path: &str) -> CommandResult<TreeListing> {
    read_dir_within(root, path, MAX_ENTRIES)
}

/// Граница отдельным доводом, чтобы её проверяли на трёх файлах, а не на пяти
/// тысячах: настоящий каталог такого размера заводится секундами и раскачивает
/// соседние проверки, которые ждут ответа по времени.
fn read_dir_within(root: &Path, path: &str, limit: usize) -> CommandResult<TreeListing> {
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

    // Ссылка может увести за пределы проекта — тогда дерево показало бы чужие
    // файлы, а открытие из него дало бы их прочитать. Сверяем развёрнутые пути,
    // а не написанные: `..` мы уже отсекли, ссылку — нет.
    let (Ok(inside), Ok(base)) = (full.canonicalize(), root.canonicalize()) else {
        return Err(
            CommandError::new(ErrorCode::WorkspaceRootUnavailable).with_context("path", path)
        );
    };
    if !inside.starts_with(&base) {
        return Err(
            CommandError::new(ErrorCode::WorkspacePathUnsupported).with_context("path", path)
        );
    }

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
