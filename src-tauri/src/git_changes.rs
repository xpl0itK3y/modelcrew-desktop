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
    pub head_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_ref: Option<String>,
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
            head_hash: None,
            upstream_ref: None,
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
    // Машиночитаемые парсеры ниже не должны зависеть от языка ОС. Это также
    // стабилизирует диагностику Git на Windows/macOS/Linux.
    command.env("LC_ALL", "C").env("LANG", "C");
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

    Ok(GitChangesSummary {
        is_repo: true,
        branch: status.branch,
        head_hash: status.head_hash,
        upstream_ref: status.upstream_ref,
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

    let is_binary =
        tracked && String::from_utf8_lossy(&raw[..raw.len().min(4096)]).contains("Binary files ");
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
fn validate_branch_name(root: &Path, name: &str) -> CommandResult<()> {
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

fn validate_namespaced_ref(
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

fn local_branch_exists(root: &Path, name: &str) -> bool {
    local_branch_tip(root, name).is_some()
}

fn local_branch_tip(root: &Path, name: &str) -> Option<String> {
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

fn branch_config_entries(root: &Path, name: &str) -> CommandResult<Vec<(String, String)>> {
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

fn cleanup_branch_config(root: &Path, name: &str) -> CommandResult<()> {
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

fn pending_branch_cleanups(root: &Path) -> CommandResult<Vec<(PathBuf, String)>> {
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

fn queue_branch_config_cleanup(root: &Path, name: &str) -> CommandResult<()> {
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

fn git_internal_path_exists(root: &Path, name: &str) -> CommandResult<bool> {
    let raw = run_git(root, &["rev-parse", "--git-path", name])?;
    let path = PathBuf::from(String::from_utf8_lossy(&raw).trim().to_owned());
    Ok(if path.is_absolute() {
        path.exists()
    } else {
        root.join(path).exists()
    })
}

fn repository_operation_in_progress(root: &Path) -> CommandResult<bool> {
    Ok(git_internal_path_exists(root, "MERGE_HEAD")?
        || git_internal_path_exists(root, "CHERRY_PICK_HEAD")?
        || git_internal_path_exists(root, "REVERT_HEAD")?
        || git_internal_path_exists(root, "REBASE_HEAD")?
        || git_internal_path_exists(root, "rebase-merge")?
        || git_internal_path_exists(root, "rebase-apply")?
        || git_internal_path_exists(root, "sequencer")?)
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

fn parse_commit_refs(decorations: &str) -> (bool, Vec<GitCommitRef>) {
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

pub fn list_log(root: &Path, limit: u32, all_branches: bool) -> CommandResult<Vec<GitCommitInfo>> {
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
    let raw = run_git(&toplevel, &args)?;
    // Глобальный -n применяется ко всему topo-потоку. Длинная main может
    // полностью вытеснить короткую side-ветку, поэтому вторым упрощённым
    // проходом забираем tips всех branch/remote refs и topology connectors.
    let supplemental_raw = all_branches
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
) -> CommandResult<Vec<GitCommitInfo>> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || list_log(&root, limit, all.unwrap_or(false)))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

// ---------- Действия: коммит и откат файла ----------

const MAX_COMMIT_MESSAGE_CHARS: usize = 4000;

pub fn commit_all(root: &Path, message: &str) -> CommandResult<()> {
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
    tauri::async_runtime::spawn_blocking(move || revert_file(&root, &path, orig_path.as_deref()))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

// ---------- Редактирование сообщения локального коммита ----------

// Полные метаданные коммита — чтобы пересоздать его через commit-tree, сохранив
// авторство, коммиттера и даты. Меняем только текст сообщения (у цели).
struct CommitMeta {
    tree: String,
    parents: Vec<String>,
    author_name: String,
    author_email: String,
    author_date: String,
    committer_name: String,
    committer_email: String,
    committer_date: String,
    message: Vec<u8>,
}

fn read_commit_meta(root: &Path, hash: &str) -> CommandResult<CommitMeta> {
    let format = "--format=%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI";
    let raw = run_git(root, &["show", "-s", format, hash])?;
    let text = String::from_utf8_lossy(&raw);
    let fields: Vec<&str> = text.splitn(8, '\u{0}').collect();
    if fields.len() < 8 {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("hash", hash));
    }
    // Pretty-format добавляет/нормализует завершающий перевод строки. Для
    // потомков читаем message прямо из commit object и воспроизводим байт-в-байт.
    let object = run_git(root, &["cat-file", "commit", hash])?;
    let message_start = object
        .windows(2)
        .position(|pair| pair == b"\n\n")
        .map(|index| index + 2)
        .ok_or_else(|| CommandError::new(ErrorCode::GitCommandFailed).with_context("hash", hash))?;
    Ok(CommitMeta {
        tree: fields[0].trim().to_owned(),
        parents: fields[1].split_whitespace().map(str::to_owned).collect(),
        author_name: fields[2].to_owned(),
        author_email: fields[3].to_owned(),
        author_date: fields[4].to_owned(),
        committer_name: fields[5].to_owned(),
        committer_email: fields[6].to_owned(),
        committer_date: fields[7].trim_end().to_owned(),
        message: object[message_start..].to_vec(),
    })
}

// Создаёт коммит из дерева с заданными родителями и метаданными, сообщение —
// через stdin (произвольный текст). Возвращает хеш нового коммита. Индекс и
// рабочее дерево не трогаются вовсе.
fn create_commit(
    root: &Path,
    tree: &str,
    parents: &[String],
    ident: &CommitMeta,
    message: &[u8],
) -> CommandResult<String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut command = git_command();
    command.arg("commit-tree").arg(tree);
    for parent in parents {
        command.arg("-p").arg(parent);
    }
    command
        .env("GIT_AUTHOR_NAME", &ident.author_name)
        .env("GIT_AUTHOR_EMAIL", &ident.author_email)
        .env("GIT_AUTHOR_DATE", &ident.author_date)
        .env("GIT_COMMITTER_NAME", &ident.committer_name)
        .env("GIT_COMMITTER_EMAIL", &ident.committer_email)
        .env("GIT_COMMITTER_DATE", &ident.committer_date)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| CommandError::new(ErrorCode::GitUnavailable).with_debug(error))?;
    child
        .stdin
        .take()
        .ok_or_else(|| CommandError::new(ErrorCode::GitCommandFailed))?
        .write_all(message)
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?;
    let output = child
        .wait_with_output()
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?;
    if !output.status.success() {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_debug(String::from_utf8_lossy(&output.stderr).into_owned()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn on_any_remote(root: &Path, hash: &str) -> CommandResult<bool> {
    run_git(root, &["branch", "-r", "--contains", hash])
        .map(|raw| !String::from_utf8_lossy(&raw).trim().is_empty())
}

// Переписывает сообщение локального коммита. Безопасно только для не запушенных
// коммитов текущей ветки: цель и все идущие после неё (до HEAD) должны быть не
// на сервере и не merge. Дерево не меняется — конфликтов нет, рабочее дерево
// остаётся как есть. Старую вершину хранит reflog.
pub fn reword_commit(root: &Path, hash: &str, message: &str) -> CommandResult<()> {
    if !is_safe_hash(hash) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("hash", hash));
    }
    if message.trim().is_empty() || message.chars().count() > MAX_COMMIT_MESSAGE_CHARS {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "message")
        );
    }
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    if repository_operation_in_progress(&toplevel)? {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "operation-in-progress"));
    }

    // Текущая ветка (обновляем её ссылку). Detached HEAD не поддерживаем.
    let branch = run_git(&toplevel, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())
        .filter(|name| !name.is_empty());
    let Some(branch) = branch else {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "detached")
        );
    };
    validate_branch_name(&toplevel, &branch)?;
    let old_head = run_git(&toplevel, &["rev-parse", "--verify", "HEAD"])
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())?;

    // Коммит должен быть на текущей ветке (предок HEAD).
    run_git(&toplevel, &["merge-base", "--is-ancestor", hash, &old_head]).map_err(|_| {
        CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "not-on-branch")
    })?;

    // Коммиты после цели до HEAD (first-parent), новейшие первыми.
    let descendants: Vec<String> = run_git(
        &toplevel,
        &["rev-list", "--first-parent", &format!("{hash}..{old_head}")],
    )
    .map(|raw| {
        String::from_utf8_lossy(&raw)
            .lines()
            .map(|line| line.trim().to_owned())
            .filter(|line| !line.is_empty())
            .collect()
    })
    .unwrap_or_default();

    // Цель + все потомки: только не запушенные и не merge.
    let target_meta = read_commit_meta(&toplevel, hash)?;
    let mut chain: Vec<String> = Vec::with_capacity(descendants.len() + 1);
    chain.push(hash.to_owned());
    chain.extend(descendants.iter().cloned());
    for commit in &chain {
        if on_any_remote(&toplevel, commit)? {
            return Err(
                CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "pushed")
            );
        }
        let meta = read_commit_meta(&toplevel, commit)?;
        if meta.parents.len() > 1 {
            return Err(
                CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "merge")
            );
        }
    }

    // Цель — только «своя» (по локальной почте).
    let local_email = run_git(&toplevel, &["config", "user.email"])
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_lowercase())
        .unwrap_or_default();
    if local_email.is_empty() || target_meta.author_email.to_lowercase() != local_email {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "not-yours")
        );
    }

    // Пересоздаём цель с новым сообщением (родители и метаданные — прежние).
    let new_target = create_commit(
        &toplevel,
        &target_meta.tree,
        &target_meta.parents,
        &target_meta,
        message.as_bytes(),
    )?;

    // Проигрываем потомков от старшего к младшему, перецепляя родителя.
    let mut new_parent = new_target;
    for descendant in descendants.iter().rev() {
        let meta = read_commit_meta(&toplevel, descendant)?;
        new_parent = create_commit(
            &toplevel,
            &meta.tree,
            &[new_parent.clone()],
            &meta,
            &meta.message,
        )?;
    }

    // Compare-and-swap: если терминал или другой Git-клиент успел передвинуть
    // ветку, update-ref откажется и не затрёт чужую новую вершину.
    run_git(
        &toplevel,
        &[
            "update-ref",
            "-m",
            "modelcrew: reword commit",
            &format!("refs/heads/{branch}"),
            &new_parent,
            &old_head,
        ],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn git_reword_commit(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    hash: String,
    message: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || reword_commit(&root, &hash, &message))
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

        let log = list_log(root, 10, false).unwrap();
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

        let decorated = list_log(root, 10, false).unwrap();
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

        let log = list_log(root, 10, false).unwrap();
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
        assert!(list_log(fresh.path(), 10, false).unwrap().is_empty());
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
            let log = list_log(root, 50, all_branches).unwrap();
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

        let log = list_log(root, 500, true).unwrap();
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

        let branch_log = list_log(root, 50, true).unwrap();
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
        let detached_log = list_log(root, 50, true).unwrap();
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

        let log = list_log(root, 10, false).unwrap();
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
        let head_only = list_log(root, 50, false).unwrap();
        assert!(!head_only.iter().any(|c| c.subject == "clash version"));
        let all_refs = list_log(root, 50, true).unwrap();
        assert!(all_refs.iter().any(|c| c.subject == "clash version"));

        // Detached HEAD: ветки нет, но история и статус работают.
        let log = list_log(root, 10, false).unwrap();
        assert!(log[0].subject.contains("main version"));
        git(&["checkout", "--quiet", &log[1].hash]);
        let summary = collect_summary(root).unwrap();
        assert!(summary.is_repo);
        assert_eq!(summary.branch, None, "detached HEAD — без имени ветки");
        assert!(!list_log(root, 5, false).unwrap().is_empty());
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
        commit_all(root, "panel commit").unwrap();
        let summary = collect_summary(root).unwrap();
        assert!(summary.files.is_empty());
        assert!(commit_all(root, "   ").is_err());
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
        git(&["config", "user.name", "t"]);
        git(&["config", "user.email", "t@t"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "first"]);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "second"]);

        let log = list_log(root, 10, false).unwrap();
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
        let tip = list_log(root, 1, false).unwrap()[0].hash.clone();
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
        let side = list_log(root, 20, true)
            .unwrap()
            .into_iter()
            .find(|commit| commit.subject == "side commit")
            .unwrap();
        assert!(side.local_only);
        assert!(!side.editable, "боковая ветка не входит в reword-цепочку");

        let before = list_log(root, 10, false).unwrap(); // third, second, first
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

        let after = list_log(root, 10, false).unwrap();
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
        git(&["config", "user.name", "Me"]);
        git(&["config", "user.email", "me@t"]);
        git(&["commit", "--quiet", "--allow-empty", "-m", "base"]);
        git(&["branch", "side"]);
        git(&["commit", "--quiet", "--allow-empty", "-m", "main work"]);
        git(&["checkout", "--quiet", "side"]);
        git(&["commit", "--quiet", "--allow-empty", "-m", "side work"]);
        git(&["checkout", "--quiet", "main"]);
        git(&["merge", "--quiet", "--no-ff", "side", "-m", "merge side"]);

        assert!(list_log(root, 20, true)
            .unwrap()
            .iter()
            .all(|commit| !commit.editable));

        git(&["commit", "--quiet", "--allow-empty", "-m", "after merge"]);
        let log = list_log(root, 20, true).unwrap();
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
        run(&["config", "user.name", "Me"], "me@t");
        run(&["config", "user.email", "me@t"], "me@t");
        std::fs::write(root.join("a.txt"), "1\n").unwrap();
        run(&["add", "."], "me@t");
        run(&["commit", "--quiet", "-m", "mine"], "me@t");
        // Коммит другого автора.
        std::fs::write(root.join("b.txt"), "x\n").unwrap();
        run(&["add", "."], "other@t");
        run(&["commit", "--quiet", "-m", "theirs"], "other@t");

        let log = list_log(root, 10, false).unwrap(); // theirs, mine
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
        let head = list_log(root, 1, false).unwrap()[0].hash.clone();
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
        let pushed = list_log(root, 20, false)
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
        assert!(list_log(root, 1, false).unwrap()[0].local_only);

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

        let commit = list_log(root, 1, false).unwrap().remove(0);
        assert_eq!(commit.remote_refs, vec!["upstream/main"]);
        assert!(!commit.local_only);
        assert!(commit_action(root, "uncommit", &commit.hash, None).is_err());
        assert!(list_log(root, 1, false).unwrap()[0].is_head);
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
}
