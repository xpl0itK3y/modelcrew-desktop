//! Общая оснастка тестов git: сборка репозиториев, запуск git и выборки
//! из сводки. Нужна всем трём наборам проверок, поэтому живёт отдельно.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::git_branches::{
    create_branch, fetch_upstream, list_log_unfiltered, publish_branch, pull_rebase, pull_upstream,
    push_upstream, reset_to_upstream,
};
use crate::git_changes::{collect_summary, GitChangedFile, GitChangesSummary};

pub(crate) fn by_path_in<'s>(summary: &'s GitChangesSummary, path: &str) -> &'s GitChangedFile {
    summary
        .files
        .iter()
        .find(|file| file.path == path)
        .unwrap_or_else(|| panic!("{path} not in summary"))
}

// Репозиторий с настроенным автором: переписывание истории разрешено только
// для собственных коммитов, поэтому user.email должен совпадать с автором.
pub(crate) fn history_repo(root: &Path) -> impl Fn(&[&str]) -> Vec<u8> + '_ {
    let git = move |args: &[&str]| {
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
    git
}

pub(crate) fn head_of(git: &impl Fn(&[&str]) -> Vec<u8>) -> String {
    String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]))
        .trim()
        .to_owned()
}

pub(crate) fn subjects(root: &Path) -> Vec<String> {
    list_log_unfiltered(root, 20, false)
        .unwrap()
        .into_iter()
        .map(|commit| commit.subject)
        .collect()
}

