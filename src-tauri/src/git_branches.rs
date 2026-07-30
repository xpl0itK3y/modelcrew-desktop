//! Ветки: список, переключение, создание, переименование и удаление, конфиг
//! ветки с очередью отложенной чистки, слияние и перенос.
//!
//! Вертикаль отделена от статусов и диффов: здесь каждая операция меняет
//! состояние репозитория, поэтому сверяет ветку и HEAD с тем, что видел фронт,
//! и отказывается работать посреди незавершённого merge или rebase. Эта сверка
//! (`ensure_sync_snapshot`) нужна и соседям, поэтому живёт здесь — вместе с
//! именем ветки, которое она проверяет.
//!
//! Сеть — в git_sync, чтение журнала — в git_log, перезапись прошлого —
//! в git_history.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::command_error::{CommandError, CommandResult, ErrorCode};
use crate::git_changes::*;
use crate::workspace_roots::WorkspaceRoots;

// ---------- Список веток ----------

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    // Полное имя ref. Для remote оно принципиально: короткие имена могут
    // совпадать с локальной веткой или не начинаться с имени remote при
    // пользовательском fetch refspec.
    pub ref_name: String,
    // Вершина ref в момент построения списка. Destructive-команды получают
    // её обратно и отказываются, если ветка успела сдвинуться до подтверждения.
    pub tip_hash: String,
    pub is_current: bool,
    // Ветка существует только на сервере: переключение создаст локальную
    // копию со слежением.
    pub is_remote: bool,
    // Уже влита в текущую ветку (её коммиты — предки HEAD).
    pub is_merged: bool,
    // Unix-время последнего коммита в миллисекундах (для сортировки/подписи).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_commit_at: Option<i64>,
}

// Проверку имени ветки поручаем самому Git: его правила сложнее
// самодельного regexp (компоненты, оканчивающиеся точкой, `//`, `HEAD` и т.д.).
// Ведущий дефис отсекаем до вызова, чтобы имя не могло стать опцией команды.
pub(crate) fn validate_branch_name(root: &Path, name: &str) -> CommandResult<()> {
    if name.is_empty() || name.starts_with('-') || name == "HEAD" {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "branch-invalid")
            .with_context("branch", name));
    }
    let reference = format!("refs/heads/{name}");
    run_git(root, &["check-ref-format", &reference])
        .map(|_| ())
        .map_err(|_| {
            CommandError::new(ErrorCode::GitCommandFailed)
                .with_context("reason", "branch-invalid")
                .with_context("branch", name)
        })
}

pub(crate) fn validate_namespaced_ref(
    root: &Path,
    namespace: &str,
    name: &str,
    reason: &str,
) -> CommandResult<String> {
    if name.is_empty() {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", reason)
            .with_context("branch", name));
    }
    let reference = format!("refs/{namespace}/{name}");
    run_git(root, &["check-ref-format", &reference])
        .map(|_| reference)
        .map_err(|_| {
            CommandError::new(ErrorCode::GitCommandFailed)
                .with_context("reason", reason)
                .with_context("branch", name)
        })
}

pub(crate) fn local_branch_exists(root: &Path, name: &str) -> bool {
    local_branch_tip(root, name).is_some()
}

pub(crate) fn local_branch_tip(root: &Path, name: &str) -> Option<String> {
    run_git(
        root,
        &[
            "show-ref",
            "--verify",
            "--hash",
            &format!("refs/heads/{name}"),
        ],
    )
    .ok()
    .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())
    .filter(|hash| is_safe_hash(hash))
}

pub(crate) fn remote_names(root: &Path) -> CommandResult<Vec<String>> {
    let raw = run_git(root, &["remote"])?;
    let mut names = String::from_utf8_lossy(&raw)
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    // Имена remote могут содержать `/`; самый длинный prefix однозначно
    // отделяет remote от имени ветки (a/b/topic -> remote a/b, branch topic).
    names.sort_by_key(|name| std::cmp::Reverse(name.len()));
    Ok(names)
}

