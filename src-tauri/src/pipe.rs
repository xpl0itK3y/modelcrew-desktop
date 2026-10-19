// Именованный канал Windows — то, чем на unix служит сокет в каталоге данных:
// вход агента в приложение.
//
// Сокет защищён каталогом с правами 0700. У канала каталога нет: все каналы
// машины лежат в одном общем пространстве имён, и защищать их приходится
// иначе.
// - В имени SID пользователя. Без него два человека за одной машиной делили бы
//   один вход, и второй приложение не поднял бы вовсе.
// - Открыть канал может только этот SID. Остальным система откажет, ещё не
//   соединив.
// - Сетевых клиентов канал не принимает: вход локальный, как и сокет.
// - Имя канала не секрет, и занять его первым может кто угодно. Поэтому
//   клиент, прежде чем отдать пропуск, проверяет, чей процесс на том конце.

use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    LocalFree, ERROR_NO_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE,
    HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
    TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_SHARE_NONE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
    SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, GetNamedPipeServerProcessId,
    WaitNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Сколько система держит в канале, пока другой конец не прочёл. Ответ со
/// снимком экрана больше, но это не предел, а размер порции: запись просто
/// дождётся, пока читатель заберёт предыдущую.
const BUFFER: u32 = 64 * 1024;

/// Адрес канала этого пользователя: `\\.\pipe\<base>.<SID>`.
///
/// Одинаковый у приложения и у шима — оба вычисляют его сами, без окружения.
pub fn address(base: &str) -> Option<PathBuf> {
    let sid = User::current()?.text()?;
    Some(PathBuf::from(format!(r"\\.\pipe\{base}.{sid}")))
}

/// Слушатель: держит экземпляр канала, который ждёт следующего клиента.
pub struct Listener {
    name: Vec<u16>,
    access: OnlyUser,
    waiting: Option<OwnedHandle>,
}

impl Listener {
    /// `first` — имя должно быть свободно, и занимаем его мы. Если оно уже
    /// занято, это отказ, а не подключение к чужому каналу: иначе клиенты
    /// расходились бы между нами и тем, кто успел раньше.
    pub fn bind(name: &Path, first: bool) -> io::Result<Self> {
        let access = OnlyUser::new()
            .ok_or_else(|| io::Error::other("не удалось описать доступ к каналу"))?;
        let name = wide(name.as_os_str());
        let waiting = instance(&name, &access, first)?;
        Ok(Self {
            name,
            access,
            waiting: Some(waiting),
        })
    }

    /// Ждёт клиента. Отдаёт канал к нему и pid процесса на том конце — по
    /// данным системы, а не по словам клиента.
    pub fn accept(&mut self) -> io::Result<(File, Option<u32>)> {
        let pipe = match self.waiting.take() {
            Some(pipe) => pipe,
            None => instance(&self.name, &self.access, false)?,
        };
        if unsafe { ConnectNamedPipe(pipe.as_raw_handle(), null_mut()) } == 0 {
            let error = io::Error::last_os_error();
            let code = error.raw_os_error().unwrap_or(0) as u32;
            // Клиент успел соединиться раньше, чем мы начали ждать, — или
            // успел и уйти. Во втором случае разговор прочтёт конец и
            // закончится сам.
            if code != ERROR_PIPE_CONNECTED && code != ERROR_NO_DATA {
                return Err(error);
            }
        }
        // Следующий экземпляр — сразу, пока этот ещё открыт. Пока жив хоть
        // один экземпляр, клиент слышит «занято» и ждёт; не останется ни
        // одного — услышит «канала нет» и решит, что приложение закрыто.
        self.waiting = instance(&self.name, &self.access, false).ok();
        let client = client_pid(&pipe);
        Ok((File::from(pipe), client))
    }
}

/// Подключение к каналу. `wait` — сколько ждать, если все экземпляры заняты.
///
/// `NotFound` — канала нет: приложение закрыто или сервер выключен.
/// `PermissionDenied` — канал держит процесс чужого пользователя.
pub fn connect(name: &Path, wait: Duration) -> io::Result<File> {
    let name = wide(name.as_os_str());
    let deadline = Instant::now() + wait;
    let pipe = loop {
        // Только опознание: сервер узнает, кто мы, но выступать от нашего
        // имени не сможет.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_NONE,
                null(),
                OPEN_EXISTING,
                SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            break unsafe { OwnedHandle::from_raw_handle(handle) };
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_PIPE_BUSY as i32) {
            return Err(error);
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "канал занят"));
        }
        // Все экземпляры заняты, а следующий сервер выставит вот-вот. Ноль
        // здесь значил бы «сколько решит система», поэтому не меньше единицы.
        let millis = left.as_millis().clamp(1, u128::from(u32::MAX)) as u32;
        unsafe { WaitNamedPipeW(name.as_ptr(), millis) };
    };
    if !server_is_ours(&pipe) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "канал держит процесс другого пользователя",
        ));
    }
    Ok(File::from(pipe))
}

fn instance(name: &[u16], access: &OnlyUser, first: bool) -> io::Result<OwnedHandle> {
    // Наследовать нельзя: иначе канал утёк бы в каждый процесс, который
    // приложение запускает, — в том числе в агентов.
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: access.0,
        bInheritHandle: 0,
    };
    let mut open = PIPE_ACCESS_DUPLEX;
    if first {
        open |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            open,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            BUFFER,
            BUFFER,
            0,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn client_pid(pipe: &OwnedHandle) -> Option<u32> {
    let mut pid = 0;
    let ok = unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid) };
    (ok != 0 && pid != 0).then_some(pid)
}

