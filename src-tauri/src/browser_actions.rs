//! Действия агента на странице проекта: прочитать её, нажать, ввести, выбрать,
//! нажать клавишу, прокрутить, положить файлы, дождаться, выполнить выражение.
//!
//! Сами действия — в скрипте страницы: элементы видны только оттуда. Здесь —
//! как его позвать и чего дождаться после: перехода, перерисовки, ответа
//! промиса. Системного ввода нет нарочно: он отнял бы у человека мышь и фокус
//! в окне, на которое тот смотрит.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::browser_page;
use crate::mcp::Acted;

/// Скрипт действий: одна функция, её зовут на каждое действие.
const SCRIPT: &str = include_str!("browser_actions.js");

/// Сколько ждать загрузку, если действие увело страницу на другой адрес.
const LOAD_WAIT: Duration = Duration::from_secs(15);

/// Сколько дать странице ответить на действие: перерисоваться, сходить за
/// данными. Дольше — агент ждёт на каждом нажатии; короче — видит страницу
/// до того, как она успела измениться.
const SETTLE: Duration = Duration::from_millis(250);

/// Сколько ждать промис, который вернуло выражение.
const PROMISE_WAIT: Duration = Duration::from_secs(10);
const PROMISE_POLL: Duration = Duration::from_millis(100);

/// Ожидание текста или элемента: по умолчанию, не дольше и как часто смотреть.
pub const WAIT_DEFAULT: f64 = 10.0;
pub const WAIT_LONGEST: f64 = 30.0;
const WAIT_POLL: Duration = Duration::from_millis(200);

/// Пустой ответ на выражение — значит, скрипт целиком не разобрался.
const EXPRESSION_BROKEN: &str = concat!(
    "Выражение не выполнилось: в нём синтаксическая ошибка. Пишите одно ",
    "выражение — например document.title — или функцию: ",
    "() => { …; return результат; }. Для await — async () => { … }.",
);

/// Выполнить действие и сказать, что вышло и где теперь страница.
///
/// `request` — запрос скрипту страницы: `op` и то, что этому действию нужно.
/// Выражение для `evaluate` идёт в поле `expression`: в скрипт оно встраивается
/// кодом, а не строкой — так его не остановит CSP страницы.
pub fn perform(app: &AppHandle, root: &str, mut request: Value) -> Result<Acted, String> {
    let op = request
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let expression = request
        .as_object_mut()
        .and_then(|fields| fields.remove("expression"))
        .and_then(|value| value.as_str().map(str::to_string));
    let (before, _) = browser_page::info(app, root).unwrap_or_default();
    let answer = match op.as_str() {
        "read" => act(app, root, &request, None)?,
        "check" => wait(app, root, &request)?,
        "evaluate" => {
            let answer = evaluate(app, root, &request, expression.as_deref())?;
            settle(app, root);
            follow(app, root, answer)
        }
        _ => {
            let answer = act(app, root, &request, None)?;
            settle(app, root);
            follow(app, root, answer)
        }
    };
    let (url, title) = browser_page::info(app, root).unwrap_or_default();
    let (text, notes) = split(&answer);
    let left = (!before.is_empty() && !url.is_empty() && before != url).then_some(before);
    Ok(Acted {
        text,
        notes,
        url,
        title,
        left,
    })
}

/// Вызов скрипта страницы. Выражение встраивается отдельными строками: иначе
/// комментарий в его конце съел бы закрывающую скобку.
pub fn compose(request: &Value, expression: Option<&str>) -> String {
    let thunk = expression.map_or_else(
        || "undefined".to_string(),
        |code| format!("() => (\n{code}\n)"),
    );
    format!("(\n{SCRIPT}\n)({request}, {thunk})")
}

