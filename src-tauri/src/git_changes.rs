// Панель «Изменения»: сводка git-статуса проекта и diff отдельных файлов.
// Команды выполняются строго в корне воркспейса из реестра, аргументы идут
// массивом (без шелла). Парсеры вынесены в чистые функции под юнит-тесты.

use crate::command_error::{CommandError, CommandResult, ErrorCode};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
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
            branch: None,
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
fn git_command() -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn run_git(root: &Path, args: &[&str]) -> CommandResult<Vec<u8>> {
    let output = git_command()
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

// ---------- Парсер `git status --porcelain=v2 --branch -z` ----------

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedStatus {
    pub branch: Option<String>,
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
            if let Some(head) = header.strip_prefix("branch.head ") {
                if head != "(detached)" {
                    parsed.branch = Some(head.to_owned());
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

fn repo_toplevel(root: &Path) -> CommandResult<Option<PathBuf>> {
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
    let Some(toplevel) = repo_toplevel(root)? else {
        return Ok(GitChangesSummary::not_a_repo());
    };

    let status_raw = run_git(
        &toplevel,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "--branch",
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
                counts
                    .get(&path)
                    .copied()
                    .unwrap_or((Some(0), Some(0)))
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

    Ok(GitChangesSummary {
        is_repo: true,
        branch: status.branch,
        ahead: status.ahead,
        behind: status.behind,
        files,
    })
}

fn is_safe_repo_path(path: &str) -> bool {
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
    let tracked = run_git(
        &toplevel,
        &["ls-files", "--error-unmatch", "--", path],
    )
    .is_ok();
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

    let is_binary = tracked
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
        &raw[..]
    };

    Ok(GitFileDiff {
        path: path.to_owned(),
        is_binary,
        truncated,
        diff: String::from_utf8_lossy(clipped).into_owned(),
    })
}

// ---------- Ветки и история ----------

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    // Ветка существует только на сервере: переключение создаст локальную
    // копию со слежением.
    pub is_remote: bool,
    // Unix-время последнего коммита в миллисекундах (для сортировки/подписи).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_commit_at: Option<i64>,
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
    // Декорации коммита: ветки/теги, указывающие на него.
    pub refs: Vec<String>,
    // Тело коммита без трейлеров Co-authored-by (они в co_authors).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub body: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub co_authors: Vec<String>,
}

// Отделяет соавторов от остального тела коммита.
pub fn split_body_and_co_authors(raw_body: &str) -> (String, Vec<String>) {
    let mut body_lines = Vec::new();
    let mut co_authors = Vec::new();
    for line in raw_body.lines() {
        let trimmed = line.trim();
        if let Some(author) = trimmed
            .strip_prefix("Co-authored-by:")
            .or_else(|| trimmed.strip_prefix("Co-Authored-By:"))
            .or_else(|| trimmed.strip_prefix("co-authored-by:"))
        {
            let author = author.trim();
            if !author.is_empty() {
                co_authors.push(author.to_owned());
            }
        } else {
            body_lines.push(line);
        }
    }
    (body_lines.join("\n").trim().to_owned(), co_authors)
}

// Имя ветки, безопасное для передачи git-у аргументом.
pub fn is_safe_ref_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && !name.starts_with('-')
        && !name.starts_with('.')
        && !name.contains("..")
        && !name.contains("@{")
        && !name.ends_with(".lock")
        && name
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, '.' | '_' | '-' | '/'))
}