fn map_fetch_refspec(refspec: &str, remote_ref: &str) -> Option<String> {
    let refspec = refspec.strip_prefix('+').unwrap_or(refspec);
    if refspec.starts_with('^') {
        return None;
    }
    let (source, destination) = refspec.split_once(':')?;
    let source_branch = source.strip_prefix("refs/heads/")?;
    if let Some((destination_prefix, destination_suffix)) = destination.split_once('*') {
        let matched = remote_ref
            .strip_prefix(destination_prefix)?
            .strip_suffix(destination_suffix)?;
        let (source_prefix, source_suffix) = source_branch.split_once('*')?;
        return Some(format!("{source_prefix}{matched}{source_suffix}"));
    }
    (destination == remote_ref).then(|| source_branch.to_owned())
}

fn local_name_for_remote_ref(root: &Path, remote_ref: &str) -> CommandResult<Option<String>> {
    for remote in remote_names(root)? {
        let key = format!("remote.{remote}.fetch");
        let Ok(raw) = run_git(root, &["config", "--get-all", &key]) else {
            continue;
        };
        for refspec in String::from_utf8_lossy(&raw).lines() {
            if let Some(local_name) = map_fetch_refspec(refspec.trim(), remote_ref) {
                return Ok(Some(local_name));
            }
        }
    }
    Ok(None)
}

fn branch_checked_out_in_worktree(root: &Path, name: &str) -> CommandResult<bool> {
    let raw = run_git(root, &["worktree", "list", "--porcelain", "-z"])?;
    let expected = format!("branch refs/heads/{name}");
    Ok(raw
        .split(|byte| *byte == 0)
        .any(|field| field == expected.as_bytes()))
}

pub(crate) fn branch_config_entries(
    root: &Path,
    name: &str,
) -> CommandResult<Vec<(String, String)>> {
    let raw = run_git(root, &["config", "--local", "--null", "--list"])?;
    Ok(raw
        .split(|byte| *byte == 0)
        .filter_map(|record| {
            let separator = record.iter().position(|byte| *byte == b'\n')?;
            let key = String::from_utf8_lossy(&record[..separator]).into_owned();
            // `branch.foo.bar.*` belongs to branch `foo.bar`, not `foo`.
            // The final dot separates the subsection (branch name) from the
            // variable, while dots before it are part of the branch name.
            let branch_and_variable = key.strip_prefix("branch.")?;
            let (subsection, _) = branch_and_variable.rsplit_once('.')?;
            if subsection != name {
                return None;
            }
            let value = String::from_utf8_lossy(&record[separator + 1..]).into_owned();
            Some((key, value))
        })
        .collect())
}

