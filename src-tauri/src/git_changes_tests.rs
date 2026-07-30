//! Проверки ядра git-модуля: разбор статуса и numstat, сборка сводки,
//! диффы, чтение и запись файлов, коммит и откат, вотчер.

use super::*;
use crate::git_branches::*;
use crate::git_changes::test_support::*;
use crate::git_changes::*;
use crate::git_history::*;
use std::process::Command;
use tempfile::tempdir;

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
    git(&["config", "core.autocrlf", "false"]);
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
    git(&["config", "core.autocrlf", "false"]);
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
    let head_only = list_log_unfiltered(root, 50, false).unwrap();
    assert!(!head_only.iter().any(|c| c.subject == "clash version"));
    let all_refs = list_log_unfiltered(root, 50, true).unwrap();
    assert!(all_refs.iter().any(|c| c.subject == "clash version"));

    // Detached HEAD: ветки нет, но история и статус работают.
    let log = list_log_unfiltered(root, 10, false).unwrap();
    assert!(log[0].subject.contains("main version"));
    git(&["checkout", "--quiet", &log[1].hash]);
    let summary = collect_summary(root).unwrap();
    assert!(summary.is_repo);
    assert_eq!(summary.branch, None, "detached HEAD — без имени ветки");
    assert!(!list_log_unfiltered(root, 5, false).unwrap().is_empty());
    let branches = list_branches(root).unwrap();
    assert!(branches.iter().all(|branch| !branch.is_current));
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
    git(&["config", "core.autocrlf", "false"]);
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
    commit_all(root, "panel commit\n\nDetailed description").unwrap();
    let summary = collect_summary(root).unwrap();
    assert!(summary.files.is_empty());
    let commit = list_log_unfiltered(root, 1, false).unwrap().remove(0);
    assert_eq!(commit.subject, "panel commit");
    assert_eq!(commit.body, "Detailed description");
    assert!(commit_all(root, "   ").is_err());
}

// Остальные тесты выключают core.autocrlf, чтобы сравнивать содержимое
// точно. Но у пользователя Git for Windows он включён по умолчанию, и в
// рабочей копии лежит CRLF. Проверяем здесь один раз и осознанно, что
// панель от этого не слепнет: файл остаётся текстовым, diff собирается,
// сообщение коммита разбирается.
#[test]
fn panel_reads_a_repository_with_autocrlf_enabled() {
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
    git(&["config", "core.autocrlf", "true"]);
    git(&["config", "user.name", "t"]);
    git(&["config", "user.email", "t@t"]);
    std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "add the file\n\nWhy it matters"]);

    // Коммит содержимое не переписывает, поэтому CRLF в рабочей копии
    // появляется только на выдаче: удаляем файл и забираем его из HEAD.
    // Так тест ведёт себя одинаково на всех системах, а не только там,
    // где autocrlf включён установщиком.
    std::fs::remove_file(root.join("a.txt")).unwrap();
    git(&["checkout", "--", "a.txt"]);
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "one\r\ntwo\r\n",
        "autocrlf обязан выдать рабочую копию с CRLF, иначе тест ничего не проверяет"
    );

    // Правка тем же переводом строки: git видит изменение, и панель тоже.
    std::fs::write(root.join("a.txt"), "one\r\ntwo\r\nthree\r\n").unwrap();
    let summary = collect_summary(root).unwrap();
    assert!(summary.is_repo);
    let changed = summary
        .files
        .iter()
        .find(|file| file.path == "a.txt")
        .expect("панель не увидела правку файла с CRLF");
    assert_eq!(changed.status, "modified");
    assert_eq!(changed.additions, Some(1));

    // Файл с CRLF остаётся текстовым, а не «бинарным без diff».
    let diff = collect_file_diff(root, "a.txt").unwrap();
    assert!(!diff.is_binary, "файл с CRLF принят за бинарный");
    assert!(
        diff.diff.contains("three"),
        "в diff нет добавленной строки: {}",
        diff.diff
    );

    // Разбор сообщения не зависит от переводов строк в содержимом.
    let commit = list_log_unfiltered(root, 1, false).unwrap().remove(0);
    assert_eq!(commit.subject, "add the file");
    assert_eq!(commit.body, "Why it matters");
}