pub fn list_branches(root: &Path) -> CommandResult<Vec<GitBranch>> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    let raw = run_git(
        &toplevel,
        &[
            "for-each-ref",
            "refs/heads",
            "--sort=-committerdate",
            "--format=%(HEAD)%1f%(refname:short)%1f%(committerdate:unix)",
        ],
    )?;
    let text = String::from_utf8_lossy(&raw);
    let mut branches: Vec<GitBranch> = text
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\u{1f}');
            let head = parts.next()?;
            let name = parts.next()?;
            let date = parts.next().and_then(|value| value.trim().parse::<i64>().ok());
            Some(GitBranch {
                name: name.to_owned(),
                is_current: head == "*",
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
            "--format=%(refname:short)%1f%(committerdate:unix)",
        ],
    ) {
        let text = String::from_utf8_lossy(&raw);
        for line in text.lines() {
            let mut parts = line.split('\u{1f}');
            let Some(full_name) = parts.next() else {
                continue;
            };
            // origin/HEAD — указатель, не ветка.
            let Some((_, short_name)) = full_name.split_once('/') else {
                continue;
            };
            if short_name == "HEAD" || local_names.contains(short_name) {
                continue;
            }
            let date = parts.next().and_then(|value| value.trim().parse::<i64>().ok());
            branches.push(GitBranch {
                name: full_name.to_owned(),
                is_current: false,
                is_remote: true,
                last_commit_at: date.map(|seconds| seconds * 1000),
            });
        }
    }
    Ok(branches)
}

// Фоновый fetch: обновляет refs/remotes, чтобы ↑/↓ показывали реальное
// расхождение с сервером. Никогда не спрашивает пароль (терминала у него
// нет) и обрывает зависший HTTP: лучше тихо не получиться, чем повиснуть.
pub fn fetch_upstream(root: &Path) -> CommandResult<()> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    let output = git_command()
        .args([
            "-c",
            "http.lowSpeedLimit=1000",
            "-c",
            "http.lowSpeedTime=15",
            "fetch",
            "--quiet",
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes")
        .current_dir(&toplevel)
        .output()
        .map_err(|error| CommandError::new(ErrorCode::GitUnavailable).with_debug(error))?;
    if !output.status.success() {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_debug(String::from_utf8_lossy(&output.stderr).chars().take(1024).collect::<String>()));
    }
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

pub fn switch_branch(root: &Path, name: &str, remote: bool) -> CommandResult<()> {
    if !is_safe_ref_name(name) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("branch", name));
    }
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    if remote {
        // Создаёт локальную ветку со слежением за серверной и переключается.
        run_git(&toplevel, &["checkout", "--track", name])?;
    } else {
        run_git(&toplevel, &["checkout", name])?;
    }
    Ok(())
}

