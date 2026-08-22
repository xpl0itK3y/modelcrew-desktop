//! Правка локальной истории: сообщение коммита, отмена последнего коммита,
//! удаление коммита, удаление тегов, а также действия над коммитом из меню
//! панели (переход, ветка отсюда, cherry-pick, revert).
//!
//! Вертикаль отделена от статусов, диффов и веток: у неё своя цена ошибки —
//! эти операции перезаписывают историю, поэтому каждая сначала проверяет, что
//! рабочее дерево и HEAD те же, что видел фронт.

use std::path::Path;

use crate::command_error::{CommandError, CommandResult, ErrorCode};
use crate::git_branches::{
    ensure_no_pending_branch_cleanup, local_branch_exists, validate_branch_name,
    validate_namespaced_ref,
};
use crate::git_changes::*;
use crate::workspace_roots::WorkspaceRoots;

// ---------- Редактирование сообщения локального коммита ----------

// Полные метаданные коммита — чтобы пересоздать его через commit-tree, сохранив
// авторство, коммиттера и даты. Меняем только текст сообщения (у цели).
pub(crate) struct CommitMeta {
    pub(crate) tree: String,
    pub(crate) parents: Vec<String>,
    pub(crate) author_name: String,
    pub(crate) author_email: String,
    pub(crate) author_date: String,
    pub(crate) committer_name: String,
    pub(crate) committer_email: String,
    pub(crate) committer_date: String,
    pub(crate) message: Vec<u8>,
}

pub(crate) fn read_commit_meta(root: &Path, hash: &str) -> CommandResult<CommitMeta> {
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

pub(crate) fn on_any_remote(root: &Path, hash: &str) -> CommandResult<bool> {
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
    let message = validated_message(message)?;
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    if repository_operation_in_progress(&toplevel)? {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "operation-in-progress"));
    }
    let (branch, old_head) = current_branch_and_head(&toplevel)?;
    let descendants = editable_chain(&toplevel, hash, &old_head)?;

    // Пересоздаём цель с новым сообщением (родители и метаданные — прежние),
    // затем перецепляем потомков: деревья не меняются, конфликтов нет.
    let target_meta = read_commit_meta(&toplevel, hash)?;
    let new_target = create_commit(
        &toplevel,
        &target_meta.tree,
        &target_meta.parents,
        &target_meta,
        message.as_bytes(),
    )?;
    let tip = replay_descendants(&toplevel, &descendants, new_target)?;
    move_branch(
        &toplevel,
        &branch,
        "modelcrew: reword commit",
        &tip,
        &old_head,
    )
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

// ---------- Правка локальной истории ----------

// Ветка и её вершина. Отделённый HEAD не поддерживаем: переписывать историю
// можно только там, где есть именованная точка, которую восстановит reflog.
fn current_branch_and_head(root: &Path) -> CommandResult<(String, String)> {
    let branch = run_git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())
        .ok()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "detached")
        })?;
    validate_branch_name(root, &branch)?;
    let head = run_git(root, &["rev-parse", "--verify", "HEAD^{commit}"])
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())?;
    if !is_safe_hash(&head) {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "head-moved")
        );
    }
    Ok((branch, head))
}

// Общий вход в любую перезапись истории: нет чужой незавершённой операции, мы
// на ветке, и её вершина — ровно та, которую пользователь видел в панели.
fn ensure_history_snapshot(root: &Path, expected_head: &str) -> CommandResult<(String, String)> {
    if !is_safe_hash(expected_head) {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "head-moved")
        );
    }
    if repository_operation_in_progress(root)? {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "operation-in-progress"));
    }
    let (branch, head) = current_branch_and_head(root)?;
    if head != expected_head {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "head-moved")
        );
    }
    Ok((branch, head))
}

