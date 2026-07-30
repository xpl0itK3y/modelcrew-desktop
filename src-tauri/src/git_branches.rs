//! Ветки и синхронизация с сервером: список веток, переключение, создание,
//! переименование и удаление, fetch/pull/push, слияние, перенос и публикация,
//! плюс чтение журнала коммитов.
//!
//! Вертикаль отделена от статусов и диффов: здесь каждая операция меняет
//! состояние репозитория, поэтому сверяет ветку и HEAD с тем, что видел фронт,
//! и отказывается работать посреди незавершённого merge или rebase.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::command_error::{CommandError, CommandResult, ErrorCode};
use crate::git_changes::*;
use crate::git_history::{on_any_remote, read_commit_meta};
use crate::workspace_roots::WorkspaceRoots;

// ---------- Ветки и история ----------

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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRef {
    pub name: String,
    pub full_name: String,
    // "local" | "remote" | "tag"
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub author_email: String,
    pub epoch_ms: i64,
    // Коммит есть только локально: upstream его ещё не видел.
    pub unpushed: bool,
    // Можно безопасно переписать сообщение: коммит входит в непрерывный
    // локальный first-parent суффикс без merge/чужих авторов до текущего HEAD.
    pub editable: bool,
    // Коммит недостижим ни из одной remote-tracking ветки. В отличие от
    // editable не зависит от GitHub-входа, автора и типа коммита.
    pub local_only: bool,
    // На этот коммит указывает HEAD (текущий checkout) — для кольца в графе.
    pub is_head: bool,
    // Полные хеши родителей (для графа веток; у merge их несколько).
    pub parents: Vec<String>,
    // Декорации коммита: ветки/теги, указывающие на него.
    pub refs: Vec<String>,
    // Те же декорации с точным типом. `refs` оставлен для алгоритма графа и
    // обратной совместимости, но UI переключается только по этим данным.
    pub ref_details: Vec<GitCommitRef>,
    // Только реальные refs/remotes, указывающие на этот коммит. Нужны UI,
    // чтобы не определять remote по ненадёжному префиксу `origin/`.
    pub remote_refs: Vec<String>,
    // Полное сообщение в исходном порядке, включая все trailer-строки. Оно
    // нужно copy/reword: body + co_authors не позволяет восстановить mixed
    // trailer block без перестановок.
    pub full_message: String,
    // Тело коммита без трейлеров Co-authored-by (они в co_authors).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub body: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub co_authors: Vec<String>,
}