// Проверка против настоящего сервера. По умолчанию пропускается: нужна
// сеть и права на запись, а обычный прогон тестов не должен ни от того,
// ни от другого зависеть. Запуск:
//   MODELCREW_TEST_REMOTE=git@github.com:user/repo.git \
//     cargo test -- --ignored live_workflow
#[test]
#[ignore = "требует сети и доступа на запись в указанный репозиторий"]
fn live_workflow_against_a_real_remote() {
    let Ok(remote) = std::env::var("MODELCREW_TEST_REMOTE") else {
        panic!("не задан MODELCREW_TEST_REMOTE");
    };
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    git_at(
        dir.path(),
        &["clone", "--quiet", &remote, work.to_str().unwrap()],
    );
    let root = work.as_path();
    configure(root);

    // Имя уникально для запуска: параллельные прогоны не мешают друг другу,
    // а забытая ветка на сервере сразу опознаётся по префиксу.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let branch = format!("modelcrew-test/{}-{nanos}", std::process::id());

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        live_scenario(root, dir.path(), &remote, &branch)
    }));

    // Ветку на сервере убираем в любом случае: наш код удалять удалённые
    // ветки не умеет намеренно, поэтому здесь это делает сам git.
    let _ = Command::new("git")
        .args(["push", "--quiet", "origin", "--delete", &branch])
        .current_dir(root)
        .output();
    if let Err(payload) = outcome {
        std::panic::resume_unwind(payload);
    }
}

#[test]
fn repo_paths_that_escape_or_look_like_options_are_rejected() {
    for accepted in [
        "src/app.ts",
        "new file.txt",
        "ещё файл.md",
        "a/b/c/d.txt",
        // Дефис не в начале строки опцией стать не может: путь всегда
        // уходит в git после `--`.
        "dir/-not-an-option.txt",
        ".gitignore",
        "a.lock",
    ] {
        assert!(is_safe_repo_path(accepted), "{accepted}");
    }
    assert!(is_safe_repo_path(&"a".repeat(4096)));

    for rejected in [
        "",
        "/etc/passwd",
        "/",
        "-o",
        "-rf",
        "--output=/tmp/x",
        "..",
        "../secret",
        "../../etc/passwd",
        "a/../../etc/passwd",
        "a/..",
        "a/../b",
        "a\\b",
        "..\\..\\windows\\win.ini",
        "\\\\server\\share\\x",
        "//server/share/x",
    ] {
        assert!(!is_safe_repo_path(rejected), "{rejected}");
    }
    assert!(!is_safe_repo_path(&"a".repeat(4097)));
}

#[test]
fn panel_never_touches_a_file_outside_the_repository() {
    let dir = tempfile::tempdir().unwrap();
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let secret = outside.join("secret.txt");
    std::fs::write(&secret, "OUTSIDE-SECRET\n").unwrap();

    let repo = repo_beside_outside(dir.path());
    let root = repo.as_path();
    let git = history_repo(root);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);
    let head = head_of(&git);

    let absolute = secret.to_str().unwrap().to_owned();
    let escapes = [
        "../outside/secret.txt",
        "../../outside/secret.txt",
        "a/../../outside/secret.txt",
        "..",
        absolute.as_str(),
    ];
    for path in escapes {
        assert!(collect_file_diff(root, path).is_err(), "diff {path}");
        assert!(read_repo_file(root, path).is_err(), "read {path}");
        assert!(
            write_repo_file(root, path, "OVERWRITTEN").is_err(),
            "write {path}"
        );
        assert!(revert_file(root, path, None).is_err(), "revert {path}");
        assert!(
            commit_file_diff(root, &head, path).is_err(),
            "commit diff {path}"
        );
        assert!(
            compare_file_diff(root, &head, None, path).is_err(),
            "compare {path}"
        );
        assert!(
            list_log(
                root,
                20,
                false,
                &GitLogFilter {
                    path: Some(path.to_owned()),
                    ..Default::default()
                },
            )
            .is_err(),
            "log {path}"
        );
    }

    // Старое имя переименованного файла — второй путь того же вызова:
    // через него checkout тоже не должен выйти за корень.
    revert_file(root, "a.txt", Some("../outside/secret.txt")).unwrap();

    assert_eq!(
        std::fs::read_to_string(&secret).unwrap(),
        "OUTSIDE-SECRET\n"
    );
    assert_eq!(
        std::fs::read_dir(&outside).unwrap().count(),
        1,
        "за корнем репозитория ничего не создано"
    );
}

