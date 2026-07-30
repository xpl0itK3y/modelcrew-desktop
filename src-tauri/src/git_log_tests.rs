//! Проверки чтения журнала: разбор вывода `git log`, порядок графа при
//! перекошенных датах, фильтры поиска и то, что декорации и текст коммита
//! остаются данными, а не командами.

use super::*;
use crate::git_changes::test_support::*;
use crate::git_history::*;
use std::process::Command;

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
    let side_tip = String::from_utf8_lossy(&git_at(&["rev-parse", "HEAD"], "2026-01-02T00:00:00Z"))
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
