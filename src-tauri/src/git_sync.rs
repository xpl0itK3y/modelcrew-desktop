//! Синхронизация с сервером: fetch, pull, push, pull --rebase, сброс на
//! upstream и публикация ещё не отправленной ветки.
//!
//! Вертикаль отделена от локальных операций с ветками: только здесь код выходит
//! в сеть. Отсюда и то, чего нет у соседей: запрет интерактивного запроса
//! пароля (терминала у команды нет — вопрос повис бы навсегда), обрыв зависшего
//! HTTP по скорости и сверка отправляемого коммита с тем, что подтвердил
//! пользователь.

use std::path::Path;

use crate::command_error::{CommandError, CommandResult, ErrorCode};
use crate::git_branches::{
    ensure_expected_branch_head, ensure_sync_snapshot, remote_names, validate_branch_name,
};
use crate::git_changes::*;
use crate::workspace_roots::WorkspaceRoots;

// Сетевая git-операция без интерактивных запросов пароля: терминала у неё
// нет, поэтому GIT_TERMINAL_PROMPT=0 и BatchMode обрывают попытку спросить
// пароль, а http.lowSpeed* — зависший HTTP. Лучше тихо/быстро упасть с
// ошибкой, чем повиснуть навсегда.
fn run_git_network(toplevel: &Path, args: &[&str]) -> CommandResult<()> {
    let output = git_command()
        .args([
            "-c",
            "http.lowSpeedLimit=1000",
            "-c",
            "http.lowSpeedTime=15",
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes")
        .current_dir(toplevel)
        .output()
        .map_err(|error| CommandError::new(ErrorCode::GitUnavailable).with_debug(error))?;
    if !output.status.success() {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_debug(
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(1024)
                .collect::<String>(),
        ));
    }
    Ok(())
}

// Фоновый fetch: обновляет refs/remotes, чтобы ↑/↓ показывали реальное
// расхождение с сервером.
pub fn fetch_upstream(root: &Path) -> CommandResult<()> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    run_git_network(&toplevel, &["fetch", "--quiet"])
}

// Забрать изменения с сервера. Fetch отделён от локальной мутации: после
// долгой сети повторно сверяем ветку и HEAD, которые видел пользователь.
// --ff-only только перематывает историю, без неявного merge-коммита.
pub fn pull_upstream(root: &Path, expected_branch: &str, expected_head: &str) -> CommandResult<()> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    ensure_sync_snapshot(&toplevel, expected_branch, expected_head)?;
    let target = upstream_target_for_branch(&toplevel, expected_branch)?;
    run_git_network(&toplevel, &["fetch", "--quiet", &target.remote])?;
    ensure_sync_snapshot(&toplevel, expected_branch, expected_head)?;
    if upstream_target_for_branch(&toplevel, expected_branch)? != target {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "head-moved")
        );
    }
    let upstream_tip = resolve_upstream_tip(&toplevel, &target.tracking_ref)?;
    run_git(
        &toplevel,
        &[
            "merge",
            "--ff-only",
            "--quiet",
            &format!("{upstream_tip}^{{commit}}"),
        ],
    )
    .map(|_| ())
}

// Отправить ровно подтверждённый commit в upstream подтверждённой ветки.
// Даже если другой Git-клиент успеет переключить/продвинуть текущую ветку,
// push не подхватит её новый HEAD по неявному push.default.
pub fn push_upstream(root: &Path, expected_branch: &str, expected_head: &str) -> CommandResult<()> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    ensure_sync_snapshot(&toplevel, expected_branch, expected_head)?;
    let target = upstream_target_for_branch(&toplevel, expected_branch)?;
    ensure_sync_snapshot(&toplevel, expected_branch, expected_head)?;
    let refspec = format!("{expected_head}^{{commit}}:{}", target.remote_branch_ref);
    run_git_network(&toplevel, &["push", "--quiet", &target.remote, &refspec])
}

