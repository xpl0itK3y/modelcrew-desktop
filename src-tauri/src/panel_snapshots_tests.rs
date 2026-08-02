//! Проверки снимков панели: что попадает в снимок, чего он не трогает и как
//! из него достаётся затёртая работа.

use super::*;
use crate::git_changes::test_support::*;
use std::process::Command;

fn repo(root: &Path) -> impl Fn(&[&str]) -> Vec<u8> + '_ {
    history_repo(root)
}

fn tracked(root: &Path, reference: &str, path: &str) -> String {
    String::from_utf8_lossy(
        &run_git(root, &["show", &format!("{reference}:{path}")]).unwrap_or_default(),
    )
    .to_string()
}

#[test]
fn keeps_the_work_a_neighbour_overwrote() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = repo(root);
    std::fs::write(root.join("app.ts"), "было\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);

    // Ход первого агента: правка и снимок.
    std::fs::write(root.join("app.ts"), "работа первого\n").unwrap();
    snapshot_panel(root, "panel-a").unwrap().expect("снимок A");

    // Второй затирает файл, не зная о первом.
    std::fs::write(root.join("app.ts"), "работа второго\n").unwrap();
    snapshot_panel(root, "panel-b").unwrap().expect("снимок B");

    // Затирание случилось, но работа первого достаётся из его снимка — ради
    // этого всё и затевалось.
    assert_eq!(
        tracked(root, &snapshot_ref("panel-a"), "app.ts"),
        "работа первого\n"
    );
    assert_eq!(
        tracked(root, &snapshot_ref("panel-b"), "app.ts"),
        "работа второго\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("app.ts")).unwrap(),
        "работа второго\n"
    );
}

#[test]
fn leaves_the_staging_area_of_the_user_alone() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = repo(root);
    std::fs::write(root.join("kept.ts"), "1\n").unwrap();
    std::fs::write(root.join("other.ts"), "1\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);

    // Человек отобрал в индекс один файл из двух изменённых.
    std::fs::write(root.join("kept.ts"), "2\n").unwrap();
    std::fs::write(root.join("other.ts"), "2\n").unwrap();
    git(&["add", "kept.ts"]);
    let staged_before = git_at(root, &["diff", "--cached", "--name-only"]);

    snapshot_panel(root, "panel-a").unwrap();

    // Снимок собирается во временном индексе: отобранное человеком остаётся
    // отобранным, иначе снимок сбрасывал бы подготовленный коммит.
    assert_eq!(
        git_at(root, &["diff", "--cached", "--name-only"]),
        staged_before
    );
    assert_eq!(staged_before, "kept.ts");
}

#[test]
fn stays_out_of_the_branches_and_the_log() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = repo(root);
    std::fs::write(root.join("app.ts"), "1\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);
    let head_before = head_of(&git);

    std::fs::write(root.join("app.ts"), "2\n").unwrap();
    snapshot_panel(root, "panel-a").unwrap().expect("снимок");

    // Ветка не сдвинулась, история не выросла: для пользователя ничего не
    // изменилось.
    assert_eq!(head_of(&git), head_before);
    assert_eq!(subjects(root), vec!["init".to_string()]);
    assert!(git_at(root, &["branch", "--list"]).contains("main"));
    assert_eq!(git_at(root, &["branch", "--list"]).lines().count(), 1);
}

#[test]
fn skips_a_turn_that_changed_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = repo(root);
    std::fs::write(root.join("app.ts"), "1\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);

    std::fs::write(root.join("app.ts"), "2\n").unwrap();
    assert!(snapshot_panel(root, "panel-a").unwrap().is_some());

    // Агент подумал и ничего не записал — второй одинаковый снимок только
    // засорил бы список, который потом смотреть человеку.
    assert!(snapshot_panel(root, "panel-a").unwrap().is_none());
}

#[test]
fn chains_the_snapshots_of_one_panel() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = repo(root);
    std::fs::write(root.join("app.ts"), "1\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);

    std::fs::write(root.join("app.ts"), "2\n").unwrap();
    snapshot_panel(root, "panel-a").unwrap();
    std::fs::write(root.join("app.ts"), "3\n").unwrap();
    snapshot_panel(root, "panel-a").unwrap();

    // Снимки идут цепочкой: по ней видно ход работы панели, а не только
    // последнее состояние.
    let reference = snapshot_ref("panel-a");
    assert_eq!(tracked(root, &reference, "app.ts"), "3\n");
    assert_eq!(tracked(root, &format!("{reference}~1"), "app.ts"), "2\n");
}

#[test]
fn takes_in_a_file_that_was_never_committed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = repo(root);
    std::fs::write(root.join("app.ts"), "1\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);

    // Новый файл агента — самая уязвимая работа: в истории его нет вообще.
    std::fs::write(root.join("fresh.ts"), "новое\n").unwrap();
    snapshot_panel(root, "panel-a").unwrap().expect("снимок");

    assert_eq!(
        tracked(root, &snapshot_ref("panel-a"), "fresh.ts"),
        "новое\n"
    );
}