#[test]
fn revision_arguments_must_be_hashes_not_git_expressions() {
    assert!(is_safe_hash("abcd"));
    assert!(is_safe_hash("0123456789abcdef0123456789abcdef01234567"));
    // Hex в верхнем регистре — обычный ответ git на некоторых платформах.
    assert!(is_safe_hash("DeAdBeEf"));
    assert!(is_safe_hash(&"a".repeat(64)));
    let too_long = "a".repeat(65);
    for rejected in [
        "",
        "abc",
        too_long.as_str(),
        "HEAD",
        "master",
        "main",
        "..",
        "-x",
        "--all",
        "$(id)",
        "@{-1}",
        "HEAD~1",
        "refs/heads/main",
        "dead beef",
        "dead;id",
    ] {
        assert!(!is_safe_hash(rejected), "{rejected}");
    }

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = history_repo(root);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);
    let head = head_of(&git);

    for hash in [
        "HEAD",
        "main",
        "..",
        "-x",
        "$(id)",
        "@{-1}",
        "HEAD~1",
        "refs/heads/main",
        "",
    ] {
        assert!(list_commit_files(root, hash).is_err(), "files {hash}");
        assert!(
            commit_file_diff(root, hash, "a.txt").is_err(),
            "diff {hash}"
        );
        assert!(commit_patch(root, hash).is_err(), "patch {hash}");
        assert!(compare_files(root, hash, None).is_err(), "compare {hash}");
        assert!(
            compare_file_diff(root, hash, None, "a.txt").is_err(),
            "compare diff {hash}"
        );
        assert!(
            compare_files(root, &head, Some(hash)).is_err(),
            "compare to {hash}"
        );
        assert!(
            commit_action(root, "checkout", hash, None).is_err(),
            "checkout {hash}"
        );
        assert!(
            commit_action(root, "cherryPick", hash, None).is_err(),
            "cherry-pick {hash}"
        );
        assert!(
            commit_action(root, "revert", hash, None).is_err(),
            "revert {hash}"
        );
        assert!(create_tag(root, "v1", hash, None).is_err(), "tag {hash}");
        assert!(reword_commit(root, hash, "new").is_err(), "reword {hash}");
        assert!(
            reset_to_commit(root, hash, "hard", &head).is_err(),
            "reset {hash}"
        );
        assert!(
            squash_commit(root, hash, "squash", &head).is_err(),
            "squash {hash}"
        );
        assert!(drop_commit(root, hash, &head).is_err(), "drop {hash}");
    }

    // Ни один отказ не должен был дойти до git.
    assert_eq!(head_of(&git), head);
    assert_eq!(git_at(root, &["tag", "--list"]), "");
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "one\n"
    );
    // Настоящий сокращённый hash при этом работает.
    assert_eq!(list_commit_files(root, &head[..12]).unwrap().len(), 1);
}