pub(crate) fn cleanup_branch_config(root: &Path, name: &str) -> CommandResult<()> {
    for attempt in 0..4 {
        if branch_config_entries(root, name)?.is_empty() {
            return Ok(());
        }
        let section = format!("branch.{name}");
        let _ = run_git(root, &["config", "--local", "--remove-section", &section]);
        if attempt < 3 {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    Err(CommandError::new(ErrorCode::GitCommandFailed)
        .with_context("reason", "branch-config-stale")
        .with_context("branch", name))
}

static BRANCH_CLEANUP_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static BRANCH_BACKUP_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn create_branch_delete_backup(root: &Path, branch: &str, tip: &str) -> CommandResult<String> {
    let zero = "0".repeat(tip.len());
    for _ in 0..32 {
        let sequence = BRANCH_BACKUP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let reference = format!(
            "refs/modelcrew/branch-delete/{}-{sequence}",
            std::process::id()
        );
        if run_git(
            root,
            &[
                "update-ref",
                "-m",
                "modelcrew: protect branch during deletion",
                &reference,
                tip,
                &zero,
            ],
        )
        .is_ok()
        {
            return Ok(reference);
        }
    }
    Err(CommandError::new(ErrorCode::GitCommandFailed)
        .with_context("reason", "branch-backup-failed")
        .with_context("branch", branch))
}

fn remove_branch_delete_backup(root: &Path, reference: &str, tip: &str) {
    let _ = run_git(root, &["update-ref", "-d", reference, tip]);
}

fn pending_branch_cleanup_dir(root: &Path) -> CommandResult<PathBuf> {
    // branch.* живёт в общем config репозитория, поэтому очередь тоже должна
    // быть общей для main и всех linked worktree. `--git-path` здесь ошибочно
    // дал бы worktree-private каталог.
    let raw = run_git(root, &["rev-parse", "--git-common-dir"])?;
    let path = PathBuf::from(String::from_utf8_lossy(&raw).trim().to_owned());
    let common_dir = if path.is_absolute() {
        path
    } else {
        root.join(path)
    };
    Ok(common_dir.join("modelcrew-branch-cleanup"))
}

pub(crate) fn pending_branch_cleanups(root: &Path) -> CommandResult<Vec<(PathBuf, String)>> {
    let directory = pending_branch_cleanup_dir(root)?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let entries = std::fs::read_dir(&directory)
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?;
    let mut pending = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(name) = std::fs::read_to_string(&path) else {
            continue;
        };
        let name = name.trim().to_owned();
        if !name.is_empty() {
            pending.push((path, name));
        }
    }
    Ok(pending)
}

pub(crate) fn queue_branch_config_cleanup(root: &Path, name: &str) -> CommandResult<()> {
    let directory = pending_branch_cleanup_dir(root)?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?;
    let sequence = BRANCH_CLEANUP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let marker = directory.join(format!("{}-{nanos}-{sequence}.pending", std::process::id()));
    std::fs::write(marker, name)
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))
}

fn drain_branch_config_cleanups(root: &Path) -> CommandResult<()> {
    for (marker, name) in pending_branch_cleanups(root)? {
        // Если ветку успели воссоздать вне приложения, её config уже снова
        // легитимен: не трогаем настройки живого ref и снимаем старый marker.
        if local_branch_exists(root, &name) {
            let _ = std::fs::remove_file(marker);
            continue;
        }
        if cleanup_branch_config(root, &name).is_ok() {
            let _ = std::fs::remove_file(marker);
        }
    }
    Ok(())
}

pub(crate) fn ensure_no_pending_branch_cleanup(root: &Path, name: &str) -> CommandResult<()> {
    let _ = drain_branch_config_cleanups(root);
    if pending_branch_cleanups(root)?
        .iter()
        .any(|(_, pending)| pending == name)
    {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "branch-config-stale")
            .with_context("branch", name));
    }
    Ok(())
}

