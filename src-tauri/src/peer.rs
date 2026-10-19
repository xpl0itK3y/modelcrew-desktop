//! Кто на том конце сокета — по данным ядра, а не по его словам.
//!
//! Пропуск в окружении опознаёт панель, пока окружение доходит. Но cursor
//! чистит его перед запуском MCP-сервера (проверено 2026-08-17), а при
//! постоянной регистрации конфиг один на проект — пропуск конкретной панели
//! туда просто некуда положить: панелей у проекта много, конфиг один.
//!
//! Поэтому спрашиваем систему: чей это процесс и из кого он вырос. Ответ
//! даёт ядро, а не собеседник, поэтому подделать его нельзя — в отличие от
//! любого поля, которое агент присылает сам.

#![cfg(any(unix, windows))]

#[cfg(unix)]
use std::os::unix::io::AsRawFd;
#[cfg(unix)]
use std::os::unix::net::UnixStream;

/// Докуда идём вверх по родителям. Между шимом и шеллом панели их единицы:
/// агент, его оболочка, шим. Предел нужен не ради глубины, а чтобы порченый
/// ответ ядра — pid, ссылающийся сам на себя, — не увёл в вечный цикл.
const MAX_DEPTH: usize = 32;

/// Pid процесса на том конце соединения.
#[cfg(target_os = "macos")]
pub fn peer_pid(stream: &UnixStream) -> Option<u32> {
    let mut pid: libc::pid_t = 0;
    let mut size = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: fd жив, пока жив stream; размер буфера соответствует типу.
    let got = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            &mut pid as *mut _ as *mut libc::c_void,
            &mut size,
        )
    };
    (got == 0 && pid > 0).then_some(pid as u32)
}

/// Pid процесса на том конце соединения.
#[cfg(target_os = "linux")]
pub fn peer_pid(stream: &UnixStream) -> Option<u32> {
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: fd жив, пока жив stream; размер буфера соответствует типу.
    let got = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut size,
        )
    };
    (got == 0 && cred.pid > 0).then_some(cred.pid as u32)
}

/// Остальные unix: спросить некого, опознание остаётся на пропуске.
#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
pub fn peer_pid(_stream: &UnixStream) -> Option<u32> {
    None
}

/// Цепочка от процесса вверх: он сам, его родитель, дед и так далее.
///
/// Первым идёт сам процесс: шим и есть тот, кого запустила панель, когда
/// агент зовёт сервер напрямую, без промежуточной оболочки.
#[cfg(unix)]
pub fn ancestry(pid: u32) -> Vec<u32> {
    climb(pid, parent_of)
}

/// Цепочка от процесса вверх — по одному снимку всех процессов системы.
///
/// Снимок один на всю цепочку: это проход по всей системе, и делать его на
/// каждом шаге вверх незачем.
#[cfg(windows)]
pub fn ancestry(pid: u32) -> Vec<u32> {
    let parents = crate::win_proc::snapshot()
        .into_iter()
        .map(|entry| (entry.pid, entry.parent))
        .collect();
    ancestry_in(pid, &parents, crate::win_proc::creation_time)
}

/// Цепочка по готовой таблице родителей.
///
/// Windows помнит pid родителя и после его смерти, а сам номер тем временем
/// может достаться новому процессу. Поэтому родителем считается только тот,
/// кто родился не позже ребёнка: процесс моложе ребёнка его родителем быть не
/// может — это чужой процесс под тем же номером, и панель по нему нашлась бы
/// чужая. Не узнали, когда кто родился, — дальше не идём: цепочка без
/// уверенности хуже короткой, за короткой есть пропуск.
#[cfg_attr(not(windows), allow(dead_code))]
fn ancestry_in(
    pid: u32,
    parents: &std::collections::HashMap<u32, u32>,
    born: impl Fn(u32) -> Option<u64>,
) -> Vec<u32> {
    climb(pid, |child| {
        let parent = *parents.get(&child)?;
        (born(parent)? <= born(child)?).then_some(parent)
    })
}

/// Подъём от процесса к предкам, пока родитель известен.
fn climb(pid: u32, parent_of: impl Fn(u32) -> Option<u32>) -> Vec<u32> {
    let mut chain = Vec::new();
    let mut current = pid;
    while current > 1 && chain.len() < MAX_DEPTH {
        chain.push(current);
        match parent_of(current) {
            // Родитель самому себе — такого не бывает, но проверка дешевле
            // зависшего потока обслуживания.
            Some(parent) if parent != current => current = parent,
            _ => break,
        }
    }
    chain
}