#[test]
fn commit_messages_are_data_not_git_options() {
    assert!(validated_message("").is_err());
    assert!(validated_message("   \n\t ").is_err());
    assert!(validated_message(&"я".repeat(MAX_COMMIT_MESSAGE_CHARS + 1)).is_err());
    assert!(validated_message(&"я".repeat(MAX_COMMIT_MESSAGE_CHARS)).is_ok());
    assert!(validated_message("-x").is_ok());
    assert!(validated_message("subject\n\nbody").is_ok());

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = history_repo(root);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();

    assert!(commit_all(root, "   ").is_err());
    assert!(commit_all(root, &"я".repeat(MAX_COMMIT_MESSAGE_CHARS + 1)).is_err());
    // Отказ произошёл до `add -A`: индекс не тронут.
    assert_eq!(git_at(root, &["status", "--porcelain"]), "?? a.txt");

    commit_all(root, "-x --amend").unwrap();
    assert_eq!(git_at(root, &["log", "-1", "--format=%s"]), "-x --amend");

    std::fs::write(root.join("b.txt"), "two\n").unwrap();
    commit_all(root, "subject line\n\nbody stays\n").unwrap();
    assert_eq!(git_at(root, &["log", "-1", "--format=%s"]), "subject line");
    assert_eq!(git_at(root, &["log", "-1", "--format=%b"]), "body stays");

    let head = head_of(&git);
    reword_commit(root, &head, "-m still data").unwrap();
    assert_eq!(git_at(root, &["log", "-1", "--format=%s"]), "-m still data");
    assert!(reword_commit(root, &head_of(&git), "  ").is_err());
}

#[test]
fn github_identity_applies_only_to_the_created_commit() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = history_repo(root);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    let identity = GithubCommitIdentity {
        name: "octocat".to_owned(),
        email: "1+octocat@users.noreply.github.com".to_owned(),
    };

    commit_all_with_identity(root, "github-authored", Some(&identity)).unwrap();

    assert_eq!(
        git_at(root, &["log", "-1", "--format=%an <%ae>|%cn <%ce>"]),
        "octocat <1+octocat@users.noreply.github.com>|octocat <1+octocat@users.noreply.github.com>"
    );
    assert_eq!(git_at(root, &["config", "user.name"]), "Me");
    assert_eq!(git_at(root, &["config", "user.email"]), "me@t");
    drop(git);
}

#[test]
fn attacker_controlled_file_names_stay_inert_data() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = history_repo(root);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);

    std::fs::write(root.join("-rf"), "payload\n").unwrap();
    std::fs::write(root.join("quo'te.txt"), "quoted\n").unwrap();

    let summary = collect_summary(root).unwrap();
    // Имена возвращаются байт в байт: core.quotepath=false плюс -z.
    let dashed = by_path_in(&summary, "-rf");
    assert_eq!(dashed.status, "untracked");
    assert_eq!(dashed.additions, Some(1));
    assert_eq!(by_path_in(&summary, "quo'te.txt").status, "untracked");

    // Имя, похожее на опцию, панель в git не отправляет вовсе.
    assert!(collect_file_diff(root, "-rf").is_err());
    assert!(read_repo_file(root, "-rf").is_err());
    assert!(write_repo_file(root, "-rf", "overwritten").is_err());
    assert!(revert_file(root, "-rf", None).is_err());
    assert_eq!(
        std::fs::read_to_string(root.join("-rf")).unwrap(),
        "payload\n"
    );

    // Кавычка в имени — обычный файл, а не разделитель.
    assert!(collect_file_diff(root, "quo'te.txt")
        .unwrap()
        .diff
        .contains("+quoted"));
    revert_file(root, "quo'te.txt", None).unwrap();
    assert!(!root.join("quo'te.txt").exists());
}

