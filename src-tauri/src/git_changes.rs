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

fn run_git(root: &Path, args: &[&str]) -> CommandResult<Vec<u8>> {
    let output = Command::new("git")
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
}