// Забрать с сервера с rebase: локальные коммиты переносятся поверх серверных —
// подходит для разошедшейся ветки. Конфликт оставляет стандартное состояние
// rebase для явного continue/abort: автоматически abort-ить нельзя, потому что
// параллельная операция могла быть начата пользователем в терминале.
pub fn pull_rebase(root: &Path, expected_branch: &str, expected_head: &str) -> CommandResult<()> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    ensure_sync_snapshot(&toplevel, expected_branch, expected_head)?;
    let target = upstream_target_for_branch(&toplevel, expected_branch)?;
    run_git_network(&toplevel, &["fetch", "--quiet", &target.remote])?;
    ensure_sync_snapshot(&toplevel, expected_branch, expected_head)?;
    if upstream_target_for_branch(&toplevel, expected_branch)? != target {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "head-moved")
        );
    }
    let upstream_tip = resolve_upstream_tip(&toplevel, &target.tracking_ref)?;
    run_git(
        &toplevel,
        &["rebase", "--quiet", &format!("{upstream_tip}^{{commit}}")],
    )
    .map(|_| ())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct UpstreamTarget {
    remote: String,
    remote_branch_ref: String,
    tracking_ref: String,
}

fn upstream_target_for_branch(root: &Path, branch: &str) -> CommandResult<UpstreamTarget> {
    let remote_key = format!("branch.{branch}.remote");
    let merge_key = format!("branch.{branch}.merge");
    let remote = run_git(root, &["config", "--get", &remote_key])
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())?;
    if remote.is_empty()
        || remote.starts_with('-')
        || remote == "."
        || !remote_names(root)?.iter().any(|name| name == &remote)
    {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "upstream-invalid"));
    }
    let remote_branch_ref = run_git(root, &["config", "--get", &merge_key])
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())?;
    if !remote_branch_ref.starts_with("refs/heads/")
        || run_git(root, &["check-ref-format", &remote_branch_ref]).is_err()
    {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "upstream-invalid"));
    }

    let local_ref = format!("refs/heads/{branch}");
    let tracking_ref = run_git(
        root,
        &[
            "for-each-ref",
            "--format=%(upstream)",
            "--count=1",
            &local_ref,
        ],
    )
    .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())?;
    if !tracking_ref.starts_with("refs/remotes/")
        || run_git(root, &["check-ref-format", &tracking_ref]).is_err()
    {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "upstream-invalid"));
    }
    Ok(UpstreamTarget {
        remote,
        remote_branch_ref,
        tracking_ref,
    })
}

fn resolve_upstream_tip(root: &Path, tracking_ref: &str) -> CommandResult<String> {
    let tip = run_git(
        root,
        &[
            "rev-parse",
            "--verify",
            &format!("{tracking_ref}^{{commit}}"),
        ],
    )
    .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())?;
    if !is_safe_hash(&tip) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "upstream-invalid"));
    }
    Ok(tip)
}

// Атомарно переставить подтверждённую локальную ветку на серверную вершину.
// Индекс и рабочее дерево намеренно не трогаем: локальные коммиты исчезают из
// истории, но все их изменения и несохранённые правки остаются staged/working.
pub fn reset_to_upstream(
    root: &Path,
    expected_branch: &str,
    expected_head: &str,
) -> CommandResult<()> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    validate_branch_name(&toplevel, expected_branch)?;
    if !is_safe_hash(expected_head) {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "head-moved")
        );
    }
    if repository_operation_in_progress(&toplevel)? {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "operation-in-progress"));
    }
    ensure_expected_branch_head(&toplevel, expected_branch, expected_head)?;
    let upstream_ref = run_git(
        &toplevel,
        &["rev-parse", "--symbolic-full-name", "@{upstream}"],
    )
    .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())?;
    if !upstream_ref.starts_with("refs/remotes/")
        || run_git(&toplevel, &["check-ref-format", &upstream_ref]).is_err()
    {
        return Err(CommandError::new(ErrorCode::GitCommandFailed));
    }
    run_git_network(&toplevel, &["fetch", "--quiet"])?;
    // Fetch может занять секунды: непосредственно перед сменой ref
    // повторно проверяем именно ветку и HEAD, подтверждённые пользователем.
    if repository_operation_in_progress(&toplevel)? {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "operation-in-progress"));
    }
    ensure_expected_branch_head(&toplevel, expected_branch, expected_head)?;
    let current_upstream = run_git(
        &toplevel,
        &["rev-parse", "--symbolic-full-name", "@{upstream}"],
    )
    .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())?;
    if current_upstream != upstream_ref {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "head-moved")
        );
    }
    let upstream_tip = run_git(
        &toplevel,
        &[
            "rev-parse",
            "--verify",
            &format!("{upstream_ref}^{{commit}}"),
        ],
    )
    .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())?;
    if !is_safe_hash(&upstream_tip) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed));
    }
    run_git(
        &toplevel,
        &[
            "update-ref",
            "-m",
            "modelcrew: align branch with upstream (keep changes)",
            &format!("refs/heads/{expected_branch}"),
            &upstream_tip,
            expected_head,
        ],
    )
    .map_err(|_| {
        CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "head-moved")
    })?;
    Ok(())
}