/// Спросить страницу. Ответ — как его дал скрипт, с отказом в поле `error`.
/// Ошибка здесь — страница не ответила вовсе.
fn ask(
    app: &AppHandle,
    root: &str,
    request: &Value,
    expression: Option<&str>,
) -> Result<Value, String> {
    let answer = browser_page::run(app, root, &compose(request, expression))?.ok_or_else(|| {
        if expression.is_some() {
            EXPRESSION_BROKEN.to_string()
        } else {
            // Скрипт свой и проверен: не выполнился он, только если страница
            // как раз сменилась.
            "Страница не выполнила действие — похоже, она как раз загружается. Повторите."
                .to_string()
        }
    })?;
    serde_json::from_str(&answer).map_err(|_| "ответ страницы не разобрать".to_string())
}

/// То же, но отказ скрипта — ошибка: агент читает её как причину.
fn act(
    app: &AppHandle,
    root: &str,
    request: &Value,
    expression: Option<&str>,
) -> Result<Value, String> {
    let answer = ask(app, root, request, expression)?;
    match answer.get("error").and_then(Value::as_str) {
        Some(reason) => Err(reason.to_string()),
        None => Ok(answer),
    }
}

/// Страница отвечает на действие не сразу: переход, перерисовка, запрос.
fn settle(app: &AppHandle, root: &str) {
    browser_page::wait_ready(app, root, LOAD_WAIT);
    std::thread::sleep(SETTLE);
}

/// После действия: каким стал элемент и что страница сделала сама — диалоги,
/// попытки открыть системные окна. Не ответила — значит, ушла дальше, и об
/// этом скажет адрес.
fn follow(app: &AppHandle, root: &str, mut answer: Value) -> Value {
    let request =
        json!({ "op": "after", "ref": answer.get("ref").cloned().unwrap_or(Value::Null) });
    let Ok(after) = act(app, root, &request, None) else {
        return answer;
    };
    let (text, notes) = split(&after);
    if let Some(fields) = answer.as_object_mut() {
        let before = fields
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let text = with_after(before, &text);
        fields.insert("text".into(), Value::String(text));
        if !notes.is_empty() {
            let mut all: Vec<Value> = fields
                .get("notes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            all.extend(notes.into_iter().map(Value::String));
            fields.insert("notes".into(), Value::Array(all));
        }
    }
    answer
}

/// Ответ на действие и то, каким элемент стал после. Если он такой же, каким
/// его уже назвал ответ, — повторять незачем.
fn with_after(before: &str, after: &str) -> String {
    let now = after.strip_prefix("Теперь: ").unwrap_or(after);
    if after.is_empty() || before.contains(now) {
        before.to_string()
    } else {
        format!("{before}\n{after}")
    }
}

fn split(answer: &Value) -> (String, Vec<String>) {
    let text = answer
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let notes = answer
        .get("notes")
        .and_then(Value::as_array)
        .map(|notes| {
            notes
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    (text, notes)
}

/// Выражение и, если оно вернуло промис, его ответ.
fn evaluate(
    app: &AppHandle,
    root: &str,
    request: &Value,
    expression: Option<&str>,
) -> Result<Value, String> {
    let expression = expression
        .map(str::trim)
        .filter(|code| !code.is_empty())
        .ok_or_else(|| "Не сказано, что выполнить: нужен параметр expression.".to_string())?;
    let answer = act(app, root, request, Some(expression))?;
    let Some(id) = answer.get("pending").and_then(Value::as_u64) else {
        return Ok(answer);
    };
    // Ждать промис внутри одного вызова нельзя: система отдаёт ответ скрипта
    // сразу. Поэтому страница держит его у себя, а мы переспрашиваем.
    let deadline = Instant::now() + PROMISE_WAIT;
    loop {
        std::thread::sleep(PROMISE_POLL);
        let answer = act(app, root, &json!({ "op": "settled", "id": id }), None)?;
        if answer.get("pending").is_none() {
            return Ok(answer);
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Промис не разрешился за {} с. Если ответ дольше, дождитесь его через browser_wait, \
                 а результат положите на страницу или в window.",
                PROMISE_WAIT.as_secs()
            ));
        }
    }
}

/// Ждать, пока на странице появится или пропадёт текст либо элемент.
fn wait(app: &AppHandle, root: &str, request: &Value) -> Result<Value, String> {
    let seconds = request
        .get("seconds")
        .and_then(Value::as_f64)
        .unwrap_or(WAIT_DEFAULT)
        .clamp(0.0, WAIT_LONGEST);
    let started = Instant::now();
    let deadline = started + Duration::from_secs_f64(seconds);
    loop {
        // Пока страница переходит, она может не ответить — это ещё не повод
        // сдаваться. Отказ скрипта — повод: значит, сам запрос неверен.
        if let Ok(answer) = ask(app, root, request, None) {
            if let Some(reason) = answer.get("error").and_then(Value::as_str) {
                return Err(reason.to_string());
            }
            if answer.get("met") == Some(&Value::Bool(true)) {
                let spent = started.elapsed().as_secs_f64();
                return Ok(json!({
                    "text": format!("Дождались за {spent:.1} с: {}.", awaited(request, true)),
                }));
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "За {seconds} с не дождались: {}. Посмотрите, что на странице, — browser_read или browser_screenshot.",
                awaited(request, false)
            ));
        }
        std::thread::sleep(WAIT_POLL);
    }
}

