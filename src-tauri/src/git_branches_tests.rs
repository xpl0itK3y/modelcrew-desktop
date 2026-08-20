//! Проверки веток: список и переключение, создание, переименование и удаление,
//! конфиг ветки и очередь его отложенной чистки, слияние и перенос.

use super::*;
use crate::git_changes::test_support::*;
use crate::git_history::*;
use crate::git_log::*;
use crate::git_sync::*;
use std::process::Command;

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
        String::from_utf8_lossy(&run_git(root, &["config", "branch.topic.remote"]).unwrap()).trim(),
        "team/platform"
    );
    assert_eq!(
        String::from_utf8_lossy(&run_git(root, &["config", "branch.topic.merge"]).unwrap()).trim(),
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
    git_at(root, &["reset", "--hard", &second]);
    commit_action(root, "cherryPick", &donor, None).unwrap();
    assert!(root.join("donor.txt").exists(), "коммит применён поверх");
    let picked = git_at(root, &["rev-parse", "HEAD"]);
    commit_action(root, "revert", &picked, None).unwrap();
    assert!(!root.join("donor.txt").exists(), "отмена убрала файл");

    // 5. Теги: переход на тег и удаление. Ставит их сам git — своей команды
    // на создание тега у панели нет.
    git_at(root, &["tag", "v1.0", &first]);
    git_at(
        root,
        &["tag", "-a", "v1.0-note", "-m", "first release", &first],
    );
    assert_eq!(git_at(root, &["cat-file", "-t", "v1.0-note"]), "tag");
    switch_branch(root, "v1.0", "tag").unwrap();
    assert!(collect_summary(root).unwrap().branch.is_none());
    switch_branch(root, "main", "local").unwrap();
    delete_tag(root, "v1.0").unwrap();
    assert!(!git_at(root, &["tag", "--list"]).contains("v1.0\n"));

    // 6. Серверная ветка видна как удалённая и переключается по полному ref.
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

    // 7. Фильтры журнала работают на реальной истории.
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