pub fn list_branches(root: &Path) -> CommandResult<Vec<GitBranch>> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    let _ = drain_branch_config_cleanups(&toplevel);
    let raw = run_git(
        &toplevel,
        &[
            "for-each-ref",
            "refs/heads",
            "--sort=-committerdate",
            "--format=%(HEAD)%1f%(refname:short)%1f%(committerdate:unix)%1f%(objectname)",
        ],
    )?;
    // Локальные ветки, уже влитые в текущую: их коммиты — предки HEAD.
    let merged: std::collections::HashSet<String> = run_git(
        &toplevel,
        // HEAD обязателен: без него --merged принимает --format за коммит.
        &["branch", "--merged", "HEAD", "--format=%(refname:short)"],
    )
    .map(|raw| {
        String::from_utf8_lossy(&raw)
            .lines()
            .map(|line| line.trim().to_owned())
            .filter(|line| !line.is_empty())
            .collect()
    })
    .unwrap_or_default();

    let text = String::from_utf8_lossy(&raw);
    let mut branches: Vec<GitBranch> = text
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\u{1f}');
            let head = parts.next()?;
            let name = parts.next()?;
            let date = parts
                .next()
                .and_then(|value| value.trim().parse::<i64>().ok());
            let tip_hash = parts.next()?.trim();
            if !is_safe_hash(tip_hash) {
                return None;
            }
            let is_current = head == "*";
            Some(GitBranch {
                is_merged: !is_current && merged.contains(name),
                name: name.to_owned(),
                ref_name: format!("refs/heads/{name}"),
                tip_hash: tip_hash.to_owned(),
                is_current,
                is_remote: false,
                last_commit_at: date.map(|seconds| seconds * 1000),
            })
        })
        .collect();

    // Ветки, существующие только на сервере: без локальной копии их не видно
    // в refs/heads, но переключиться на них хочется в один клик.
    let local_names: std::collections::HashSet<String> =
        branches.iter().map(|branch| branch.name.clone()).collect();
    if let Ok(raw) = run_git(
        &toplevel,
        &[
            "for-each-ref",
            "refs/remotes",
            "--sort=-committerdate",
            "--format=%(refname)%1f%(committerdate:unix)%1f%(objectname)%1f%(symref)",
        ],
    ) {
        let text = String::from_utf8_lossy(&raw);
        for line in text.lines() {
            let mut parts = line.split('\u{1f}');
            let Some(full_ref) = parts.next() else {
                continue;
            };
            let Some(display_name) = full_ref.strip_prefix("refs/remotes/") else {
                continue;
            };
            let date = parts
                .next()
                .and_then(|value| value.trim().parse::<i64>().ok());
            let Some(tip_hash) = parts.next().filter(|hash| is_safe_hash(hash.trim())) else {
                continue;
            };
            let symbolic_target = parts.next().unwrap_or_default();
            if !symbolic_target.is_empty() || display_name.ends_with("/HEAD") {
                continue;
            }
            let Ok(Some(local_name)) = local_name_for_remote_ref(&toplevel, full_ref) else {
                continue;
            };
            if local_names.contains(&local_name) {
                continue;
            }
            branches.push(GitBranch {
                name: display_name.to_owned(),
                ref_name: full_ref.to_owned(),
                tip_hash: tip_hash.trim().to_owned(),
                is_current: false,
                is_remote: true,
                is_merged: false,
                last_commit_at: date.map(|seconds| seconds * 1000),
            });
        }
    }
    Ok(branches)
}

// ---------- Сверка с тем, что видел фронт ----------

// Разрушающая операция получает от панели ветку и её вершину и сверяет их с
// репозиторием: между показом списка и нажатием кнопки пользователь мог
// закоммитить из терминала, переключить ветку или начать merge.
fn attached_branch_and_head(root: &Path) -> CommandResult<(String, String)> {
    let branch = run_git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())?;
    let head = run_git(root, &["rev-parse", "--verify", "HEAD^{commit}"])
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())?;
    if branch.is_empty() || !is_safe_hash(&head) {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "head-moved")
        );
    }
    Ok((branch, head))
}

pub(crate) fn ensure_expected_branch_head(
    root: &Path,
    expected_branch: &str,
    expected_head: &str,
) -> CommandResult<()> {
    let (branch, head) = attached_branch_and_head(root)?;
    if branch != expected_branch || head != expected_head {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "head-moved")
        );
    }
    Ok(())
}

pub(crate) fn ensure_sync_snapshot(
    root: &Path,
    expected_branch: &str,
    expected_head: &str,
) -> CommandResult<()> {
    validate_branch_name(root, expected_branch)?;
    if !is_safe_hash(expected_head) {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "head-moved")
        );
    }
    if repository_operation_in_progress(root)? {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "operation-in-progress"));
    }
    ensure_expected_branch_head(root, expected_branch, expected_head)
}

