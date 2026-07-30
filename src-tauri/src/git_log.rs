//! Чтение журнала коммитов: разбор вывода `git log`, топологическая склейка
//! графа веток, фильтры поиска, файлы коммита и диффы по ним.
//!
//! Вертикаль ничего не меняет в репозитории. Отсюда и разница с соседями: у
//! неё нет ни сверки «ветка и HEAD те же, что видел фронт», ни отказов посреди
//! незавершённого merge — эти проверки нужны тем, кто пишет, а не читает.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::command_error::{CommandError, CommandResult, ErrorCode};
use crate::git_changes::*;
use crate::workspace_roots::WorkspaceRoots;

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

// Проверки вертикали лежат рядом, отдельным файлом: их вдвое больше кода.
#[cfg(test)]
#[path = "git_log_tests.rs"]
mod tests;
