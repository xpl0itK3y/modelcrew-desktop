//! Снимок рабочего дерева после каждого хода агента.
//!
//! Заявки на файлы держатся на хуках, а хук есть не у всякого агента, и запись
//! через оболочку (`sed -i`, `> file`) мимо них проходит у всех. Значит часть
//! столкновений случится в любом случае — снимок делает их обратимыми: прежнее
//! содержимое остаётся в объектах git и достаётся одной командой.
//!
//! Снимок — обычный коммит в своём пространстве ссылок `refs/modelcrew/…`. Ни
//! в одну ветку он не входит, в `git log` не попадает и на работу пользователя
//! не влияет: для него ничего не меняется.
//!
//! Индекс пользователя при этом не трогается — сборка идёт во временном,
//! через `GIT_INDEX_FILE`. Иначе снимок сбрасывал бы то, что человек отобрал
//! для следующего коммита.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::command_error::{CommandError, CommandResult, ErrorCode};
use crate::git_changes::{is_safe_repo_path, repo_toplevel, run_git, run_git_with_env};
use crate::workspace_roots::WorkspaceRoots;

/// Автор снимков. Настройки пользователя может не быть вовсе, а `commit-tree`
/// без личности не работает — подставляем свою и не трогаем чужую.
const SNAPSHOT_IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "ModelCrew"),
    ("GIT_AUTHOR_EMAIL", "snapshots@modelcrew.local"),
    ("GIT_COMMITTER_NAME", "ModelCrew"),
    ("GIT_COMMITTER_EMAIL", "snapshots@modelcrew.local"),
];

pub fn snapshot_ref(panel_id: &str) -> String {
    format!("refs/modelcrew/panels/{panel_id}")
}

fn text_of(raw: Vec<u8>) -> String {
    String::from_utf8_lossy(&raw).trim().to_owned()
}

/// Снимает состояние дерева и записывает его под ссылку панели.
///
/// Возвращает id коммита, если снимок сделан, и `None`, когда снимать нечего:
/// не репозиторий или дерево не изменилось с прошлого раза. Второе — обычный
/// случай: ход агента мог ничего не записать.
pub fn snapshot_panel(root: &Path, panel_id: &str) -> CommandResult<Option<String>> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Ok(None);
    };
    let index = temp_index_path(&toplevel, panel_id);
    let env = index_env(&index);
    let result = build_snapshot(&toplevel, panel_id, &env);
    // Временный индекс не должен пережить неудачу: иначе следующий снимок
    // соберётся поверх чужого состояния.
    let _ = std::fs::remove_file(&index);
    result
}

fn build_snapshot(
    toplevel: &Path,
    panel_id: &str,
    env: &[(&str, &str)],
) -> CommandResult<Option<String>> {
    // Пустой репозиторий: HEAD ещё не на что указывать, но снять состояние
    // рабочего дерева уже есть смысл.
    if run_git_with_env(toplevel, &["read-tree", "HEAD"], env).is_err() {
        run_git_with_env(toplevel, &["read-tree", "--empty"], env)?;
    }
    run_git_with_env(toplevel, &["add", "-A"], env)?;
    let tree = text_of(run_git_with_env(toplevel, &["write-tree"], env)?);
    if tree.is_empty() {
        return Ok(None);
    }

    let reference = snapshot_ref(panel_id);
    let previous = run_git(toplevel, &["rev-parse", "--verify", "--quiet", &reference])
        .ok()
        .map(text_of)
        .filter(|id| !id.is_empty());
    // Дерево то же — ход агента ничего не записал. Плодить одинаковые снимки
    // незачем: их потом просматривать человеку.
    if let Some(previous) = &previous {
        let previous_tree = run_git(toplevel, &["rev-parse", &format!("{previous}^{{tree}}")])
            .ok()
            .map(text_of);
        if previous_tree.as_deref() == Some(tree.as_str()) {
            return Ok(None);
        }
    }

    let message = format!("modelcrew: снимок панели {panel_id}");
    let mut args = vec!["commit-tree", tree.as_str()];
    if let Some(previous) = &previous {
        args.push("-p");
        args.push(previous.as_str());
    }
    args.push("-m");
    args.push(message.as_str());
    let commit = text_of(run_git_with_env(toplevel, &args, &SNAPSHOT_IDENTITY)?);
    if commit.is_empty() {
        return Ok(None);
    }
    run_git(toplevel, &["update-ref", &reference, &commit])?;
    Ok(Some(commit))
}