pub fn switch_branch(root: &Path, name: &str, kind: &str) -> CommandResult<()> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    match kind {
        "local" => {
            validate_branch_name(&toplevel, name)?;
            if !local_branch_exists(&toplevel, name) {
                return Err(CommandError::new(ErrorCode::GitCommandFailed)
                    .with_context("reason", "branch-missing")
                    .with_context("branch", name));
            }
            run_git(&toplevel, &["switch", "--no-guess", name])?;
        }
        "remote" => {
            let remote_ref = name;
            if !remote_ref.starts_with("refs/remotes/")
                || run_git(&toplevel, &["check-ref-format", remote_ref]).is_err()
            {
                return Err(CommandError::new(ErrorCode::GitCommandFailed)
                    .with_context("reason", "branch-invalid")
                    .with_context("branch", name));
            }
            let Some(local_name) = local_name_for_remote_ref(&toplevel, remote_ref)? else {
                return Err(CommandError::new(ErrorCode::GitCommandFailed)
                    .with_context("reason", "branch-invalid")
                    .with_context("branch", name));
            };
            validate_branch_name(&toplevel, &local_name)?;
            if local_branch_exists(&toplevel, &local_name) {
                return Err(CommandError::new(ErrorCode::GitCommandFailed)
                    .with_context("reason", "branch-exists")
                    .with_context("branch", &local_name));
            }
            ensure_no_pending_branch_cleanup(&toplevel, &local_name)?;
            run_git(&toplevel, &["show-ref", "--verify", "--hash", remote_ref])?;
            // Явное имя получено из реального fetch refspec, а полный source
            // ref исключает перехват одноимённой локальной веткой или тегом.
            run_git(
                &toplevel,
                &["switch", "--track", "-c", &local_name, remote_ref],
            )?;
        }
        "tag" => {
            let tag_ref = validate_namespaced_ref(&toplevel, "tags", name, "tag-invalid")?;
            // Сначала разрешаем точный refs/tags/... в commit hash. Поэтому
            // одноимённая локальная ветка не может перехватить checkout.
            let peeled = format!("{tag_ref}^{{commit}}");
            let raw = run_git(&toplevel, &["rev-parse", "--verify", &peeled])?;
            let commit = String::from_utf8_lossy(&raw).trim().to_owned();
            if !is_safe_hash(&commit) {
                return Err(CommandError::new(ErrorCode::GitCommandFailed)
                    .with_context("reason", "tag-invalid")
                    .with_context("branch", name));
            }
            run_git(&toplevel, &["switch", "--detach", &commit])?;
        }
        _ => {
            return Err(CommandError::new(ErrorCode::GitCommandFailed)
                .with_context("reason", "ref-kind-invalid"));
        }
    }
    Ok(())
}

pub fn create_branch(root: &Path, name: &str) -> CommandResult<()> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    validate_branch_name(&toplevel, name)?;
    if local_branch_exists(&toplevel, name) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "branch-exists")
            .with_context("branch", name));
    }
    ensure_no_pending_branch_cleanup(&toplevel, name)?;
    // Без явного `HEAD` команда работает и в обычном репозитории, и с unborn
    // HEAD (новый репозиторий без первого коммита). Одна команда также не
    // оставляет созданную, но не выбранную ветку при ошибке checkout.
    run_git(&toplevel, &["checkout", "-b", name])?;
    Ok(())
}

pub fn rename_branch(root: &Path, branch: &str, new_name: &str) -> CommandResult<()> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    validate_branch_name(&toplevel, branch)?;
    validate_branch_name(&toplevel, new_name)?;
    let Some(original_tip) = local_branch_tip(&toplevel, branch) else {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "branch-missing")
            .with_context("branch", branch));
    };
    if local_branch_exists(&toplevel, new_name) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "branch-exists")
            .with_context("branch", new_name));
    }
    ensure_no_pending_branch_cleanup(&toplevel, new_name)?;
    // -m (не -M) принципиально не перезаписывает существующую ветку.
    if let Err(error) = run_git(&toplevel, &["branch", "-m", "--", branch, new_name]) {
        // Git переименовывает ref раньше config. При занятом config.lock он
        // возвращает ошибку уже после мутации; разворачиваем тот же нативный
        // rename назад (он также обновляет HEAD всех linked worktree).
        if !local_branch_exists(&toplevel, branch)
            && local_branch_tip(&toplevel, new_name).as_deref() == Some(original_tip.as_str())
        {
            let _ = run_git(&toplevel, &["branch", "-m", "--", new_name, branch]);
            if local_branch_tip(&toplevel, branch).as_deref() == Some(original_tip.as_str())
                && !local_branch_exists(&toplevel, new_name)
            {
                return Err(error);
            }
            return Err(CommandError::new(ErrorCode::GitCommandFailed)
                .with_context("reason", "branch-restore-failed")
                .with_context("branch", branch)
                .with_debug(format!("{error:?}")));
        }
        return Err(error);
    }
    Ok(())
}