pub fn list_log(root: &Path, limit: u32) -> CommandResult<Vec<GitCommitInfo>> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    let limit = limit.clamp(1, 500);
    let count = format!("-n{limit}");
    let raw = match run_git(
        &toplevel,
        &[
            "log",
            &count,
            "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1f%b%x1e",
        ],
    ) {
        Ok(raw) => raw,
        // Пустой репозиторий без коммитов — не ошибка, а пустая история.
        Err(_) => return Ok(Vec::new()),
    };
    let text = String::from_utf8_lossy(&raw);
    Ok(text
        .split('\u{1e}')
        .filter_map(|record| {
            let record = record.trim_start_matches(['\n', '\r']);
            let mut parts = record.split('\u{1f}');
            let hash = parts.next()?.trim();
            if hash.is_empty() {
                return None;
            }
            let short_hash = parts.next()?.to_owned();
            let author = parts.next()?.to_owned();
            let author_email = parts.next()?.to_owned();
            let epoch = parts.next().and_then(|value| value.trim().parse::<i64>().ok())?;
            let subject = parts.next()?.to_owned();
            let refs = parts
                .next()
                .map(|decorations| {
                    decorations
                        .split(", ")
                        .map(|entry| entry.trim().trim_start_matches("HEAD -> "))
                        .filter(|entry| !entry.is_empty() && *entry != "HEAD")
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let (body, co_authors) =
                split_body_and_co_authors(parts.next().unwrap_or_default());
            Some(GitCommitInfo {
                hash: hash.to_owned(),
                short_hash,
                subject,
                author,
                author_email,
                epoch_ms: epoch * 1000,
                refs,
                body,
                co_authors,
            })
        })
        .collect())
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

fn is_safe_hash(hash: &str) -> bool {
    (4..=64).contains(&hash.len()) && hash.chars().all(|ch| ch.is_ascii_hexdigit())
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
    remote: Option<bool>,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        switch_branch(&root, &branch, remote.unwrap_or(false))
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
) -> CommandResult<Vec<GitCommitInfo>> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || list_log(&root, limit))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

// ---------- Действия: коммит и откат файла ----------

const MAX_COMMIT_MESSAGE_CHARS: usize = 4000;

pub fn commit_all(root: &Path, message: &str) -> CommandResult<()> {
    let message = message.trim();
    if message.is_empty() || message.chars().count() > MAX_COMMIT_MESSAGE_CHARS {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "message"));
    }
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    run_git(&toplevel, &["add", "-A"])?;
    run_git(&toplevel, &["commit", "-m", message])?;
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
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    message: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || commit_all(&root, &message))
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
    tauri::async_runtime::spawn_blocking(move || {
        revert_file(&root, &path, orig_path.as_deref())
    })
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
    let mut components = relative.components().map(|part| {
        part.as_os_str().to_string_lossy().into_owned()
    });
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
    let mut watcher = notify::recommended_watcher(
        move |event: Result<notify::Event, notify::Error>| {
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
        },
    )?;
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

    #[test]
    fn parses_branch_and_counts_from_porcelain() {
        let raw = b"# branch.oid abc\0# branch.head main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 abc def src/app.ts\0\
1 A. N... 000000 100644 100644 000 def new file.txt\0\
? untracked.md\0";
        let parsed = parse_porcelain_status(raw);
        assert_eq!(parsed.branch.as_deref(), Some("main"));
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
        assert_eq!((fresh.path.as_str(), fresh.status), ("fresh.txt", "untracked"));
        assert_eq!(fresh.additions, Some(1));
        let tracked = &summary.files[1];
        assert_eq!((tracked.path.as_str(), tracked.status), ("tracked.txt", "modified"));
        assert_eq!(tracked.additions, Some(2));
        assert_eq!(tracked.deletions, Some(1));

        let diff = collect_file_diff(root, "tracked.txt").unwrap();
        assert!(diff.diff.contains("+TWO"));
        assert!(diff.diff.contains("-two"));
        let fresh_diff = collect_file_diff(root, "fresh.txt").unwrap();
        assert!(fresh_diff.diff.contains("+hello"));

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
        assert_eq!(co_authors, vec!["Alex <a@t>".to_owned(), "Kim <k@t>".to_owned()]);
        let (empty_body, none) = split_body_and_co_authors("");
        assert_eq!(empty_body, "");
        assert!(none.is_empty());
    }

    #[test]
    fn validates_branch_names() {
        assert!(is_safe_ref_name("main"));
        assert!(is_safe_ref_name("feature/agent-resume"));
        assert!(is_safe_ref_name("v1.2.3"));
        assert!(!is_safe_ref_name(""));
        assert!(!is_safe_ref_name("-rf"));
        assert!(!is_safe_ref_name("a..b"));
        assert!(!is_safe_ref_name("bad name"));
        assert!(!is_safe_ref_name("head@{1}"));
        assert!(!is_safe_ref_name("x.lock"));
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

        let log = list_log(root, 10).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].subject, "second commit");
        assert_eq!(log[0].author, "Denis");
        assert_eq!(log[0].author_email, "d@t");
        assert_eq!(log[0].body, "Detailed description of the change.");
        assert_eq!(log[0].co_authors, vec!["Alex <alex@t>".to_owned()]);
        assert!(log[0].epoch_ms > 0);
        assert!(log[0].refs.iter().any(|entry| entry == "feature/x"));
        // Однострочный коммит: без тела и соавторов.
        assert_eq!(log[1].body, "");
        assert!(log[1].co_authors.is_empty());

        // Файлы конкретного коммита: b.txt добавлен вторым коммитом.
        let files = list_commit_files(root, &log[0].hash).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "b.txt");
        assert_eq!(files[0].additions, Some(1));
        assert!(list_commit_files(root, "not-a-hash").is_err());

        switch_branch(root, "main", false).unwrap();
        let branches = list_branches(root).unwrap();
        assert_eq!(
            branches.iter().find(|branch| branch.is_current).unwrap().name,
            "main"
        );
        assert!(switch_branch(root, "no-such-branch", false).is_err());

        // Ветка только на «сервере» (bare-репозиторий): попадает в список с
        // пометкой is_remote, переключение создаёт локальную со слежением.
        let remote_dir = tempfile::tempdir().unwrap();
        let bare = Command::new("git")
            .args(["init", "--bare", "--quiet"])
            .current_dir(remote_dir.path())
            .output()
            .unwrap();
        assert!(bare.status.success());
        git(&["remote", "add", "origin", remote_dir.path().to_str().unwrap()]);
        git(&["push", "--quiet", "origin", "main", "feature/x"]);
        git(&["branch", "-D", "feature/x"]);

        let branches = list_branches(root).unwrap();
        let remote_only = branches
            .iter()
            .find(|branch| branch.name == "origin/feature/x")
            .expect("remote-only branch listed");
        assert!(remote_only.is_remote);
        // main существует локально — origin/main дублем не показывается.
        assert!(!branches.iter().any(|branch| branch.name == "origin/main"));

        switch_branch(root, "origin/feature/x", true).unwrap();
        let branches = list_branches(root).unwrap();
        assert_eq!(
            branches.iter().find(|branch| branch.is_current).unwrap().name,
            "feature/x"
        );

        // Кто-то запушил в main с другой машины: fetch обновляет refs/remotes,
        // и статус показывает отставание (стрелка ↓ в панели).
        switch_branch(root, "main", false).unwrap();
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
        run_at(&clone_path, &["commit", "--quiet", "-m", "from another machine"]);
        run_at(&clone_path, &["push", "--quiet", "origin", "main"]);

        fetch_upstream(root).unwrap();
        let summary = collect_summary(root).unwrap();
        assert_eq!(summary.behind, Some(1));

        // Пустой репозиторий: история пуста, а не ошибка.
        let fresh = tempfile::tempdir().unwrap();
        let init = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(fresh.path())
            .output()
            .unwrap();
        assert!(init.status.success());
        assert!(list_log(fresh.path(), 10).unwrap().is_empty());
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
        git(&["config", "user.name", "t"]);
        git(&["config", "user.email", "t@t"]);
        std::fs::write(root.join("a.txt"), "original\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);

        // Откат правки отслеживаемого файла возвращает содержимое HEAD.
        std::fs::write(root.join("a.txt"), "edited\n").unwrap();
        revert_file(root, "a.txt", None).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "original\n");

        // Откат нового файла удаляет его.
        std::fs::write(root.join("fresh.txt"), "temp\n").unwrap();
        revert_file(root, "fresh.txt", None).unwrap();
        assert!(!root.join("fresh.txt").exists());

        // Откат переименования: старое имя возвращается, новое исчезает.
        git(&["mv", "a.txt", "b.txt"]);
        revert_file(root, "b.txt", Some("a.txt")).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "original\n");
        assert!(!root.join("b.txt").exists());
        assert!(collect_summary(root).unwrap().files.is_empty());

        // Коммит из панели забирает всё, включая новые файлы.
        std::fs::write(root.join("a.txt"), "committed\n").unwrap();
        std::fs::write(root.join("new.txt"), "brand new\n").unwrap();
        commit_all(root, "panel commit").unwrap();
        let summary = collect_summary(root).unwrap();
        assert!(summary.files.is_empty());
        assert!(commit_all(root, "   ").is_err());
    }
}