// Перевод строки в имени файла легален только на unix; проверяем, что
// -z-разбор не превращает один файл в два (и не теряет остаток имени).
#[cfg(unix)]
#[test]
fn a_newline_in_a_file_name_does_not_split_the_status_entry() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = history_repo(root);
    git(&["commit", "--quiet", "--allow-empty", "-m", "init"]);

    // Разделителей пути в имени быть не должно — иначе это уже вложенный
    // путь, а не одно имя файла; подделку заголовка диффа это не портит.
    let hostile = "a.txt\n--- a-dev-null\n+++ b-etc-passwd\n@@ -0,0 +1 @@\n";
    std::fs::write(root.join(hostile), "x\n").unwrap();

    let summary = collect_summary(root).unwrap();
    assert_eq!(summary.files.len(), 1);
    assert_eq!(summary.files[0].path, hostile);
    assert_eq!(summary.files[0].status, "untracked");
}

// .git/config чужого репозитория умеет запускать программы. Здесь заперты
// те векторы, которые сейчас не срабатывают: pager (вывод идёт в pipe),
// editor (сообщение всегда передаётся аргументом) и alias поверх
// встроенных команд. Маркер лежит вне репозитория, чтобы не попасть в
// статус и не быть удалённым самими командами.
#[cfg(unix)]
#[test]
fn panel_never_runs_the_repository_pager_editor_or_aliases() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let repo = repo_beside_outside(dir.path());
    let root = repo.as_path();
    let git = history_repo(root);

    let marker = dir.path().join("marker");
    let script = dir.path().join("payload.sh");
    std::fs::write(
        &script,
        format!("#!/bin/sh\n: > \"{}\"\nexit 0\n", marker.display()),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let program = script.to_str().unwrap();
    let alias = format!("!{program}");
    git(&["config", "core.pager", program]);
    git(&["config", "core.editor", program]);
    git(&["config", "sequence.editor", program]);
    for name in ["alias.status", "alias.diff", "alias.log", "alias.commit"] {
        git(&["config", name, &alias]);
    }

    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);
    std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();

    assert!(collect_summary(root).unwrap().is_repo);
    assert!(collect_file_diff(root, "a.txt")
        .unwrap()
        .diff
        .contains("+two"));
    assert!(!list_log(root, 20, false, &GitLogFilter::default())
        .unwrap()
        .is_empty());
    list_branches(root).unwrap();
    commit_all(root, "second").unwrap();
    let head = head_of(&git);
    assert_eq!(list_commit_files(root, &head).unwrap().len(), 1);
    commit_action(root, "revert", &head, None).unwrap();

    assert!(
        !marker.exists(),
        "команды панели не должны запускать программы из конфигурации репозитория"
    );
}

