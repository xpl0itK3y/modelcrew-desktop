//! Проверки правки истории: сообщение коммита, uncommit/amend/squash/fixup,
//! удаление и сброс, сравнение состояний, теги и патчи.

use super::*;
use crate::git_branches::*;
use crate::git_changes::test_support::*;
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