/// Чего ждали — словами, для ответа агенту.
pub fn awaited(request: &Value, met: bool) -> String {
    let gone = request.get("gone") == Some(&Value::Bool(true));
    if let Some(text) = request.get("text").and_then(Value::as_str) {
        return match (gone, met) {
            (false, true) => format!("текст «{text}» на странице"),
            (false, false) => format!("текста «{text}» на странице всё ещё нет"),
            (true, true) => format!("текста «{text}» на странице больше нет"),
            (true, false) => format!("текст «{text}» всё ещё на странице"),
        };
    }
    let selector = request
        .get("selector")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match (gone, met) {
        (false, true) => format!("элемент «{selector}» виден"),
        (false, false) => format!("элемента «{selector}» всё ещё не видно"),
        (true, true) => format!("элемента «{selector}» больше не видно"),
        (true, false) => format!("элемент «{selector}» всё ещё виден"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_is_one_function_called_with_the_request() {
        let call = compose(&json!({ "op": "read" }), None);
        assert!(call.starts_with("(\n"), "{}", &call[..40]);
        assert!(
            call.ends_with(r#")({"op":"read"}, undefined)"#),
            "{}",
            &call[call.len() - 60..]
        );
    }

    #[test]
    fn a_comment_at_the_end_of_an_expression_does_not_swallow_the_call() {
        // Агент пишет как в консоли, и комментарий в конце — обычное дело.
        let call = compose(
            &json!({ "op": "evaluate" }),
            Some("document.title // заголовок"),
        );
        assert!(
            call.ends_with("() => (\ndocument.title // заголовок\n))"),
            "{}",
            &call[call.len() - 80..]
        );
    }

    #[test]
    fn says_what_it_waited_for_either_way() {
        let text = json!({ "op": "check", "text": "Сохранено" });
        assert_eq!(awaited(&text, true), "текст «Сохранено» на странице");
        assert_eq!(
            awaited(&text, false),
            "текста «Сохранено» на странице всё ещё нет"
        );
        let gone = json!({ "op": "check", "selector": ".spinner", "gone": true });
        assert_eq!(awaited(&gone, true), "элемента «.spinner» больше не видно");
        assert_eq!(awaited(&gone, false), "элемент «.spinner» всё ещё виден");
    }

    #[test]
    fn names_the_element_again_only_if_it_changed() {
        let clicked = "Нажали [e2 button «Сохранить» focused].";
        assert_eq!(
            with_after(clicked, "Теперь: [e2 button «Сохранить» focused]"),
            clicked
        );
        assert_eq!(
            with_after(clicked, "Теперь: [e2 button «Сохранить» disabled focused]"),
            format!("{clicked}\nТеперь: [e2 button «Сохранить» disabled focused]")
        );
        assert_eq!(with_after(clicked, ""), clicked);
    }

    #[test]
    fn notes_ride_along_with_the_text() {
        let (text, notes) = split(&json!({ "text": "Нажали", "notes": ["диалог", 7] }));
        assert_eq!(text, "Нажали");
        assert_eq!(notes, ["диалог"]);
    }
}