fn co_author_from_trailer(line: &str) -> Option<String> {
    let (token, value) = line.trim().split_once(':')?;
    if !token.eq_ignore_ascii_case("co-authored-by") {
        return None;
    }
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn is_trailer_line(line: &str) -> bool {
    let Some((token, value)) = line.trim().split_once(':') else {
        return false;
    };
    !token.is_empty()
        && !value.trim().is_empty()
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

// Отделяет соавторов только из заключительного trailer block. Упоминание
// `Co-authored-by:` в примере/цитате посреди описания не является трейлером.
pub fn split_body_and_co_authors(raw_body: &str) -> (String, Vec<String>) {
    let trimmed = raw_body.trim();
    if trimmed.is_empty() {
        return (String::new(), Vec::new());
    }
    let lines = trimmed.lines().collect::<Vec<_>>();
    let trailer_start = lines
        .iter()
        .rposition(|line| line.trim().is_empty())
        .map(|index| index + 1)
        .unwrap_or(0);
    let candidate = &lines[trailer_start..];
    let is_trailer_block = !candidate.is_empty()
        && is_trailer_line(candidate[0])
        && candidate
            .iter()
            .all(|line| is_trailer_line(line) || line.starts_with([' ', '\t']));
    if !is_trailer_block {
        return (trimmed.to_owned(), Vec::new());
    }

    let mut body_lines = lines[..trailer_start].to_vec();
    let mut co_authors = Vec::new();
    for line in candidate {
        if let Some(author) = co_author_from_trailer(line) {
            co_authors.push(author);
        } else {
            body_lines.push(line);
        }
    }
    (body_lines.join("\n").trim().to_owned(), co_authors)
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

fn remote_names(root: &Path) -> CommandResult<Vec<String>> {
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

fn ensure_no_pending_branch_cleanup(root: &Path, name: &str) -> CommandResult<()> {
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

// Атомарно переставить подтверждённую локальную ветку на серверную вершину.
// Индекс и рабочее дерево намеренно не трогаем: локальные коммиты исчезают из
// истории, но все их изменения и несохранённые правки остаются staged/working.
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

fn ensure_expected_branch_head(
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct UpstreamTarget {
    remote: String,
    remote_branch_ref: String,
    tracking_ref: String,
}

fn ensure_sync_snapshot(
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

#[tauri::command]
pub async fn git_commit_action(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    action: String,
    hash: String,
    name: Option<String>,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        commit_action(&root, &action, &hash, name.as_deref())
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
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

fn uncommit_head(root: &Path, hash: &str) -> CommandResult<()> {
    if repository_operation_in_progress(root)? {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "operation-in-progress"));
    }
    // Detached HEAD не подходит: reset должен передвигать именно локальную
    // ветку, а не оставлять изменения без именованной точки восстановления.
    let head_ref = run_git(root, &["symbolic-ref", "--quiet", "HEAD"])
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())
        .map_err(|_| {
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "detached")
        })?;

    let head = run_git(root, &["rev-parse", "--verify", "HEAD"])
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())?;
    if head != hash {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "head-moved")
        );
    }

    // Суффикс заставляет Git трактовать 40 hex именно как object id даже при
    // наличии плохо названной refs/heads/<40-hex>.
    let commit = format!("{hash}^{{commit}}");
    let meta = read_commit_meta(root, &commit)?;
    if meta.parents.len() != 1 {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "parent-count")
        );
    }
    if on_any_remote(root, &commit)? {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "pushed"));
    }

    // CAS передвигает именно локальную ветку и не может затереть коммит,
    // созданный терминалом между проверками. Индекс намеренно не трогаем:
    // это атомарный эквивалент reset --soft, а отдельный mixed-reset индекса
    // создал бы гонку с параллельным commit/add в терминале.
    let parent = &meta.parents[0];
    run_git(
        root,
        &[
            "update-ref",
            "-m",
            "modelcrew: undo local commit",
            &head_ref,
            parent,
            &head,
        ],
    )
    .map_err(|_| {
        CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "head-moved")
    })?;
    Ok(())
}

fn run_history_action(root: &Path, args: &[&str]) -> CommandResult<()> {
    // Не вмешиваемся в операцию, начатую терминалом или другим Git-клиентом.
    if repository_operation_in_progress(root)? {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "operation-in-progress"));
    }
    // При конфликте сохраняем стандартное состояние Git. Автоматический
    // abort без owner-token небезопасен: параллельный клиент мог начать свою
    // операцию между проверкой выше и вызовом команды.
    run_git(root, args).map(|_| ())
}

// Действие над конкретным коммитом истории. Все варианты — стандартные
// операции git, которые пользователь осознанно запускает из меню; ошибки
// (грязное дерево, конфликт cherry-pick/revert) поднимаются наверх. Конфликт
// сохраняется как штатная незавершённая операция Git для явного continue/abort.
//   checkout   — перейти на коммит (HEAD отделяется);
//   branch     — создать ветку `name` от коммита и переключиться на неё;
//   cherryPick — применить коммит поверх текущей ветки;
//   revert     — создать коммит, отменяющий данный;
//   uncommit   — убрать локальный HEAD-коммит, сохранив изменения в дереве.
pub fn commit_action(
    root: &Path,
    action: &str,
    hash: &str,
    name: Option<&str>,
) -> CommandResult<()> {
    if !is_safe_hash(hash) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("hash", hash));
    }
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    let resolved = run_git(
        &toplevel,
        &["rev-parse", "--verify", &format!("{hash}^{{commit}}")],
    )
    .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())?;
    if !is_safe_hash(&resolved) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("hash", hash));
    }
    // Не передаём голый 40-hex последующим porcelain-командам: Git допускает
    // ref с таким именем и некоторые команды выберут ref вместо object id.
    let resolved_commit = format!("{resolved}^{{commit}}");
    match action {
        "checkout" => run_git(&toplevel, &["switch", "--detach", &resolved_commit]).map(|_| ()),
        "branch" => {
            let Some(name) = name else {
                return Err(CommandError::new(ErrorCode::GitCommandFailed)
                    .with_context("branch", name.unwrap_or_default()));
            };
            validate_branch_name(&toplevel, name)?;
            if local_branch_exists(&toplevel, name) {
                return Err(CommandError::new(ErrorCode::GitCommandFailed)
                    .with_context("reason", "branch-exists")
                    .with_context("branch", name));
            }
            ensure_no_pending_branch_cleanup(&toplevel, name)?;
            run_git(&toplevel, &["switch", "-c", name, &resolved_commit]).map(|_| ())
        }
        "cherryPick" => run_history_action(&toplevel, &["cherry-pick", &resolved_commit]),
        "revert" => run_history_action(&toplevel, &["revert", "--no-edit", &resolved_commit]),
        "uncommit" => uncommit_head(&toplevel, &resolved),
        other => Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("action", other)),
    }
}

