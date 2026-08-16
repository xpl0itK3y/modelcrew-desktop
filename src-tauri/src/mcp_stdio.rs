//! Шим: агент говорит с ним по stdio, он передаёт всё в сокет приложения.
//!
//! Это то же самое приложение, запущенное с `--mcp-stdio`, — ровно тот приём,
//! которым уже работают хуки на Windows: exe запускает любая оболочка, а
//! отдельный бинарник пришлось бы собирать, подписывать и класть в пакет.
//!
//! Шим намеренно глуп: он не разбирает JSON-RPC и ничего о нём не знает. Иначе
//! протокол пришлось бы поддерживать в двух местах, и они разъехались бы при
//! первой же правке. Своё у него ровно одно — рукопожатие: первой строкой он
//! предъявляет пропуск панели, из окружения которой запущен.

use std::io::{BufRead, BufReader, Write};

use crate::mcp;

/// Запуск шимом. `None` — запуск обычный, приложение должно подниматься.
pub fn run_if_shim() -> Option<i32> {
    if !is_shim(std::env::args()) {
        return None;
    }
    Some(run())
}

fn is_shim<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .nth(1)
        .is_some_and(|arg| arg.as_ref() == mcp::STDIO_FLAG)
}

#[cfg(unix)]
fn run() -> i32 {
    use std::os::unix::net::UnixStream;

    let Ok(path) = std::env::var(mcp::SOCK_ENV) else {
        return fail(&format!(
            "{} не задана: агент запущен не из терминала ModelCrew.",
            mcp::SOCK_ENV
        ));
    };
    let token = std::env::var(mcp::TOKEN_ENV).unwrap_or_default();
    if token.is_empty() {
        return fail(&format!(
            "{} не задана: непонятно, чья это панель.",
            mcp::TOKEN_ENV
        ));
    }
    let Ok(stream) = UnixStream::connect(&path) else {
        return fail(&format!("ModelCrew не отвечает на {path}."));
    };

    pump(stream, &token)
}

#[cfg(not(unix))]
fn run() -> i32 {
    // На Windows нужен именованный канал. Пока его нет, приложение не ставит
    // панели переменную окружения, так что сюда попасть можно только вручную.
    fail("MCP на этой платформе пока не поддержан.")
}

/// Перекачка в обе стороны. Ответы идут своим потоком: сервер отвечает не
/// обязательно по одному ответу на запрос — уведомления он может слать сам,
/// а порядок ответов протокол не обещает.
#[cfg(unix)]
fn pump(stream: std::os::unix::net::UnixStream, token: &str) -> i32 {
    let Ok(read_half) = stream.try_clone() else {
        return fail("не удалось раздвоить соединение.");
    };
    let mut to_app = stream;

    if to_app
        .write_all(mcp::handshake(token).as_bytes())
        .and_then(|()| to_app.write_all(b"\n"))
        .and_then(|()| to_app.flush())
        .is_err()
    {
        return fail("рукопожатие не дошло.");
    }

    // Сокет → stdout.
    let back = std::thread::spawn(move || {
        let mut out = std::io::stdout();
        for line in BufReader::new(read_half).lines().map_while(Result::ok) {
            if out
                .write_all(line.as_bytes())
                .and_then(|()| out.write_all(b"\n"))
                .and_then(|()| out.flush())
                .is_err()
            {
                return;
            }
        }
    });

    // stdin → сокет. Конец ввода означает, что агент закончил: закрываем
    // запись, чтобы приложение увидело конец, и ждём остатки ответов.
    for line in BufReader::new(std::io::stdin())
        .lines()
        .map_while(Result::ok)
    {
        if to_app
            .write_all(line.as_bytes())
            .and_then(|()| to_app.write_all(b"\n"))
            .and_then(|()| to_app.flush())
            .is_err()
        {
            break;
        }
    }
    let _ = to_app.shutdown(std::net::Shutdown::Write);
    let _ = back.join();
    0
}

/// Причина уходит в stderr: stdout занят протоколом, и любая посторонняя
/// строка в нём читается клиентом как битый ответ.
fn fail(reason: &str) -> i32 {
    eprintln!("ModelCrew MCP: {reason}");
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shim_run_is_told_apart_from_a_normal_one() {
        assert!(is_shim(["ModelCrew", mcp::STDIO_FLAG]));
        // Обычный запуск: окно должно подняться, а не молча закрыться.
        assert!(!is_shim(["ModelCrew"]));
        assert!(!is_shim(["ModelCrew", "--version"]));
        // Флаг не первым аргументом — не наш случай: так его мог передать
        // пользователь чему-то другому.
        assert!(!is_shim(["ModelCrew", "--other", mcp::STDIO_FLAG]));
    }

    #[test]
    fn does_not_collide_with_the_hook_flag() {
        // Оба флага проверяются на одном и том же месте, и спутать их нельзя:
        // хук отвечает и выходит, шим держит сессию.
        assert!(!is_shim(["ModelCrew", crate::agent_hook_cli::HOOK_FLAG]));
        assert!(crate::agent_hook_cli::mode_from_args(["ModelCrew", mcp::STDIO_FLAG]).is_none());
    }
}