pub fn delete_branch(
    root: &Path,
    branch: &str,
    force: bool,
    expected_tip: &str,
) -> CommandResult<()> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    let _ = drain_branch_config_cleanups(&toplevel);
    validate_branch_name(&toplevel, branch)?;
    if !is_safe_hash(expected_tip) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "branch-moved")
            .with_context("branch", branch));
    }
    let Some(actual_tip) = local_branch_tip(&toplevel, branch) else {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "branch-missing")
            .with_context("branch", branch));
    };
    let current = run_git(&toplevel, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned());
    if current.as_deref() == Some(branch) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "branch-current")
            .with_context("branch", branch));
    }
    if branch_checked_out_in_worktree(&toplevel, branch)? {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "branch-worktree")
            .with_context("branch", branch));
    }
    // Confirmation applies to the exact ref the user saw. If a terminal,
    // hook or another Git client advanced it meanwhile, force-delete must not
    // silently remove the new commits.
    if actual_tip != expected_tip {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "branch-moved")
            .with_context("branch", branch));
    }
    let backup_ref = create_branch_delete_backup(&toplevel, branch, expected_tip)?;
    if !force
        && run_git(
            &toplevel,
            &["merge-base", "--is-ancestor", expected_tip, "HEAD"],
        )
        .is_err()
    {
        remove_branch_delete_backup(&toplevel, &backup_ref, expected_tip);
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "branch-unmerged")
            .with_context("branch", branch));
    }

    // CAS-delete: Git удалит ref только если он всё ещё указывает ровно на
    // подтверждённую вершину. Новый concurrent commit никогда не удаляется.
    let reference = format!("refs/heads/{branch}");
    if let Err(error) = run_git(
        &toplevel,
        &[
            "update-ref",
            "-m",
            "modelcrew: delete local branch",
            "-d",
            &reference,
            expected_tip,
        ],
    ) {
        remove_branch_delete_backup(&toplevel, &backup_ref, expected_tip);
        if local_branch_tip(&toplevel, branch).as_deref() != Some(expected_tip) {
            return Err(CommandError::new(ErrorCode::GitCommandFailed)
                .with_context("reason", "branch-moved")
                .with_context("branch", branch));
        } else {
            return Err(error);
        }
    }

    remove_branch_delete_backup(&toplevel, &backup_ref, expected_tip);

    // Git считает cleanup config best-effort и в редкой гонке с `git config`
    // может вернуть success после удаления ref, оставив branch.<name>.*.
    // Удаление уже состоялось, поэтому не показываем ложную ошибку: ставим
    // marker и автоматически дочищаем секцию при следующем чтении/действии.
    if cleanup_branch_config(&toplevel, branch).is_err() {
        queue_branch_config_cleanup(&toplevel, branch).map_err(|error| {
            CommandError::new(ErrorCode::GitCommandFailed)
                .with_context("reason", "branch-config-stale")
                .with_context("branch", branch)
                .with_debug(format!("{error:?}"))
        })?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_branches(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
) -> CommandResult<Vec<GitBranch>> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || list_branches(&root))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[tauri::command]
pub async fn git_switch_branch(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    branch: String,
    kind: Option<String>,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        switch_branch(&root, &branch, kind.as_deref().unwrap_or("local"))
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[tauri::command]
pub async fn git_create_branch(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    name: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || create_branch(&root, &name))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[tauri::command]
pub async fn git_rename_branch(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    branch: String,
    new_name: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || rename_branch(&root, &branch, &new_name))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[tauri::command]
pub async fn git_delete_branch(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    branch: String,
    force: bool,
    expected_tip: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        delete_branch(&root, &branch, force, &expected_tip)
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

// ---------- Слияние и перенос ----------

// Сообщение слияния строим сами: git, получив полное имя ref, вписал бы в него
// «refs/heads/topic» вместо привычного «topic». Заодно это отсекает ссылки,
// которые сливать из панели нельзя.
fn merge_message(reference: &str) -> Option<String> {
    if let Some(name) = reference.strip_prefix("refs/heads/") {
        return Some(format!("Merge branch '{name}'"));
    }
    if let Some(name) = reference.strip_prefix("refs/remotes/") {
        return Some(format!("Merge remote-tracking branch '{name}'"));
    }
    reference
        .strip_prefix("refs/tags/")
        .map(|name| format!("Merge tag '{name}'"))
}

// Полное имя ref, существующее в этом репозитории. Только полные имена: по
// короткому «origin/main» git мог бы выбрать одноимённую локальную ветку.
fn existing_ref(root: &Path, reference: &str) -> CommandResult<()> {
    if !reference.starts_with("refs/") || run_git(root, &["check-ref-format", reference]).is_err() {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "branch-invalid")
            .with_context("branch", reference));
    }
    run_git(root, &["show-ref", "--verify", "--quiet", reference])
        .map(|_| ())
        .map_err(|_| {
            CommandError::new(ErrorCode::GitCommandFailed)
                .with_context("reason", "branch-missing")
                .with_context("branch", reference)
        })
}