#[test]
fn works_in_a_repository_without_a_single_commit() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let output = Command::new("git")
        .args(["init", "--quiet", "--initial-branch=main"])
        .current_dir(root)
        .output()
        .unwrap();
    assert!(output.status.success());
    configure(root);
    std::fs::write(root.join("first.ts"), "первый\n").unwrap();

    // HEAD ещё некуда указывать, но работа агента уже есть и терять её нельзя.
    snapshot_panel(root, "panel-a").unwrap().expect("снимок");

    assert_eq!(
        tracked(root, &snapshot_ref("panel-a"), "first.ts"),
        "первый\n"
    );
}

#[test]
fn says_nothing_outside_a_repository() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("note.txt"), "просто папка\n").unwrap();

    // Панель может быть открыта где угодно: не репозиторий — не ошибка.
    assert_eq!(snapshot_panel(dir.path(), "panel-a").unwrap(), None);
}

#[test]
fn keeps_the_panels_apart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = repo(root);
    std::fs::write(root.join("app.ts"), "1\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);

    std::fs::write(root.join("app.ts"), "от первой\n").unwrap();
    snapshot_panel(root, "panel-a").unwrap();
    std::fs::write(root.join("app.ts"), "от второй\n").unwrap();
    snapshot_panel(root, "panel-b").unwrap();

    // Ссылки у панелей свои: снимок соседа не перезаписывается.
    assert_eq!(
        tracked(root, &snapshot_ref("panel-a"), "app.ts"),
        "от первой\n"
    );
    assert_eq!(
        tracked(root, &snapshot_ref("panel-b"), "app.ts"),
        "от второй\n"
    );
}

#[test]
fn lists_what_each_turn_changed_newest_first() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = repo(root);
    std::fs::write(root.join("app.ts"), "1\n").unwrap();
    std::fs::write(root.join("other.ts"), "1\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);

    std::fs::write(root.join("app.ts"), "от первой\n").unwrap();
    snapshot_panel(root, "panel-a").unwrap();
    std::fs::write(root.join("other.ts"), "от второй\n").unwrap();
    snapshot_panel(root, "panel-b").unwrap();

    let list = list_panel_snapshots(root).unwrap();
    assert_eq!(list.len(), 2);
    // Показываем, что изменил этот ход, а не всё дерево.
    let files = |panel: &str| {
        list.iter()
            .find(|item| item.panel_id == panel)
            .map(|item| item.files.clone())
            .unwrap_or_default()
    };
    // У первого снимка панели предшественника нет, поэтому сравнение идёт с
    // веткой — и туда попадает всё несохранённое, включая правку соседа.
    // Точный список «что сделал этот ход» появляется со второго снимка.
    assert_eq!(files("panel-a"), vec!["app.ts".to_string()]);
    assert_eq!(
        files("panel-b"),
        vec!["app.ts".to_string(), "other.ts".to_string()]
    );

    // Второй ход той же панели показывает уже ровно свою работу.
    std::fs::write(root.join("third.ts"), "ещё\n").unwrap();
    snapshot_panel(root, "panel-b").unwrap();
    let list = list_panel_snapshots(root).unwrap();
    let second = list
        .iter()
        .find(|item| item.panel_id == "panel-b")
        .expect("снимок panel-b");
    assert_eq!(second.files, vec!["third.ts".to_string()]);
    // Оба хода закончились в одну секунду: порядок при этом обязан быть
    // устойчивым, иначе список прыгает при каждом обновлении.
    assert_eq!(
        list_panel_snapshots(root)
            .unwrap()
            .iter()
            .map(|item| item.panel_id.clone())
            .collect::<Vec<_>>(),
        list.iter()
            .map(|item| item.panel_id.clone())
            .collect::<Vec<_>>()
    );
}

#[test]
fn brings_one_file_back_without_touching_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = repo(root);
    std::fs::write(root.join("app.ts"), "1\n").unwrap();
    std::fs::write(root.join("other.ts"), "1\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);

    std::fs::write(root.join("app.ts"), "работа первого\n").unwrap();
    snapshot_panel(root, "panel-a").unwrap();
    // Сосед затёр файл и заодно поработал в другом.
    std::fs::write(root.join("app.ts"), "затёрто\n").unwrap();
    std::fs::write(root.join("other.ts"), "работа второго\n").unwrap();

    restore_from_snapshot(root, "panel-a", "app.ts").unwrap();

    assert_eq!(
        std::fs::read_to_string(root.join("app.ts")).unwrap(),
        "работа первого\n"
    );
    // Возвращаем ровно один файл: восстановление снимка целиком затёрло бы
    // работу, которая шла после него.
    assert_eq!(
        std::fs::read_to_string(root.join("other.ts")).unwrap(),
        "работа второго\n"
    );
}

#[test]
fn refuses_a_path_that_leaves_the_project() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = repo(root);
    std::fs::write(root.join("app.ts"), "1\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "init"]);
    snapshot_panel(root, "panel-a").unwrap();

    // Путь приходит из интерфейса, но проверять его всё равно надо здесь.
    for hostile in ["../outside.txt", "/etc/passwd", ""] {
        assert!(restore_from_snapshot(root, "panel-a", hostile).is_err());
    }
}

#[test]
fn has_nothing_to_list_outside_a_repository() {
    let dir = tempfile::tempdir().unwrap();

    assert!(list_panel_snapshots(dir.path()).unwrap().is_empty());
}
