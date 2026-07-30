// Панель «Изменения»: сводка git-статуса проекта и diff отдельных файлов.
// Команды выполняются строго в корне воркспейса из реестра, аргументы идут
// массивом (без шелла). Парсеры вынесены в чистые функции под юнит-тесты.

use crate::command_error::{CommandError, CommandResult, ErrorCode};
use crate::git_branches::local_branch_exists;
use crate::github_auth::{github_commit_identity, GithubCommitIdentity};
use crate::workspace_roots::WorkspaceRoots;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

// Diff больше этого не отдаём целиком: панель предложит открыть файл.
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
// Файлы крупнее не читаем при подсчёте строк нового файла.
const MAX_UNTRACKED_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    // "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted"
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
    // None — бинарный файл, счётчики строк неприменимы.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangesSummary {
    pub is_repo: bool,
    // Самого git в системе нет. Отличается от «папка не репозиторий»: там
    // показывать нечего, а здесь есть что чинить, и пользователь должен об
    // этом узнать, а не гадать, куда пропала панель.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub git_missing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_ref: Option<String>,
    // Куда вернуться с отделённого HEAD: ветка, на которой мы были до этого.
    // Заполняется только при detached HEAD и только если ветка ещё жива.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<i64>,
    pub files: Vec<GitChangedFile>,
}

impl GitChangesSummary {
    fn not_a_repo() -> Self {
        Self {
            is_repo: false,
            git_missing: false,
            branch: None,
            head_hash: None,
            upstream_ref: None,
            previous_branch: None,
            ahead: None,
            behind: None,
            files: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub path: String,
    pub is_binary: bool,
    pub truncated: bool,
    pub diff: String,
}

// Команда git без консольного окна: на Windows каждый дочерний процесс с
// консолью мигает окном, а статус мы гоняем постоянно.
pub(crate) fn git_command() -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    // Машиночитаемые парсеры ниже не должны зависеть от языка ОС. Это также
    // стабилизирует диагностику Git на Windows/macOS/Linux.
    command.env("LC_ALL", "C").env("LANG", "C");
    command
}

pub(crate) fn run_git(root: &Path, args: &[&str]) -> CommandResult<Vec<u8>> {
    run_git_with_env(root, args, &[])
}

fn run_git_with_env(
    root: &Path,
    args: &[&str],
    environment: &[(&str, &str)],
) -> CommandResult<Vec<u8>> {
    let mut command = git_command();
    for (name, value) in environment {
        command.env(name, value);
    }
    let output = command
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| CommandError::new(ErrorCode::GitUnavailable).with_debug(error))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not a git repository") {
            return Err(CommandError::new(ErrorCode::GitNotARepository));
        }
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context(
                "exitCode",
                output
                    .status
                    .code()
                    .map_or_else(|| "signal".to_string(), |code| code.to_string()),
            )
            .with_debug(stderr.chars().take(4096).collect::<String>()));
    }
    Ok(output.stdout)
}

// ---------- Общие проверки репозитория ----------

pub(crate) fn is_safe_hash(hash: &str) -> bool {
    (4..=64).contains(&hash.len()) && hash.chars().all(|ch| ch.is_ascii_hexdigit())
}

pub(crate) fn git_internal_path_exists(root: &Path, name: &str) -> CommandResult<bool> {
    let raw = run_git(root, &["rev-parse", "--git-path", name])?;
    let path = PathBuf::from(String::from_utf8_lossy(&raw).trim().to_owned());
    Ok(if path.is_absolute() {
        path.exists()
    } else {
        root.join(path).exists()
    })
}

pub(crate) fn repository_operation_in_progress(root: &Path) -> CommandResult<bool> {
    Ok(git_internal_path_exists(root, "MERGE_HEAD")?
        || git_internal_path_exists(root, "CHERRY_PICK_HEAD")?
        || git_internal_path_exists(root, "REVERT_HEAD")?
        || git_internal_path_exists(root, "REBASE_HEAD")?
        || git_internal_path_exists(root, "rebase-merge")?
        || git_internal_path_exists(root, "rebase-apply")?
        || git_internal_path_exists(root, "sequencer")?)
}

// ---------- Парсер `git status --porcelain=v2 --branch -z` ----------

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedStatus {
    pub branch: Option<String>,
    pub head_hash: Option<String>,
    pub upstream_ref: Option<String>,
    pub ahead: Option<i64>,
    pub behind: Option<i64>,
    // (path, status, orig_path)
    pub entries: Vec<(String, &'static str, Option<String>)>,
}

fn status_from_xy(xy: &str) -> &'static str {
    let staged = xy.as_bytes().first().copied().unwrap_or(b'.');
    let worktree = xy.as_bytes().get(1).copied().unwrap_or(b'.');
    if staged == b'A' && worktree != b'D' {
        return "added";
    }
    if staged == b'D' || worktree == b'D' {
        return "deleted";
    }
    if staged == b'R' || worktree == b'R' {
        return "renamed";
    }
    "modified"
}

pub fn parse_porcelain_status(raw: &[u8]) -> ParsedStatus {
    let mut parsed = ParsedStatus::default();
    let mut fields = raw.split(|byte| *byte == 0);
    while let Some(field) = fields.next() {
        if field.is_empty() {
            continue;
        }
        let line = String::from_utf8_lossy(field).into_owned();
        if let Some(header) = line.strip_prefix("# ") {
            if let Some(oid) = header.strip_prefix("branch.oid ") {
                if is_safe_hash(oid) {
                    parsed.head_hash = Some(oid.to_owned());
                }
            } else if let Some(head) = header.strip_prefix("branch.head ") {
                if head != "(detached)" {
                    parsed.branch = Some(head.to_owned());
                }
            } else if let Some(upstream) = header.strip_prefix("branch.upstream ") {
                if !upstream.is_empty() {
                    parsed.upstream_ref = Some(upstream.to_owned());
                }
            } else if let Some(ab) = header.strip_prefix("branch.ab ") {
                for part in ab.split_whitespace() {
                    if let Some(value) = part.strip_prefix('+') {
                        parsed.ahead = value.parse().ok();
                    } else if let Some(value) = part.strip_prefix('-') {
                        parsed.behind = value.parse().ok();
                    }
                }
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("? ") {
            parsed.entries.push((path.to_owned(), "untracked", None));
            continue;
        }
        if line.starts_with("u ") {
            // u XY sub m1 m2 m3 mW h1 h2 h3 path — путь после 10 полей.
            if let Some(path) = nth_field_rest(&line, 10) {
                parsed.entries.push((path.to_owned(), "conflicted", None));
            }
            continue;
        }
        if line.starts_with("1 ") {
            // 1 XY sub mH mI mW hH hI path
            let xy = nth_field(&line, 1).unwrap_or_default();
            if let Some(path) = nth_field_rest(&line, 8) {
                parsed
                    .entries
                    .push((path.to_owned(), status_from_xy(&xy), None));
            }
            continue;
        }
        if line.starts_with("2 ") {
            // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
            let xy = nth_field(&line, 1).unwrap_or_default();
            if let Some(path) = nth_field_rest(&line, 9) {
                let orig = fields
                    .next()
                    .map(|orig| String::from_utf8_lossy(orig).into_owned());
                let status = if xy.contains('R') {
                    "renamed"
                } else {
                    status_from_xy(&xy)
                };
                parsed.entries.push((path.to_owned(), status, orig));
            }
            continue;
        }
    }
    parsed
}

fn nth_field(line: &str, index: usize) -> Option<String> {
    line.split(' ').nth(index).map(str::to_owned)
}

// Хвост строки после `count` полей: путь может содержать пробелы.
fn nth_field_rest(line: &str, count: usize) -> Option<&str> {
    let mut rest = line;
    for _ in 0..count {
        let space = rest.find(' ')?;
        rest = &rest[space + 1..];
    }
    (!rest.is_empty()).then_some(rest)
}

// ---------- Парсер `git diff --numstat -z` ----------

// path -> (additions, deletions); None-ы — бинарный файл.
pub fn parse_numstat(raw: &[u8]) -> Vec<(String, Option<u64>, Option<u64>)> {
    let mut result = Vec::new();
    let mut fields = raw.split(|byte| *byte == 0).peekable();
    while let Some(field) = fields.next() {
        if field.is_empty() {
            continue;
        }
        let line = String::from_utf8_lossy(field);
        let mut parts = line.splitn(3, '\t');
        let additions = parts.next().unwrap_or_default();
        let deletions = parts.next().unwrap_or_default();
        let path_part = parts.next().unwrap_or_default();
        let additions = additions.parse::<u64>().ok();
        let deletions = deletions.parse::<u64>().ok();
        if path_part.is_empty() {
            // Переименование: -z даёт `add\tdel\t\0old\0new\0`.
            let _old = fields.next();
            if let Some(new_path) = fields.next() {
                result.push((
                    String::from_utf8_lossy(new_path).into_owned(),
                    additions,
                    deletions,
                ));
            }
        } else {
            result.push((path_part.to_owned(), additions, deletions));
        }
    }
    result
}

// ---------- Подсчёт строк нового (untracked) файла ----------

// None — файл бинарный или недоступен.
pub fn count_text_lines(bytes: &[u8]) -> Option<u64> {
    let probe = &bytes[..bytes.len().min(8192)];
    if probe.contains(&0) {
        return None;
    }
    if bytes.is_empty() {
        return Some(0);
    }
    let newlines = bytes.iter().filter(|byte| **byte == b'\n').count() as u64;
    Some(if bytes.ends_with(b"\n") {
        newlines
    } else {
        newlines + 1
    })
}

fn untracked_line_count(root: &Path, path: &str) -> Option<u64> {
    let full = root.join(path);
    let metadata = std::fs::metadata(&full).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_UNTRACKED_BYTES {
        return None;
    }
    count_text_lines(&std::fs::read(&full).ok()?)
}

// Unified diff нового файла собирается вручную: git не показывает untracked.
pub fn synthesize_added_diff(path: &str, content: &str) -> String {
    let lines: Vec<&str> = if content.is_empty() {
        Vec::new()
    } else {
        content.trim_end_matches('\n').split('\n').collect()
    };
    let mut diff = format!(
        "--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n",
        lines.len()
    );
    for line in &lines {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    diff
}

// ---------- Сборка сводки ----------

pub(crate) fn repo_toplevel(root: &Path) -> CommandResult<Option<PathBuf>> {
    match run_git(root, &["rev-parse", "--show-toplevel"]) {
        Ok(stdout) => {
            let path = String::from_utf8_lossy(&stdout).trim().to_owned();
            Ok((!path.is_empty()).then(|| PathBuf::from(path)))
        }
        Err(error) if error.code == ErrorCode::GitNotARepository => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn collect_summary(root: &Path) -> CommandResult<GitChangesSummary> {
    let toplevel = match repo_toplevel(root) {
        Ok(Some(toplevel)) => toplevel,
        Ok(None) => return Ok(GitChangesSummary::not_a_repo()),
        // Отсутствие git — не повод молча спрятать всю панель: возвращаем
        // сводку с признаком, чтобы интерфейс объяснил причину.
        Err(error) if error.code == ErrorCode::GitUnavailable => {
            return Ok(GitChangesSummary {
                git_missing: true,
                ..GitChangesSummary::not_a_repo()
            })
        }
        Err(error) => return Err(error),
    };

    let status_raw = run_git(
        &toplevel,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ],
    )?;
    let status = parse_porcelain_status(&status_raw);

    // Счётчики строк относительно HEAD (staged + unstaged разом); в пустом
    // репозитории HEAD ещё нет — тогда сравниваем индекс с рабочим деревом.
    let numstat_raw = run_git(&toplevel, &["diff", "--numstat", "-z", "HEAD"])
        .or_else(|_| run_git(&toplevel, &["diff", "--numstat", "-z"]))?;
    let mut counts = std::collections::HashMap::new();
    for (path, additions, deletions) in parse_numstat(&numstat_raw) {
        counts.insert(path, (additions, deletions));
    }

    let mut files: Vec<GitChangedFile> = status
        .entries
        .into_iter()
        .map(|(path, file_status, orig_path)| {
            let (additions, deletions) = if file_status == "untracked" {
                (untracked_line_count(&toplevel, &path), Some(0))
            } else {
                counts.get(&path).copied().unwrap_or((Some(0), Some(0)))
            };
            GitChangedFile {
                path,
                status: file_status,
                orig_path,
                additions,
                deletions,
            }
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));

    // На отделённом HEAD подсказываем, куда вернуться: `@{-1}` — предыдущий
    // checkout. Если это была не ветка или её уже удалили, подсказки нет.
    let previous_branch = status.branch.is_none().then(|| {
        run_git(&toplevel, &["rev-parse", "--symbolic-full-name", "@{-1}"])
            .ok()
            .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())
            .and_then(|reference| {
                reference
                    .strip_prefix("refs/heads/")
                    .map(str::to_owned)
                    .filter(|name| local_branch_exists(&toplevel, name))
            })
    });

    Ok(GitChangesSummary {
        is_repo: true,
        git_missing: false,
        branch: status.branch,
        head_hash: status.head_hash,
        upstream_ref: status.upstream_ref,
        previous_branch: previous_branch.flatten(),
        ahead: status.ahead,
        behind: status.behind,
        files,
    })
}

pub(crate) fn is_safe_repo_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('-')
        && !path.contains('\\')
        && !path.split('/').any(|part| part == "..")
        && path.len() <= 4096
}

pub fn collect_file_diff(root: &Path, path: &str) -> CommandResult<GitFileDiff> {
    if !is_safe_repo_path(path) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("path", path));
    }
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };

    // Известен ли путь git-у: для untracked файла diff собирается вручную.
    let tracked = run_git(&toplevel, &["ls-files", "--error-unmatch", "--", path]).is_ok();
    let raw = if tracked {
        run_git(&toplevel, &["diff", "HEAD", "--", path])
            .or_else(|_| run_git(&toplevel, &["diff", "--", path]))?
    } else {
        let full = toplevel.join(path);
        let bytes = std::fs::read(&full)
            .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?;
        if count_text_lines(&bytes).is_none() {
            return Ok(GitFileDiff {
                path: path.to_owned(),
                is_binary: true,
                truncated: false,
                diff: String::new(),
            });
        }
        synthesize_added_diff(path, &String::from_utf8_lossy(&bytes)).into_bytes()
    };

    Ok(diff_payload(path, &raw, tracked))
}

// Общая упаковка вывода `git diff`: отметка бинарника и обрезка по размеру.
// `detect_binary` выключается для собранного вручную диффа нового файла — там
// строка «Binary files» могла бы прийти из самого содержимого.
pub(crate) fn diff_payload(path: &str, raw: &[u8], detect_binary: bool) -> GitFileDiff {
    let is_binary = detect_binary
        && String::from_utf8_lossy(&raw[..raw.len().min(4096)]).contains("Binary files ");
    let truncated = raw.len() > MAX_DIFF_BYTES;
    let clipped = if truncated {
        // Режем по границе строки, чтобы не рвать UTF-8 и разметку диффа.
        let cut = raw[..MAX_DIFF_BYTES]
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(MAX_DIFF_BYTES, |position| position + 1);
        &raw[..cut]
    } else {
        raw
    };

    GitFileDiff {
        path: path.to_owned(),
        is_binary,
        truncated,
        diff: String::from_utf8_lossy(clipped).into_owned(),
    }
}

// ---------- Правка файла в панели ----------

// Файлы крупнее в редактор не грузим и не сохраняем — не текстовый сценарий.
const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_WRITE_BYTES: usize = 5 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileContent {
    pub content: String,
    pub is_binary: bool,
    pub too_large: bool,
    // Файл существует на диске (удалённый откроется пустым — сохранение
    // воссоздаст его).
    pub exists: bool,
}

pub fn read_repo_file(root: &Path, path: &str) -> CommandResult<GitFileContent> {
    if !is_safe_repo_path(path) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("path", path));
    }
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    let full = toplevel.join(path);
    let metadata = match std::fs::metadata(&full) {
        Ok(metadata) => metadata,
        Err(_) => {
            return Ok(GitFileContent {
                content: String::new(),
                is_binary: false,
                too_large: false,
                exists: false,
            });
        }
    };
    if !metadata.is_file() {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("path", path));
    }
    if metadata.len() > MAX_EDIT_BYTES {
        return Ok(GitFileContent {
            content: String::new(),
            is_binary: false,
            too_large: true,
            exists: true,
        });
    }
    let bytes = std::fs::read(&full)
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?;
    if count_text_lines(&bytes).is_none() {
        return Ok(GitFileContent {
            content: String::new(),
            is_binary: true,
            too_large: false,
            exists: true,
        });
    }
    Ok(GitFileContent {
        content: String::from_utf8_lossy(&bytes).into_owned(),
        is_binary: false,
        too_large: false,
        exists: true,
    })
}

pub fn write_repo_file(root: &Path, path: &str, content: &str) -> CommandResult<()> {
    if !is_safe_repo_path(path) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("path", path));
    }
    if content.len() > MAX_WRITE_BYTES {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "too-large")
        );
    }
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    let full = toplevel.join(path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?;
    }
    std::fs::write(&full, content)
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?;
    Ok(())
}

#[tauri::command]
pub async fn git_read_file(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    path: String,
) -> CommandResult<GitFileContent> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || read_repo_file(&root, &path))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[tauri::command]
pub async fn git_write_file(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    path: String,
    content: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || write_repo_file(&root, &path, &content))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

// ---------- Действия: коммит и откат файла ----------

pub(crate) const MAX_COMMIT_MESSAGE_CHARS: usize = 4000;

pub fn commit_all(root: &Path, message: &str) -> CommandResult<()> {
    commit_all_with_identity(root, message, None)
}

fn commit_all_with_identity(
    root: &Path,
    message: &str,
    identity: Option<&GithubCommitIdentity>,
) -> CommandResult<()> {
    let message = message.trim();
    if message.is_empty() || message.chars().count() > MAX_COMMIT_MESSAGE_CHARS {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "message")
        );
    }
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    run_git(&toplevel, &["add", "-A"])?;
    if let Some(identity) = identity {
        let environment = [
            ("GIT_AUTHOR_NAME", identity.name.as_str()),
            ("GIT_AUTHOR_EMAIL", identity.email.as_str()),
            ("GIT_COMMITTER_NAME", identity.name.as_str()),
            ("GIT_COMMITTER_EMAIL", identity.email.as_str()),
        ];
        run_git_with_env(&toplevel, &["commit", "-m", message], &environment)?;
    } else {
        run_git(&toplevel, &["commit", "-m", message])?;
    }
    Ok(())
}

// Возвращает файл к состоянию HEAD; новые файлы удаляются. Подтверждение —
// на фронтенде, команда выполняет уже принятое решение. Для переименованного
// файла orig_path указывает старое имя: оно восстанавливается из HEAD.
pub fn revert_file(root: &Path, path: &str, orig_path: Option<&str>) -> CommandResult<()> {
    if !is_safe_repo_path(path) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("path", path));
    }
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    if let Some(orig) = orig_path {
        if is_safe_repo_path(orig) {
            run_git(&toplevel, &["checkout", "HEAD", "--", orig])?;
        }
    }
    let in_head = run_git(&toplevel, &["ls-tree", "HEAD", "--", path])
        .map(|stdout| !stdout.is_empty())
        .unwrap_or(false);
    if in_head {
        run_git(&toplevel, &["checkout", "HEAD", "--", path])?;
        return Ok(());
    }
    let tracked = run_git(&toplevel, &["ls-files", "--error-unmatch", "--", path]).is_ok();
    if tracked {
        // Добавлен в индекс, но не в HEAD: убираем и из индекса, и с диска.
        run_git(&toplevel, &["rm", "-fq", "--", path])?;
        return Ok(());
    }
    std::fs::remove_file(toplevel.join(path))
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?;
    Ok(())
}

#[tauri::command]
pub async fn git_commit(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    message: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    let identity = github_commit_identity(&app);
    tauri::async_runtime::spawn_blocking(move || match identity.as_ref() {
        Some(identity) => commit_all_with_identity(&root, &message, Some(identity)),
        None => commit_all(&root, &message),
    })
    .await
    .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[tauri::command]
pub async fn git_revert_file(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    path: String,
    orig_path: Option<String>,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || revert_file(&root, &path, orig_path.as_deref()))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

// ---------- Реал-тайм: вотчер рабочего дерева ----------

// Событие внутри .git интересно только когда меняется состояние репозитория
// (индекс, HEAD, ветки) — журнал и объекты git status не меняют.
pub fn is_relevant_event_path(repo_root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(repo_root) else {
        return true; // событие вне корня — перестрахуемся и проверим
    };
    let mut components = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned());
    let Some(first) = components.next() else {
        return true;
    };
    if first != ".git" {
        return true;
    }
    match components.next().as_deref() {
        Some("index") | Some("HEAD") | Some("refs") => true,
        _ => false,
    }
}

struct GitWatchHandle {
    // Drop наблюдателя закрывает канал — поток дебаунса завершается сам.
    _watcher: notify::RecommendedWatcher,
}