pub(crate) fn parse_commit_refs(decorations: &str) -> (bool, Vec<GitCommitRef>) {
    let mut is_head = false;
    let mut refs = Vec::new();
    for raw_entry in decorations.split(", ") {
        let mut entry = raw_entry.trim();
        if entry == "HEAD" {
            is_head = true;
            continue;
        }
        if let Some(target) = entry.strip_prefix("HEAD -> ") {
            is_head = true;
            entry = target;
        }
        let detail = if let Some(name) = entry.strip_prefix("refs/heads/") {
            Some(GitCommitRef {
                name: name.to_owned(),
                full_name: entry.to_owned(),
                kind: "local".to_owned(),
            })
        } else if let Some(name) = entry.strip_prefix("refs/remotes/") {
            (!name.ends_with("/HEAD")).then(|| GitCommitRef {
                name: name.to_owned(),
                full_name: entry.to_owned(),
                kind: "remote".to_owned(),
            })
        } else {
            entry
                .strip_prefix("tag: refs/tags/")
                .map(|name| GitCommitRef {
                    name: name.to_owned(),
                    full_name: format!("refs/tags/{name}"),
                    kind: "tag".to_owned(),
                })
        };
        if let Some(detail) = detail {
            refs.push(detail);
        }
    }
    (is_head, refs)
}

fn parse_log_records(
    raw: &[u8],
    upstream_unpushed: &std::collections::HashSet<String>,
    local_only: &std::collections::HashSet<String>,
    rewordable: &std::collections::HashSet<String>,
) -> CommandResult<Vec<GitCommitInfo>> {
    const FIELD_COUNT: usize = 10;
    let mut fields = raw.split(|byte| *byte == 0).collect::<Vec<_>>();
    // `git log -z` завершает и последнюю запись NUL-байтом.
    if fields.last().is_some_and(|field| field.is_empty()) {
        fields.pop();
    }
    if fields.len() % FIELD_COUNT != 0 {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "invalidLogRecord"));
    }

    let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
    let mut commits = Vec::with_capacity(fields.len() / FIELD_COUNT);
    for record in fields.chunks_exact(FIELD_COUNT) {
        let hash = text(record[0]);
        if !is_safe_hash(&hash) {
            return Err(CommandError::new(ErrorCode::GitCommandFailed)
                .with_context("reason", "invalidLogHash"));
        }
        let short_hash = text(record[1]);
        let author = text(record[2]);
        let author_email = text(record[3]);
        let epoch = text(record[4]).parse::<i64>().map_err(|error| {
            CommandError::new(ErrorCode::GitCommandFailed)
                .with_context("reason", "invalidLogTimestamp")
                .with_debug(error)
        })?;
        let subject = text(record[5]);
        // С `--decorate=full` локальная ветка, remote ref и тег не становятся
        // неразличимыми даже при одинаковом отображаемом имени.
        let decorations = text(record[6]);
        let (is_head, ref_details) = parse_commit_refs(&decorations);
        let refs = ref_details
            .iter()
            .map(|detail| detail.name.clone())
            .collect::<Vec<_>>();
        let commit_remote_refs = ref_details
            .iter()
            .filter(|detail| detail.kind == "remote")
            .map(|detail| detail.name.clone())
            .collect::<Vec<_>>();
        let parents = text(record[7])
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let (body, co_authors) = split_body_and_co_authors(&text(record[8]));
        let full_message = text(record[9]).trim_end_matches('\n').to_owned();
        let is_local_only = local_only.contains(&hash);
        let editable = rewordable.contains(&hash);
        commits.push(GitCommitInfo {
            // Без upstream множество upstream_unpushed пусто, но local_only
            // всё равно честно показывает, что коммита нет ни на одном remote.
            unpushed: upstream_unpushed.contains(&hash) || is_local_only,
            editable,
            local_only: is_local_only,
            is_head,
            hash,
            short_hash,
            subject,
            author,
            author_email,
            epoch_ms: epoch.saturating_mul(1000),
            parents,
            refs,
            ref_details,
            remote_refs: commit_remote_refs,
            full_message,
            body,
            co_authors,
        });
    }
    Ok(commits)
}

