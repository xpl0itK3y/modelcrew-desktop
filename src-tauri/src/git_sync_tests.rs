//! Проверки синхронизации с сервером: fetch, pull, push, rebase, сброс на
//! upstream и публикация ветки — против настоящего удалённого репозитория,
//! плюс отказ от транспорта, который выполняет команды.

use super::*;
use crate::git_branches::*;
use crate::git_changes::test_support::*;
use std::process::Command;

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