// Чужой .git/config может увести core.hooksPath куда угодно. Простой
// просмотр репозитория — статус, дифф, история, ветки, патч — обязан
// оставаться read-only: ни один хук не должен запуститься от того, что
// пользователь всего лишь открыл папку.
#[cfg(unix)]
#[test]
fn read_only_panel_entry_points_never_run_repository_hooks() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let repo = repo_beside_outside(dir.path());
    let root = repo.as_path();
    let git = history_repo(root);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);
    let head = head_of(&git);
    git(&["branch", "other"]);
    git(&["tag", "v1"]);
    std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(root.join("new.txt"), "fresh\n").unwrap();

    // Хуки и маркеры лежат вне рабочего дерева: внутри они сами попали бы
    // в статус и в дифф. Конфигурацию ставим после фикстуры, иначе хуки
    // сработали бы на её собственных коммитах.
    let hooks = dir.path().join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    let names = [
        "pre-commit",
        "prepare-commit-msg",
        "commit-msg",
        "post-commit",
        "post-checkout",
        "post-merge",
        "post-rewrite",
        "reference-transaction",
        "pre-push",
    ];
    for name in names {
        let hook = hooks.join(name);
        std::fs::write(
            &hook,
            format!(
                "#!/bin/sh\n: > \"{}\"\nexit 0\n",
                dir.path().join(format!("fired-{name}")).display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);

    let summary = collect_summary(root).unwrap();
    assert_eq!(by_path_in(&summary, "a.txt").status, "modified");
    assert_eq!(by_path_in(&summary, "new.txt").status, "untracked");
    assert!(collect_file_diff(root, "a.txt")
        .unwrap()
        .diff
        .contains("+two"));
    assert!(collect_file_diff(root, "new.txt")
        .unwrap()
        .diff
        .contains("+fresh"));
    assert!(read_repo_file(root, "a.txt")
        .unwrap()
        .content
        .contains("two"));
    assert!(!list_log(root, 20, false, &GitLogFilter::default())
        .unwrap()
        .is_empty());
    assert!(!list_log(root, 20, true, &GitLogFilter::default())
        .unwrap()
        .is_empty());
    assert!(list_branches(root)
        .unwrap()
        .iter()
        .any(|branch| branch.name == "other"));
    assert_eq!(list_commit_files(root, &head).unwrap().len(), 1);
    assert!(commit_file_diff(root, &head, "a.txt")
        .unwrap()
        .diff
        .contains("+one"));
    assert!(commit_patch(root, &head).unwrap().contains("+one"));
    assert_eq!(compare_files(root, &head, None).unwrap().len(), 1);
    assert!(compare_file_diff(root, &head, None, "a.txt")
        .unwrap()
        .diff
        .contains("+two"));

    for name in names {
        assert!(
            !dir.path().join(format!("fired-{name}")).exists(),
            "хук {name} не должен запускаться при просмотре репозитория"
        );
    }
}

// Конфигурация чужого репозитория не должна прятать от панели ни одного
// изменения: невидимый в обзоре файл всё равно попадёт в коммит, ведь
// commit_all делает `add -A`.
#[test]
fn summary_ignores_repository_config_that_hides_changes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = history_repo(root);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);
    let head = head_of(&git);

    for (key, value) in [
        ("status.showUntrackedFiles", "no"),
        ("status.short", "true"),
        ("status.branch", "false"),
        ("status.relativePaths", "true"),
        ("core.quotepath", "true"),
        ("diff.noprefix", "true"),
    ] {
        git(&["config", key, value]);
    }

    std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::create_dir_all(root.join("sub")).unwrap();
    std::fs::write(root.join("sub").join("deep.txt"), "planted\n").unwrap();
    std::fs::write(root.join("ещё файл.md"), "planted\n").unwrap();

    let summary = collect_summary(root).unwrap();
    assert_eq!(summary.branch.as_deref(), Some("main"));
    assert_eq!(summary.head_hash.as_deref(), Some(head.as_str()));
    assert_eq!(by_path_in(&summary, "sub/deep.txt").status, "untracked");
    // core.quotepath=true в чужом конфиге не должен превратить имя в
    // экранированную строку: панель ищет файл по этому же имени.
    assert_eq!(by_path_in(&summary, "ещё файл.md").status, "untracked");
    let modified = by_path_in(&summary, "a.txt");
    assert_eq!(modified.status, "modified");
    assert_eq!(modified.additions, Some(1));
    assert!(collect_file_diff(root, "a.txt")
        .unwrap()
        .diff
        .contains("+two"));
}

// NUL проходит проверку пути, но системный вызов видит строку целиком и
// обязан отказать: обрезка до префикса означала бы работу с чужим файлом.
#[test]
fn an_embedded_nul_in_a_path_never_reaches_another_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = history_repo(root);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);
    let head = head_of(&git);

    for path in ["a.txt\u{0}", "a.txt\u{0}b"] {
        assert!(collect_file_diff(root, path).is_err(), "diff {path:?}");
        assert!(
            commit_file_diff(root, &head, path).is_err(),
            "commit diff {path:?}"
        );
        assert!(
            compare_file_diff(root, &head, None, path).is_err(),
            "compare {path:?}"
        );
        assert!(
            write_repo_file(root, path, "OVERWRITTEN").is_err(),
            "write {path:?}"
        );
        assert!(revert_file(root, path, None).is_err(), "revert {path:?}");
        assert!(
            list_log(
                root,
                20,
                false,
                &GitLogFilter {
                    path: Some(path.to_owned()),
                    ..Default::default()
                },
            )
            .is_err(),
            "log {path:?}"
        );
        // Чтение либо падает, либо сообщает «файла нет», но содержимого
        // a.txt не отдаёт никогда.
        if let Ok(file) = read_repo_file(root, path) {
            assert!(!file.exists && file.content.is_empty(), "read {path:?}");
        }
    }

    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "one\n"
    );
    assert!(
        collect_summary(root).unwrap().files.is_empty(),
        "репозиторий должен остаться нетронутым"
    );
}