// Объединяет ограниченный основной поток истории с редкими decoration-tip
// записями. Простое append нарушило бы граф, если добавленный tip ссылается на
// уже видимого родителя. Стабильная топологическая сортировка сохраняет
// исходный порядок настолько, насколько позволяют связи child -> parent.
fn merge_topological_commits(
    mut primary: Vec<GitCommitInfo>,
    supplemental: Vec<GitCommitInfo>,
) -> Vec<GitCommitInfo> {
    let mut seen = primary
        .iter()
        .map(|commit| commit.hash.clone())
        .collect::<std::collections::HashSet<_>>();
    for commit in supplemental {
        if seen.insert(commit.hash.clone()) {
            primary.push(commit);
        }
    }
    if primary.len() < 2 {
        return primary;
    }

    let positions = primary
        .iter()
        .enumerate()
        .map(|(index, commit)| (commit.hash.clone(), index))
        .collect::<std::collections::HashMap<_, _>>();
    let mut incoming_children = vec![0usize; primary.len()];
    let mut visible_parents = vec![Vec::new(); primary.len()];
    for (child_index, commit) in primary.iter().enumerate() {
        for parent in &commit.parents {
            let Some(&parent_index) = positions.get(parent) else {
                continue;
            };
            if parent_index == child_index || visible_parents[child_index].contains(&parent_index) {
                continue;
            }
            visible_parents[child_index].push(parent_index);
            incoming_children[parent_index] += 1;
        }
    }

    let mut available = std::collections::BinaryHeap::new();
    for (index, incoming) in incoming_children.iter().enumerate() {
        if *incoming == 0 {
            available.push(std::cmp::Reverse(index));
        }
    }
    let mut commits = primary.into_iter().map(Some).collect::<Vec<_>>();
    let mut ordered = Vec::with_capacity(commits.len());
    while let Some(std::cmp::Reverse(index)) = available.pop() {
        let Some(commit) = commits[index].take() else {
            continue;
        };
        ordered.push(commit);
        for parent_index in &visible_parents[index] {
            incoming_children[*parent_index] -= 1;
            if incoming_children[*parent_index] == 0 {
                available.push(std::cmp::Reverse(*parent_index));
            }
        }
    }

    // Commit-граф ацикличен. Если повреждённый объект всё же дал цикл,
    // не теряем записи: возвращаем их в стабильном исходном порядке.
    if ordered.len() != commits.len() {
        ordered.extend(commits.into_iter().flatten());
    }
    ordered
}

// Фильтр журнала. Пустые поля не сужают выборку. Отдельно от `limit`, потому
// что фильтр применяет сам git — иначе пришлось бы вычитывать всю историю.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogFilter {
    // Подстрока в сообщении коммита (заголовок и описание).
    pub text: Option<String>,
    pub author: Option<String>,
    // Путь внутри репозитория: остаются только коммиты, менявшие его.
    pub path: Option<String>,
}

impl GitLogFilter {
    fn value(field: &Option<String>) -> Option<&str> {
        field
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
    }

    pub fn is_empty(&self) -> bool {
        Self::value(&self.text).is_none()
            && Self::value(&self.author).is_none()
            && Self::value(&self.path).is_none()
    }
}

#[cfg(test)]
pub(crate) fn list_log_unfiltered(
    root: &Path,
    limit: u32,
    all_branches: bool,
) -> CommandResult<Vec<GitCommitInfo>> {
    list_log(root, limit, all_branches, &GitLogFilter::default())
}

