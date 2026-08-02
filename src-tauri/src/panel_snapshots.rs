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

use crate::command_error::CommandResult;
use crate::git_changes::{repo_toplevel, run_git, run_git_with_env};

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