#[test]
fn oversized_untracked_files_stay_within_the_panel_limits() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = history_repo(root);
    git(&["commit", "--quiet", "--allow-empty", "-m", "init"]);

    // Больше и лимита подсчёта строк, и лимита диффа, и лимита редактора.
    let huge = "заполнение\n".repeat(300_000);
    assert!(huge.len() as u64 > MAX_UNTRACKED_BYTES);
    std::fs::write(root.join("huge.txt"), &huge).unwrap();

    let summary = collect_summary(root).unwrap();
    let entry = by_path_in(&summary, "huge.txt");
    assert_eq!(entry.status, "untracked");
    assert_eq!(entry.additions, None);

    let diff = collect_file_diff(root, "huge.txt").unwrap();
    assert!(diff.truncated);
    assert!(diff.diff.len() <= MAX_DIFF_BYTES + 1024);

    let content = read_repo_file(root, "huge.txt").unwrap();
    assert!(content.too_large && content.content.is_empty());

    assert!(write_repo_file(root, "huge.txt", &"a".repeat(MAX_WRITE_BYTES + 1)).is_err());
    assert_eq!(
        std::fs::metadata(root.join("huge.txt")).unwrap().len(),
        huge.len() as u64
    );
}

// Архив чужого репозитория может привезти симлинк на каталог за пределами
// рабочего дерева и именованный канал. Сводка не должна ни спускаться по
// такому симлинку, ни открывать канал (иначе поток панели встанет навсегда).
#[cfg(unix)]
#[test]
fn summary_does_not_follow_a_symlinked_directory_or_open_a_pipe() {
    let dir = tempfile::tempdir().unwrap();
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "OUTSIDE-SECRET\n").unwrap();

    let repo = repo_beside_outside(dir.path());
    let root = repo.as_path();
    let git = history_repo(root);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);

    std::os::unix::fs::symlink("../outside", root.join("dirlink")).unwrap();
    std::os::unix::fs::symlink("../outside/missing", root.join("dangling")).unwrap();
    let pipe_created = Command::new("mkfifo")
        .arg(root.join("pipe"))
        .status()
        .map(|status| status.success())
        .unwrap_or(false);

    // Зависание здесь было бы неотличимо от «тест долго идёт», поэтому
    // сводку собираем в отдельном потоке со сторожевым таймером.
    let path = root.to_path_buf();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(collect_summary(&path));
    });
    let summary = receiver
        .recv_timeout(std::time::Duration::from_secs(60))
        .expect("сводка не должна зависать на специальных файлах")
        .unwrap();

    assert_eq!(by_path_in(&summary, "dirlink").status, "untracked");
    assert_eq!(by_path_in(&summary, "dirlink").additions, None);
    assert_eq!(by_path_in(&summary, "dangling").additions, None);
    assert!(
        summary
            .files
            .iter()
            .all(|file| !file.path.starts_with("dirlink/")),
        "содержимое внешнего каталога не должно попасть в сводку"
    );
    if pipe_created {
        assert!(
            summary
                .files
                .iter()
                .all(|file| file.path != "pipe" || file.additions.is_none()),
            "канал не должен читаться"
        );
    }
    // Симлинк на каталог — не редактируемый файл.
    assert!(read_repo_file(root, "dirlink").is_err());
}