#[tauri::command]
pub async fn git_fetch_upstream(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || fetch_upstream(&root))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[tauri::command]
pub async fn git_pull(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    expected_branch: String,
    expected_head: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        pull_upstream(&root, &expected_branch, &expected_head)
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[tauri::command]
pub async fn git_push(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    expected_branch: String,
    expected_head: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        push_upstream(&root, &expected_branch, &expected_head)
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[tauri::command]
pub async fn git_pull_rebase(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    expected_branch: String,
    expected_head: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        pull_rebase(&root, &expected_branch, &expected_head)
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[tauri::command]
pub async fn git_reset_to_upstream(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    expected_branch: String,
    expected_head: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        reset_to_upstream(&root, &expected_branch, &expected_head)
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}
// Отправляет ещё не опубликованную ветку на сервер и привязывает её к
// созданной серверной ветке, чтобы дальше работали обычные ↑/↓.
pub fn publish_branch(
    root: &Path,
    expected_branch: &str,
    expected_head: &str,
    remote: Option<&str>,
) -> CommandResult<()> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    ensure_sync_snapshot(&toplevel, expected_branch, expected_head)?;
    if upstream_target_for_branch(&toplevel, expected_branch).is_ok() {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "upstream-exists"));
    }
    let remotes = remote_names(&toplevel)?;
    let remote = match remote.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) if remotes.iter().any(|known| known == name) => name.to_owned(),
        Some(name) => {
            return Err(CommandError::new(ErrorCode::GitCommandFailed)
                .with_context("reason", "remote-missing")
                .with_context("remote", name));
        }
        // Без явного выбора берём origin, а при единственном remote — его.
        None if remotes.iter().any(|name| name == "origin") => "origin".to_owned(),
        None if remotes.len() == 1 => remotes[0].clone(),
        None => {
            return Err(CommandError::new(ErrorCode::GitCommandFailed)
                .with_context("reason", "remote-ambiguous"));
        }
    };

    // Отправляем ровно подтверждённый коммит: параллельный коммит из терминала
    // не уедет на сервер незаметно для пользователя.
    let refspec = format!("{expected_head}^{{commit}}:refs/heads/{expected_branch}");
    run_git_network(&toplevel, &["push", "--quiet", &remote, &refspec])?;
    let tracking = format!("refs/remotes/{remote}/{expected_branch}");
    run_git(
        &toplevel,
        &["branch", "--set-upstream-to", &tracking, expected_branch],
    )
    .map(|_| ())
    .map_err(|error| {
        // Push уже прошёл, поэтому это не «не удалось опубликовать», а «не
        // удалось связать»: сообщение должно отличаться.
        CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "published-untracked")
            .with_debug(format!("{error:?}"))
    })
}
#[tauri::command]
pub async fn git_publish_branch(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    expected_branch: String,
    expected_head: String,
    remote: Option<String>,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        publish_branch(&root, &expected_branch, &expected_head, remote.as_deref())
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

// Проверки вертикали лежат рядом, отдельным файлом: их вдвое больше кода.
#[cfg(test)]
#[path = "git_sync_tests.rs"]
mod tests;