#[cfg(target_os = "macos")]
fn parent_of(pid: u32) -> Option<u32> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: буфер наш и по размеру совпадает с тем, что просим.
    let got = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    // Короткий ответ означает, что заполнено не всё: доверять полю нельзя.
    (got == size).then_some(info.pbi_ppid)
}

#[cfg(target_os = "linux")]
fn parent_of(pid: u32) -> Option<u32> {
    ppid_in_status(&std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?)
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn parent_of(_pid: u32) -> Option<u32> {
    None
}

/// Разбор `/proc/<pid>/status` отдельно от чтения файла: так он проверяется
/// и там, где такого файла нет.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn ppid_in_status(text: &str) -> Option<u32> {
    text.lines()
        .find_map(|line| line.strip_prefix("PPid:"))?
        .trim()
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn the_caller_is_named_by_the_kernel_and_not_by_himself() {
        // Соединяемся сами с собой: pid на том конце обязан оказаться нашим.
        // Это и есть всё свойство, ради которого затеяно опознание по
        // процессу, — сказать «я такой-то» собеседник не может.
        let path = std::env::temp_dir().join(format!("mc-peer-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let _client = UnixStream::connect(&path).unwrap();
        let (served, _) = listener.accept().unwrap();

        assert_eq!(peer_pid(&served), Some(std::process::id()));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_chain_starts_with_the_caller_and_climbs_to_his_parent() {
        let chain = ancestry(std::process::id());
        let parent = own_parent();

        assert_eq!(chain.first(), Some(&std::process::id()));
        assert!(
            chain.contains(&parent),
            "родителя нет в цепочке {chain:?}, ждали {parent}"
        );
    }

    #[test]
    fn a_chain_of_a_process_that_is_gone_is_empty_rather_than_endless() {
        // Панель могли закрыть, пока агент думал. Пустая цепочка — это
        // «не знаю, чей ты», и дальше в дело идёт пропуск.
        assert!(ancestry(0).is_empty());
        assert!(ancestry(1).is_empty());
    }

    #[cfg(unix)]
    fn own_parent() -> u32 {
        // SAFETY: getppid не трогает память и всегда успешен.
        unsafe { libc::getppid() as u32 }
    }

    #[cfg(windows)]
    fn own_parent() -> u32 {
        crate::win_proc::snapshot()
            .into_iter()
            .find(|entry| entry.pid == std::process::id())
            .map(|entry| entry.parent)
            .expect("себя в снимке процессов не нашли")
    }

    #[test]
    fn climbs_while_every_parent_is_older_than_its_child() {
        // Шим 30 ← агент 20 ← шелл панели 10 ← приложение 8.
        let parents = [(30, 20), (20, 10), (10, 8)].into_iter().collect();
        let born = |pid| {
            [(30, 4), (20, 3), (10, 2), (8, 1)]
                .into_iter()
                .find(|&(p, _)| p == pid)
                .map(|(_, at)| at)
        };

        assert_eq!(ancestry_in(30, &parents, born), vec![30, 20, 10, 8]);
    }

    #[test]
    fn a_parent_younger_than_its_child_is_a_stranger_under_the_same_number() {
        // Шелл 10 закрыли, пока агент 20 работал, и номер 10 достался
        // процессу, родившемуся позже агента. Пойди мы по нему дальше —
        // агент нашёлся бы в чужой панели, той, где теперь живёт новый 10.
        let parents = [(30, 20), (20, 10), (10, 8)].into_iter().collect();
        let born = |pid| {
            [(30, 4), (20, 3), (10, 5), (8, 1)]
                .into_iter()
                .find(|&(p, _)| p == pid)
                .map(|(_, at)| at)
        };

        assert_eq!(ancestry_in(30, &parents, born), vec![30, 20]);
    }

    #[test]
    fn stops_where_it_cannot_tell_who_was_born_first() {
        // Времени рождения не узнать — процесс уже ушёл или закрыт от нас.
        let parents = [(30, 20), (20, 10)].into_iter().collect();
        let born = |pid| (pid != 10).then_some(1);

        assert_eq!(ancestry_in(30, &parents, born), vec![30, 20]);
    }

    #[test]
    fn the_parent_is_read_out_of_the_line_that_names_it() {
        let status = "Name:\tzsh\nPid:\t4242\nPPid:\t4158\nTracerPid:\t0\n";
        assert_eq!(ppid_in_status(status), Some(4158));
        // Ни строки про родителя — процесс уже исчез, файл обрезан.
        assert_eq!(ppid_in_status("Name:\tzsh\n"), None);
        assert_eq!(ppid_in_status(""), None);
    }
}
