//! Проверки правки истории: сообщение коммита, отмена последнего коммита,
//! удаление коммита, удаление тегов и действия над коммитом из меню панели.

use super::*;
use crate::git_branches::*;
use crate::git_changes::test_support::*;
use crate::git_log::*;
use crate::git_sync::*;
use std::process::Command;

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
    assert!(editable["third"]);
    assert!(editable["second"]);
    assert!(!editable["published"], "коммит уже на сервере");
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

    // 2. Удаление коммита из середины: потомки переносятся, файл исчезает.
    let unwanted = commit_file(root, "unwanted.txt", "remove\n", "unwanted");
    commit_file(root, "keep.txt", "keep\n", "keep me");
    let head = git_at(root, &["rev-parse", "HEAD"]);
    drop_commit(root, &unwanted, &head).unwrap();
    assert!(!root.join("unwanted.txt").exists());
    assert!(root.join("keep.txt").exists());
    assert!(collect_summary(root).unwrap().files.is_empty());

    // 3. Отмена последнего коммита: изменения остаются подготовленными.
    let head = git_at(root, &["rev-parse", "HEAD"]);
    commit_action(root, "uncommit", &head, None).unwrap();
    assert!(root.join("keep.txt").exists());
    assert!(!collect_summary(root).unwrap().files.is_empty());
    git_at(root, &["commit", "--quiet", "-m", "keep me again"]);
}

#[test]
fn deletes_local_tags() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = history_repo(root);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "first"]);
    let head = head_of(&git);

    // Ставит теги сам git: своей команды на создание у панели нет, а удалять
    // приходится и лёгкие, и аннотированные.
    git(&["tag", "v1.0", &head]);
    git(&["tag", "-a", "v1.0-annotated", "-m", "first release", &head]);
    assert_eq!(
        String::from_utf8_lossy(&git(&["cat-file", "-t", "v1.0-annotated"])).trim(),
        "tag"
    );

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
    delete_tag(root, "v1.0-annotated").unwrap();
    assert_eq!(String::from_utf8_lossy(&git(&["tag", "--list"])).trim(), "");
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
        reword_commit(root, &head, "mine now").unwrap_err(),
        drop_commit(root, &head, &head).unwrap_err(),
    ] {
        assert_eq!(
            reason.context.get("reason").map(String::as_str),
            Some("not-yours")
        );
    }
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
        assert!(delete_tag(root, hostile).is_err(), "delete {hostile}");
    }
    assert_eq!(
        git_at(root, &["for-each-ref", "--format=%(refname)", "refs/tags"]),
        "refs/tags/-rf"
    );
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