#[derive(Default)]
pub struct GitWatchState {
    watchers: std::sync::Mutex<std::collections::HashMap<String, GitWatchHandle>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitChangesEvent<'a> {
    workspace_id: &'a str,
    summary: &'a GitChangesSummary,
}

const DEBOUNCE_MS: u64 = 300;

fn spawn_watch(
    app: tauri::AppHandle,
    workspace_id: String,
    root: PathBuf,
) -> Result<GitWatchHandle, notify::Error> {
    use notify::Watcher;

    let (event_sender, event_receiver) = std::sync::mpsc::channel::<()>();
    let filter_root = root.clone();
    let mut watcher =
        notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            let Ok(event) = event else {
                return;
            };
            if event
                .paths
                .iter()
                .any(|path| is_relevant_event_path(&filter_root, path))
            {
                let _ = event_sender.send(());
            }
        })?;
    watcher.watch(&root, notify::RecursiveMode::Recursive)?;

    std::thread::spawn(move || {
        let mut last_key: Option<String> = None;
        loop {
            match event_receiver.recv() {
                Ok(()) => {
                    // Тихое окно: серия событий (npm install, генерация кода)
                    // схлопывается в один прогон git status.
                    while event_receiver
                        .recv_timeout(std::time::Duration::from_millis(DEBOUNCE_MS))
                        .is_ok()
                    {}
                    let Ok(summary) = collect_summary(&root) else {
                        continue;
                    };
                    let key = serde_json::to_string(&summary).unwrap_or_default();
                    if last_key.as_deref() == Some(key.as_str()) {
                        continue;
                    }
                    last_key = Some(key);
                    use tauri::Emitter;
                    let _ = app.emit(
                        "git-changes",
                        GitChangesEvent {
                            workspace_id: &workspace_id,
                            summary: &summary,
                        },
                    );
                }
                // Вотчер удалён (unwatch/выход) — отправитель закрыт.
                Err(_) => break,
            }
        }
    });

    Ok(GitWatchHandle { _watcher: watcher })
}

// Возвращает false, если вотчер поднять не удалось (например, лимит inotify
// на гигантском дереве) — фронтенд остаётся на поллинге.
#[tauri::command]
pub fn git_changes_watch(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    roots: tauri::State<'_, WorkspaceRoots>,
    state: tauri::State<'_, GitWatchState>,
    workspace_id: String,
) -> CommandResult<bool> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    let mut watchers = state
        .watchers
        .lock()
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?;
    if watchers.contains_key(&workspace_id) {
        return Ok(true);
    }
    match spawn_watch(app, workspace_id.clone(), root) {
        Ok(handle) => {
            watchers.insert(workspace_id, handle);
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub fn git_changes_unwatch(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, GitWatchState>,
    workspace_id: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    if let Ok(mut watchers) = state.watchers.lock() {
        watchers.remove(&workspace_id);
    }
    Ok(())
}

// ---------- Команды ----------

#[tauri::command]
pub async fn git_changes_summary(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
) -> CommandResult<GitChangesSummary> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || collect_summary(&root))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[tauri::command]
pub async fn git_file_diff(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    path: String,
) -> CommandResult<GitFileDiff> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || collect_file_diff(&root, &path))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[cfg(test)]
mod tests {
    use super::*;
    // Часть проверок относится к вертикалям веток и истории — они в своих
    // модулях, а тесты пока живут здесь одним набором.
    use crate::git_branches::*;
    use crate::git_history::*;

    #[test]
    fn parses_branch_and_counts_from_porcelain() {
        let raw = b"# branch.oid 1111111111111111111111111111111111111111\0# branch.head main\0# branch.upstream fork/cache/dev\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 abc def src/app.ts\0\
1 A. N... 000000 100644 100644 000 def new file.txt\0\
? untracked.md\0";
        let parsed = parse_porcelain_status(raw);
        assert_eq!(parsed.branch.as_deref(), Some("main"));
        assert_eq!(
            parsed.head_hash.as_deref(),
            Some("1111111111111111111111111111111111111111")
        );
        assert_eq!(parsed.upstream_ref.as_deref(), Some("fork/cache/dev"));
        assert_eq!(parsed.ahead, Some(2));
        assert_eq!(parsed.behind, Some(1));
        assert_eq!(
            parsed.entries,
            vec![
                ("src/app.ts".to_owned(), "modified", None),
                // Путь с пробелом не режется.
                ("new file.txt".to_owned(), "added", None),
                ("untracked.md".to_owned(), "untracked", None),
            ]
        );
    }

    #[test]
    fn parses_renames_and_conflicts() {
        let raw = b"2 R. N... 100644 100644 100644 abc def R100 new/name.rs\0old/name.rs\0\
u UU N... 100644 100644 100644 100644 a b c conflicted.rs\0\
1 .D N... 100644 100644 000000 abc def gone.rs\0";
        let parsed = parse_porcelain_status(raw);
        assert_eq!(
            parsed.entries,
            vec![
                (
                    "new/name.rs".to_owned(),
                    "renamed",
                    Some("old/name.rs".to_owned())
                ),
                ("conflicted.rs".to_owned(), "conflicted", None),
                ("gone.rs".to_owned(), "deleted", None),
            ]
        );
    }

    #[test]
    fn parses_numstat_with_binary_and_rename() {
        let raw = b"12\t3\tsrc/app.ts\0-\t-\tlogo.png\05\t0\t\0old.rs\0new.rs\0";
        assert_eq!(
            parse_numstat(raw),
            vec![
                ("src/app.ts".to_owned(), Some(12), Some(3)),
                ("logo.png".to_owned(), None, None),
                ("new.rs".to_owned(), Some(5), Some(0)),
            ]
        );
    }

    #[test]
    fn counts_lines_and_detects_binary() {
        assert_eq!(count_text_lines(b""), Some(0));
        assert_eq!(count_text_lines(b"one\ntwo\n"), Some(2));
        assert_eq!(count_text_lines(b"one\ntwo"), Some(2));
        assert_eq!(count_text_lines(b"bin\0ary"), None);
    }

    #[test]
    fn synthesizes_a_unified_diff_for_new_files() {
        let diff = synthesize_added_diff("a.txt", "one\ntwo\n");
        assert_eq!(
            diff,
            "--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n"
        );
        assert_eq!(
            synthesize_added_diff("empty.txt", ""),
            "--- /dev/null\n+++ b/empty.txt\n@@ -0,0 +1,0 @@\n"
        );
    }

    #[test]
    fn filters_git_internals_from_watch_events() {
        let root = Path::new("/repo");
        assert!(is_relevant_event_path(root, Path::new("/repo/src/app.ts")));
        assert!(is_relevant_event_path(root, Path::new("/repo/.git/index")));
        assert!(is_relevant_event_path(root, Path::new("/repo/.git/HEAD")));
        assert!(is_relevant_event_path(
            root,
            Path::new("/repo/.git/refs/heads/main")
        ));
        assert!(!is_relevant_event_path(
            root,
            Path::new("/repo/.git/objects/ab/cdef")
        ));
        assert!(!is_relevant_event_path(
            root,
            Path::new("/repo/.git/logs/HEAD")
        ));
    }

    #[test]
    fn rejects_unsafe_diff_paths() {
        assert!(is_safe_repo_path("src/app.ts"));
        assert!(is_safe_repo_path("new file.txt"));
        assert!(!is_safe_repo_path("/etc/passwd"));
        assert!(!is_safe_repo_path("../outside"));
        assert!(!is_safe_repo_path("nested/../../outside"));
        assert!(!is_safe_repo_path("-rf"));
        assert!(!is_safe_repo_path(""));
    }

    #[test]
    fn summary_walks_a_real_repository() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(status.status.success(), "git {args:?} failed");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("tracked.txt"), "one\ntwo\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);

        std::fs::write(root.join("tracked.txt"), "one\nTWO\nthree\n").unwrap();
        std::fs::write(root.join("fresh.txt"), "hello\n").unwrap();

        let summary = collect_summary(root).unwrap();
        assert!(summary.is_repo);
        assert_eq!(summary.branch.as_deref(), Some("main"));
        assert_eq!(summary.files.len(), 2);
        let fresh = &summary.files[0];
        assert_eq!(
            (fresh.path.as_str(), fresh.status),
            ("fresh.txt", "untracked")
        );
        assert_eq!(fresh.additions, Some(1));
        let tracked = &summary.files[1];
        assert_eq!(
            (tracked.path.as_str(), tracked.status),
            ("tracked.txt", "modified")
        );
        assert_eq!(tracked.additions, Some(2));
        assert_eq!(tracked.deletions, Some(1));

        let diff = collect_file_diff(root, "tracked.txt").unwrap();
        assert!(diff.diff.contains("+TWO"));
        assert!(diff.diff.contains("-two"));
        let fresh_diff = collect_file_diff(root, "fresh.txt").unwrap();
        assert!(fresh_diff.diff.contains("+hello"));

        // Git's default porcelain output collapses a wholly-untracked directory
        // to `directory/`. The panel needs actual files so diff and revert keep
        // their file semantics instead of trying to read/remove a directory.
        std::fs::create_dir_all(root.join("nested/deep")).unwrap();
        std::fs::write(root.join("nested/deep/new.txt"), "inside\n").unwrap();
        let nested_summary = collect_summary(root).unwrap();
        let nested = nested_summary
            .files
            .iter()
            .find(|file| file.path == "nested/deep/new.txt")
            .expect("nested untracked file must not be collapsed to a directory");
        assert_eq!(nested.status, "untracked");
        assert_eq!(nested.additions, Some(1));
        assert!(collect_file_diff(root, &nested.path)
            .unwrap()
            .diff
            .contains("+inside"));
        revert_file(root, &nested.path, None).unwrap();
        assert!(!root.join("nested/deep/new.txt").exists());