// Запускает git в конкретной папке с фиксированной подписью автора.
// Возвращает stdout: тесты ниже сверяют по нему реальное состояние Git,
// а не только результат наших функций.
pub(crate) fn git_at(root: &Path, args: &[&str]) -> String {
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
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

pub(crate) fn configure(root: &Path) {
    git_at(root, &["config", "core.autocrlf", "false"]);
    git_at(root, &["config", "user.name", "Me"]);
    git_at(root, &["config", "user.email", "me@t"]);
}

pub(crate) fn commit_file(root: &Path, name: &str, body: &str, message: &str) -> String {
    std::fs::write(root.join(name), body).unwrap();
    git_at(root, &["add", "--", name]);
    git_at(root, &["commit", "--quiet", "-m", message]);
    git_at(root, &["rev-parse", "HEAD"])
}

// «Сервер» — обычный bare-репозиторий: для git это полноценный remote, а
// тесту не нужны ни сеть, ни учётные данные. Рабочую копию именно создаём,
// а не клонируем: клон пустого репозитория уже прописал бы upstream в
// конфиг, и случай «ветка ещё не опубликована» перестал бы существовать.
pub(crate) fn server_and_workdir(dir: &Path) -> (PathBuf, PathBuf) {
    let bare = dir.join("server.git");
    git_at(
        dir,
        &[
            "init",
            "--quiet",
            "--bare",
            "--initial-branch=main",
            bare.to_str().unwrap(),
        ],
    );
    let work = dir.join("work");
    std::fs::create_dir(&work).unwrap();
    git_at(&work, &["init", "--quiet", "--initial-branch=main"]);
    configure(&work);
    git_at(&work, &["remote", "add", "origin", bare.to_str().unwrap()]);
    (bare, work)
}

pub(crate) fn live_scenario(root: &Path, dir: &Path, remote: &str, branch: &str) {
    // 1. Новая ветка и первая публикация: на сервере её ещё нет.
    create_branch(root, branch).unwrap();
    let first = commit_file(root, "live.txt", "first\n", "live: first");
    assert!(collect_summary(root).unwrap().upstream_ref.is_none());
    publish_branch(root, branch, &first, None).unwrap();

    let listed = git_at(
        root,
        &["ls-remote", "origin", &format!("refs/heads/{branch}")],
    );
    assert!(listed.starts_with(&first), "сервер принял ветку: {listed}");
    let summary = collect_summary(root).unwrap();
    assert_eq!(
        summary.upstream_ref.as_deref(),
        Some(format!("origin/{branch}").as_str())
    );
    assert_eq!((summary.ahead, summary.behind), (Some(0), Some(0)));

    // 2. Обычная отправка следующего коммита.
    let second = commit_file(root, "live.txt", "first\nsecond\n", "live: second");
    push_upstream(root, branch, &second).unwrap();
    assert!(git_at(
        root,
        &["ls-remote", "origin", &format!("refs/heads/{branch}")]
    )
    .starts_with(&second));

    // 3. Чужой коммит: вторая рабочая копия того же репозитория.
    let other = dir.join("other");
    git_at(dir, &["clone", "--quiet", remote, other.to_str().unwrap()]);
    configure(&other);
    git_at(&other, &["checkout", "--quiet", branch]);
    let theirs = commit_file(&other, "theirs.txt", "colleague\n", "live: colleague");
    git_at(&other, &["push", "--quiet", "origin", branch]);

    fetch_upstream(root).unwrap();
    assert_eq!(collect_summary(root).unwrap().behind, Some(1));
    pull_upstream(root, branch, &second).unwrap();
    assert_eq!(git_at(root, &["rev-parse", "HEAD"]), theirs);

    // 4. Расхождение и перенос поверх серверного состояния.
    let ours = commit_file(root, "ours.txt", "mine\n", "live: mine");
    let theirs_second = commit_file(&other, "theirs.txt", "colleague\nmore\n", "live: more");
    git_at(&other, &["push", "--quiet", "origin", branch]);
    fetch_upstream(root).unwrap();
    let summary = collect_summary(root).unwrap();
    assert_eq!((summary.ahead, summary.behind), (Some(1), Some(1)));
    assert!(
        pull_upstream(root, branch, &ours).is_err(),
        "перемотка невозможна на разошедшейся ветке"
    );
    pull_rebase(root, branch, &ours).unwrap();
    assert_eq!(git_at(root, &["rev-parse", "HEAD~1"]), theirs_second);
    let rebased = git_at(root, &["rev-parse", "HEAD"]);
    push_upstream(root, branch, &rebased).unwrap();

    // 5. Выравнивание по серверу: локальный коммит уходит, файл остаётся.
    let extra = commit_file(root, "extra.txt", "local only\n", "live: local only");
    reset_to_upstream(root, branch, &extra).unwrap();
    assert_eq!(git_at(root, &["rev-parse", "HEAD"]), rebased);
    assert!(root.join("extra.txt").exists());

    // 6. Отправка с устаревшим подтверждением не проходит.
    assert_eq!(
        push_upstream(root, branch, &extra)
            .unwrap_err()
            .context
            .get("reason")
            .map(String::as_str),
        Some("head-moved")
    );

    // 7. Отказ приходит и с той стороны: сервер ушёл вперёд, а наша
    // вершина не менялась, поэтому собственные проверки её пропускают —
    // ошибку обязан вернуть сам push, а не тишина.
    git_at(&other, &["fetch", "--quiet", "origin"]);
    git_at(
        &other,
        &["reset", "--hard", "--quiet", &format!("origin/{branch}")],
    );
    commit_file(&other, "ahead.txt", "server moved\n", "live: server moved");
    git_at(&other, &["push", "--quiet", "origin", branch]);
    let head = git_at(root, &["rev-parse", "HEAD"]);
    assert!(
        push_upstream(root, branch, &head).is_err(),
        "сервер должен отклонить откат ветки назад"
    );

    // 8. Недоступный репозиторий не должен подвешивать приложение: без
    // интерактивного запроса пароля git обязан упасть, а не ждать ввода.
    let broken = dir.join("broken");
    std::fs::create_dir(&broken).unwrap();
    git_at(&broken, &["init", "--quiet", "--initial-branch=main"]);
    configure(&broken);
    git_at(
        &broken,
        &[
            "remote",
            "add",
            "origin",
            "git@github.com:xpl0itK3y/modelcrew-no-such-repository.git",
        ],
    );
    let orphan = commit_file(&broken, "x.txt", "x\n", "live: unreachable");
    let started = std::time::Instant::now();
    assert!(publish_branch(&broken, "main", &orphan, None).is_err());
    assert!(
        started.elapsed() < std::time::Duration::from_secs(60),
        "падение вместо ожидания ввода: {:?}",
        started.elapsed()
    );
}

// Репозиторий в подпапке временного каталога: рядом с ним остаётся место
// для «внешних» файлов и маркеров, которые панель трогать не должна.
pub(crate) fn repo_beside_outside(dir: &Path) -> PathBuf {
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    repo
}