/// Снимок в виде, пригодном для показа.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelSnapshotView {
    pub panel_id: String,
    pub commit: String,
    pub epoch_ms: i64,
    /// Что этот ход изменил: разница с предыдущим снимком этой же панели, а
    /// для первого — с текущим состоянием ветки.
    pub files: Vec<String>,
}

/// Все снимки проекта, свежие сверху.
pub fn list_panel_snapshots(root: &Path) -> CommandResult<Vec<PanelSnapshotView>> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Ok(Vec::new());
    };
    let raw = run_git(
        &toplevel,
        &[
            "for-each-ref",
            "--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)",
            "refs/modelcrew/panels/",
        ],
    )?;
    let mut snapshots = Vec::new();
    for line in String::from_utf8_lossy(&raw).lines() {
        let mut fields = line.split('\t');
        let (Some(reference), Some(commit), Some(when)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let Some(panel_id) = reference.rsplit('/').next() else {
            continue;
        };
        snapshots.push(PanelSnapshotView {
            panel_id: panel_id.to_string(),
            files: snapshot_files(&toplevel, commit),
            commit: commit.to_string(),
            epoch_ms: when.parse::<i64>().unwrap_or_default() * 1_000,
        });
    }
    // Свежие сверху: человек ищет то, что только что затёрли. У времени
    // коммита секундная точность, а два хода нередко заканчиваются в одну
    // секунду — доупорядочиваем по панели, иначе список прыгал бы при каждом
    // обновлении.
    snapshots.sort_by(|a, b| {
        b.epoch_ms
            .cmp(&a.epoch_ms)
            .then_with(|| a.panel_id.cmp(&b.panel_id))
    });
    Ok(snapshots)
}

/// Что изменил этот ход. У первого снимка панели предшественника нет —
/// сравниваем с текущей веткой, иначе показали бы всё дерево целиком.
fn snapshot_files(toplevel: &Path, commit: &str) -> Vec<String> {
    let base = if run_git(
        toplevel,
        &["rev-parse", "--verify", "--quiet", &format!("{commit}^")],
    )
    .is_ok()
    {
        format!("{commit}^")
    } else if run_git(toplevel, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok() {
        "HEAD".to_string()
    } else {
        return Vec::new();
    };
    run_git(toplevel, &["diff", "--name-only", &base, commit])
        .map(|raw| {
            String::from_utf8_lossy(&raw)
                .lines()
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Возвращает файл из снимка в рабочее дерево. Ровно один файл: восстановить
/// весь снимок значило бы затереть работу, которая шла после него.
pub fn restore_from_snapshot(root: &Path, panel_id: &str, path: &str) -> CommandResult<()> {
    if !is_safe_repo_path(path) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("path", path));
    }
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    let reference = snapshot_ref(panel_id);
    let body = run_git(&toplevel, &["show", &format!("{reference}:{path}")])?;
    let target = toplevel.join(path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?;
    }
    std::fs::write(&target, body)
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?;
    Ok(())
}

#[tauri::command]
pub async fn panel_snapshots(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
) -> CommandResult<Vec<PanelSnapshotView>> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || list_panel_snapshots(&root))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[tauri::command]
pub async fn panel_snapshot_restore(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    panel_id: String,
    path: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || restore_from_snapshot(&root, &panel_id, &path))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

/// Свой индекс на панель: два хода в соседних панелях могут закончиться
/// одновременно, и общий временный индекс они бы затёрли друг другу.
fn temp_index_path(toplevel: &Path, panel_id: &str) -> PathBuf {
    let safe: String = panel_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .collect();
    std::env::temp_dir().join(format!(
        "modelcrew-index-{}-{safe}",
        toplevel
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default()
    ))
}

fn index_env(index: &Path) -> Vec<(&'static str, &str)> {
    vec![("GIT_INDEX_FILE", index.to_str().unwrap_or_default())]
}

#[cfg(test)]
#[path = "panel_snapshots_tests.rs"]
mod tests;