        // Папка без git — не ошибка, а «не репозиторий».
        let plain = tempfile::tempdir().unwrap();
        let empty = collect_summary(plain.path()).unwrap();
        assert!(!empty.is_repo);
    }

    #[test]
    fn splits_co_authors_from_the_body() {
        let (body, co_authors) = split_body_and_co_authors(
            "Long description line.\n\nCo-authored-by: Alex <a@t>\nCo-Authored-By: Kim <k@t>",
        );
        assert_eq!(body, "Long description line.");
        assert_eq!(
            co_authors,
            vec!["Alex <a@t>".to_owned(), "Kim <k@t>".to_owned()]
        );
        let (empty_body, none) = split_body_and_co_authors("");
        assert_eq!(empty_body, "");
        assert!(none.is_empty());

        let quoted = "Example:\nCo-authored-by: Not A Trailer <example@t>\nThis prose follows it.";
        let (quoted_body, quoted_authors) = split_body_and_co_authors(quoted);
        assert_eq!(quoted_body, quoted);
        assert!(quoted_authors.is_empty());

        let mixed = "Description.\n\nCo-authored-by: Alex <a@t>\nSigned-off-by: Sam <s@t>\nReviewed-by: Pat <p@t>\nco-authored-by: Kim <k@t>";
        let (mixed_body, mixed_authors) = split_body_and_co_authors(mixed);
        assert_eq!(
            mixed_body,
            "Description.\n\nSigned-off-by: Sam <s@t>\nReviewed-by: Pat <p@t>"
        );
        assert_eq!(
            mixed_authors,
            vec!["Alex <a@t>".to_owned(), "Kim <k@t>".to_owned()]
        );
    }

    #[test]
    fn keeps_same_named_local_remote_and_tag_refs_distinct() {
        let (is_head, refs) = parse_commit_refs(
            "HEAD -> refs/heads/origin/topic, refs/remotes/origin/topic, tag: refs/tags/origin/topic",
        );
        assert!(is_head);
        assert_eq!(
            refs,
            vec![
                GitCommitRef {
                    name: "origin/topic".to_owned(),
                    full_name: "refs/heads/origin/topic".to_owned(),
                    kind: "local".to_owned(),
                },
                GitCommitRef {
                    name: "origin/topic".to_owned(),
                    full_name: "refs/remotes/origin/topic".to_owned(),
                    kind: "remote".to_owned(),
                },
                GitCommitRef {
                    name: "origin/topic".to_owned(),
                    full_name: "refs/tags/origin/topic".to_owned(),
                    kind: "tag".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn validates_branch_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for valid in ["main", "feature/agent-resume", "v1.2.3", "@", "задача"] {
            assert!(validate_branch_name(root, valid).is_ok(), "{valid}");
        }
        for invalid in [
            "",
            "-rf",
            "HEAD",
            "a//b",
            "a/",
            "a/.hidden",
            "a..b",
            "bad name",
            "head@{1}",
            "@{-1}",
            "x.lock",
        ] {
            assert!(validate_branch_name(root, invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn branch_config_entries_match_dotted_branch_names_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["config", "branch.foo.remote", "origin"]);
        git(&["config", "branch.foo.bar.remote", "upstream"]);

        assert_eq!(
            branch_config_entries(root, "foo").unwrap(),
            vec![("branch.foo.remote".to_owned(), "origin".to_owned())]
        );
        assert_eq!(
            branch_config_entries(root, "foo.bar").unwrap(),
            vec![("branch.foo.bar.remote".to_owned(), "upstream".to_owned())]
        );

        cleanup_branch_config(root, "foo").unwrap();
        assert!(branch_config_entries(root, "foo").unwrap().is_empty());
        assert_eq!(
            branch_config_entries(root, "foo.bar").unwrap(),
            vec![("branch.foo.bar.remote".to_owned(), "upstream".to_owned())],
            "cleanup ветки foo не должен удалять config ветки foo.bar"
        );
    }

    #[test]
    fn lists_branches_and_history_in_a_real_repository() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "Denis")
                .env("GIT_AUTHOR_EMAIL", "d@t")
                .env("GIT_COMMITTER_NAME", "Denis")
                .env("GIT_COMMITTER_EMAIL", "d@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first commit"]);
        git(&["checkout", "--quiet", "-b", "feature/x"]);
        std::fs::write(root.join("b.txt"), "two\n").unwrap();
        git(&["add", "."]);
        git(&[
            "commit",
            "--quiet",
            "-m",
            "second commit",
            "-m",
            "Detailed description of the change.\n\nCo-authored-by: Alex <alex@t>",
        ]);

        let branches = list_branches(root).unwrap();
        assert_eq!(branches.len(), 2);
        let current = branches.iter().find(|branch| branch.is_current).unwrap();
        assert_eq!(current.name, "feature/x");
        assert!(current.last_commit_at.is_some());

        let log = list_log_unfiltered(root, 10, false).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].subject, "second commit");
        // Верхушка текущей ветки помечена как HEAD, предок — нет.
        assert!(log[0].is_head);
        assert!(!log[1].is_head);
        assert_eq!(log[0].author, "Denis");
        assert_eq!(log[0].author_email, "d@t");
        assert_eq!(log[0].body, "Detailed description of the change.");
        assert_eq!(
            log[0].full_message,
            "second commit\n\nDetailed description of the change.\n\nCo-authored-by: Alex <alex@t>"
        );
        assert_eq!(log[0].co_authors, vec!["Alex <alex@t>".to_owned()]);
        assert!(log[0].epoch_ms > 0);
        assert!(log[0].refs.iter().any(|entry| entry == "feature/x"));
        // Родитель второго коммита — первый (для графа веток).
        assert_eq!(log[0].parents, vec![log[1].hash.clone()]);
        // Однострочный коммит: без тела и соавторов.
        assert_eq!(log[1].body, "");
        assert!(log[1].co_authors.is_empty());
        // Корневой коммит без родителей.
        assert!(log[1].parents.is_empty());

        // Файлы конкретного коммита: b.txt добавлен вторым коммитом.
        let files = list_commit_files(root, &log[0].hash).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "b.txt");
        assert_eq!(files[0].additions, Some(1));
        assert!(list_commit_files(root, "not-a-hash").is_err());

        // Diff файла из коммита — для просмотра истории по строкам.
        let patch = commit_file_diff(root, &log[0].hash, "b.txt").unwrap();
        assert!(patch.diff.contains("+two"), "{}", patch.diff);
        assert!(!patch.is_binary);
        // Корневой коммит родителя не имеет, но показываться обязан.
        let first = commit_file_diff(root, &log[1].hash, "a.txt").unwrap();
        assert!(first.diff.contains("@@"), "{}", first.diff);
        assert!(commit_file_diff(root, "not-a-hash", "b.txt").is_err());
        assert!(commit_file_diff(root, &log[0].hash, "../escape").is_err());

        switch_branch(root, "main", "local").unwrap();
        let branches = list_branches(root).unwrap();
        assert_eq!(
            branches
                .iter()
                .find(|branch| branch.is_current)
                .unwrap()
                .name,
            "main"
        );
        assert!(switch_branch(root, "no-such-branch", "local").is_err());

        // Ветка и тег с одинаковым именем разрешаются строго по типу ref.
        let first_hash = log[1].hash.clone();
        let second_hash = log[0].hash.clone();
        git(&["branch", "collision", &first_hash]);
        git(&["tag", "collision", &second_hash]);
        switch_branch(root, "collision", "tag").unwrap();
        assert_eq!(
            String::from_utf8_lossy(&run_git(root, &["rev-parse", "HEAD"]).unwrap()).trim(),
            second_hash
        );
        assert!(run_git(root, &["symbolic-ref", "--quiet", "HEAD"]).is_err());
        switch_branch(root, "collision", "local").unwrap();
        assert_eq!(
            collect_summary(root).unwrap().branch.as_deref(),
            Some("collision")
        );
        assert_eq!(
            String::from_utf8_lossy(&run_git(root, &["rev-parse", "HEAD"]).unwrap()).trim(),
            first_hash
        );
        switch_branch(root, "main", "local").unwrap();
        git(&["branch", "-D", "collision"]);
        let before_missing_local =
            String::from_utf8_lossy(&run_git(root, &["rev-parse", "HEAD"]).unwrap())
                .trim()
                .to_owned();
        assert!(switch_branch(root, "collision", "local").is_err());
        assert_eq!(
            collect_summary(root).unwrap().branch.as_deref(),
            Some("main")
        );
        assert_eq!(
            String::from_utf8_lossy(&run_git(root, &["rev-parse", "HEAD"]).unwrap()).trim(),
            before_missing_local
        );

        // Ветка только на «сервере» (bare-репозиторий): попадает в список с
        // пометкой is_remote, переключение создаёт локальную со слежением.
        let remote_dir = tempfile::tempdir().unwrap();
        let bare = Command::new("git")
            .args(["init", "--bare", "--quiet"])
            .current_dir(remote_dir.path())
            .output()
            .unwrap();
        assert!(bare.status.success());
        git(&[
            "remote",
            "add",
            "origin",
            remote_dir.path().to_str().unwrap(),
        ]);
        git(&["push", "--quiet", "origin", "main", "feature/x"]);
        git(&["remote", "set-head", "origin", "main"]);
        git(&["branch", "-D", "feature/x"]);

        let decorated = list_log_unfiltered(root, 10, false).unwrap();
        assert!(decorated
            .iter()
            .all(|commit| !commit.refs.iter().any(|name| name == "origin/HEAD")));
        assert!(decorated
            .iter()
            .all(|commit| !commit.remote_refs.iter().any(|name| name == "origin/HEAD")));

        let branches = list_branches(root).unwrap();
        let remote_only = branches
            .iter()
            .find(|branch| branch.name == "origin/feature/x")
            .expect("remote-only branch listed");
        assert!(remote_only.is_remote);
        // main существует локально — origin/main дублем не показывается.
        assert!(!branches.iter().any(|branch| branch.name == "origin/main"));

        switch_branch(root, "refs/remotes/origin/feature/x", "remote").unwrap();
        let branches = list_branches(root).unwrap();
        assert_eq!(
            branches
                .iter()
                .find(|branch| branch.is_current)
                .unwrap()
                .name,
            "feature/x"
        );

        // Кто-то запушил в main с другой машины: fetch обновляет refs/remotes,
        // и статус показывает отставание (стрелка ↓ в панели).
        switch_branch(root, "main", "local").unwrap();
        let run_at = |dir: &Path, args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(dir)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed");
        };
        run_at(root, &["branch", "--set-upstream-to=origin/main", "main"]);
        let clone_dir = tempfile::tempdir().unwrap();
        let clone_path = clone_dir.path().join("clone");
        run_at(
            clone_dir.path(),
            &[
                "clone",
                "--quiet",
                "--branch",
                "main",
                remote_dir.path().to_str().unwrap(),
                clone_path.to_str().unwrap(),
            ],
        );
        std::fs::write(clone_path.join("c.txt"), "three\n").unwrap();
        run_at(&clone_path, &["add", "."]);
        run_at(
            &clone_path,
            &["commit", "--quiet", "-m", "from another machine"],
        );
        run_at(&clone_path, &["push", "--quiet", "origin", "main"]);

        fetch_upstream(root).unwrap();
        let summary = collect_summary(root).unwrap();
        assert_eq!(summary.behind, Some(1));

        // Вливаем feature/x в main: ветка получает пометку «влита», а
        // merge-коммит — «не запушен» (его нет на origin/main).
        run_at(root, &["merge", "--quiet", "--no-edit", "feature/x"]);
        let branches = list_branches(root).unwrap();
        let feature = branches
            .iter()
            .find(|branch| branch.name == "feature/x")
            .unwrap();
        assert!(feature.is_merged);
        let main = branches
            .iter()
            .find(|branch| branch.name == "main")
            .unwrap();
        assert!(!main.is_merged); // текущая ветка не помечается

        let log = list_log_unfiltered(root, 10, false).unwrap();
        assert!(log[0].unpushed, "свежий merge ещё не на сервере");
        let pushed_first = log
            .iter()
            .find(|commit| commit.subject == "first commit")
            .unwrap();
        assert!(!pushed_first.unpushed, "запушенный коммит без пометки");

        // Пустой репозиторий: история пуста, а не ошибка.
        let fresh = tempfile::tempdir().unwrap();
        let init = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(fresh.path())
            .output()
            .unwrap();
        assert!(init.status.success());
        assert!(list_log_unfiltered(fresh.path(), 10, false)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn tracks_remote_refs_through_custom_fetch_refspecs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["commit", "--quiet", "--allow-empty", "-m", "base"]);

        let remote = tempfile::tempdir().unwrap();
        let init = Command::new("git")
            .args(["init", "--bare", "--quiet"])
            .current_dir(remote.path())
            .output()
            .unwrap();
        assert!(init.status.success());
        git(&[
            "remote",
            "add",
            "team/platform",
            remote.path().to_str().unwrap(),
        ]);
        git(&["push", "--quiet", "team/platform", "main:topic"]);
        git(&["config", "--unset-all", "remote.team/platform.fetch"]);
        git(&[
            "config",
            "--add",
            "remote.team/platform.fetch",
            "+refs/heads/*:refs/remotes/cache/*",
        ]);
        git(&["fetch", "--quiet", "team/platform"]);

        let branches = list_branches(root).unwrap();
        let remote_only = branches
            .iter()
            .find(|branch| branch.ref_name == "refs/remotes/cache/topic")
            .expect("custom remote ref is listed");
        assert_eq!(remote_only.name, "cache/topic");
        assert!(remote_only.is_remote);

        switch_branch(root, &remote_only.ref_name, "remote").unwrap();
        assert_eq!(
            collect_summary(root).unwrap().branch.as_deref(),
            Some("topic")
        );
        assert_eq!(
            String::from_utf8_lossy(&run_git(root, &["config", "branch.topic.remote"]).unwrap())
                .trim(),
            "team/platform"
        );
        assert_eq!(
            String::from_utf8_lossy(&run_git(root, &["config", "branch.topic.merge"]).unwrap())
                .trim(),
            "refs/heads/topic"
        );
    }

    #[test]
    fn pending_config_cleanup_blocks_every_app_branch_creation_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["commit", "--quiet", "--allow-empty", "-m", "base"]);
        let head = String::from_utf8_lossy(&run_git(root, &["rev-parse", "HEAD"]).unwrap())
            .trim()
            .to_owned();

        let remote = tempfile::tempdir().unwrap();
        let init = Command::new("git")
            .args(["init", "--bare", "--quiet"])
            .current_dir(remote.path())
            .output()
            .unwrap();
        assert!(init.status.success());
        git(&["remote", "add", "origin", remote.path().to_str().unwrap()]);
        git(&["push", "--quiet", "origin", "main:pending"]);
        git(&["fetch", "--quiet", "origin"]);
        git(&["config", "branch.pending.remote", "stale"]);
        queue_branch_config_cleanup(root, "pending").unwrap();
        let config_lock = root.join(".git/config.lock");
        std::fs::write(&config_lock, "held\n").unwrap();

        assert!(commit_action(root, "branch", &head, Some("pending")).is_err());
        assert!(!local_branch_exists(root, "pending"));
        assert!(switch_branch(root, "refs/remotes/origin/pending", "remote").is_err());
        assert!(!local_branch_exists(root, "pending"));
        assert_eq!(
            String::from_utf8_lossy(&run_git(root, &["rev-parse", "HEAD"]).unwrap()).trim(),
            head
        );

        std::fs::remove_file(config_lock).unwrap();
        switch_branch(root, "refs/remotes/origin/pending", "remote").unwrap();
        assert_eq!(
            collect_summary(root).unwrap().branch.as_deref(),
            Some("pending")
        );
        assert!(pending_branch_cleanups(root).unwrap().is_empty());
        assert_eq!(
            String::from_utf8_lossy(&run_git(root, &["config", "branch.pending.remote"]).unwrap())
                .trim(),
            "origin"
        );
    }

    #[test]
    fn config_cleanup_markers_are_shared_between_linked_worktrees() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["commit", "--quiet", "--allow-empty", "-m", "base"]);
        git(&["branch", "doomed"]);
        git(&["config", "branch.doomed.remote", "origin"]);
        let doomed_tip = local_branch_tip(root, "doomed").unwrap();
        let linked_dir = tempfile::tempdir().unwrap();
        let linked = linked_dir.path().join("linked");
        git(&[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "linked",
            linked.to_str().unwrap(),
        ]);

        let config_lock = root.join(".git/config.lock");
        std::fs::write(&config_lock, "held\n").unwrap();
        delete_branch(&linked, "doomed", true, &doomed_tip).unwrap();
        assert!(pending_branch_cleanups(&linked)
            .unwrap()
            .iter()
            .any(|(_, name)| name == "doomed"));
        assert!(pending_branch_cleanups(root)
            .unwrap()
            .iter()
            .any(|(_, name)| name == "doomed"));

        std::fs::remove_file(config_lock).unwrap();
        list_branches(root).unwrap();
        assert!(branch_config_entries(root, "doomed").unwrap().is_empty());
        assert!(pending_branch_cleanups(&linked).unwrap().is_empty());
        assert!(pending_branch_cleanups(root).unwrap().is_empty());
    }

    #[test]
    fn log_keeps_every_child_before_its_parents_when_dates_are_skewed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git_at = |args: &[&str], date: &str| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "Topology Test")
                .env("GIT_AUTHOR_EMAIL", "topology@test")
                .env("GIT_COMMITTER_NAME", "Topology Test")
                .env("GIT_COMMITTER_EMAIL", "topology@test")
                .env("GIT_AUTHOR_DATE", date)
                .env("GIT_COMMITTER_DATE", date)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
        };

        git_at(
            &["init", "--quiet", "--initial-branch=main"],
            "2026-01-01T00:00:00Z",
        );
        git_at(
            &["config", "core.autocrlf", "false"],
            "2026-01-01T00:00:00Z",
        );
        // Общий родитель намеренно новее одного из потомков. Без
        // --topo-order обычный git log может поставить `root` выше `side-1`,
        // хотя side-1 прямо ссылается на root как на родителя.
        git_at(
            &["commit", "--quiet", "--allow-empty", "-m", "root"],
            "2026-01-05T00:00:00Z",
        );
        git_at(&["branch", "side"], "2026-01-05T00:00:00Z");
        git_at(&["checkout", "--quiet", "side"], "2026-01-05T00:00:00Z");
        git_at(
            &["commit", "--quiet", "--allow-empty", "-m", "side-1"],
            "2026-01-01T00:00:00Z",
        );
        git_at(
            &["commit", "--quiet", "--allow-empty", "-m", "side-2"],
            "2026-01-02T00:00:00Z",
        );
        git_at(&["checkout", "--quiet", "main"], "2026-01-05T00:00:00Z");
        git_at(
            &["commit", "--quiet", "--allow-empty", "-m", "main-1"],
            "2026-01-04T00:00:00Z",
        );
        git_at(
            &["merge", "--quiet", "--no-ff", "side", "-m", "merge"],
            "2026-01-06T00:00:00Z",
        );

        for all_branches in [false, true] {
            let log = list_log_unfiltered(root, 50, all_branches).unwrap();
            let positions: std::collections::HashMap<&str, usize> = log
                .iter()
                .enumerate()
                .map(|(index, commit)| (commit.hash.as_str(), index))
                .collect();

            for (child_index, commit) in log.iter().enumerate() {
                for parent in &commit.parents {
                    if let Some(parent_index) = positions.get(parent.as_str()) {
                        assert!(
                            child_index < *parent_index,
                            "{} must precede its parent {} in {all_branches:?} history",
                            commit.subject,
                            log[*parent_index].subject,
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn all_branches_limit_never_hides_a_branch_tip() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git_at = |args: &[&str], date: &str| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "Limit Test")
                .env("GIT_AUTHOR_EMAIL", "limit@test")
                .env("GIT_COMMITTER_NAME", "Limit Test")
                .env("GIT_COMMITTER_EMAIL", "limit@test")
                .env("GIT_AUTHOR_DATE", date)
                .env("GIT_COMMITTER_DATE", date)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
            output.stdout
        };
        git_at(
            &["init", "--quiet", "--initial-branch=main"],
            "2026-01-01T00:00:00Z",
        );
        git_at(
            &["config", "core.autocrlf", "false"],
            "2026-01-01T00:00:00Z",
        );
        git_at(
            &["commit", "--quiet", "--allow-empty", "-m", "base"],
            "2026-01-01T00:00:00Z",
        );
        git_at(&["branch", "side"], "2026-01-01T00:00:00Z");
        git_at(&["checkout", "--quiet", "side"], "2026-01-01T00:00:00Z");
        git_at(
            &["commit", "--quiet", "--allow-empty", "-m", "short side tip"],
            "2026-01-02T00:00:00Z",
        );
        let side_tip =
            String::from_utf8_lossy(&git_at(&["rev-parse", "HEAD"], "2026-01-02T00:00:00Z"))
                .trim()
                .to_owned();
        git_at(&["checkout", "--quiet", "main"], "2027-01-01T00:00:00Z");
        for index in 0..510 {
            git_at(
                &[
                    "commit",
                    "--quiet",
                    "--allow-empty",
                    "-m",
                    &format!("main-{index}"),
                ],
                "2027-01-01T00:00:00Z",
            );
        }

        let limited_without_supplement = run_git(
            root,
            &["log", "-n500", "--topo-order", "--format=%H", "--branches"],
        )
        .unwrap();
        assert!(
            !String::from_utf8_lossy(&limited_without_supplement)
                .lines()
                .any(|hash| hash == side_tip),
            "fixture должен воспроизводить вытеснение короткой ветки глобальным limit"
        );

        let log = list_log_unfiltered(root, 500, true).unwrap();
        let positions = log
            .iter()
            .enumerate()
            .map(|(index, commit)| (commit.hash.as_str(), index))
            .collect::<std::collections::HashMap<_, _>>();
        assert!(positions.contains_key(side_tip.as_str()));
        assert!(log.iter().any(|commit| {
            commit.hash == side_tip
                && commit
                    .ref_details
                    .iter()
                    .any(|reference| reference.kind == "local" && reference.name == "side")
        }));
        for (child_index, commit) in log.iter().enumerate() {
            for parent in &commit.parents {
                if let Some(parent_index) = positions.get(parent.as_str()) {
                    assert!(
                        child_index < *parent_index,
                        "{} must precede parent {}",
                        commit.hash,
                        parent
                    );
                }
            }
        }
    }

    #[test]
    fn all_branches_excludes_non_branch_refs_and_includes_detached_head() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "Branch Test")
                .env("GIT_AUTHOR_EMAIL", "branches@test")
                .env("GIT_COMMITTER_NAME", "Branch Test")
                .env("GIT_COMMITTER_EMAIL", "branches@test")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
            output.stdout
        };
        let hash = |args: &[&str]| String::from_utf8_lossy(&git(args)).trim().to_owned();

        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("tracked.txt"), "base\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "root"]);
        let root_hash = hash(&["rev-parse", "HEAD"]);

        git(&["checkout", "--quiet", "-b", "side"]);
        git(&["commit", "--quiet", "--allow-empty", "-m", "side-tip"]);
        let side_hash = hash(&["rev-parse", "HEAD"]);
        git(&["checkout", "--quiet", "main"]);
        git(&["commit", "--quiet", "--allow-empty", "-m", "main-tip"]);
        let main_hash = hash(&["rev-parse", "HEAD"]);

        // Коммит доступен только через tag: это не ветка и в режиме «Все
        // ветки» отдельную компоненту графа создавать не должен.
        let tree = hash(&["rev-parse", "HEAD^{tree}"]);
        let tag_only_hash = hash(&["commit-tree", tree.as_str(), "-p", "HEAD", "-m", "tag-only"]);
        git(&["tag", "archived-only", tag_only_hash.as_str()]);

        // refs/stash — служебный merge-граф, а не пользовательская ветка.
        std::fs::write(root.join("tracked.txt"), "stashed\n").unwrap();
        git(&["stash", "push", "--quiet", "-m", "hidden-stash"]);
        let stash_hash = hash(&["rev-parse", "refs/stash"]);

        let branch_log = list_log_unfiltered(root, 50, true).unwrap();
        let branch_hashes = branch_log
            .iter()
            .map(|commit| commit.hash.as_str())
            .collect::<std::collections::HashSet<_>>();
        assert!(branch_hashes.contains(main_hash.as_str()));
        assert!(branch_hashes.contains(side_hash.as_str()));
        assert!(!branch_hashes.contains(tag_only_hash.as_str()));
        assert!(!branch_hashes.contains(stash_hash.as_str()));
        let side_commit = branch_log
            .iter()
            .find(|commit| commit.hash == side_hash)
            .unwrap();
        assert!(side_commit.local_only);
        assert!(
            side_commit.unpushed,
            "без upstream local-only всё равно не запушен"
        );

        // Detached HEAD не входит в refs/heads, поэтому добавляется отдельной
        // starting revision и живёт рядом с обычными ветками.
        git(&["checkout", "--quiet", "--detach", root_hash.as_str()]);
        git(&["commit", "--quiet", "--allow-empty", "-m", "detached-tip"]);
        let detached_hash = hash(&["rev-parse", "HEAD"]);
        let detached_log = list_log_unfiltered(root, 50, true).unwrap();
        let detached_hashes = detached_log
            .iter()
            .map(|commit| commit.hash.as_str())
            .collect::<std::collections::HashSet<_>>();
        assert!(detached_hashes.contains(detached_hash.as_str()));
        assert!(detached_hashes.contains(main_hash.as_str()));
        assert!(detached_hashes.contains(side_hash.as_str()));
        let detached_commit = detached_log
            .iter()
            .find(|commit| commit.hash == detached_hash)
            .unwrap();
        assert!(detached_commit.local_only);
        assert!(detached_commit.unpushed);
    }

    #[test]
    fn log_control_characters_cannot_corrupt_parent_fields() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "Parser Test")
                .env("GIT_AUTHOR_EMAIL", "parser@test")
                .env("GIT_COMMITTER_NAME", "Parser Test")
                .env("GIT_COMMITTER_EMAIL", "parser@test")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
            output.stdout
        };

        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["commit", "--quiet", "--allow-empty", "-m", "root"]);
        let root_hash = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]))
            .trim()
            .to_owned();
        let subject = "subject with \u{1f} unit and \u{1e} record separators";
        let body = "body keeps \u{1e} and \u{1f} as ordinary text";
        let message_path = root.join("message.txt");
        std::fs::write(&message_path, format!("{subject}\n\n{body}\n")).unwrap();
        git(&[
            "commit",
            "--quiet",
            "--allow-empty",
            "-F",
            message_path.to_str().unwrap(),
        ]);

        let log = list_log_unfiltered(root, 10, false).unwrap();
        assert_eq!(log[0].subject, subject);
        assert_eq!(log[0].body, body);
        assert_eq!(log[0].parents, vec![root_hash]);
    }

    #[test]
    fn survives_a_messy_repository() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "Дэн")
                .env("GIT_AUTHOR_EMAIL", "d@t")
                .env("GIT_COMMITTER_NAME", "Дэн")
                .env("GIT_COMMITTER_EMAIL", "d@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["config", "user.name", "Дэн"]);
        git(&["config", "user.email", "d@t"]);

        // Юникод и пробелы в именах, кириллица в коммитах.
        std::fs::write(root.join("файл с пробелами.txt"), "раз\nдва\n").unwrap();
        std::fs::write(root.join("old-name.txt"), "stable content\nline\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "начальный коммит — юникод ✓"]);

        // Переименование + бинарник + новый юникод-файл.
        git(&["mv", "old-name.txt", "new-name.txt"]);
        std::fs::write(root.join("blob.bin"), [0_u8, 159, 146, 150, 0, 7]).unwrap();
        std::fs::write(root.join("ещё файл.md"), "# привет\n").unwrap();

        let summary = collect_summary(root).unwrap();
        let by_path = |path: &str| {
            summary
                .files
                .iter()
                .find(|file| file.path == path)
                .unwrap_or_else(|| panic!("{path} not in summary"))
        };
        let renamed = by_path("new-name.txt");
        assert_eq!(renamed.status, "renamed");
        assert_eq!(renamed.orig_path.as_deref(), Some("old-name.txt"));
        let binary = by_path("blob.bin");
        assert_eq!(binary.status, "untracked");
        assert_eq!(binary.additions, None, "бинарник без счётчиков строк");
        assert_eq!(by_path("ещё файл.md").additions, Some(1));

        let binary_diff = collect_file_diff(root, "blob.bin").unwrap();
        assert!(binary_diff.is_binary);
        let unicode_diff = collect_file_diff(root, "ещё файл.md").unwrap();
        assert!(unicode_diff.diff.contains("+# привет"));

        // Гигантский файл: diff обрезается, но не ломается.
        let huge = "строка наполнения диффа\n".repeat(80_000);
        std::fs::write(root.join("huge.txt"), &huge).unwrap();
        let huge_diff = collect_file_diff(root, "huge.txt").unwrap();
        assert!(huge_diff.truncated);
        assert!(huge_diff.diff.len() <= MAX_DIFF_BYTES + 1024);
        std::fs::remove_file(root.join("huge.txt")).unwrap();

        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "вторая ревизия"]);

        // Конфликт слияния: файл получает статус conflicted, сводка живёт.
        git(&["checkout", "--quiet", "-b", "clash"]);
        std::fs::write(root.join("новый файл.md"), "версия из clash\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "clash version"]);
        git(&["checkout", "--quiet", "main"]);
        std::fs::write(root.join("новый файл.md"), "версия из main\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "main version"]);
        let merge = Command::new("git")
            .args(["merge", "clash"])
            .current_dir(root)
            .output()
            .unwrap();
        assert!(!merge.status.success(), "merge must conflict");
        let summary = collect_summary(root).unwrap();
        assert_eq!(by_path_in(&summary, "новый файл.md").status, "conflicted");
        git(&["merge", "--abort"]);

        // «Все ветки»: коммит из невлитой ветки clash не виден в истории
        // текущей ветки, но появляется с --all (как серверные ветки).
        let head_only = list_log_unfiltered(root, 50, false).unwrap();
        assert!(!head_only.iter().any(|c| c.subject == "clash version"));
        let all_refs = list_log_unfiltered(root, 50, true).unwrap();
        assert!(all_refs.iter().any(|c| c.subject == "clash version"));

        // Detached HEAD: ветки нет, но история и статус работают.
        let log = list_log_unfiltered(root, 10, false).unwrap();
        assert!(log[0].subject.contains("main version"));
        git(&["checkout", "--quiet", &log[1].hash]);
        let summary = collect_summary(root).unwrap();
        assert!(summary.is_repo);
        assert_eq!(summary.branch, None, "detached HEAD — без имени ветки");
        assert!(!list_log_unfiltered(root, 5, false).unwrap().is_empty());
        let branches = list_branches(root).unwrap();
        assert!(branches.iter().all(|branch| !branch.is_current));
    }

    fn by_path_in<'s>(summary: &'s GitChangesSummary, path: &str) -> &'s GitChangedFile {
        summary
            .files
            .iter()
            .find(|file| file.path == path)
            .unwrap_or_else(|| panic!("{path} not in summary"))
    }

    #[test]
    fn reads_and_writes_files_within_the_repository() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let init = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(root)
            .output()
            .unwrap();
        assert!(init.status.success());

        std::fs::write(root.join("edit me.txt"), "одна\nдве\n").unwrap();

        // Чтение существующего текстового файла (юникод, пробел в имени).
        let read = read_repo_file(root, "edit me.txt").unwrap();
        assert!(read.exists && !read.is_binary && !read.too_large);
        assert_eq!(read.content, "одна\nдве\n");

        // Правка и запись, затем повторное чтение видит новую версию.
        write_repo_file(root, "edit me.txt", "одна\nДВЕ\nтри\n").unwrap();
        assert_eq!(
            read_repo_file(root, "edit me.txt").unwrap().content,
            "одна\nДВЕ\nтри\n"
        );

        // Сохранение воссоздаёт отсутствующий файл во вложенной папке.
        assert!(!read_repo_file(root, "sub/new.txt").unwrap().exists);
        write_repo_file(root, "sub/new.txt", "создан\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("sub/new.txt")).unwrap(),
            "создан\n"
        );

        // Бинарный файл: редактирование недоступно.
        std::fs::write(root.join("blob.bin"), [0_u8, 1, 2, 0]).unwrap();
        assert!(read_repo_file(root, "blob.bin").unwrap().is_binary);

        // Побег из корня и абсолютные пути отклоняются на чтении и записи.
        assert!(read_repo_file(root, "../escape.txt").is_err());
        assert!(write_repo_file(root, "/etc/passwd", "x").is_err());
        assert!(write_repo_file(root, "../../evil", "x").is_err());
    }

    #[test]
    fn commits_and_reverts_in_a_real_repository() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["config", "user.name", "t"]);
        git(&["config", "user.email", "t@t"]);
        std::fs::write(root.join("a.txt"), "original\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);

        // Откат правки отслеживаемого файла возвращает содержимое HEAD.
        std::fs::write(root.join("a.txt"), "edited\n").unwrap();
        revert_file(root, "a.txt", None).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "original\n"
        );

        // Откат нового файла удаляет его.
        std::fs::write(root.join("fresh.txt"), "temp\n").unwrap();
        revert_file(root, "fresh.txt", None).unwrap();
        assert!(!root.join("fresh.txt").exists());

        // Откат переименования: старое имя возвращается, новое исчезает.
        git(&["mv", "a.txt", "b.txt"]);
        revert_file(root, "b.txt", Some("a.txt")).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "original\n"
        );
        assert!(!root.join("b.txt").exists());
        assert!(collect_summary(root).unwrap().files.is_empty());

        // Коммит из панели забирает всё, включая новые файлы.
        std::fs::write(root.join("a.txt"), "committed\n").unwrap();
        std::fs::write(root.join("new.txt"), "brand new\n").unwrap();
        commit_all(root, "panel commit\n\nDetailed description").unwrap();
        let summary = collect_summary(root).unwrap();
        assert!(summary.files.is_empty());
        let commit = list_log_unfiltered(root, 1, false).unwrap().remove(0);
        assert_eq!(commit.subject, "panel commit");
        assert_eq!(commit.body, "Detailed description");
        assert!(commit_all(root, "   ").is_err());
    }

    // Остальные тесты выключают core.autocrlf, чтобы сравнивать содержимое
    // точно. Но у пользователя Git for Windows он включён по умолчанию, и в
    // рабочей копии лежит CRLF. Проверяем здесь один раз и осознанно, что
    // панель от этого не слепнет: файл остаётся текстовым, diff собирается,
    // сообщение коммита разбирается.
    #[test]
    fn panel_reads_a_repository_with_autocrlf_enabled() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "true"]);
        git(&["config", "user.name", "t"]);
        git(&["config", "user.email", "t@t"]);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "add the file\n\nWhy it matters"]);

        // Коммит содержимое не переписывает, поэтому CRLF в рабочей копии
        // появляется только на выдаче: удаляем файл и забираем его из HEAD.
        // Так тест ведёт себя одинаково на всех системах, а не только там,
        // где autocrlf включён установщиком.
        std::fs::remove_file(root.join("a.txt")).unwrap();
        git(&["checkout", "--", "a.txt"]);
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\r\ntwo\r\n",
            "autocrlf обязан выдать рабочую копию с CRLF, иначе тест ничего не проверяет"
        );

        // Правка тем же переводом строки: git видит изменение, и панель тоже.
        std::fs::write(root.join("a.txt"), "one\r\ntwo\r\nthree\r\n").unwrap();
        let summary = collect_summary(root).unwrap();
        assert!(summary.is_repo);
        let changed = summary
            .files
            .iter()
            .find(|file| file.path == "a.txt")
            .expect("панель не увидела правку файла с CRLF");
        assert_eq!(changed.status, "modified");
        assert_eq!(changed.additions, Some(1));

        // Файл с CRLF остаётся текстовым, а не «бинарным без diff».
        let diff = collect_file_diff(root, "a.txt").unwrap();
        assert!(!diff.is_binary, "файл с CRLF принят за бинарный");
        assert!(
            diff.diff.contains("three"),
            "в diff нет добавленной строки: {}",
            diff.diff
        );

        // Разбор сообщения не зависит от переводов строк в содержимом.
        let commit = list_log_unfiltered(root, 1, false).unwrap().remove(0);
        assert_eq!(commit.subject, "add the file");
        assert_eq!(commit.body, "Why it matters");
    }

    #[test]
    fn commit_actions_in_a_real_repository() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["config", "user.name", "t"]);
        git(&["config", "user.email", "t@t"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "second"]);

        let log = list_log_unfiltered(root, 10, false).unwrap();
        let second = log[0].hash.clone();
        let first = log[1].hash.clone();

        // Некорректные ввод отклоняются до запуска git.
        assert!(commit_action(root, "checkout", "nope", None).is_err());
        assert!(commit_action(root, "unknown", &second, None).is_err());
        assert!(commit_action(root, "branch", &second, Some("bad name")).is_err());

        // Ветка от первого коммита: создаётся и становится текущей.
        commit_action(root, "branch", &first, Some("from-first")).unwrap();
        let branches = list_branches(root).unwrap();
        assert_eq!(
            branches.iter().find(|b| b.is_current).unwrap().name,
            "from-first"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\n",
            "новая ветка стоит на первом коммите"
        );

        // Cherry-pick второго коммита поверх ветки от первого.
        commit_action(root, "cherryPick", &second, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\ntwo\n",
            "cherry-pick принёс изменение второго коммита"
        );

        // Revert последнего коммита откатывает содержимое новым коммитом.
        let tip = list_log_unfiltered(root, 1, false).unwrap()[0].hash.clone();
        commit_action(root, "revert", &tip, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\n",
            "revert вернул содержимое к состоянию до коммита"
        );

        // Checkout на коммит отделяет HEAD — текущей ветки нет.
        commit_action(root, "checkout", &first, None).unwrap();
        assert_eq!(collect_summary(root).unwrap().branch, None);
    }

    #[test]
    fn commit_actions_do_not_dwim_a_full_hash_as_a_branch_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
            output.stdout
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["commit", "--quiet", "--allow-empty", "-m", "first"]);
        let first = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]))
            .trim()
            .to_owned();
        assert_eq!(first.len(), 40, "регрессия проверяет полный SHA-1 hash");
        git(&["commit", "--quiet", "--allow-empty", "-m", "second"]);
        let second = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]))
            .trim()
            .to_owned();

        // Такое имя ref допустимо, но оно указывает на другой коммит. Git
        // switch без предварительного resolve мог бы выбрать эту ветку.
        git(&["branch", &first, &second]);
        assert_eq!(
            local_branch_tip(root, &first).as_deref(),
            Some(second.as_str())
        );

        commit_action(root, "checkout", &first, None).unwrap();
        assert_eq!(collect_summary(root).unwrap().branch, None);
        assert_eq!(
            String::from_utf8_lossy(&git(&["rev-parse", "HEAD"])).trim(),
            first
        );

        commit_action(root, "branch", &first, Some("from-exact-hash")).unwrap();
        assert_eq!(
            collect_summary(root).unwrap().branch.as_deref(),
            Some("from-exact-hash")
        );
        assert_eq!(
            String::from_utf8_lossy(&git(&["rev-parse", "HEAD"])).trim(),
            first
        );
    }

    #[test]
    fn rewords_a_local_commit_and_preserves_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "Me")
                .env("GIT_AUTHOR_EMAIL", "me@t")
                .env("GIT_COMMITTER_NAME", "Me")
                .env("GIT_COMMITTER_EMAIL", "me@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["config", "user.name", "Me"]);
        git(&["config", "user.email", "me@t"]);
        std::fs::write(root.join("a.txt"), "1\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        git(&["branch", "side"]);
        std::fs::write(root.join("a.txt"), "1\n2\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "second", "-m", "old body"]);
        std::fs::write(root.join("a.txt"), "1\n2\n3\n").unwrap();
        git(&["add", "."]);
        let third_message_path = root.join(".git/third-message");
        std::fs::write(
            &third_message_path,
            b"third\n\nbody keeps trailing spaces  \n\n\n",
        )
        .unwrap();
        git(&[
            "commit",
            "--quiet",
            "--cleanup=verbatim",
            "-F",
            third_message_path.to_str().unwrap(),
        ]);
        std::fs::remove_file(third_message_path).unwrap();

        git(&["checkout", "--quiet", "side"]);
        std::fs::write(root.join("side.txt"), "side\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "side commit"]);
        git(&["checkout", "--quiet", "main"]);
        let side = list_log_unfiltered(root, 20, true)
            .unwrap()
            .into_iter()
            .find(|commit| commit.subject == "side commit")
            .unwrap();
        assert!(side.local_only);
        assert!(!side.editable, "боковая ветка не входит в reword-цепочку");

        let before = list_log_unfiltered(root, 10, false).unwrap(); // third, second, first
        let second = before[1].hash.clone();
        let third_before = read_commit_meta(root, &before[0].hash).unwrap();
        assert!(third_before
            .message
            .windows(3)
            .any(|bytes| bytes == b"  \n"));
        assert!(third_before.message.ends_with(b"\n\n\n"));
        assert!(before[1].editable, "свой не запушенный коммит редактируем");

        // Правим сообщение среднего коммита (у него есть потомок third).
        reword_commit(root, &second, "reworded second\n\nnew body").unwrap();

        let after = list_log_unfiltered(root, 10, false).unwrap();
        assert_eq!(after.len(), 3);
        assert_eq!(after[0].subject, "third");
        assert_eq!(after[1].subject, "reworded second");
        assert_eq!(after[1].body, "new body");
        assert_eq!(after[2].subject, "first");
        // Хеши цели и её потомка изменились, корень — нет.
        assert_ne!(after[1].hash, second);
        assert_ne!(after[0].hash, before[0].hash);
        assert_eq!(after[2].hash, before[2].hash);
        // Потомок сохранил дерево, сообщение и авторство.
        let third_after = read_commit_meta(root, &after[0].hash).unwrap();
        assert_eq!(third_after.tree, third_before.tree);
        assert_eq!(third_after.message, third_before.message);
        assert_eq!(third_after.author_email, "me@t");
        // Рабочее дерево нетронуто и чистое.
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "1\n2\n3\n"
        );
        assert!(collect_summary(root).unwrap().files.is_empty());
    }

    #[test]
    fn reword_preserves_the_submitted_message_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "Me")
                .env("GIT_AUTHOR_EMAIL", "me@t")
                .env("GIT_COMMITTER_NAME", "Me")
                .env("GIT_COMMITTER_EMAIL", "me@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
            output.stdout
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["config", "user.name", "Me"]);
        git(&["config", "user.email", "me@t"]);
        let message_path = root.join(".git/verbatim-message");
        std::fs::write(
            &message_path,
            b"  spaced subject  \n\nbody keeps trailing spaces  \n\n\n",
        )
        .unwrap();
        git(&[
            "commit",
            "--quiet",
            "--allow-empty",
            "--cleanup=verbatim",
            "-F",
            message_path.to_str().unwrap(),
        ]);
        std::fs::remove_file(message_path).unwrap();
        let old_head = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]))
            .trim()
            .to_owned();
        let before = read_commit_meta(root, &old_head).unwrap();
        assert!(before.message.starts_with(b"  spaced subject  \n"));
        assert!(before.message.ends_with(b"  \n\n\n"));

        let unchanged_message = String::from_utf8(before.message.clone()).unwrap();
        reword_commit(root, &old_head, &unchanged_message).unwrap();

        let new_head = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]))
            .trim()
            .to_owned();
        let after = read_commit_meta(root, &new_head).unwrap();
        assert_eq!(after.message, before.message);
        assert_eq!(
            new_head, old_head,
            "байт-в-байт то же сообщение даёт тот же commit"
        );
    }

    #[test]
    fn exposes_reword_only_for_the_safe_first_parent_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "Me")
                .env("GIT_AUTHOR_EMAIL", "me@t")
                .env("GIT_COMMITTER_NAME", "Me")
                .env("GIT_COMMITTER_EMAIL", "me@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["config", "user.name", "Me"]);
        git(&["config", "user.email", "me@t"]);
        git(&["commit", "--quiet", "--allow-empty", "-m", "base"]);
        git(&["branch", "side"]);
        git(&["commit", "--quiet", "--allow-empty", "-m", "main work"]);
        git(&["checkout", "--quiet", "side"]);
        git(&["commit", "--quiet", "--allow-empty", "-m", "side work"]);
        git(&["checkout", "--quiet", "main"]);
        git(&["merge", "--quiet", "--no-ff", "side", "-m", "merge side"]);

        assert!(list_log_unfiltered(root, 20, true)
            .unwrap()
            .iter()
            .all(|commit| !commit.editable));

        git(&["commit", "--quiet", "--allow-empty", "-m", "after merge"]);
        let log = list_log_unfiltered(root, 20, true).unwrap();
        assert!(
            log.iter()
                .find(|commit| commit.subject == "after merge")
                .unwrap()
                .editable
        );
        assert!(log
            .iter()
            .filter(|commit| commit.subject != "after merge")
            .all(|commit| !commit.editable));
    }

    #[test]
    fn refuses_unsafe_rewords() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let run = |args: &[&str], email: &str| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "N")
                .env("GIT_AUTHOR_EMAIL", email)
                .env("GIT_COMMITTER_NAME", "N")
                .env("GIT_COMMITTER_EMAIL", email)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed");
        };
        run(&["init", "--quiet", "--initial-branch=main"], "me@t");
        run(&["config", "core.autocrlf", "false"], "me@t");
        run(&["config", "user.name", "Me"], "me@t");
        run(&["config", "user.email", "me@t"], "me@t");
        std::fs::write(root.join("a.txt"), "1\n").unwrap();
        run(&["add", "."], "me@t");
        run(&["commit", "--quiet", "-m", "mine"], "me@t");
        // Коммит другого автора.
        std::fs::write(root.join("b.txt"), "x\n").unwrap();
        run(&["add", "."], "other@t");
        run(&["commit", "--quiet", "-m", "theirs"], "other@t");

        let log = list_log_unfiltered(root, 10, false).unwrap(); // theirs, mine
        let theirs = &log[0];
        let mine = &log[1];
        assert!(!theirs.editable, "чужой коммит не редактируем");
        // Чужой коммит — отказ.
        assert!(reword_commit(root, &theirs.hash, "x").is_err());
        // Пустое сообщение — отказ.
        assert!(reword_commit(root, &mine.hash, "   ").is_err());
        // Некорректный хеш — отказ.
        assert!(reword_commit(root, "zzzz", "x").is_err());

        // Merge-коммит — отказ.
        run(&["checkout", "--quiet", "-b", "feat"], "me@t");
        std::fs::write(root.join("c.txt"), "y\n").unwrap();
        run(&["add", "."], "me@t");
        run(&["commit", "--quiet", "-m", "feat work"], "me@t");
        run(&["checkout", "--quiet", "main"], "me@t");
        run(
            &["merge", "--quiet", "--no-ff", "--no-edit", "feat"],
            "me@t",
        );
        let head = list_log_unfiltered(root, 1, false).unwrap()[0].hash.clone();
        assert!(
            reword_commit(root, &head, "x").is_err(),
            "merge-коммит переписывать нельзя"
        );

        // Запушенный коммит — отказ (есть на remote-tracking ветке).
        let remote = tempfile::tempdir().unwrap();
        Command::new("git")
            .args(["init", "--bare", "--quiet"])
            .current_dir(remote.path())
            .output()
            .unwrap();
        run(
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
            "me@t",
        );
        run(&["push", "--quiet", "origin", "main"], "me@t");
        let pushed = list_log_unfiltered(root, 20, false)
            .unwrap()
            .into_iter()
            .find(|c| c.subject == "mine")
            .unwrap()
            .hash;
        assert!(
            reword_commit(root, &pushed, "x").is_err(),
            "запушенный коммит переписывать нельзя"
        );
    }

    #[test]
    fn creates_renames_and_deletes_local_branches_safely() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("base.txt"), "base\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "base"]);

        assert!(create_branch(root, "a//b").is_err());
        create_branch(root, "feature/local").unwrap();
        assert_eq!(
            collect_summary(root).unwrap().branch.as_deref(),
            Some("feature/local")
        );
        assert!(create_branch(root, "feature/local").is_err());

        rename_branch(root, "feature/local", "topic").unwrap();
        assert_eq!(
            collect_summary(root).unwrap().branch.as_deref(),
            Some("topic")
        );
        assert!(rename_branch(root, "topic", "main").is_err());

        std::fs::write(root.join("topic.txt"), "topic\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "topic work"]);
        let topic_tip = local_branch_tip(root, "topic").unwrap();
        switch_branch(root, "main", "local").unwrap();
        let unmerged_error = delete_branch(root, "topic", false, &topic_tip).unwrap_err();
        assert_eq!(
            unmerged_error.context.get("reason").map(String::as_str),
            Some("branch-unmerged"),
            "невлитая ветка не удаляется без force"
        );
        assert!(local_branch_exists(root, "topic"));
        delete_branch(root, "topic", true, &topic_tip).unwrap();
        assert!(!local_branch_exists(root, "topic"));

        create_branch(root, "merged").unwrap();
        std::fs::write(root.join("merged.txt"), "merged\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "merged work"]);
        let merged_tip = local_branch_tip(root, "merged").unwrap();
        git(&["config", "branch.merged.remote", "origin"]);
        git(&["config", "branch.merged.merge", "refs/heads/merged"]);
        switch_branch(root, "main", "local").unwrap();
        git(&["merge", "--quiet", "--no-edit", "merged"]);
        delete_branch(root, "merged", false, &merged_tip).unwrap();
        assert!(!local_branch_exists(root, "merged"));
        assert!(run_git(
            root,
            &["config", "--local", "--get-regexp", "^branch\\.merged\\."]
        )
        .is_err());

        create_branch(root, "moving").unwrap();
        let stale_tip = local_branch_tip(root, "moving").unwrap();
        std::fs::write(root.join("moving.txt"), "moving\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "move branch"]);
        let moving_tip = local_branch_tip(root, "moving").unwrap();
        switch_branch(root, "main", "local").unwrap();
        let moved_error = delete_branch(root, "moving", true, &stale_tip).unwrap_err();
        assert_eq!(
            moved_error.context.get("reason").map(String::as_str),
            Some("branch-moved")
        );
        assert_eq!(
            local_branch_tip(root, "moving").as_deref(),
            Some(moving_tip.as_str())
        );
        delete_branch(root, "moving", true, &moving_tip).unwrap();

        create_branch(root, "linked").unwrap();
        let linked_tip = local_branch_tip(root, "linked").unwrap();
        switch_branch(root, "main", "local").unwrap();
        let worktrees = tempfile::tempdir().unwrap();
        let linked_path = worktrees.path().join("linked");
        git(&[
            "worktree",
            "add",
            "--quiet",
            linked_path.to_str().unwrap(),
            "linked",
        ]);
        assert!(delete_branch(root, "linked", true, &linked_tip).is_err());
        assert!(local_branch_exists(root, "linked"));
        assert_eq!(
            String::from_utf8_lossy(
                &run_git(&linked_path, &["symbolic-ref", "--short", "HEAD"]).unwrap()
            )
            .trim(),
            "linked"
        );
        assert!(list_branches(root)
            .unwrap()
            .iter()
            .all(|branch| !branch.name.starts_with("modelcrew-delete/")));
        git(&[
            "worktree",
            "remove",
            "--force",
            linked_path.to_str().unwrap(),
        ]);
        delete_branch(root, "linked", true, &linked_tip).unwrap();

        create_branch(root, "locked-config").unwrap();
        let locked_tip = local_branch_tip(root, "locked-config").unwrap();
        git(&["config", "branch.locked-config.remote", "origin"]);
        switch_branch(root, "main", "local").unwrap();
        let config_lock = root.join(".git/config.lock");
        std::fs::write(&config_lock, "held by another git process\n").unwrap();
        delete_branch(root, "locked-config", true, &locked_tip).unwrap();
        assert!(!local_branch_exists(root, "locked-config"));
        assert!(!branch_config_entries(root, "locked-config")
            .unwrap()
            .is_empty());
        assert!(pending_branch_cleanups(root)
            .unwrap()
            .iter()
            .any(|(_, name)| name == "locked-config"));
        std::fs::remove_file(config_lock).unwrap();
        list_branches(root).unwrap();
        assert!(branch_config_entries(root, "locked-config")
            .unwrap()
            .is_empty());
        assert!(pending_branch_cleanups(root).unwrap().is_empty());

        git(&[
            "config",
            "branch.preconfigured.description",
            "keep this setting",
        ]);
        create_branch(root, "preconfigured").unwrap();
        assert_eq!(
            String::from_utf8_lossy(
                &run_git(root, &["config", "branch.preconfigured.description"]).unwrap()
            )
            .trim(),
            "keep this setting"
        );
        let preconfigured_tip = local_branch_tip(root, "preconfigured").unwrap();
        switch_branch(root, "main", "local").unwrap();
        delete_branch(root, "preconfigured", false, &preconfigured_tip).unwrap();

        create_branch(root, "rename-lock").unwrap();
        switch_branch(root, "main", "local").unwrap();
        git(&["config", "branch.rename-lock.remote", "origin"]);
        let config_lock = root.join(".git/config.lock");
        std::fs::write(&config_lock, "held by another git process\n").unwrap();
        assert!(rename_branch(root, "rename-lock", "renamed-lock").is_err());
        assert!(local_branch_exists(root, "rename-lock"));
        assert!(!local_branch_exists(root, "renamed-lock"));
        std::fs::remove_file(config_lock).unwrap();

        create_branch(root, "current").unwrap();
        let current_tip = local_branch_tip(root, "current").unwrap();
        assert!(delete_branch(root, "current", false, &current_tip).is_err());
        assert!(delete_branch(root, "current", true, &current_tip).is_err());
        assert!(local_branch_exists(root, "current"));
        assert!(String::from_utf8_lossy(
            &run_git(
                root,
                &[
                    "for-each-ref",
                    "refs/modelcrew/branch-delete",
                    "--format=%(refname)",
                ],
            )
            .unwrap()
        )
        .trim()
        .is_empty());
    }

    #[test]
    fn creates_branch_in_repository_without_commits() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let output = Command::new("git")
            .args(["init", "--quiet", "--initial-branch=main"])
            .current_dir(root)
            .output()
            .unwrap();
        assert!(output.status.success());

        create_branch(root, "feature/empty").unwrap();
        let head = run_git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())
            .unwrap();
        assert_eq!(head, "feature/empty");
    }

    #[test]
    fn reset_to_upstream_rejects_a_stale_confirmation() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("a.txt"), "base\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "base"]);

        let remote = tempfile::tempdir().unwrap();
        let init = Command::new("git")
            .args(["init", "--bare", "--quiet"])
            .current_dir(remote.path())
            .output()
            .unwrap();
        assert!(init.status.success());
        git(&["remote", "add", "origin", remote.path().to_str().unwrap()]);
        git(&["push", "--quiet", "-u", "origin", "main"]);
        let upstream = String::from_utf8_lossy(
            &run_git(root, &["rev-parse", "refs/remotes/origin/main"]).unwrap(),
        )
        .trim()
        .to_owned();

        std::fs::write(root.join("a.txt"), "local commit\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "local"]);
        let local_head = String::from_utf8_lossy(&run_git(root, &["rev-parse", "HEAD"]).unwrap())
            .trim()
            .to_owned();
        std::fs::write(root.join("a.txt"), "dirty work\n").unwrap();

        assert!(reset_to_upstream(root, "other", &local_head).is_err());
        assert!(reset_to_upstream(root, "main", &upstream).is_err());
        assert_eq!(
            String::from_utf8_lossy(&run_git(root, &["rev-parse", "HEAD"]).unwrap()).trim(),
            local_head
        );
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "dirty work\n"
        );

        reset_to_upstream(root, "main", &local_head).unwrap();
        assert_eq!(
            String::from_utf8_lossy(&run_git(root, &["rev-parse", "HEAD"]).unwrap()).trim(),
            upstream
        );
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "dirty work\n",
            "выравнивание истории не должно уничтожать рабочие правки"
        );
        assert!(
            run_git(root, &["diff", "--cached", "--quiet"]).is_err(),
            "изменения убранного локального коммита остаются в индексе"
        );
        assert!(
            run_git(root, &["diff", "--quiet"]).is_err(),
            "незакоммиченные изменения поверх индекса тоже сохраняются"
        );
    }

    #[test]
    fn sync_actions_reject_a_stale_branch_head_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
            output.stdout
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["commit", "--quiet", "--allow-empty", "-m", "base"]);
        let stale_head = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]))
            .trim()
            .to_owned();

        let remote = tempfile::tempdir().unwrap();
        let init = Command::new("git")
            .args(["init", "--bare", "--quiet", "--initial-branch=main"])
            .current_dir(remote.path())
            .output()
            .unwrap();
        assert!(init.status.success());
        git(&["remote", "add", "origin", remote.path().to_str().unwrap()]);
        git(&["push", "--quiet", "-u", "origin", "main"]);

        git(&["commit", "--quiet", "--allow-empty", "-m", "new local head"]);
        let current_head = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]))
            .trim()
            .to_owned();

        for error in [
            pull_upstream(root, "main", &stale_head).unwrap_err(),
            push_upstream(root, "main", &stale_head).unwrap_err(),
            pull_rebase(root, "main", &stale_head).unwrap_err(),
        ] {
            assert_eq!(
                error.context.get("reason").map(String::as_str),
                Some("head-moved")
            );
        }
        let remote_head = || {
            let output = Command::new("git")
                .args([
                    "--git-dir",
                    remote.path().to_str().unwrap(),
                    "rev-parse",
                    "refs/heads/main",
                ])
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "remote rev-parse failed: {output:?}"
            );
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        };
        assert_eq!(remote_head(), stale_head, "stale push ничего не отправил");

        push_upstream(root, "main", &current_head).unwrap();
        assert_eq!(
            remote_head(),
            current_head,
            "push отправляет ровно подтверждённый commit"
        );
    }

    #[test]
    fn uncommit_moves_local_head_and_preserves_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed");
            output.stdout
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        let first = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]))
            .trim()
            .to_owned();

        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("b.txt"), "committed\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "second"]);
        let second = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]))
            .trim()
            .to_owned();
        assert!(list_log_unfiltered(root, 1, false).unwrap()[0].local_only);

        // Незакоммиченная правка поверх второго коммита тоже должна сохраниться.
        std::fs::write(root.join("a.txt"), "one\ntwo\nworking\n").unwrap();
        commit_action(root, "uncommit", &second, None).unwrap();

        let head = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]))
            .trim()
            .to_owned();
        assert_eq!(head, first);
        assert_eq!(
            collect_summary(root).unwrap().branch.as_deref(),
            Some("main")
        );
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\ntwo\nworking\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("b.txt")).unwrap(),
            "committed\n"
        );
        assert!(!collect_summary(root).unwrap().files.is_empty());
        let cached = Command::new("git")
            .args(["diff", "--cached", "--quiet"])
            .current_dir(root)
            .status()
            .unwrap();
        assert!(
            !cached.success(),
            "атомарный soft-uncommit оставляет изменения подготовленными"
        );
        let stale_error = commit_action(root, "uncommit", &second, None).unwrap_err();
        assert_eq!(
            stale_error.context.get("reason").map(String::as_str),
            Some("head-moved")
        );
    }

    #[test]
    fn reports_remote_refs_for_non_origin_remotes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed");
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "second"]);

        let remote = tempfile::tempdir().unwrap();
        let init = Command::new("git")
            .args(["init", "--bare", "--quiet", "--initial-branch=main"])
            .current_dir(remote.path())
            .output()
            .unwrap();
        assert!(init.status.success());
        git(&["remote", "add", "upstream", remote.path().to_str().unwrap()]);
        git(&["push", "--quiet", "-u", "upstream", "main"]);

        let commit = list_log_unfiltered(root, 1, false).unwrap().remove(0);
        assert_eq!(commit.remote_refs, vec!["upstream/main"]);
        assert!(!commit.local_only);
        assert!(commit_action(root, "uncommit", &commit.hash, None).is_err());
        assert!(list_log_unfiltered(root, 1, false).unwrap()[0].is_head);
    }

    #[test]
    fn preserves_conflicting_cherry_pick_and_revert_for_explicit_resolution() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed");
            output.stdout
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("a.txt"), "base\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "base"]);

        git(&["checkout", "--quiet", "-b", "feature"]);
        std::fs::write(root.join("a.txt"), "feature\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "feature"]);
        let feature = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]))
            .trim()
            .to_owned();

        git(&["checkout", "--quiet", "main"]);
        std::fs::write(root.join("a.txt"), "main\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "main"]);
        let main_head = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]))
            .trim()
            .to_owned();

        // Чужую незавершённую операцию не abort-им: новый action только
        // отказывает, оставляя владельцу возможность continue/abort.
        let preexisting = Command::new("git")
            .args(["cherry-pick", &feature])
            .current_dir(root)
            .output()
            .unwrap();
        assert!(!preexisting.status.success());
        assert!(root.join(".git/CHERRY_PICK_HEAD").exists());
        assert!(commit_action(root, "revert", &feature, None).is_err());
        assert!(commit_action(root, "uncommit", &main_head, None).is_err());
        assert!(reword_commit(root, &main_head, "renamed main").is_err());
        assert!(pull_rebase(root, "main", &main_head).is_err());
        assert_eq!(
            String::from_utf8_lossy(&git(&["rev-parse", "HEAD"])).trim(),
            main_head
        );
        assert!(root.join(".git/CHERRY_PICK_HEAD").exists());
        git(&["cherry-pick", "--abort"]);

        assert!(commit_action(root, "cherryPick", &feature, None).is_err());
        assert!(root.join(".git/CHERRY_PICK_HEAD").exists());
        assert_eq!(
            String::from_utf8_lossy(&git(&["rev-parse", "HEAD"])).trim(),
            main_head
        );
        git(&["cherry-pick", "--abort"]);
        assert!(collect_summary(root).unwrap().files.is_empty());

        assert!(commit_action(root, "revert", &feature, None).is_err());
        assert!(root.join(".git/REVERT_HEAD").exists());
        assert_eq!(
            String::from_utf8_lossy(&git(&["rev-parse", "HEAD"])).trim(),
            main_head
        );
        git(&["revert", "--abort"]);
        assert!(collect_summary(root).unwrap().files.is_empty());
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "main\n"
        );
    }

    // Репозиторий с настроенным автором: переписывание истории разрешено только
    // для собственных коммитов, поэтому user.email должен совпадать с автором.
    fn history_repo(root: &Path) -> impl Fn(&[&str]) -> Vec<u8> + '_ {
        let git = move |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "Me")
                .env("GIT_AUTHOR_EMAIL", "me@t")
                .env("GIT_COMMITTER_NAME", "Me")
                .env("GIT_COMMITTER_EMAIL", "me@t")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed: {output:?}");
            output.stdout
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["config", "user.name", "Me"]);
        git(&["config", "user.email", "me@t"]);
        git
    }

    fn head_of(git: &impl Fn(&[&str]) -> Vec<u8>) -> String {
        String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]))
            .trim()
            .to_owned()
    }

    fn subjects(root: &Path) -> Vec<String> {
        list_log_unfiltered(root, 20, false)
            .unwrap()
            .into_iter()
            .map(|commit| commit.subject)
            .collect()
    }

    #[test]
    fn amends_staged_changes_into_the_last_commit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        let first = head_of(&git);

        std::fs::write(root.join("b.txt"), "added later\n").unwrap();
        git(&["add", "b.txt"]);
        // Незастейдженная правка не должна попасть в коммит.
        std::fs::write(root.join("c.txt"), "still working\n").unwrap();

        amend_commit(root, &first, Some("first, with more")).unwrap();

        let head = head_of(&git);
        assert_ne!(head, first);
        assert_eq!(subjects(root), vec!["first, with more".to_owned()]);
        let files = list_commit_files(root, &head).unwrap();
        let mut names: Vec<_> = files.iter().map(|file| file.path.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["a.txt", "b.txt"]);
        let staged = Command::new("git")
            .args(["diff", "--cached", "--quiet"])
            .current_dir(root)
            .status()
            .unwrap();
        assert!(staged.success(), "индекс совпадает с новым коммитом");
        assert_eq!(
            std::fs::read_to_string(root.join("c.txt")).unwrap(),
            "still working\n"
        );

        // Подтверждение относится к конкретной вершине: устаревшее отклоняется.
        let stale = amend_commit(root, &first, None).unwrap_err();
        assert_eq!(
            stale.context.get("reason").map(String::as_str),
            Some("head-moved")
        );
    }

    #[test]
    fn resets_the_branch_to_a_chosen_commit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        let first = head_of(&git);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        git(&["commit", "--quiet", "-am", "second"]);
        let second = head_of(&git);

        // soft двигает только ссылку: файлы и индекс остаются как были.
        reset_to_commit(root, &first, "soft", &second).unwrap();
        assert_eq!(head_of(&git), first);
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\ntwo\n"
        );
        let staged = Command::new("git")
            .args(["diff", "--cached", "--quiet"])
            .current_dir(root)
            .status()
            .unwrap();
        assert!(!staged.success(), "soft оставляет правки подготовленными");

        // hard возвращает и файлы к выбранному коммиту.
        reset_to_commit(root, &second, "soft", &first).unwrap();
        reset_to_commit(root, &first, "hard", &second).unwrap();
        assert_eq!(head_of(&git), first);
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\n"
        );

        assert_eq!(
            reset_to_commit(root, &second, "wipe", &first)
                .unwrap_err()
                .context
                .get("reason")
                .map(String::as_str),
            Some("reset-mode")
        );
    }

    #[test]
    fn squashes_a_commit_into_its_parent_without_touching_the_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        std::fs::write(root.join("b.txt"), "two\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "second"]);
        let second = head_of(&git);
        std::fs::write(root.join("c.txt"), "three\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "third"]);
        let head = head_of(&git);
        let tree_before = String::from_utf8_lossy(&git(&["rev-parse", "HEAD^{tree}"]))
            .trim()
            .to_owned();

        squash_commit(root, &second, "squash", &head).unwrap();

        assert_eq!(subjects(root), vec!["third".to_owned(), "first".to_owned()]);
        let log = list_log_unfiltered(root, 20, false).unwrap();
        assert_eq!(log[1].body, "second");
        // Содержимое вершины не изменилось, поэтому рабочая папка остаётся верной.
        let tree_after = String::from_utf8_lossy(&git(&["rev-parse", "HEAD^{tree}"]))
            .trim()
            .to_owned();
        assert_eq!(tree_after, tree_before);
        assert!(root.join("b.txt").exists());
    }

    #[test]
    fn fixup_keeps_only_the_parent_message() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        std::fs::write(root.join("a.txt"), "one\ntypo fixed\n").unwrap();
        git(&["commit", "--quiet", "-am", "fix typo"]);
        let head = head_of(&git);

        squash_commit(root, &head, "fixup", &head).unwrap();

        assert_eq!(subjects(root), vec!["first".to_owned()]);
        assert_eq!(list_log_unfiltered(root, 1, false).unwrap()[0].body, "");
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\ntypo fixed\n"
        );
    }

    #[test]
    fn drops_a_commit_and_replays_its_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        std::fs::write(root.join("unwanted.txt"), "remove me\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "unwanted"]);
        let unwanted = head_of(&git);
        std::fs::write(root.join("c.txt"), "keep me\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "third"]);
        let head = head_of(&git);

        drop_commit(root, &unwanted, &head).unwrap();

        assert_eq!(subjects(root), vec!["third".to_owned(), "first".to_owned()]);
        assert!(!root.join("unwanted.txt").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("c.txt")).unwrap(),
            "keep me\n"
        );
        assert!(collect_summary(root).unwrap().files.is_empty());
    }

    #[test]
    fn refuses_to_drop_a_commit_with_unsaved_work() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        std::fs::write(root.join("b.txt"), "two\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "second"]);
        let head = head_of(&git);
        std::fs::write(root.join("a.txt"), "one\nediting\n").unwrap();

        let error = drop_commit(root, &head, &head).unwrap_err();
        assert_eq!(
            error.context.get("reason").map(String::as_str),
            Some("dirty-tree")
        );
        assert_eq!(head_of(&git), head);
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\nediting\n"
        );
    }

    #[test]
    fn filters_history_by_message_author_and_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "add the parser"]);
        std::fs::write(root.join("b.txt"), "two\n").unwrap();
        git(&["add", "."]);
        let colleague = Command::new("git")
            .args(["commit", "--quiet", "-m", "tune the -- renderer"])
            .current_dir(root)
            .env("GIT_AUTHOR_NAME", "Sam")
            .env("GIT_AUTHOR_EMAIL", "sam@t")
            .env("GIT_COMMITTER_NAME", "Sam")
            .env("GIT_COMMITTER_EMAIL", "sam@t")
            .output()
            .unwrap();
        assert!(colleague.status.success());

        let by_text = |text: &str| {
            list_log(
                root,
                20,
                false,
                &GitLogFilter {
                    text: Some(text.to_owned()),
                    ..Default::default()
                },
            )
            .unwrap()
            .into_iter()
            .map(|commit| commit.subject)
            .collect::<Vec<_>>()
        };
        assert_eq!(by_text("parser"), vec!["add the parser".to_owned()]);
        // Регистр не важен, а текст ищется как подстрока, не как regexp.
        assert_eq!(by_text("PARSER"), vec!["add the parser".to_owned()]);
        assert!(by_text("par.er").is_empty());
        // Значение с ведущим дефисом не должно превратиться в опцию git.
        assert_eq!(
            by_text("-- renderer"),
            vec!["tune the -- renderer".to_owned()]
        );

        let by_author = list_log(
            root,
            20,
            false,
            &GitLogFilter {
                author: Some("sam".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(by_author.len(), 1);
        assert_eq!(by_author[0].author, "Sam");

        let by_path = list_log(
            root,
            20,
            false,
            &GitLogFilter {
                path: Some("a.txt".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(by_path.len(), 1);
        assert_eq!(by_path[0].subject, "add the parser");

        assert!(list_log(
            root,
            20,
            false,
            &GitLogFilter {
                path: Some("../outside".to_owned()),
                ..Default::default()
            },
        )
        .is_err());
    }

    // Запускает git в конкретной папке с фиксированной подписью автора.
    // Возвращает stdout: тесты ниже сверяют по нему реальное состояние Git,
    // а не только результат наших функций.
    fn git_at(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .env("GIT_AUTHOR_NAME", "Me")
            .env("GIT_AUTHOR_EMAIL", "me@t")
            .env("GIT_COMMITTER_NAME", "Me")
            .env("GIT_COMMITTER_EMAIL", "me@t")
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?} failed: {output:?}");
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn configure(root: &Path) {
        git_at(root, &["config", "core.autocrlf", "false"]);
        git_at(root, &["config", "user.name", "Me"]);
        git_at(root, &["config", "user.email", "me@t"]);
    }

    fn commit_file(root: &Path, name: &str, body: &str, message: &str) -> String {
        std::fs::write(root.join(name), body).unwrap();
        git_at(root, &["add", "--", name]);
        git_at(root, &["commit", "--quiet", "-m", message]);
        git_at(root, &["rev-parse", "HEAD"])
    }

    // «Сервер» — обычный bare-репозиторий: для git это полноценный remote, а
    // тесту не нужны ни сеть, ни учётные данные. Рабочую копию именно создаём,
    // а не клонируем: клон пустого репозитория уже прописал бы upstream в
    // конфиг, и случай «ветка ещё не опубликована» перестал бы существовать.
    fn server_and_workdir(dir: &Path) -> (PathBuf, PathBuf) {
        let bare = dir.join("server.git");
        git_at(
            dir,
            &[
                "init",
                "--quiet",
                "--bare",
                "--initial-branch=main",
                bare.to_str().unwrap(),
            ],
        );
        let work = dir.join("work");
        std::fs::create_dir(&work).unwrap();
        git_at(&work, &["init", "--quiet", "--initial-branch=main"]);
        configure(&work);
        git_at(&work, &["remote", "add", "origin", bare.to_str().unwrap()]);
        (bare, work)
    }

    // Полный цикл работы с сервером: публикация ветки, отправка, приём,
    // расхождение, rebase и выравнивание. Всё через те же функции, которые
    // вызывает панель, и с проверкой обеих сторон — локальной и серверной.
    #[test]
    fn full_remote_workflow_against_a_real_server() {
        let dir = tempfile::tempdir().unwrap();
        let (bare, work) = server_and_workdir(dir.path());
        let root = work.as_path();

        // 1. Первый коммит: ветки на сервере ещё нет, сравнивать не с чем.
        let first = commit_file(root, "a.txt", "one\n", "first");
        let summary = collect_summary(root).unwrap();
        assert_eq!(summary.branch.as_deref(), Some("main"));
        assert!(summary.upstream_ref.is_none(), "ветка ещё не опубликована");

        // 2. Публикация: ветка уезжает на сервер и получает upstream.
        publish_branch(root, "main", &first, None).unwrap();
        assert_eq!(git_at(&bare, &["rev-parse", "refs/heads/main"]), first);
        let summary = collect_summary(root).unwrap();
        assert_eq!(summary.upstream_ref.as_deref(), Some("origin/main"));
        assert_eq!((summary.ahead, summary.behind), (Some(0), Some(0)));

        // 3. Отдельная ветка от HEAD, коммит в ней и её публикация.
        create_branch(root, "feature/panel").unwrap();
        let feature = commit_file(root, "b.txt", "feature\n", "feature work");
        publish_branch(root, "feature/panel", &feature, None).unwrap();
        assert_eq!(
            git_at(&bare, &["rev-parse", "refs/heads/feature/panel"]),
            feature
        );

        // 4. Возврат на main и слияние ветки в неё.
        switch_branch(root, "main", "local").unwrap();
        assert_eq!(
            collect_summary(root).unwrap().branch.as_deref(),
            Some("main")
        );
        let head = git_at(root, &["rev-parse", "HEAD"]);
        merge_ref(root, "refs/heads/feature/panel", "main", &head, false).unwrap();
        assert!(root.join("b.txt").exists(), "слияние принесло файл ветки");

        // 5. Отправка результата: сервер догоняет локальную вершину.
        let merged = git_at(root, &["rev-parse", "HEAD"]);
        push_upstream(root, "main", &merged).unwrap();
        assert_eq!(git_at(&bare, &["rev-parse", "refs/heads/main"]), merged);
        assert_eq!(collect_summary(root).unwrap().ahead, Some(0));

        // 6. Чужой коммит на сервере: делаем его из второй рабочей копии.
        let other = dir.path().join("other");
        git_at(
            dir.path(),
            &[
                "clone",
                "--quiet",
                bare.to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        );
        configure(&other);
        let theirs = commit_file(&other, "c.txt", "from colleague\n", "colleague work");
        git_at(&other, &["push", "--quiet", "origin", "main"]);

        // Панель узнаёт о сервере через fetch — до него счётчики не меняются.
        fetch_upstream(root).unwrap();
        assert_eq!(collect_summary(root).unwrap().behind, Some(1));
        pull_upstream(root, "main", &merged).unwrap();
        assert_eq!(git_at(root, &["rev-parse", "HEAD"]), theirs);
        assert!(root.join("c.txt").exists());

        // 7. Расхождение: коммит у нас и коммит на сервере одновременно.
        let ours = commit_file(root, "d.txt", "mine\n", "my work");
        let theirs_second = commit_file(&other, "e.txt", "theirs\n", "their second");
        git_at(&other, &["push", "--quiet", "origin", "main"]);
        fetch_upstream(root).unwrap();
        let summary = collect_summary(root).unwrap();
        assert_eq!(
            (summary.ahead, summary.behind),
            (Some(1), Some(1)),
            "ветки разошлись"
        );

        // Простая перемотка тут невозможна — именно поэтому есть rebase.
        assert!(pull_upstream(root, "main", &ours).is_err());
        pull_rebase(root, "main", &ours).unwrap();
        let after_rebase = git_at(root, &["rev-parse", "HEAD"]);
        assert_ne!(after_rebase, ours, "коммит переложен, значит хеш новый");
        assert_eq!(
            git_at(root, &["rev-parse", "HEAD~1"]),
            theirs_second,
            "наш коммит лёг поверх серверного"
        );
        assert_eq!(collect_summary(root).unwrap().behind, Some(0));

        // 8. Выравнивание по серверу: коммит уходит из истории, файл остаётся.
        push_upstream(root, "main", &after_rebase).unwrap();
        let extra = commit_file(root, "f.txt", "local only\n", "local only");
        reset_to_upstream(root, "main", &extra).unwrap();
        assert_eq!(git_at(root, &["rev-parse", "HEAD"]), after_rebase);
        assert!(
            root.join("f.txt").exists(),
            "выравнивание не должно стирать файлы"
        );

        // 9. Устаревшее подтверждение отклоняется: вершина уже другая.
        assert_eq!(
            push_upstream(root, "main", &extra)
                .unwrap_err()
                .context
                .get("reason")
                .map(String::as_str),
            Some("head-moved")
        );
    }

    // Правка локальной истории рядом с уже опубликованной: панель обязана
    // разрешать первое и отказывать во втором, а не полагаться на аккуратность
    // пользователя.
    #[test]
    fn full_local_history_workflow_next_to_published_commits() {
        let dir = tempfile::tempdir().unwrap();
        let (_bare, work) = server_and_workdir(dir.path());
        let root = work.as_path();

        let published = commit_file(root, "a.txt", "one\n", "published");
        publish_branch(root, "main", &published, None).unwrap();
        let second = commit_file(root, "b.txt", "two\n", "second");
        commit_file(root, "c.txt", "three\n", "third");

        // Опубликованный коммит переписывать нельзя, локальные — можно.
        let log = list_log(root, 10, false, &GitLogFilter::default()).unwrap();
        let editable: std::collections::HashMap<&str, bool> = log
            .iter()
            .map(|commit| (commit.subject.as_str(), commit.editable))
            .collect();
        assert_eq!(editable["third"], true);
        assert_eq!(editable["second"], true);
        assert_eq!(editable["published"], false, "коммит уже на сервере");
        assert_eq!(
            reword_commit(root, &published, "rewritten")
                .unwrap_err()
                .context
                .get("reason")
                .map(String::as_str),
            Some("pushed")
        );

        // 1. Переименование сообщения: потомок сохраняется, дерево не меняется.
        let tree_before = git_at(root, &["rev-parse", "HEAD^{tree}"]);
        reword_commit(root, &second, "second, reworded").unwrap();
        let subjects: Vec<String> = list_log(root, 10, false, &GitLogFilter::default())
            .unwrap()
            .into_iter()
            .map(|commit| commit.subject)
            .collect();
        assert_eq!(subjects, ["third", "second, reworded", "published"]);
        assert_eq!(git_at(root, &["rev-parse", "HEAD^{tree}"]), tree_before);

        // 2. Дополнение последнего коммита подготовленными правками.
        std::fs::write(root.join("d.txt"), "added later\n").unwrap();
        git_at(root, &["add", "d.txt"]);
        let head = git_at(root, &["rev-parse", "HEAD"]);
        amend_commit(root, &head, None).unwrap();
        let files = list_commit_files(root, &git_at(root, &["rev-parse", "HEAD"])).unwrap();
        let mut names: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
        names.sort();
        assert_eq!(names, ["c.txt", "d.txt"]);

        // 3. Склейка двух локальных коммитов: содержимое вершины не меняется.
        let tree_before = git_at(root, &["rev-parse", "HEAD^{tree}"]);
        let head = git_at(root, &["rev-parse", "HEAD"]);
        squash_commit(root, &head, "fixup", &head).unwrap();
        let subjects: Vec<String> = list_log(root, 10, false, &GitLogFilter::default())
            .unwrap()
            .into_iter()
            .map(|commit| commit.subject)
            .collect();
        assert_eq!(subjects, ["second, reworded", "published"]);
        assert_eq!(git_at(root, &["rev-parse", "HEAD^{tree}"]), tree_before);

        // 4. Удаление коммита из середины: потомки переносятся, файл исчезает.
        let unwanted = commit_file(root, "unwanted.txt", "remove\n", "unwanted");
        commit_file(root, "keep.txt", "keep\n", "keep me");
        let head = git_at(root, &["rev-parse", "HEAD"]);
        drop_commit(root, &unwanted, &head).unwrap();
        assert!(!root.join("unwanted.txt").exists());
        assert!(root.join("keep.txt").exists());
        assert!(collect_summary(root).unwrap().files.is_empty());

        // 5. Отмена последнего коммита: изменения остаются подготовленными.
        let head = git_at(root, &["rev-parse", "HEAD"]);
        commit_action(root, "uncommit", &head, None).unwrap();
        assert!(root.join("keep.txt").exists());
        assert!(!collect_summary(root).unwrap().files.is_empty());
        git_at(root, &["commit", "--quiet", "-m", "keep me again"]);

        // 6. Сброс ветки на выбранный коммит в трёх режимах.
        let target = git_at(root, &["rev-parse", "HEAD~1"]);
        let head = git_at(root, &["rev-parse", "HEAD"]);
        reset_to_commit(root, &target, "soft", &head).unwrap();
        assert_eq!(git_at(root, &["rev-parse", "HEAD"]), target);
        assert!(root.join("keep.txt").exists(), "soft не трогает файлы");
        let head = git_at(root, &["rev-parse", "HEAD"]);
        reset_to_commit(root, &published, "hard", &head).unwrap();
        assert_eq!(git_at(root, &["rev-parse", "HEAD"]), published);
        assert!(!root.join("keep.txt").exists(), "hard вернул рабочую папку");
        assert!(!root.join("b.txt").exists());
    }

    // Жизненный цикл веток и тегов целиком: создание, переименование, удаление
    // влитой и невлитой, защита от устаревшего подтверждения, действия над
    // коммитом и сравнение состояний.
    #[test]
    fn full_branch_lifecycle_workflow() {
        let dir = tempfile::tempdir().unwrap();
        let (bare, work) = server_and_workdir(dir.path());
        let root = work.as_path();

        let first = commit_file(root, "a.txt", "one\n", "first");
        publish_branch(root, "main", &first, None).unwrap();
        let second = commit_file(root, "a.txt", "one\ntwo\n", "second");

        // 1. Создание, переименование и список веток.
        create_branch(root, "wip").unwrap();
        rename_branch(root, "wip", "feature/rename-me").unwrap();
        switch_branch(root, "main", "local").unwrap();
        let branches = list_branches(root).unwrap();
        let names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        assert!(names.contains(&"feature/rename-me"));
        assert!(!names.contains(&"wip"), "старое имя исчезло");
        let feature = branches
            .iter()
            .find(|b| b.name == "feature/rename-me")
            .unwrap();
        assert_eq!(feature.ref_name, "refs/heads/feature/rename-me");
        assert!(feature.is_merged, "ветка создана от текущей вершины");

        // 2. Влитая ветка удаляется, невлитая — только принудительно.
        delete_branch(root, "feature/rename-me", false, &feature.tip_hash).unwrap();
        create_branch(root, "unmerged").unwrap();
        let stray = commit_file(root, "stray.txt", "stray\n", "stray work");
        switch_branch(root, "main", "local").unwrap();
        assert_eq!(
            delete_branch(root, "unmerged", false, &stray)
                .unwrap_err()
                .context
                .get("reason")
                .map(String::as_str),
            Some("branch-unmerged")
        );
        // Подтверждение относится к увиденной вершине: чужой коммит не теряется.
        assert_eq!(
            delete_branch(root, "unmerged", true, &second)
                .unwrap_err()
                .context
                .get("reason")
                .map(String::as_str),
            Some("branch-moved")
        );
        delete_branch(root, "unmerged", true, &stray).unwrap();
        assert!(!list_branches(root)
            .unwrap()
            .iter()
            .any(|b| b.name == "unmerged"));
        // Текущую ветку удалить нельзя ни при каких подтверждениях.
        assert_eq!(
            delete_branch(root, "main", true, &second)
                .unwrap_err()
                .context
                .get("reason")
                .map(String::as_str),
            Some("branch-current")
        );

        // 3. Действия над коммитом: ветка от него, отделённый HEAD и возврат.
        commit_action(root, "branch", &first, Some("from-first")).unwrap();
        assert_eq!(git_at(root, &["rev-parse", "HEAD"]), first);
        switch_branch(root, "main", "local").unwrap();
        commit_action(root, "checkout", &first, None).unwrap();
        let summary = collect_summary(root).unwrap();
        assert!(summary.branch.is_none(), "HEAD отделён");
        assert_eq!(
            summary.previous_branch.as_deref(),
            Some("main"),
            "панель знает, куда вернуться"
        );
        switch_branch(root, "main", "local").unwrap();

        // 4. Перенос чужого коммита и его отмена новым коммитом.
        let side = git_at(root, &["rev-parse", "refs/heads/from-first"]);
        assert_eq!(side, first);
        let donor = commit_file(root, "donor.txt", "donor\n", "donor work");
        reset_to_commit(root, &second, "hard", &donor).unwrap();
        commit_action(root, "cherryPick", &donor, None).unwrap();
        assert!(root.join("donor.txt").exists(), "коммит применён поверх");
        let picked = git_at(root, &["rev-parse", "HEAD"]);
        commit_action(root, "revert", &picked, None).unwrap();
        assert!(!root.join("donor.txt").exists(), "отмена убрала файл");

        // 5. Теги: лёгкий и аннотированный, переход на тег и удаление.
        create_tag(root, "v1.0", &first, None).unwrap();
        create_tag(root, "v1.0-note", &first, Some("first release")).unwrap();
        assert_eq!(git_at(root, &["cat-file", "-t", "v1.0-note"]), "tag");
        switch_branch(root, "v1.0", "tag").unwrap();
        assert!(collect_summary(root).unwrap().branch.is_none());
        switch_branch(root, "main", "local").unwrap();
        delete_tag(root, "v1.0").unwrap();
        assert!(!git_at(root, &["tag", "--list"]).contains("v1.0\n"));

        // 6. Сравнение двух состояний и с рабочей папкой.
        let head = git_at(root, &["rev-parse", "HEAD"]);
        let changed = compare_files(root, &first, Some(&head)).unwrap();
        assert!(changed.iter().any(|file| file.path == "a.txt"));
        assert!(compare_file_diff(root, &first, Some(&head), "a.txt")
            .unwrap()
            .diff
            .contains("+two"));
        std::fs::write(root.join("a.txt"), "one\ntwo\nworking\n").unwrap();
        assert!(compare_file_diff(root, &head, None, "a.txt")
            .unwrap()
            .diff
            .contains("+working"));
        git_at(root, &["checkout", "--", "a.txt"]);

        // 7. Серверная ветка видна как удалённая и переключается по полному ref.
        git_at(&bare, &["branch", "release", "refs/heads/main"]);
        fetch_upstream(root).unwrap();
        let remote = list_branches(root)
            .unwrap()
            .into_iter()
            .find(|b| b.name == "origin/release")
            .expect("серверная ветка попала в список");
        assert!(remote.is_remote);
        switch_branch(root, &remote.ref_name, "remote").unwrap();
        assert_eq!(
            collect_summary(root).unwrap().branch.as_deref(),
            Some("release"),
            "создана локальная копия со слежением"
        );

        // 8. Фильтры журнала работают на реальной истории.
        let by_text = list_log(
            root,
            50,
            true,
            &GitLogFilter {
                text: Some("donor".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!by_text.is_empty());
        assert!(by_text
            .iter()
            .all(|commit| commit.subject.to_lowercase().contains("donor")));
        let by_path = list_log(
            root,
            50,
            true,
            &GitLogFilter {
                path: Some("stray.txt".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            by_path.is_empty(),
            "коммит удалённой ветки больше не в истории"
        );
    }

    // Проверка против настоящего сервера. По умолчанию пропускается: нужна
    // сеть и права на запись, а обычный прогон тестов не должен ни от того,
    // ни от другого зависеть. Запуск:
    //   MODELCREW_TEST_REMOTE=git@github.com:user/repo.git \
    //     cargo test -- --ignored live_workflow
    #[test]
    #[ignore = "требует сети и доступа на запись в указанный репозиторий"]
    fn live_workflow_against_a_real_remote() {
        let Ok(remote) = std::env::var("MODELCREW_TEST_REMOTE") else {
            panic!("не задан MODELCREW_TEST_REMOTE");
        };
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        git_at(
            dir.path(),
            &["clone", "--quiet", &remote, work.to_str().unwrap()],
        );
        let root = work.as_path();
        configure(root);

        // Имя уникально для запуска: параллельные прогоны не мешают друг другу,
        // а забытая ветка на сервере сразу опознаётся по префиксу.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let branch = format!("modelcrew-test/{}-{nanos}", std::process::id());

        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            live_scenario(root, dir.path(), &remote, &branch)
        }));

        // Ветку на сервере убираем в любом случае: наш код удалять удалённые
        // ветки не умеет намеренно, поэтому здесь это делает сам git.
        let _ = Command::new("git")
            .args(["push", "--quiet", "origin", "--delete", &branch])
            .current_dir(root)
            .output();
        if let Err(payload) = outcome {
            std::panic::resume_unwind(payload);
        }
    }

    fn live_scenario(root: &Path, dir: &Path, remote: &str, branch: &str) {
        // 1. Новая ветка и первая публикация: на сервере её ещё нет.
        create_branch(root, branch).unwrap();
        let first = commit_file(root, "live.txt", "first\n", "live: first");
        assert!(collect_summary(root).unwrap().upstream_ref.is_none());
        publish_branch(root, branch, &first, None).unwrap();

        let listed = git_at(
            root,
            &["ls-remote", "origin", &format!("refs/heads/{branch}")],
        );
        assert!(listed.starts_with(&first), "сервер принял ветку: {listed}");
        let summary = collect_summary(root).unwrap();
        assert_eq!(
            summary.upstream_ref.as_deref(),
            Some(format!("origin/{branch}").as_str())
        );
        assert_eq!((summary.ahead, summary.behind), (Some(0), Some(0)));

        // 2. Обычная отправка следующего коммита.
        let second = commit_file(root, "live.txt", "first\nsecond\n", "live: second");
        push_upstream(root, branch, &second).unwrap();
        assert!(git_at(
            root,
            &["ls-remote", "origin", &format!("refs/heads/{branch}")]
        )
        .starts_with(&second));

        // 3. Чужой коммит: вторая рабочая копия того же репозитория.
        let other = dir.join("other");
        git_at(dir, &["clone", "--quiet", remote, other.to_str().unwrap()]);
        configure(&other);
        git_at(&other, &["checkout", "--quiet", branch]);
        let theirs = commit_file(&other, "theirs.txt", "colleague\n", "live: colleague");
        git_at(&other, &["push", "--quiet", "origin", branch]);

        fetch_upstream(root).unwrap();
        assert_eq!(collect_summary(root).unwrap().behind, Some(1));
        pull_upstream(root, branch, &second).unwrap();
        assert_eq!(git_at(root, &["rev-parse", "HEAD"]), theirs);

        // 4. Расхождение и перенос поверх серверного состояния.
        let ours = commit_file(root, "ours.txt", "mine\n", "live: mine");
        let theirs_second = commit_file(&other, "theirs.txt", "colleague\nmore\n", "live: more");
        git_at(&other, &["push", "--quiet", "origin", branch]);
        fetch_upstream(root).unwrap();
        let summary = collect_summary(root).unwrap();
        assert_eq!((summary.ahead, summary.behind), (Some(1), Some(1)));
        assert!(
            pull_upstream(root, branch, &ours).is_err(),
            "перемотка невозможна на разошедшейся ветке"
        );
        pull_rebase(root, branch, &ours).unwrap();
        assert_eq!(git_at(root, &["rev-parse", "HEAD~1"]), theirs_second);
        let rebased = git_at(root, &["rev-parse", "HEAD"]);
        push_upstream(root, branch, &rebased).unwrap();

        // 5. Выравнивание по серверу: локальный коммит уходит, файл остаётся.
        let extra = commit_file(root, "extra.txt", "local only\n", "live: local only");
        reset_to_upstream(root, branch, &extra).unwrap();
        assert_eq!(git_at(root, &["rev-parse", "HEAD"]), rebased);
        assert!(root.join("extra.txt").exists());

        // 6. Отправка с устаревшим подтверждением не проходит.
        assert_eq!(
            push_upstream(root, branch, &extra)
                .unwrap_err()
                .context
                .get("reason")
                .map(String::as_str),
            Some("head-moved")
        );

        // 7. Отказ приходит и с той стороны: сервер ушёл вперёд, а наша
        // вершина не менялась, поэтому собственные проверки её пропускают —
        // ошибку обязан вернуть сам push, а не тишина.
        git_at(&other, &["fetch", "--quiet", "origin"]);
        git_at(
            &other,
            &["reset", "--hard", "--quiet", &format!("origin/{branch}")],
        );
        commit_file(&other, "ahead.txt", "server moved\n", "live: server moved");
        git_at(&other, &["push", "--quiet", "origin", branch]);
        let head = git_at(root, &["rev-parse", "HEAD"]);
        assert!(
            push_upstream(root, branch, &head).is_err(),
            "сервер должен отклонить откат ветки назад"
        );

        // 8. Недоступный репозиторий не должен подвешивать приложение: без
        // интерактивного запроса пароля git обязан упасть, а не ждать ввода.
        let broken = dir.join("broken");
        std::fs::create_dir(&broken).unwrap();
        git_at(&broken, &["init", "--quiet", "--initial-branch=main"]);
        configure(&broken);
        git_at(
            &broken,
            &[
                "remote",
                "add",
                "origin",
                "git@github.com:xpl0itK3y/modelcrew-no-such-repository.git",
            ],
        );
        let orphan = commit_file(&broken, "x.txt", "x\n", "live: unreachable");
        let started = std::time::Instant::now();
        assert!(publish_branch(&broken, "main", &orphan, None).is_err());
        assert!(
            started.elapsed() < std::time::Duration::from_secs(60),
            "падение вместо ожидания ввода: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn merges_and_rebases_by_exact_ref() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        git(&["checkout", "--quiet", "-b", "topic"]);
        std::fs::write(root.join("b.txt"), "topic\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "topic work"]);
        git(&["checkout", "--quiet", "main"]);
        std::fs::write(root.join("c.txt"), "main\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "main work"]);
        let head = head_of(&git);

        merge_ref(root, "refs/heads/topic", "main", &head, false).unwrap();
        // Сообщение должно быть привычным, без «refs/heads/» внутри.
        assert_eq!(
            String::from_utf8_lossy(&git(&["log", "-1", "--format=%s"])).trim(),
            "Merge branch 'topic'"
        );
        assert!(root.join("b.txt").exists());

        // Подтверждение относится к конкретной вершине.
        assert_eq!(
            merge_ref(root, "refs/heads/topic", "main", &head, false)
                .unwrap_err()
                .context
                .get("reason")
                .map(String::as_str),
            Some("head-moved")
        );
        // Короткое имя не принимаем: оно неоднозначно.
        assert_eq!(
            merge_ref(root, "topic", "main", &head_of(&git), false)
                .unwrap_err()
                .context
                .get("reason")
                .map(String::as_str),
            Some("ref-kind-invalid")
        );
        assert_eq!(
            merge_ref(root, "refs/heads/gone", "main", &head_of(&git), false)
                .unwrap_err()
                .context
                .get("reason")
                .map(String::as_str),
            Some("branch-missing")
        );

        // Rebase переносит коммиты ветки поверх выбранной.
        git(&["checkout", "--quiet", "-b", "feature", "refs/heads/topic"]);
        std::fs::write(root.join("d.txt"), "feature\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "feature work"]);
        let feature_head = head_of(&git);
        rebase_onto(root, "refs/heads/main", "feature", &feature_head).unwrap();
        let subjects = String::from_utf8_lossy(&git(&["log", "--format=%s"])).into_owned();
        assert!(subjects.starts_with("feature work\n"));
        assert!(subjects.contains("Merge branch 'topic'"));
    }

    #[test]
    fn keeps_a_conflicted_merge_for_the_user_to_resolve() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "base\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "base"]);
        git(&["checkout", "--quiet", "-b", "other"]);
        std::fs::write(root.join("a.txt"), "theirs\n").unwrap();
        git(&["commit", "--quiet", "-am", "theirs"]);
        git(&["checkout", "--quiet", "main"]);
        std::fs::write(root.join("a.txt"), "ours\n").unwrap();
        git(&["commit", "--quiet", "-am", "ours"]);
        let head = head_of(&git);

        let error = merge_ref(root, "refs/heads/other", "main", &head, false).unwrap_err();
        assert_eq!(
            error.context.get("reason").map(String::as_str),
            Some("merge-conflict")
        );
        // Незавершённое слияние остаётся на месте: решает пользователь.
        assert!(root.join(".git/MERGE_HEAD").exists());
        // Пока конфликт не разрешён, другие операции не вмешиваются.
        assert_eq!(
            merge_ref(root, "refs/heads/other", "main", &head, false)
                .unwrap_err()
                .context
                .get("reason")
                .map(String::as_str),
            Some("operation-in-progress")
        );
    }

    #[test]
    fn publishes_a_branch_that_has_no_upstream_yet() {
        let dir = tempfile::tempdir().unwrap();
        let bare = dir.path().join("server.git");
        let init = Command::new("git")
            .args(["init", "--quiet", "--bare", bare.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(init.status.success());

        let work = dir.path().join("work");
        std::fs::create_dir(&work).unwrap();
        let root = work.as_path();
        let git = history_repo(root);
        git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        let head = head_of(&git);

        // До публикации upstream нет, поэтому сравнивать с сервером нечего.
        assert!(collect_summary(root).unwrap().upstream_ref.is_none());
        publish_branch(root, "main", &head, None).unwrap();

        let summary = collect_summary(root).unwrap();
        assert_eq!(summary.upstream_ref.as_deref(), Some("origin/main"));
        assert_eq!(summary.ahead, Some(0));
        assert_eq!(
            String::from_utf8_lossy(&git(&["rev-parse", "refs/remotes/origin/main"])).trim(),
            head
        );
        // Повторная публикация уже связанной ветки — не то, что нужно делать.
        assert_eq!(
            publish_branch(root, "main", &head, None)
                .unwrap_err()
                .context
                .get("reason")
                .map(String::as_str),
            Some("upstream-exists")
        );
    }

    #[test]
    fn points_back_to_the_branch_left_behind_by_a_detached_head() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        git(&["commit", "--quiet", "-am", "second"]);
        assert!(collect_summary(root).unwrap().previous_branch.is_none());

        let first = String::from_utf8_lossy(&git(&["rev-parse", "HEAD~1"]))
            .trim()
            .to_owned();
        commit_action(root, "checkout", &first, None).unwrap();

        let summary = collect_summary(root).unwrap();
        assert!(summary.branch.is_none());
        assert_eq!(summary.previous_branch.as_deref(), Some("main"));
    }

    #[test]
    fn compares_two_commits_and_the_working_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        let first = head_of(&git);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("b.txt"), "new file\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "second"]);
        let second = head_of(&git);

        let between = compare_files(root, &first, Some(&second)).unwrap();
        let mut names: Vec<_> = between.iter().map(|file| file.path.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["a.txt", "b.txt"]);
        let diff = compare_file_diff(root, &first, Some(&second), "a.txt").unwrap();
        assert!(diff.diff.contains("+two"));
        assert!(!diff.is_binary);

        // Без второй стороны сравниваем с текущим рабочим деревом.
        std::fs::write(root.join("a.txt"), "one\ntwo\nworking\n").unwrap();
        let against_worktree = compare_files(root, &second, None).unwrap();
        assert_eq!(against_worktree.len(), 1);
        assert_eq!(against_worktree[0].path, "a.txt");
        assert!(compare_file_diff(root, &second, None, "a.txt")
            .unwrap()
            .diff
            .contains("+working"));

        assert!(compare_files(root, "not-a-hash", None).is_err());
        assert!(compare_file_diff(root, &first, None, "../outside").is_err());
    }

    #[test]
    fn creates_and_deletes_local_tags() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        let head = head_of(&git);

        create_tag(root, "v1.0", &head, None).unwrap();
        create_tag(root, "v1.0-annotated", &head, Some("first release")).unwrap();
        let tags = String::from_utf8_lossy(&git(&["tag", "--list"])).into_owned();
        assert!(tags.contains("v1.0"));
        assert!(tags.contains("v1.0-annotated"));
        // Аннотированный тег — отдельный объект, лёгкий указывает прямо на коммит.
        let annotated = String::from_utf8_lossy(&git(&["cat-file", "-t", "v1.0-annotated"]))
            .trim()
            .to_owned();
        assert_eq!(annotated, "tag");

        assert_eq!(
            create_tag(root, "v1.0", &head, None)
                .unwrap_err()
                .context
                .get("reason")
                .map(String::as_str),
            Some("tag-exists")
        );
        for invalid in ["-rf", "bad name", ""] {
            assert_eq!(
                create_tag(root, invalid, &head, None)
                    .unwrap_err()
                    .context
                    .get("reason")
                    .map(String::as_str),
                Some("tag-invalid"),
                "{invalid}"
            );
        }

        delete_tag(root, "v1.0").unwrap();
        assert!(!String::from_utf8_lossy(&git(&["tag", "--list"])).contains("v1.0\n"));
        assert_eq!(
            delete_tag(root, "v1.0")
                .unwrap_err()
                .context
                .get("reason")
                .map(String::as_str),
            Some("tag-missing")
        );
    }

    #[test]
    fn exports_a_commit_as_an_appliable_patch() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        git(&["commit", "--quiet", "-am", "second"]);
        let head = head_of(&git);

        let patch = commit_patch(root, &head).unwrap();
        assert!(patch.contains("Subject: [PATCH] second"));
        assert!(patch.contains("+two"));
        assert!(patch.contains("diff --git a/a.txt b/a.txt"));

        // Merge-коммит не имеет патча против одного родителя — отдаём diff.
        git(&["checkout", "--quiet", "-b", "side", "HEAD~1"]);
        std::fs::write(root.join("b.txt"), "side\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "side"]);
        git(&["checkout", "--quiet", "main"]);
        git(&["merge", "--quiet", "--no-ff", "--no-edit", "side"]);
        let merge = head_of(&git);
        let merge_patch = commit_patch(root, &merge).unwrap();
        assert!(merge_patch.contains("Merge:"), "{merge_patch}");
        assert!(merge_patch.contains("Merge branch 'side'"));

        // Самый первый коммит тоже должен экспортироваться, а не выдавать пустоту.
        let first = String::from_utf8_lossy(&git(&["rev-list", "--max-parents=0", "HEAD"]))
            .trim()
            .to_owned();
        assert!(commit_patch(root, &first).unwrap().contains("+one"));
    }

    #[test]
    fn refuses_to_rewrite_a_pushed_or_foreign_commit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);

        // Чужой автор — переписывать нельзя даже свой локальный суффикс поверх.
        std::fs::write(root.join("b.txt"), "two\n").unwrap();
        git(&["add", "."]);
        let output = Command::new("git")
            .args(["commit", "--quiet", "-m", "from a colleague"])
            .current_dir(root)
            .env("GIT_AUTHOR_NAME", "Other")
            .env("GIT_AUTHOR_EMAIL", "other@t")
            .env("GIT_COMMITTER_NAME", "Other")
            .env("GIT_COMMITTER_EMAIL", "other@t")
            .output()
            .unwrap();
        assert!(output.status.success());
        let head = head_of(&git);

        for reason in [
            amend_commit(root, &head, Some("mine now")).unwrap_err(),
            squash_commit(root, &head, "squash", &head).unwrap_err(),
            drop_commit(root, &head, &head).unwrap_err(),
        ] {
            assert_eq!(
                reason.context.get("reason").map(String::as_str),
                Some("not-yours")
            );
        }
    }

    // ---------- Безопасность: репозиторий считаем враждебным ----------

    // Репозиторий в подпапке временного каталога: рядом с ним остаётся место
    // для «внешних» файлов и маркеров, которые панель трогать не должна.
    fn repo_beside_outside(dir: &Path) -> PathBuf {
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        repo
    }

    #[test]
    fn repo_paths_that_escape_or_look_like_options_are_rejected() {
        for accepted in [
            "src/app.ts",
            "new file.txt",
            "ещё файл.md",
            "a/b/c/d.txt",
            // Дефис не в начале строки опцией стать не может: путь всегда
            // уходит в git после `--`.
            "dir/-not-an-option.txt",
            ".gitignore",
            "a.lock",
        ] {
            assert!(is_safe_repo_path(accepted), "{accepted}");
        }
        assert!(is_safe_repo_path(&"a".repeat(4096)));

        for rejected in [
            "",
            "/etc/passwd",
            "/",
            "-o",
            "-rf",
            "--output=/tmp/x",
            "..",
            "../secret",
            "../../etc/passwd",
            "a/../../etc/passwd",
            "a/..",
            "a/../b",
            "a\\b",
            "..\\..\\windows\\win.ini",
            "\\\\server\\share\\x",
            "//server/share/x",
        ] {
            assert!(!is_safe_repo_path(rejected), "{rejected}");
        }
        assert!(!is_safe_repo_path(&"a".repeat(4097)));
    }

    #[test]
    fn panel_never_touches_a_file_outside_the_repository() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, "OUTSIDE-SECRET\n").unwrap();

        let repo = repo_beside_outside(dir.path());
        let root = repo.as_path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);
        let head = head_of(&git);

        let absolute = secret.to_str().unwrap().to_owned();
        let escapes = [
            "../outside/secret.txt",
            "../../outside/secret.txt",
            "a/../../outside/secret.txt",
            "..",
            absolute.as_str(),
        ];
        for path in escapes {
            assert!(collect_file_diff(root, path).is_err(), "diff {path}");
            assert!(read_repo_file(root, path).is_err(), "read {path}");
            assert!(
                write_repo_file(root, path, "OVERWRITTEN").is_err(),
                "write {path}"
            );
            assert!(revert_file(root, path, None).is_err(), "revert {path}");
            assert!(
                commit_file_diff(root, &head, path).is_err(),
                "commit diff {path}"
            );
            assert!(
                compare_file_diff(root, &head, None, path).is_err(),
                "compare {path}"
            );
            assert!(
                list_log(
                    root,
                    20,
                    false,
                    &GitLogFilter {
                        path: Some(path.to_owned()),
                        ..Default::default()
                    },
                )
                .is_err(),
                "log {path}"
            );
        }

        // Старое имя переименованного файла — второй путь того же вызова:
        // через него checkout тоже не должен выйти за корень.
        revert_file(root, "a.txt", Some("../outside/secret.txt")).unwrap();

        assert_eq!(
            std::fs::read_to_string(&secret).unwrap(),
            "OUTSIDE-SECRET\n"
        );
        assert_eq!(
            std::fs::read_dir(&outside).unwrap().count(),
            1,
            "за корнем репозитория ничего не создано"
        );
    }

    #[test]
    fn revision_arguments_must_be_hashes_not_git_expressions() {
        assert!(is_safe_hash("abcd"));
        assert!(is_safe_hash("0123456789abcdef0123456789abcdef01234567"));
        // Hex в верхнем регистре — обычный ответ git на некоторых платформах.
        assert!(is_safe_hash("DeAdBeEf"));
        assert!(is_safe_hash(&"a".repeat(64)));
        let too_long = "a".repeat(65);
        for rejected in [
            "",
            "abc",
            too_long.as_str(),
            "HEAD",
            "master",
            "main",
            "..",
            "-x",
            "--all",
            "$(id)",
            "@{-1}",
            "HEAD~1",
            "refs/heads/main",
            "dead beef",
            "dead;id",
        ] {
            assert!(!is_safe_hash(rejected), "{rejected}");
        }

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);
        let head = head_of(&git);

        for hash in [
            "HEAD",
            "main",
            "..",
            "-x",
            "$(id)",
            "@{-1}",
            "HEAD~1",
            "refs/heads/main",
            "",
        ] {
            assert!(list_commit_files(root, hash).is_err(), "files {hash}");
            assert!(
                commit_file_diff(root, hash, "a.txt").is_err(),
                "diff {hash}"
            );
            assert!(commit_patch(root, hash).is_err(), "patch {hash}");
            assert!(compare_files(root, hash, None).is_err(), "compare {hash}");
            assert!(
                compare_file_diff(root, hash, None, "a.txt").is_err(),
                "compare diff {hash}"
            );
            assert!(
                compare_files(root, &head, Some(hash)).is_err(),
                "compare to {hash}"
            );
            assert!(
                commit_action(root, "checkout", hash, None).is_err(),
                "checkout {hash}"
            );
            assert!(
                commit_action(root, "cherryPick", hash, None).is_err(),
                "cherry-pick {hash}"
            );
            assert!(
                commit_action(root, "revert", hash, None).is_err(),
                "revert {hash}"
            );
            assert!(create_tag(root, "v1", hash, None).is_err(), "tag {hash}");
            assert!(reword_commit(root, hash, "new").is_err(), "reword {hash}");
            assert!(
                reset_to_commit(root, hash, "hard", &head).is_err(),
                "reset {hash}"
            );
            assert!(
                squash_commit(root, hash, "squash", &head).is_err(),
                "squash {hash}"
            );
            assert!(drop_commit(root, hash, &head).is_err(), "drop {hash}");
        }

        // Ни один отказ не должен был дойти до git.
        assert_eq!(head_of(&git), head);
        assert_eq!(git_at(root, &["tag", "--list"]), "");
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\n"
        );
        // Настоящий сокращённый hash при этом работает.
        assert_eq!(list_commit_files(root, &head[..12]).unwrap().len(), 1);
    }

    #[test]
    fn branch_names_cannot_become_git_options() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);
        let head = head_of(&git);
        git(&["branch", "victim"]);

        for hostile in [
            "-D",
            "-d",
            "--force",
            "--all",
            "--upload-pack=/tmp/x",
            "HEAD",
            "",
            "a b",
            "a..b",
            "a//b",
            "a/",
            "x.lock",
            "@{-1}",
            "..",
            "a\u{1}b",
        ] {
            assert!(validate_branch_name(root, hostile).is_err(), "{hostile}");
            assert!(create_branch(root, hostile).is_err(), "create {hostile}");
            assert!(
                switch_branch(root, hostile, "local").is_err(),
                "switch {hostile}"
            );
            assert!(
                rename_branch(root, "victim", hostile).is_err(),
                "rename to {hostile}"
            );
            assert!(
                rename_branch(root, hostile, "safe").is_err(),
                "rename from {hostile}"
            );
            assert!(
                delete_branch(root, hostile, true, &head).is_err(),
                "delete {hostile}"
            );
            assert!(
                commit_action(root, "branch", &head, Some(hostile)).is_err(),
                "branch at commit {hostile}"
            );
        }
        assert_eq!(
            git_at(root, &["for-each-ref", "--format=%(refname)", "refs/heads"]),
            "refs/heads/main\nrefs/heads/victim"
        );
        assert_eq!(git_at(root, &["symbolic-ref", "--short", "HEAD"]), "main");

        // Обычные имена продолжают работать.
        create_branch(root, "feature/new-thing").unwrap();
        switch_branch(root, "main", "local").unwrap();
        rename_branch(root, "victim", "renamed").unwrap();
        assert_eq!(
            git_at(root, &["for-each-ref", "--format=%(refname)", "refs/heads"]),
            "refs/heads/feature/new-thing\nrefs/heads/main\nrefs/heads/renamed"
        );
    }

    #[test]
    fn tag_names_cannot_become_git_options() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);
        let head = head_of(&git);
        // Тег с ведущим дефисом создаёт чужой репозиторий: имя приходит из
        // refs, а не от пользователя, и позиционным аргументом уходить не может.
        git(&["update-ref", "refs/tags/-rf", &head]);

        for hostile in [
            "-D", "--force", "-rf", "--delete", "..", "a..b", "", "a b", "a/",
        ] {
            assert!(validated_tag_ref(root, hostile).is_err(), "{hostile}");
            assert!(
                create_tag(root, hostile, &head, None).is_err(),
                "create {hostile}"
            );
            assert!(delete_tag(root, hostile).is_err(), "delete {hostile}");
        }
        assert_eq!(
            git_at(root, &["for-each-ref", "--format=%(refname)", "refs/tags"]),
            "refs/tags/-rf"
        );

        // Сообщение тега с ведущим дефисом остаётся данными.
        create_tag(root, "v1.0", &head, Some("-x marks the spot")).unwrap();
        assert_eq!(
            git_at(root, &["tag", "-l", "--format=%(contents)", "v1.0"]),
            "-x marks the spot"
        );
        delete_tag(root, "v1.0").unwrap();
        assert_eq!(
            git_at(root, &["for-each-ref", "--format=%(refname)", "refs/tags"]),
            "refs/tags/-rf"
        );
    }

    #[test]
    fn merge_and_rebase_only_accept_existing_full_refs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);
        let head = head_of(&git);

        for hostile in [
            "-x",
            "--no-ff",
            "--onto=/tmp/x",
            "HEAD",
            "main",
            "",
            "refs/heads/main..refs/heads/main",
            "refs/heads/missing",
            "refs/heads/a..b",
            "refs/../../etc/passwd",
        ] {
            assert!(
                merge_ref(root, hostile, "main", &head, false).is_err(),
                "merge {hostile}"
            );
            assert!(
                rebase_onto(root, hostile, "main", &head).is_err(),
                "rebase {hostile}"
            );
        }
        assert_eq!(head_of(&git), head);
        assert!(!repository_operation_in_progress(root).unwrap());
    }

    #[test]
    fn commit_messages_are_data_not_git_options() {
        assert!(validated_message("").is_err());
        assert!(validated_message("   \n\t ").is_err());
        assert!(validated_message(&"я".repeat(MAX_COMMIT_MESSAGE_CHARS + 1)).is_err());
        assert!(validated_message(&"я".repeat(MAX_COMMIT_MESSAGE_CHARS)).is_ok());
        assert!(validated_message("-x").is_ok());
        assert!(validated_message("subject\n\nbody").is_ok());

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();

        assert!(commit_all(root, "   ").is_err());
        assert!(commit_all(root, &"я".repeat(MAX_COMMIT_MESSAGE_CHARS + 1)).is_err());
        // Отказ произошёл до `add -A`: индекс не тронут.
        assert_eq!(git_at(root, &["status", "--porcelain"]), "?? a.txt");

        commit_all(root, "-x --amend").unwrap();
        assert_eq!(git_at(root, &["log", "-1", "--format=%s"]), "-x --amend");

        std::fs::write(root.join("b.txt"), "two\n").unwrap();
        commit_all(root, "subject line\n\nbody stays\n").unwrap();
        assert_eq!(git_at(root, &["log", "-1", "--format=%s"]), "subject line");
        assert_eq!(git_at(root, &["log", "-1", "--format=%b"]), "body stays");

        let head = head_of(&git);
        reword_commit(root, &head, "-m still data").unwrap();
        assert_eq!(git_at(root, &["log", "-1", "--format=%s"]), "-m still data");
        assert!(reword_commit(root, &head_of(&git), "  ").is_err());
    }

    #[test]
    fn github_identity_applies_only_to_the_created_commit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        let identity = GithubCommitIdentity {
            name: "octocat".to_owned(),
            email: "1+octocat@users.noreply.github.com".to_owned(),
        };

        commit_all_with_identity(root, "github-authored", Some(&identity)).unwrap();

        assert_eq!(
            git_at(root, &["log", "-1", "--format=%an <%ae>|%cn <%ce>"]),
            "octocat <1+octocat@users.noreply.github.com>|octocat <1+octocat@users.noreply.github.com>"
        );
        assert_eq!(git_at(root, &["config", "user.name"]), "Me");
        assert_eq!(git_at(root, &["config", "user.email"]), "me@t");
        drop(git);
    }

    #[test]
    fn history_filters_stay_data_not_git_options() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo_beside_outside(dir.path());
        let root = repo.as_path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "usual subject"]);

        let planted = dir.path().join("planted.txt");
        let filtered = |text: Option<&str>, author: Option<&str>| {
            list_log(
                root,
                20,
                false,
                &GitLogFilter {
                    text: text.map(str::to_owned),
                    author: author.map(str::to_owned),
                    path: None,
                },
            )
        };
        // `git log --output=<file>` действительно существует: если бы значение
        // фильтра стало опцией, файл появился бы на диске.
        let injections = [
            format!("--output={}", planted.display()),
            "--all".to_owned(),
            "-n1".to_owned(),
            "--exit-code".to_owned(),
        ];
        for value in &injections {
            assert!(
                filtered(Some(value.as_str()), None).unwrap().is_empty(),
                "text {value}"
            );
            assert!(
                filtered(None, Some(value.as_str())).unwrap().is_empty(),
                "author {value}"
            );
        }
        assert!(!planted.exists(), "фильтр не должен стать опцией git");

        let by_path = |path: &str| {
            list_log(
                root,
                20,
                false,
                &GitLogFilter {
                    path: Some(path.to_owned()),
                    ..Default::default()
                },
            )
        };
        assert!(by_path("-rf").is_err());
        assert!(by_path("--all").is_err());
        assert!(by_path("../outside").is_err());

        // Обычный фильтр по-прежнему находит коммит.
        assert_eq!(filtered(Some("usual"), None).unwrap().len(), 1);
        assert_eq!(filtered(None, Some("Me")).unwrap().len(), 1);
    }

    #[test]
    fn attacker_controlled_file_names_stay_inert_data() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);

        std::fs::write(root.join("-rf"), "payload\n").unwrap();
        std::fs::write(root.join("quo'te.txt"), "quoted\n").unwrap();

        let summary = collect_summary(root).unwrap();
        // Имена возвращаются байт в байт: core.quotepath=false плюс -z.
        let dashed = by_path_in(&summary, "-rf");
        assert_eq!(dashed.status, "untracked");
        assert_eq!(dashed.additions, Some(1));
        assert_eq!(by_path_in(&summary, "quo'te.txt").status, "untracked");

        // Имя, похожее на опцию, панель в git не отправляет вовсе.
        assert!(collect_file_diff(root, "-rf").is_err());
        assert!(read_repo_file(root, "-rf").is_err());
        assert!(write_repo_file(root, "-rf", "overwritten").is_err());
        assert!(revert_file(root, "-rf", None).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("-rf")).unwrap(),
            "payload\n"
        );

        // Кавычка в имени — обычный файл, а не разделитель.
        assert!(collect_file_diff(root, "quo'te.txt")
            .unwrap()
            .diff
            .contains("+quoted"));
        revert_file(root, "quo'te.txt", None).unwrap();
        assert!(!root.join("quo'te.txt").exists());
    }

    // Перевод строки в имени файла легален только на unix; проверяем, что
    // -z-разбор не превращает один файл в два (и не теряет остаток имени).
    #[cfg(unix)]
    #[test]
    fn a_newline_in_a_file_name_does_not_split_the_status_entry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        git(&["commit", "--quiet", "--allow-empty", "-m", "init"]);

        // Разделителей пути в имени быть не должно — иначе это уже вложенный
        // путь, а не одно имя файла; подделку заголовка диффа это не портит.
        let hostile = "a.txt\n--- a-dev-null\n+++ b-etc-passwd\n@@ -0,0 +1 @@\n";
        std::fs::write(root.join(hostile), "x\n").unwrap();

        let summary = collect_summary(root).unwrap();
        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].path, hostile);
        assert_eq!(summary.files[0].status, "untracked");
    }

    #[test]
    fn attacker_controlled_ref_names_stay_inert_data() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        let subject = "\u{1b}[2J\u{1b}[H not a terminal command";
        git(&["commit", "--quiet", "-m", subject]);
        let head = head_of(&git);
        // Такие refs делает только чужой репозиторий: их имена приходят из
        // refs, а не от пользователя, и опциями стать не должны.
        git(&["update-ref", "refs/heads/--help", &head]);
        git(&["update-ref", "refs/tags/--version", &head]);

        let branches = list_branches(root).unwrap();
        let hostile = branches
            .iter()
            .find(|branch| branch.name == "--help")
            .expect("ветка должна вернуться как данные");
        assert_eq!(hostile.tip_hash, head);
        assert!(!hostile.is_current);

        let log = list_log(root, 20, true, &GitLogFilter::default()).unwrap();
        assert_eq!(log[0].subject, subject);
        assert!(log[0]
            .ref_details
            .iter()
            .any(|reference| reference.name == "--help" && reference.kind == "local"));
        assert!(log[0]
            .ref_details
            .iter()
            .any(|reference| reference.name == "--version" && reference.kind == "tag"));

        assert!(switch_branch(root, "--help", "local").is_err());
        assert!(delete_branch(root, "--help", true, &head).is_err());
        assert!(delete_tag(root, "--version").is_err());
        assert_eq!(git_at(root, &["rev-parse", "refs/heads/--help"]), head);
        assert_eq!(git_at(root, &["rev-parse", "refs/tags/--version"]), head);
    }

    // .git/config чужого репозитория умеет запускать программы. Здесь заперты
    // те векторы, которые сейчас не срабатывают: pager (вывод идёт в pipe),
    // editor (сообщение всегда передаётся аргументом) и alias поверх
    // встроенных команд. Маркер лежит вне репозитория, чтобы не попасть в
    // статус и не быть удалённым самими командами.
    #[cfg(unix)]
    #[test]
    fn panel_never_runs_the_repository_pager_editor_or_aliases() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let repo = repo_beside_outside(dir.path());
        let root = repo.as_path();
        let git = history_repo(root);

        let marker = dir.path().join("marker");
        let script = dir.path().join("payload.sh");
        std::fs::write(
            &script,
            format!("#!/bin/sh\n: > \"{}\"\nexit 0\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let program = script.to_str().unwrap();
        let alias = format!("!{program}");
        git(&["config", "core.pager", program]);
        git(&["config", "core.editor", program]);
        git(&["config", "sequence.editor", program]);
        for name in ["alias.status", "alias.diff", "alias.log", "alias.commit"] {
            git(&["config", name, &alias]);
        }

        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();

        assert!(collect_summary(root).unwrap().is_repo);
        assert!(collect_file_diff(root, "a.txt")
            .unwrap()
            .diff
            .contains("+two"));
        assert!(!list_log(root, 20, false, &GitLogFilter::default())
            .unwrap()
            .is_empty());
        list_branches(root).unwrap();
        commit_all(root, "second").unwrap();
        let head = head_of(&git);
        assert_eq!(list_commit_files(root, &head).unwrap().len(), 1);
        commit_action(root, "revert", &head, None).unwrap();

        assert!(
            !marker.exists(),
            "команды панели не должны запускать программы из конфигурации репозитория"
        );
    }

    // Чужой .git/config может увести core.hooksPath куда угодно. Простой
    // просмотр репозитория — статус, дифф, история, ветки, патч — обязан
    // оставаться read-only: ни один хук не должен запуститься от того, что
    // пользователь всего лишь открыл папку.
    #[cfg(unix)]
    #[test]
    fn read_only_panel_entry_points_never_run_repository_hooks() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let repo = repo_beside_outside(dir.path());
        let root = repo.as_path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);
        let head = head_of(&git);
        git(&["branch", "other"]);
        git(&["tag", "v1"]);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("new.txt"), "fresh\n").unwrap();

        // Хуки и маркеры лежат вне рабочего дерева: внутри они сами попали бы
        // в статус и в дифф. Конфигурацию ставим после фикстуры, иначе хуки
        // сработали бы на её собственных коммитах.
        let hooks = dir.path().join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let names = [
            "pre-commit",
            "prepare-commit-msg",
            "commit-msg",
            "post-commit",
            "post-checkout",
            "post-merge",
            "post-rewrite",
            "reference-transaction",
            "pre-push",
        ];
        for name in names {
            let hook = hooks.join(name);
            std::fs::write(
                &hook,
                format!(
                    "#!/bin/sh\n: > \"{}\"\nexit 0\n",
                    dir.path().join(format!("fired-{name}")).display()
                ),
            )
            .unwrap();
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);

        let summary = collect_summary(root).unwrap();
        assert_eq!(by_path_in(&summary, "a.txt").status, "modified");
        assert_eq!(by_path_in(&summary, "new.txt").status, "untracked");
        assert!(collect_file_diff(root, "a.txt")
            .unwrap()
            .diff
            .contains("+two"));
        assert!(collect_file_diff(root, "new.txt")
            .unwrap()
            .diff
            .contains("+fresh"));
        assert!(read_repo_file(root, "a.txt")
            .unwrap()
            .content
            .contains("two"));
        assert!(!list_log(root, 20, false, &GitLogFilter::default())
            .unwrap()
            .is_empty());
        assert!(!list_log(root, 20, true, &GitLogFilter::default())
            .unwrap()
            .is_empty());
        assert!(list_branches(root)
            .unwrap()
            .iter()
            .any(|branch| branch.name == "other"));
        assert_eq!(list_commit_files(root, &head).unwrap().len(), 1);
        assert!(commit_file_diff(root, &head, "a.txt")
            .unwrap()
            .diff
            .contains("+one"));
        assert!(commit_patch(root, &head).unwrap().contains("+one"));
        assert_eq!(compare_files(root, &head, None).unwrap().len(), 1);
        assert!(compare_file_diff(root, &head, None, "a.txt")
            .unwrap()
            .diff
            .contains("+two"));

        for name in names {
            assert!(
                !dir.path().join(format!("fired-{name}")).exists(),
                "хук {name} не должен запускаться при просмотре репозитория"
            );
        }
    }

    // ext::-URL превращает fetch в запуск произвольной команды. Git запрещает
    // такой транспорт по умолчанию — фиксируем это как требование панели.
    #[cfg(unix)]
    #[test]
    fn fetch_refuses_a_command_executing_remote_url() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo_beside_outside(dir.path());
        let root = repo.as_path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);

        let marker = dir.path().join("marker");
        git(&[
            "remote",
            "add",
            "origin",
            &format!("ext::sh -c \"touch {}\"", marker.display()),
        ]);

        assert!(fetch_upstream(root).is_err());
        assert!(!marker.exists());
    }

    // insteadOf переписывает URL уже внутри git, поэтому безобидная на вид
    // ссылка на локальный путь превращается в ext::-команду. Запрет транспорта
    // обязан работать и после подстановки.
    #[cfg(unix)]
    #[test]
    fn fetch_refuses_a_remote_url_rewritten_into_a_command() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo_beside_outside(dir.path());
        let root = repo.as_path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);

        let marker = dir.path().join("marker");
        // URL указывает на несуществующий локальный путь: сети тест не касается
        // ни при каком исходе.
        let url = dir.path().join("server.git");
        git(&["remote", "add", "origin", url.to_str().unwrap()]);
        git(&[
            "config",
            &format!("url.ext::sh -c \"touch {}\".insteadOf", marker.display()),
            &format!("{}/", dir.path().display()),
        ]);

        assert!(fetch_upstream(root).is_err());
        assert!(!marker.exists());
    }

    // Конфигурация чужого репозитория не должна прятать от панели ни одного
    // изменения: невидимый в обзоре файл всё равно попадёт в коммит, ведь
    // commit_all делает `add -A`.
    #[test]
    fn summary_ignores_repository_config_that_hides_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);
        let head = head_of(&git);

        for (key, value) in [
            ("status.showUntrackedFiles", "no"),
            ("status.short", "true"),
            ("status.branch", "false"),
            ("status.relativePaths", "true"),
            ("core.quotepath", "true"),
            ("diff.noprefix", "true"),
        ] {
            git(&["config", key, value]);
        }

        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub").join("deep.txt"), "planted\n").unwrap();
        std::fs::write(root.join("ещё файл.md"), "planted\n").unwrap();

        let summary = collect_summary(root).unwrap();
        assert_eq!(summary.branch.as_deref(), Some("main"));
        assert_eq!(summary.head_hash.as_deref(), Some(head.as_str()));
        assert_eq!(by_path_in(&summary, "sub/deep.txt").status, "untracked");
        // core.quotepath=true в чужом конфиге не должен превратить имя в
        // экранированную строку: панель ищет файл по этому же имени.
        assert_eq!(by_path_in(&summary, "ещё файл.md").status, "untracked");
        let modified = by_path_in(&summary, "a.txt");
        assert_eq!(modified.status, "modified");
        assert_eq!(modified.additions, Some(1));
        assert!(collect_file_diff(root, "a.txt")
            .unwrap()
            .diff
            .contains("+two"));
    }

    // NUL проходит проверку пути, но системный вызов видит строку целиком и
    // обязан отказать: обрезка до префикса означала бы работу с чужим файлом.
    #[test]
    fn an_embedded_nul_in_a_path_never_reaches_another_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);
        let head = head_of(&git);

        for path in ["a.txt\u{0}", "a.txt\u{0}b"] {
            assert!(collect_file_diff(root, path).is_err(), "diff {path:?}");
            assert!(
                commit_file_diff(root, &head, path).is_err(),
                "commit diff {path:?}"
            );
            assert!(
                compare_file_diff(root, &head, None, path).is_err(),
                "compare {path:?}"
            );
            assert!(
                write_repo_file(root, path, "OVERWRITTEN").is_err(),
                "write {path:?}"
            );
            assert!(revert_file(root, path, None).is_err(), "revert {path:?}");
            assert!(
                list_log(
                    root,
                    20,
                    false,
                    &GitLogFilter {
                        path: Some(path.to_owned()),
                        ..Default::default()
                    },
                )
                .is_err(),
                "log {path:?}"
            );
            // Чтение либо падает, либо сообщает «файла нет», но содержимого
            // a.txt не отдаёт никогда.
            if let Ok(file) = read_repo_file(root, path) {
                assert!(!file.exists && file.content.is_empty(), "read {path:?}");
            }
        }

        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\n"
        );
        assert!(
            collect_summary(root).unwrap().files.is_empty(),
            "репозиторий должен остаться нетронутым"
        );
    }

    // Имя remote-ref приходит из чужого репозитория, а из него выводится имя
    // новой локальной ветки: она не должна стать опцией `switch -c`.
    #[test]
    fn switch_branch_rejects_hostile_remote_refs_and_unknown_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);
        let head = head_of(&git);
        git(&[
            "remote",
            "add",
            "origin",
            dir.path().join("srv.git").to_str().unwrap(),
        ]);
        git(&["update-ref", "refs/remotes/origin/feature", &head]);
        git(&["update-ref", "refs/remotes/origin/--help", &head]);

        for hostile in [
            "-x",
            "--all",
            "",
            "main",
            "refs/heads/main",
            "refs/tags/v1",
            "refs/remotes",
            "refs/remotes/../../heads/main",
            "refs/remotes/origin/--help",
            "refs/remotes/origin/missing",
        ] {
            assert!(
                switch_branch(root, hostile, "remote").is_err(),
                "remote {hostile}"
            );
        }
        for kind in ["--force", "", "Local", "branch", "remotes"] {
            assert!(switch_branch(root, "main", kind).is_err(), "kind {kind}");
        }
        assert_eq!(
            git_at(root, &["for-each-ref", "--format=%(refname)", "refs/heads"]),
            "refs/heads/main"
        );
        assert_eq!(git_at(root, &["symbolic-ref", "--short", "HEAD"]), "main");

        // Нормальный remote-ref по-прежнему создаёт отслеживающую ветку.
        switch_branch(root, "refs/remotes/origin/feature", "remote").unwrap();
        assert_eq!(
            git_at(root, &["symbolic-ref", "--short", "HEAD"]),
            "feature"
        );
        assert_eq!(git_at(root, &["config", "branch.feature.remote"]), "origin");
    }

    // Режимы и действия — такие же строки из webview, как и всё остальное:
    // каждое значение обязано проверяться по белому списку, а не подставляться
    // в командную строку git.
    #[test]
    fn mode_arguments_cannot_become_git_options() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);
        let first = head_of(&git);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "second"]);
        let head = head_of(&git);

        for mode in [
            "--hard",
            "hard --exec=touch x",
            "hard;id",
            "",
            "Hard",
            "keep",
        ] {
            assert!(
                reset_to_commit(root, &first, mode, &head).is_err(),
                "reset {mode}"
            );
        }
        for mode in ["--squash", "squash --exec=touch x", "", "Squash", "reword"] {
            assert!(
                squash_commit(root, &head, mode, &head).is_err(),
                "squash {mode}"
            );
        }
        for action in ["--exec=touch x", "", "Checkout", "switch", "reset"] {
            assert!(
                commit_action(root, action, &head, None).is_err(),
                "action {action}"
            );
        }

        assert_eq!(head_of(&git), head);
        assert_eq!(subjects(root), vec!["second".to_owned(), "init".to_owned()]);
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\ntwo\n"
        );
    }

    #[test]
    fn oversized_untracked_files_stay_within_the_panel_limits() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        git(&["commit", "--quiet", "--allow-empty", "-m", "init"]);

        // Больше и лимита подсчёта строк, и лимита диффа, и лимита редактора.
        let huge = "заполнение\n".repeat(300_000);
        assert!(huge.len() as u64 > MAX_UNTRACKED_BYTES);
        std::fs::write(root.join("huge.txt"), &huge).unwrap();

        let summary = collect_summary(root).unwrap();
        let entry = by_path_in(&summary, "huge.txt");
        assert_eq!(entry.status, "untracked");
        assert_eq!(entry.additions, None);

        let diff = collect_file_diff(root, "huge.txt").unwrap();
        assert!(diff.truncated);
        assert!(diff.diff.len() <= MAX_DIFF_BYTES + 1024);

        let content = read_repo_file(root, "huge.txt").unwrap();
        assert!(content.too_large && content.content.is_empty());

        assert!(write_repo_file(root, "huge.txt", &"a".repeat(MAX_WRITE_BYTES + 1)).is_err());
        assert_eq!(
            std::fs::metadata(root.join("huge.txt")).unwrap().len(),
            huge.len() as u64
        );
    }

    // Архив чужого репозитория может привезти симлинк на каталог за пределами
    // рабочего дерева и именованный канал. Сводка не должна ни спускаться по
    // такому симлинку, ни открывать канал (иначе поток панели встанет навсегда).
    #[cfg(unix)]
    #[test]
    fn summary_does_not_follow_a_symlinked_directory_or_open_a_pipe() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "OUTSIDE-SECRET\n").unwrap();

        let repo = repo_beside_outside(dir.path());
        let root = repo.as_path();
        let git = history_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);

        std::os::unix::fs::symlink("../outside", root.join("dirlink")).unwrap();
        std::os::unix::fs::symlink("../outside/missing", root.join("dangling")).unwrap();
        let pipe_created = Command::new("mkfifo")
            .arg(root.join("pipe"))
            .status()
            .map(|status| status.success())
            .unwrap_or(false);

        // Зависание здесь было бы неотличимо от «тест долго идёт», поэтому
        // сводку собираем в отдельном потоке со сторожевым таймером.
        let path = root.to_path_buf();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(collect_summary(&path));
        });
        let summary = receiver
            .recv_timeout(std::time::Duration::from_secs(60))
            .expect("сводка не должна зависать на специальных файлах")
            .unwrap();

        assert_eq!(by_path_in(&summary, "dirlink").status, "untracked");
        assert_eq!(by_path_in(&summary, "dirlink").additions, None);
        assert_eq!(by_path_in(&summary, "dangling").additions, None);
        assert!(
            summary
                .files
                .iter()
                .all(|file| !file.path.starts_with("dirlink/")),
            "содержимое внешнего каталога не должно попасть в сводку"
        );
        if pipe_created {
            assert!(
                summary
                    .files
                    .iter()
                    .all(|file| file.path != "pipe" || file.additions.is_none()),
                "канал не должен читаться"
            );
        }
        // Симлинк на каталог — не редактируемый файл.
        assert!(read_repo_file(root, "dirlink").is_err());
    }

    // Каталог очереди лежит внутри .git, поэтому его содержимое полностью
    // подконтрольно чужому репозиторию: подложенный marker не должен ни
    // менять config живой ветки, ни блокировать создание новых.
    #[test]
    fn planted_branch_cleanup_markers_leave_a_live_branch_config_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = history_repo(root);
        git(&["commit", "--quiet", "--allow-empty", "-m", "init"]);
        git(&["config", "branch.main.remote", "origin"]);
        git(&["config", "branch.main.merge", "refs/heads/main"]);

        let queue = root.join(".git").join("modelcrew-branch-cleanup");
        std::fs::create_dir_all(&queue).unwrap();
        std::fs::write(queue.join("1-1-1.pending"), "main\n").unwrap();
        std::fs::write(queue.join("2-2-2.pending"), "--global\n").unwrap();
        std::fs::write(queue.join("3-3-3.pending"), "\n").unwrap();

        list_branches(root).unwrap();

        assert_eq!(
            git_at(root, &["config", "--local", "branch.main.remote"]),
            "origin"
        );
        assert_eq!(
            git_at(root, &["config", "--local", "branch.main.merge"]),
            "refs/heads/main"
        );
        create_branch(root, "feature").unwrap();
        assert_eq!(
            git_at(root, &["symbolic-ref", "--short", "HEAD"]),
            "feature"
        );
    }
}