/// Тот ли пользователь держит канал, что и мы. Не выяснили — не тот: пропуск
/// панели не должен уйти неизвестно кому.
fn server_is_ours(pipe: &OwnedHandle) -> bool {
    let mut pid = 0;
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } == 0 {
        return false;
    }
    match (User::of_pid(pid), User::current()) {
        (Some(theirs), Some(ours)) => theirs.is(&ours),
        _ => false,
    }
}

/// Пользователь процесса — буфер `TOKEN_USER`, в котором лежит его SID.
/// Буфер из `u64`, а не из байтов: внутри указатель, и его нужно выровнять.
struct User(Vec<u64>);

impl User {
    fn current() -> Option<Self> {
        // Псевдодескриптор своего процесса: закрывать его не нужно.
        Self::of_process(unsafe { GetCurrentProcess() })
    }

    fn of_pid(pid: u32) -> Option<Self> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return None;
        }
        let process = unsafe { OwnedHandle::from_raw_handle(process) };
        Self::of_process(process.as_raw_handle())
    }

    fn of_process(process: HANDLE) -> Option<Self> {
        let mut token = null_mut();
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let mut size = 0_u32;
        unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut size) };
        if size == 0 {
            return None;
        }
        let mut buffer = vec![0_u64; (size as usize).div_ceil(8)];
        let ok = unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                buffer.as_mut_ptr().cast(),
                size,
                &mut size,
            )
        };
        (ok != 0).then_some(Self(buffer))
    }

    fn sid(&self) -> PSID {
        unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }

    fn is(&self, other: &User) -> bool {
        unsafe { EqualSid(self.sid(), other.sid()) != 0 }
    }

    /// SID строкой: `S-1-5-21-…`.
    fn text(&self) -> Option<String> {
        let mut text = null_mut();
        if unsafe { ConvertSidToStringSidW(self.sid(), &mut text) } == 0 {
            return None;
        }
        let length = (0..)
            .take_while(|&at| unsafe { *text.add(at) } != 0)
            .count();
        let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).ok();
        unsafe { LocalFree(text.cast()) };
        sid
    }
}

/// Доступ «только этому пользователю» в том виде, какой ждёт
/// `CreateNamedPipeW`.
struct OnlyUser(PSECURITY_DESCRIPTOR);

impl OnlyUser {
    fn new() -> Option<Self> {
        let sid = User::current()?.text()?;
        // P — без прав, унаследованных сверху; GA — всё, но одному SID.
        // Остальным система откажет, ещё не соединив.
        let sddl = wide(OsStr::new(&format!("D:P(A;;GA;;;{sid})")));
        let mut descriptor = null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        };
        (ok != 0).then_some(Self(descriptor))
    }
}

impl Drop for OnlyUser {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

// Слушатель уходит в свой поток вместе с описанием доступа. Описание после
// создания никто не меняет, и переносить его между потоками безопасно.
unsafe impl Send for OnlyUser {}

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Своё имя каждому тесту: тесты идут параллельно, а канал — один на
    /// всю машину.
    fn fresh_name() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        address(&format!(
            "com.modelcrew.desktop.test.{}.{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ))
        .unwrap()
    }

    #[test]
    fn the_address_belongs_to_the_user_who_asks() {
        let name = fresh_name();
        let text = name.to_string_lossy();
        assert!(text.starts_with(r"\\.\pipe\com.modelcrew.desktop.test."));
        assert!(text.contains(".S-1-"), "{text}");
    }

    #[test]
    fn a_line_goes_there_and_back_and_the_server_learns_who_called() {
        let name = fresh_name();
        let mut listener = Listener::bind(&name, true).unwrap();
        let server = std::thread::spawn(move || {
            let (pipe, client) = listener.accept().unwrap();
            let mut reader = BufReader::new(pipe);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let out = reader.get_mut();
            out.write_all(format!("echo {line}").as_bytes()).unwrap();
            out.flush().unwrap();
            client
        });

        let pipe = connect(&name, Duration::from_secs(5)).unwrap();
        let mut reader = BufReader::new(pipe);
        reader.get_mut().write_all(b"hello\n").unwrap();
        let mut answer = String::new();
        reader.read_line(&mut answer).unwrap();

        assert_eq!(answer, "echo hello\n");
        // Клиент — этот же процесс: pid система называет его.
        assert_eq!(server.join().unwrap(), Some(std::process::id()));
    }

    #[test]
    fn the_next_client_gets_in_while_the_first_is_still_talking() {
        let name = fresh_name();
        let mut listener = Listener::bind(&name, true).unwrap();
        let server = std::thread::spawn(move || {
            let first = listener.accept().unwrap();
            let second = listener.accept().unwrap();
            (first, second)
        });

        let first = connect(&name, Duration::from_secs(5)).unwrap();
        let second = connect(&name, Duration::from_secs(5)).unwrap();
        let _ = server.join().unwrap();
        drop((first, second));
    }

    #[test]
    fn a_name_already_taken_is_not_shared() {
        let name = fresh_name();
        let _owner = Listener::bind(&name, true).unwrap();
        assert!(Listener::bind(&name, true).is_err());
    }

    #[test]
    fn no_pipe_means_nobody_is_home() {
        let error = connect(&fresh_name(), Duration::from_secs(1)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn the_pipe_disappears_with_its_last_instance() {
        let name = fresh_name();
        drop(Listener::bind(&name, true).unwrap());
        let error = connect(&name, Duration::from_secs(1)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
