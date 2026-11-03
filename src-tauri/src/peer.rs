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

/// Командная строка процесса, как её запустили: argv по элементам.
///
/// Нужна подписи панели (имя программы на переднем плане). Раньше её давал
/// ps, но это запуск процесса раз в полторы секунды, пока открыт хоть один
/// терминал. Ядро отдаёт то же самое одним системным вызовом.
#[cfg(target_os = "macos")]
pub fn command_line(pid: u32) -> Option<Vec<String>> {
    let mut argmax: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    // SAFETY: буфер наш, размер его типа передан вместе с ним.
    let got = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            &mut argmax as *mut _ as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if got != 0 || argmax <= 0 {
        return None;
    }
    let mut buffer = vec![0u8; argmax as usize];
    let mut size = buffer.len();
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    // SAFETY: буфер наш; ядро пишет не больше size байт и возвращает, сколько
    // записало.
    let got = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            buffer.as_mut_ptr() as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if got != 0 {
        return None;
    }
    argv_in_procargs(&buffer[..size.min(buffer.len())])
}

/// Командная строка процесса, как её запустили: argv по элементам.
#[cfg(target_os = "linux")]
pub fn command_line(pid: u32) -> Option<Vec<String>> {
    argv_in_cmdline(&std::fs::read(format!("/proc/{pid}/cmdline")).ok()?)
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
pub fn command_line(_pid: u32) -> Option<Vec<String>> {
    None
}

/// Короткое имя процесса — когда argv не прочесть: процесс чужой (sudo) или
/// уже зомби. ps в таком случае тоже показывал только его.
#[cfg(target_os = "macos")]
pub fn short_name(pid: u32) -> Option<String> {
    let mut buffer = [0u8; 256];
    // SAFETY: буфер наш, его длина передана вместе с ним.
    let got = unsafe {
        libc::proc_name(
            pid as libc::c_int,
            buffer.as_mut_ptr() as *mut libc::c_void,
            buffer.len() as u32,
        )
    };
    let length = usize::try_from(got).ok().filter(|&length| length > 0)?;
    Some(String::from_utf8_lossy(&buffer[..length.min(buffer.len())]).into_owned())
}

/// Короткое имя процесса — когда argv не прочесть.
#[cfg(target_os = "linux")]
pub fn short_name(pid: u32) -> Option<String> {
    let name = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    let name = name.trim_end_matches('\n');
    (!name.is_empty()).then(|| name.to_string())
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
pub fn short_name(_pid: u32) -> Option<String> {
    None
}

/// Разбор ответа KERN_PROCARGS2: argc, путь к исполняемому файлу, нули
/// выравнивания, затем argc строк argv (за ними окружение — его не трогаем).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn argv_in_procargs(buffer: &[u8]) -> Option<Vec<String>> {
    let argc = i32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?);
    let argc = usize::try_from(argc).ok().filter(|&argc| argc > 0)?;
    let rest = &buffer[4..];
    let after_path = &rest[rest.iter().position(|&byte| byte == 0)?..];
    let args = &after_path[after_path.iter().position(|&byte| byte != 0)?..];
    let argv: Vec<String> = args
        .split(|&byte| byte == 0)
        .take(argc)
        .map(|arg| String::from_utf8_lossy(arg).into_owned())
        .collect();
    (argv.len() == argc).then_some(argv)
}

/// Разбор `/proc/<pid>/cmdline`: argv через нули, с нулём в конце. Пустой
/// файл — у зомби и потоков ядра.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn argv_in_cmdline(bytes: &[u8]) -> Option<Vec<String>> {
    let bytes = bytes.strip_suffix(&[0]).unwrap_or(bytes);
    if bytes.is_empty() {
        return None;
    }
    Some(
        bytes
            .split(|&byte| byte == 0)
            .map(|arg| String::from_utf8_lossy(arg).into_owned())
            .collect(),
    )
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
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn the_command_line_comes_from_the_kernel_whole() {
        // Свой процесс: argv, с которым нас запустили, известен и так.
        let expected: Vec<String> = std::env::args().collect();
        assert_eq!(command_line(std::process::id()), Some(expected));
        let name = short_name(std::process::id()).expect("имя своего процесса");
        assert!(!name.is_empty());
        // Процесса нет — нет и ответа, а не мусор из буфера.
        assert_eq!(command_line(0x7fff_fff0), None);
        assert_eq!(short_name(0x7fff_fff0), None);
    }

    #[test]
    fn procargs_yield_argv_without_the_exec_path_or_the_environment() {
        let mut buffer = 3i32.to_ne_bytes().to_vec();
        buffer.extend_from_slice(b"/usr/local/bin/node\0\0\0\0");
        buffer.extend_from_slice(b"node\0/Users/me/Application Support/codex.js\0--resume\0");
        buffer.extend_from_slice(b"HOME=/Users/me\0");
        assert_eq!(
            argv_in_procargs(&buffer),
            Some(vec![
                "node".to_string(),
                "/Users/me/Application Support/codex.js".to_string(),
                "--resume".to_string(),
            ])
        );
        // Обрезанный ответ не выдаём за полный.
        let mut short = 3i32.to_ne_bytes().to_vec();
        short.extend_from_slice(b"/bin/zsh\0zsh\0");
        assert_eq!(argv_in_procargs(&short), None);
        assert_eq!(argv_in_procargs(&[]), None);
        assert_eq!(argv_in_procargs(&0i32.to_ne_bytes()), None);
    }

    #[test]
    fn cmdline_splits_on_nuls_and_keeps_spaces_inside_an_argument() {
        assert_eq!(
            argv_in_cmdline(b"-zsh\0"),
            Some(vec!["-zsh".to_string()])
        );
        assert_eq!(
            argv_in_cmdline(b"/opt/my tools/claude\0--model\0opus\0"),
            Some(vec![
                "/opt/my tools/claude".to_string(),
                "--model".to_string(),
                "opus".to_string(),
            ])
        );
        assert_eq!(argv_in_cmdline(b""), None);
    }

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