// Незавершённая операция после нашей команды означает конфликт: Git оставил
// стандартное состояние, которое пользователь разрешит сам. Ничего не
// откатываем — параллельный клиент мог начать свою операцию.
fn conflict_or(root: &Path, result: CommandResult<Vec<u8>>, reason: &str) -> CommandResult<()> {
    match result {
        Ok(_) => Ok(()),
        Err(error) => {
            if repository_operation_in_progress(root)? {
                return Err(
                    CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", reason)
                );
            }
            Err(error)
        }
    }
}

// Вливает ветку, серверную ссылку или тег в текущую ветку.
pub fn merge_ref(
    root: &Path,
    reference: &str,
    expected_branch: &str,
    expected_head: &str,
    no_ff: bool,
) -> CommandResult<()> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    ensure_sync_snapshot(&toplevel, expected_branch, expected_head)?;
    let Some(message) = merge_message(reference) else {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "ref-kind-invalid"));
    };
    existing_ref(&toplevel, reference)?;
    let mut args = vec!["merge", "--no-edit", "-m", message.as_str()];
    if no_ff {
        args.push("--no-ff");
    }
    args.push(reference);
    conflict_or(&toplevel, run_git(&toplevel, &args), "merge-conflict")
}

// Переносит коммиты текущей ветки поверх выбранной. Грязное дерево git
// отвергнет сам, конфликт оставит штатное состояние rebase.
pub fn rebase_onto(
    root: &Path,
    reference: &str,
    expected_branch: &str,
    expected_head: &str,
) -> CommandResult<()> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    ensure_sync_snapshot(&toplevel, expected_branch, expected_head)?;
    if merge_message(reference).is_none() {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "ref-kind-invalid"));
    }
    existing_ref(&toplevel, reference)?;
    conflict_or(
        &toplevel,
        run_git(&toplevel, &["rebase", reference]),
        "rebase-conflict",
    )
}

#[tauri::command]
pub async fn git_merge_ref(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    reference: String,
    expected_branch: String,
    expected_head: String,
    no_ff: Option<bool>,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        merge_ref(
            &root,
            &reference,
            &expected_branch,
            &expected_head,
            no_ff.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[tauri::command]
pub async fn git_rebase_onto(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    reference: String,
    expected_branch: String,
    expected_head: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        rebase_onto(&root, &reference, &expected_branch, &expected_head)
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

// Проверки вертикали лежат рядом, отдельным файлом: их вдвое больше кода.
#[cfg(test)]
#[path = "git_branches_tests.rs"]
mod tests;