// Коммиты между целью и HEAD (не включая цель), новейшие первыми. Проверяет,
// что весь переписываемый суффикс безопасен: ничего из него нет на сервере, нет
// merge-коммитов и все авторы — локальный пользователь. Ровно это же условие
// вычисляет `list_log` для флага `editable`, поэтому UI и бэкенд не расходятся.
fn editable_chain(root: &Path, target: &str, head: &str) -> CommandResult<Vec<String>> {
    run_git(root, &["merge-base", "--is-ancestor", target, head]).map_err(|_| {
        CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "not-on-branch")
    })?;
    let descendants: Vec<String> = run_git(
        root,
        &["rev-list", "--first-parent", &format!("{target}..{head}")],
    )
    .map(|raw| {
        String::from_utf8_lossy(&raw)
            .lines()
            .map(|line| line.trim().to_owned())
            .filter(|line| !line.is_empty())
            .collect()
    })
    .unwrap_or_default();

    let local_email = run_git(root, &["config", "user.email"])
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_lowercase())
        .unwrap_or_default();
    let mut chain = Vec::with_capacity(descendants.len() + 1);
    chain.push(target.to_owned());
    chain.extend(descendants.iter().cloned());
    for commit in &chain {
        ensure_rewritable(root, commit, &local_email)?;
    }
    Ok(descendants)
}

fn ensure_rewritable(root: &Path, commit: &str, local_email: &str) -> CommandResult<()> {
    if on_any_remote(root, commit)? {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "pushed"));
    }
    let meta = read_commit_meta(root, commit)?;
    if meta.parents.len() > 1 {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "merge"));
    }
    if local_email.is_empty() || meta.author_email.to_lowercase() != local_email {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "not-yours")
        );
    }
    Ok(())
}

// Пересоздаёт потомков поверх новой базы, меняя только родителя. Деревья не
// трогаются, поэтому конфликтов быть не может, а вершина сохраняет своё
// содержимое — рабочая папка остаётся согласованной с историей.
fn replay_descendants(
    root: &Path,
    descendants: &[String],
    mut new_parent: String,
) -> CommandResult<String> {
    for descendant in descendants.iter().rev() {
        let meta = read_commit_meta(root, descendant)?;
        new_parent = create_commit(
            root,
            &meta.tree,
            &[new_parent.clone()],
            &meta,
            &meta.message,
        )?;
    }
    Ok(new_parent)
}

// Переставляет ветку на новую вершину только если она всё ещё указывает на ту,
// с которой мы начали: параллельный коммит из терминала не будет потерян.
fn move_branch(root: &Path, branch: &str, reason: &str, to: &str, from: &str) -> CommandResult<()> {
    run_git(
        root,
        &[
            "update-ref",
            "-m",
            reason,
            &format!("refs/heads/{branch}"),
            to,
            from,
        ],
    )
    .map(|_| ())
    .map_err(|_| {
        CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "head-moved")
    })
}

pub(crate) fn validated_message(message: &str) -> CommandResult<&str> {
    if message.trim().is_empty() || message.chars().count() > MAX_COMMIT_MESSAGE_CHARS {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "message")
        );
    }
    Ok(message)
}

// Трёхсторонний merge без рабочей папки: возвращает дерево «ours + правки
// theirs относительно base». Это семантика cherry-pick, но ни индекс, ни файлы
// на диске не затрагиваются, поэтому параллельная работа в терминале цела.
fn merge_tree(root: &Path, base: &str, ours: &str, theirs: &str) -> CommandResult<String> {
    let output = git_command()
        .args([
            "merge-tree",
            "--write-tree",
            &format!("--merge-base={base}"),
            ours,
            theirs,
        ])
        .current_dir(root)
        .output()
        .map_err(|error| CommandError::new(ErrorCode::GitUnavailable).with_debug(error))?;
    if output.status.success() {
        let tree = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_owned();
        if is_safe_hash(&tree) {
            return Ok(tree);
        }
        return Err(CommandError::new(ErrorCode::GitCommandFailed));
    }
    // Код 1 — обычный конфликт содержимого; всё остальное значит, что git не
    // понял команду (например, слишком старый для `merge-tree --write-tree`).
    let reason = if output.status.code() == Some(1) {
        "replay-conflict"
    } else {
        "git-too-old"
    };
    Err(CommandError::new(ErrorCode::GitCommandFailed)
        .with_context("reason", reason)
        .with_debug(String::from_utf8_lossy(&output.stderr).into_owned()))
}