pub fn list_log(
    root: &Path,
    limit: u32,
    all_branches: bool,
    filter: &GitLogFilter,
) -> CommandResult<Vec<GitCommitInfo>> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    let head_exists = run_git(&toplevel, &["rev-parse", "--verify", "HEAD"]).is_ok();
    let detached_head =
        head_exists && run_git(&toplevel, &["symbolic-ref", "--quiet", "HEAD"]).is_err();
    if !all_branches && !head_exists {
        // Unborn HEAD: это корректный пустой репозиторий. Прочие ошибки `log`
        // ниже не маскируем под пустую историю.
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 800);
    let count = format!("-n{limit}");
    // Граф строится сверху вниз и предполагает топологический порядок: любой
    // коммит обязан идти раньше всех своих родителей. Обычный `git log`
    // сортирует преимущественно по времени и при намеренно/случайно сбитых
    // датах способен показать общий родитель раньше одного из потомков — такую
    // последовательность уже невозможно правдиво соединить линиями. Заодно
    // --topo-order держит параллельные ветки цельными, как нативный git graph.
    const LOG_FORMAT: &str = "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%D%x00%P%x00%b%x00%B";
    let mut args = vec![
        "log",
        count.as_str(),
        "--topo-order",
        "-z",
        "--decorate=full",
        "--decorate-refs-exclude=refs/remotes/*/HEAD",
        LOG_FORMAT,
    ];
    if all_branches {
        // Кнопка называется «Все ветки»: stash, notes, bisect и tag-only
        // компоненты из `--all` здесь неуместны. Теги на достижимых коммитах
        // всё равно остаются в %D. Detached HEAD добавляем отдельно, потому что
        // ни одна локальная ветка может на него не указывать.
        args.push("--branches");
        args.push("--remotes");
        if detached_head {
            args.push("HEAD");
        }
    }
    // Значения уходят одним argv-элементом внутри `--opt=value`, поэтому даже
    // текст, начинающийся с дефиса, не может стать опцией git.
    let text = GitLogFilter::value(&filter.text).map(|text| format!("--grep={text}"));
    let author = GitLogFilter::value(&filter.author).map(|name| format!("--author={name}"));
    if let Some(grep) = text.as_deref() {
        // Поиск — по подстроке, а не по регулярному выражению: пользователь
        // вводит кусок сообщения, а не шаблон.
        args.push("--fixed-strings");
        args.push("--regexp-ignore-case");
        args.push(grep);
    }
    if let Some(author) = author.as_deref() {
        args.push("--regexp-ignore-case");
        args.push(author);
    }
    let path = GitLogFilter::value(&filter.path);
    if let Some(path) = path {
        if !is_safe_repo_path(path) {
            return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("path", path));
        }
        args.push("--");
        args.push(path);
    }
    let raw = run_git(&toplevel, &args)?;
    // Глобальный -n применяется ко всему topo-потоку. Длинная main может
    // полностью вытеснить короткую side-ветку, поэтому вторым упрощённым
    // проходом забираем tips всех branch/remote refs и topology connectors.
    let supplemental_raw = (all_branches && filter.is_empty())
        .then(|| {
            run_git(
                &toplevel,
                &[
                    "log",
                    "--topo-order",
                    "--simplify-by-decoration",
                    "-z",
                    "--decorate=full",
                    "--decorate-refs-exclude=refs/remotes/*/HEAD",
                    LOG_FORMAT,
                    "--branches",
                    "--remotes",
                ],
            )
        })
        .transpose()?;
    // Коммиты, которых ещё нет на upstream текущей ветки. Без upstream
    // сравнивать не с чем — тогда пометок нет.
    let upstream_unpushed: std::collections::HashSet<String> =
        run_git(&toplevel, &["rev-list", "-n", "600", "@{upstream}..HEAD"])
            .map(|raw| {
                String::from_utf8_lossy(&raw)
                    .lines()
                    .map(|line| line.trim().to_owned())
                    .filter(|line| !line.is_empty())
                    .collect()
            })
            .unwrap_or_default();

    // Локальная почта — чтобы отметить «свои» коммиты как редактируемые.
    let local_email = run_git(&toplevel, &["config", "user.email"])
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_lowercase())
        .unwrap_or_default();

    // Коммиты, которых нет ни на одной remote-ветке — их безопасно переписывать.
    // В отличие от @{upstream} работает и без upstream (тогда всё локально).
    let mut local_only_args = vec!["rev-list", "-n", "2000"];
    if all_branches {
        local_only_args.push("--branches");
        if detached_head {
            local_only_args.push("HEAD");
        }
    } else {
        local_only_args.push("HEAD");
    }
    local_only_args.push("--not");
    local_only_args.push("--remotes");
    let local_only: std::collections::HashSet<String> = run_git(&toplevel, &local_only_args)
        .map(|raw| {
            String::from_utf8_lossy(&raw)
                .lines()
                .map(|line| line.trim().to_owned())
                .filter(|line| !line.is_empty())
                .collect()
        })
        .unwrap_or_default();

    // Reword пересобирает цепочку от HEAD до выбранного коммита. Поэтому
    // действие доступно только для непрерывного безопасного суффикса
    // first-parent: первый merge, опубликованный или чужой коммит блокирует и
    // все более старые цели, даже если сами они локальные и линейные.
    let mut rewordable = std::collections::HashSet::new();
    if !detached_head && !local_email.is_empty() {
        if let Ok(raw) = run_git(
            &toplevel,
            &[
                "log",
                "--first-parent",
                "-n2000",
                "--format=%H%x1f%P%x1f%ae",
                "HEAD",
            ],
        ) {
            for line in String::from_utf8_lossy(&raw).lines() {
                let mut fields = line.split('\u{1f}');
                let hash = fields.next().unwrap_or_default().trim();
                let parents = fields.next().unwrap_or_default();
                let email = fields.next().unwrap_or_default().trim().to_lowercase();
                let safe = is_safe_hash(hash)
                    && local_only.contains(hash)
                    && parents.split_whitespace().count() <= 1
                    && email == local_email;
                if !safe {
                    break;
                }
                rewordable.insert(hash.to_owned());
            }
        }
    }

    let primary = parse_log_records(&raw, &upstream_unpushed, &local_only, &rewordable)?;
    let Some(supplemental_raw) = supplemental_raw else {
        return Ok(primary);
    };
    let supplemental = parse_log_records(
        &supplemental_raw,
        &upstream_unpushed,
        &local_only,
        &rewordable,
    )?;
    Ok(merge_topological_commits(primary, supplemental))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u64>,
}