// Убирает коммит из истории ветки, перенося его потомков на родителя. В отличие
// от squash дерево вершины меняется, поэтому требуем чистую рабочую папку и
// обновляем её вместе со ссылкой — иначе правки пользователя разъехались бы с
// историей. При конфликте ничего не меняется: ошибка возвращается до записи.
pub fn drop_commit(root: &Path, hash: &str, expected_head: &str) -> CommandResult<()> {
    if !is_safe_hash(hash) {
        return Err(CommandError::new(ErrorCode::GitCommandFailed).with_context("hash", hash));
    }
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    let (_, head) = ensure_history_snapshot(&toplevel, expected_head)?;
    if !run_git(&toplevel, &["status", "--porcelain", "-z"])?.is_empty() {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "dirty-tree")
        );
    }
    let target = run_git(
        &toplevel,
        &["rev-parse", "--verify", &format!("{hash}^{{commit}}")],
    )
    .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())?;
    let descendants = editable_chain(&toplevel, &target, &head)?;
    let target_meta = read_commit_meta(&toplevel, &target)?;
    let [base] = target_meta.parents.as_slice() else {
        return Err(
            CommandError::new(ErrorCode::GitCommandFailed).with_context("reason", "parent-count")
        );
    };

    let mut tip = base.clone();
    for descendant in descendants.iter().rev() {
        let meta = read_commit_meta(&toplevel, descendant)?;
        let [old_parent] = meta.parents.as_slice() else {
            return Err(CommandError::new(ErrorCode::GitCommandFailed)
                .with_context("reason", "parent-count"));
        };
        let tree = merge_tree(&toplevel, old_parent, &tip, descendant)?;
        tip = create_commit(&toplevel, &tree, &[tip.clone()], &meta, &meta.message)?;
    }

    // Новая вершина несёт другое дерево, поэтому ссылку и рабочую папку двигаем
    // одной командой. `--keep` откажется работать, если между проверкой и
    // выполнением появились правки, которые пришлось бы затереть.
    ensure_history_snapshot(&toplevel, expected_head)?;
    run_git(
        &toplevel,
        &["reset", "--keep", &format!("{tip}^{{commit}}")],
    )
    .map(|_| ())
}

// ---------- Теги ----------

// Имя тега уходит в `git tag` позиционным аргументом, поэтому ведущий дефис
// отсекаем до вызова: иначе имя стало бы опцией команды.
pub(crate) fn validated_tag_ref(root: &Path, name: &str) -> CommandResult<String> {
    if name.starts_with('-') {
        return Err(CommandError::new(ErrorCode::GitCommandFailed)
            .with_context("reason", "tag-invalid")
            .with_context("tag", name));
    }
    validate_namespaced_ref(root, "tags", name, "tag-invalid")
}

// Удаляет локальный тег. Тег на сервере не трогаем: это уже изменение общего
// репозитория, а не локальной копии.
pub fn delete_tag(root: &Path, name: &str) -> CommandResult<()> {
    let Some(toplevel) = repo_toplevel(root)? else {
        return Err(CommandError::new(ErrorCode::GitNotARepository));
    };
    let reference = validated_tag_ref(&toplevel, name)?;
    let current = run_git(&toplevel, &["show-ref", "--verify", "--hash", &reference])
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_owned())
        .map_err(|_| {
            CommandError::new(ErrorCode::GitCommandFailed)
                .with_context("reason", "tag-missing")
                .with_context("tag", name)
        })?;
    // Удаляем ровно то значение, которое только что прочитали: если тег успели
    // пересоздать на другом коммите, ref останется нетронутым.
    run_git(
        &toplevel,
        &[
            "update-ref",
            "-m",
            "modelcrew: delete tag",
            "-d",
            &reference,
            &current,
        ],
    )
    .map(|_| ())
}

#[tauri::command]
pub async fn git_delete_tag(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    name: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || delete_tag(&root, &name))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

#[tauri::command]
pub async fn git_drop_commit(
    window: tauri::WebviewWindow,
    roots: tauri::State<'_, WorkspaceRoots>,
    workspace_id: String,
    hash: String,
    expected_head: String,
) -> CommandResult<()> {
    super::ensure_main_window(&window)?;
    let root = roots.resolve(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || drop_commit(&root, &hash, &expected_head))
        .await
        .map_err(|error| CommandError::new(ErrorCode::GitCommandFailed).with_debug(error))?
}

// ---------- Действия над коммитом из меню истории ----------

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
// Проверки вертикали лежат рядом, отдельным файлом: их вдвое больше кода.
#[cfg(test)]
#[path = "git_history_tests.rs"]
mod tests;