// Файлы, изменённые конкретным коммитом (для раскрытой карточки истории).
pub fn list_commit_files(root: &Path, hash: &str) -> CommandResult<Vec<GitCommitFile>> {
    if !is_safe_hash(hash) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("hash", hash));
    }
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    let raw = run_git(
        &toplevel,
        &[
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--numstat",
            "-r",
            "-z",
            hash,
        ],
    )?;
    Ok(parse_numstat(&raw)
        .into_iter()
        .map(|(path, additions, deletions)| GitCommitFile {
            path,
            additions,
            deletions,
        })
        .collect())
}

// Diff одного файла внутри коммита. Обход тот же, что у списка файлов, поэтому
// и здесь виден корневой коммит: `git diff <hash>^` на нём просто падает.
pub fn commit_file_diff(root: &Path, hash: &str, path: &str) -> CommandResult<GitFileDiff> {
    if !is_safe_hash(hash) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("hash", hash));
    }
    if !is_safe_repo_path(path) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("path", path));
    }
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    let raw = run_git(
        &toplevel,
        &[
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--patch",
            "-r",
            hash,
            "--",
            path,
        ],
    )?;
    Ok(diff_payload(path, &raw, true))
}

#[tauri::command]
pub async fn git_commit_file_diff(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    hash: String,
    path: String,
) -> CommandResult<GitFileDiff> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || commit_file_diff(&root, &hash, &path))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[tauri::command]
pub async fn git_commit_files(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    hash: String,
) -> CommandResult<Vec<GitCommitFile>> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || list_commit_files(&root, &hash))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
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

#[tauri::command]
pub async fn git_log(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    limit: u32,
    all: Option<bool>,
    filter: Option<GitLogFilter>,
) -> CommandResult<Vec<GitCommitInfo>> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        list_log(
            &root,
            limit,
            all.unwrap_or(false),
            &filter.unwrap_or_default(),
        )
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

// ---------- Слияние, перенос и публикация ветки ----------

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
