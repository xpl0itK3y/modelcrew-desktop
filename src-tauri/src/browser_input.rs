//! Настоящий ввод в страницу проекта: события мыши системы.
//!
//! События из скрипта страницы браузер отличает от настоящих: `isTrusted` у
//! них ложь, CSS-правило `:hover` от них не включается, а в рамку с другого
//! домена скрипту не попасть вовсе. Настоящее событие система отдаёт прямо
//! webview страницы — мимо курсора и фокуса человека: его мышь не дёргается,
//! окно на передний план не выходит.
//!
//! Точки — в CSS-пикселях окна страницы, как их меряет скрипт. Сколько это
//! точек самого webview, считается по его размеру: страницу могли подогнать
//! под ящик или увеличить.

use serde_json::Value;
use tauri::AppHandle;

/// Точка на странице и окно страницы, в котором её мерили: `innerWidth` и
/// `innerHeight`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spot {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Input {
    /// Подвести мышь.
    Move(Spot),
    /// Подвести и нажать. `count` — сколько нажатий подряд: два — двойное.
    Click { at: Spot, button: Button, count: u8 },
}

impl Input {
    /// Что ввести — как это расписал скрипт страницы.
    pub fn from_plan(plan: &Value) -> Result<Self, String> {
        let number = |key: &str| {
            plan.get(key)
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .ok_or_else(|| format!("в плане ввода нет {key}"))
        };
        let at = Spot {
            x: number("x")?,
            y: number("y")?,
            width: number("width")?,
            height: number("height")?,
        };
        match plan.get("kind").and_then(Value::as_str) {
            Some("move") => Ok(Input::Move(at)),
            Some("click") => Ok(Input::Click {
                at,
                button: match plan.get("button").and_then(Value::as_str) {
                    Some("right") => Button::Right,
                    _ => Button::Left,
                },
                count: plan
                    .get("count")
                    .and_then(Value::as_u64)
                    .map_or(1, |count| count.clamp(1, 3) as u8),
            }),
            other => Err(format!("ввод «{}» не знаю", other.unwrap_or_default())),
        }
    }
}

/// Есть ли здесь настоящий ввод. Нет — действует скрипт страницы.
pub const AVAILABLE: bool = cfg!(any(target_os = "macos", target_os = "linux", windows));

/// Отдать ввод странице проекта.
pub fn send(app: &AppHandle, root: &str, input: Input) -> Result<(), String> {
    system::send(app, root, input)
}

/// Во сколько раз точка webview больше CSS-пикселя страницы — по каждой оси.
#[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
fn scale(view: (f64, f64), at: &Spot) -> (f64, f64) {
    let across = if at.width > 0.0 && view.0 > 0.0 {
        view.0 / at.width
    } else {
        1.0
    };
    let down = if at.height > 0.0 && view.1 > 0.0 {
        view.1 / at.height
    } else {
        across
    };
    (across, down)
}

/// macOS: события AppKit прямо в WKWebView, мимо окна и курсора.
#[cfg(target_os = "macos")]
mod system {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::{NSPoint, NSProcessInfo};
    use objc2_web_kit::WKWebView;
    use tauri::AppHandle;

    use super::{Button, Input, Spot};

    pub fn send(app: &AppHandle, root: &str, input: Input) -> Result<(), String> {
        crate::browser_page::ask(app, root, move |platform| {
            // Указатель отдаёт сам Tauri, на главном потоке, где webview и
            // живёт.
            let webview = unsafe { &*(platform.inner() as *mut WKWebView) };
            deliver(webview, input)
        })
    }

    fn deliver(webview: &WKWebView, input: Input) -> Result<(), String> {
        let window = webview
            .window()
            .ok_or_else(|| "у страницы нет окна".to_string())?;
        let number = window.windowNumber();
        let time = NSProcessInfo::processInfo().systemUptime();
        let mouse = |kind: NSEventType,
                     at: Spot,
                     clicks: isize,
                     pressure: f32|
         -> Result<Retained<NSEvent>, String> {
            NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                kind,
                place(webview, &at),
                NSEventModifierFlags(0),
                time,
                number,
                None,
                0,
                clicks,
                pressure,
            )
            .ok_or_else(|| "событие мыши не собралось".to_string())
        };
        let (at, press) = match input {
            Input::Move(at) => (at, None),
            Input::Click { at, button, count } => (at, Some((button, count))),
        };
        // Простое движение мыши над окном не в фокусе WebKit отдаёт только
        // полосам прокрутки: наведения на странице от него нет. Движение с
        // кнопкой страница получает целиком, а какие кнопки зажаты, WebKit
        // спрашивает у системы — у неё не зажато ничего. Странице это обычный
        // mousemove.
        let moved = mouse(NSEventType::LeftMouseDragged, at, 0, 0.0)?;
        webview.mouseDragged(&moved);
        let Some((button, count)) = press else {
            return Ok(());
        };
        for clicks in 1..=isize::from(count) {
            match button {
                Button::Left => {
                    let down = mouse(NSEventType::LeftMouseDown, at, clicks, 1.0)?;
                    let up = mouse(NSEventType::LeftMouseUp, at, clicks, 0.0)?;
                    webview.mouseDown(&down);
                    webview.mouseUp(&up);
                }
                Button::Right => {
                    let down = mouse(NSEventType::RightMouseDown, at, clicks, 1.0)?;
                    let up = mouse(NSEventType::RightMouseUp, at, clicks, 0.0)?;
                    webview.rightMouseDown(&down);
                    webview.rightMouseUp(&up);
                }
            }
        }
        Ok(())
    }

    /// Точка страницы — точка в окне, где стоит webview.
    fn place(webview: &WKWebView, at: &Spot) -> NSPoint {
        let bounds = webview.bounds();
        let (across, down) = super::scale((bounds.size.width, bounds.size.height), at);
        let from_top = at.y * down;
        let y = if webview.isFlipped() {
            from_top
        } else {
            bounds.size.height - from_top
        };
        webview.convertPoint_toView(NSPoint::new(at.x * across, y), None)
    }
}

/// Linux: события GDK прямо в виджет WebKitGTK. Страница живёт в окне без
/// экрана, и мышь человека до неё не достаёт вовсе.
#[cfg(target_os = "linux")]
mod system {
    use gtk::gdk;
    use gtk::glib;
    use gtk::glib::translate::{from_glib_full, IntoGlib, ToGlibPtr, ToGlibPtrMut};
    use gtk::prelude::*;
    use tauri::AppHandle;

    use super::{Button, Input, Spot};

    pub fn send(app: &AppHandle, root: &str, input: Input) -> Result<(), String> {
        crate::browser_page::ask(app, root, move |platform| deliver(&platform.inner(), input))
    }

    fn deliver(webview: &webkit2gtk::WebView, input: Input) -> Result<(), String> {
        let window = webview
            .window()
            .ok_or_else(|| "у страницы нет окна".to_string())?;
        // WebKit спрашивает у события, с какого оно устройства: без него
        // событие для него не мышь.
        let pointer = window
            .display()
            .default_seat()
            .and_then(|seat| seat.pointer())
            .ok_or_else(|| "у системы нет мыши".to_string())?;
        let (at, press) = match input {
            Input::Move(at) => (at, None),
            Input::Click { at, button, count } => (at, Some((button, count))),
        };
        let (x, y) = place(webview, &at);
        let (root_x, root_y) = window.root_coords(x.round() as i32, y.round() as i32);
        // Время — настоящее: по нему WebKit считает, двойное ли нажатие.
        let time = (glib::monotonic_time() / 1000) as u32;
        let mouse = |kind: gdk::EventType, button: u32, state: gdk::ModifierType| {
            let mut event: gdk::Event =
                unsafe { from_glib_full(gdk::ffi::gdk_event_new(kind.into_glib())) };
            event.set_device(Some(&pointer));
            unsafe {
                let raw: *mut gdk::ffi::GdkEvent = event.to_glib_none_mut().0;
                // Окно событие отпустит само, когда его освободят.
                let owner: *mut gdk::ffi::GdkWindow = window.to_glib_full();
                if kind == gdk::EventType::MotionNotify {
                    let motion = &mut (*raw).motion;
                    motion.window = owner;
                    motion.time = time;
                    motion.x = x;
                    motion.y = y;
                    motion.x_root = f64::from(root_x);
                    motion.y_root = f64::from(root_y);
                    motion.state = state.into_glib();
                } else {
                    let pressed = &mut (*raw).button;
                    pressed.window = owner;
                    pressed.time = time;
                    pressed.x = x;
                    pressed.y = y;
                    pressed.x_root = f64::from(root_x);
                    pressed.y_root = f64::from(root_y);
                    pressed.state = state.into_glib();
                    pressed.button = button;
                }
            }
            webview.event(&event);
        };
        mouse(gdk::EventType::MotionNotify, 0, gdk::ModifierType::empty());
        let Some((button, count)) = press else {
            return Ok(());
        };
        let (number, held) = match button {
            Button::Left => (1, gdk::ModifierType::BUTTON1_MASK),
            Button::Right => (3, gdk::ModifierType::BUTTON3_MASK),
        };
        for _ in 0..count {
            mouse(
                gdk::EventType::ButtonPress,
                number,
                gdk::ModifierType::empty(),
            );
            mouse(gdk::EventType::ButtonRelease, number, held);
        }
        Ok(())
    }

    /// Точка страницы — точка в окне GDK, которому идёт событие.
    fn place(webview: &webkit2gtk::WebView, at: &Spot) -> (f64, f64) {
        let view = (
            f64::from(webview.allocated_width()),
            f64::from(webview.allocated_height()),
        );
        let (across, down) = super::scale(view, at);
        let (mut x, mut y) = (at.x * across, at.y * down);
        // Своего окна у виджета нет — точки считаются от окна родителя.
        if !webview.has_window() {
            let allocation = webview.allocation();
            x += f64::from(allocation.x());
            y += f64::from(allocation.y());
        }
        (x, y)
    }
}

/// Windows: события мыши через DevTools самого WebView2 — те же, что шлёт
/// Playwright. Окно и курсор системы они не трогают.
#[cfg(windows)]
mod system {
    use std::collections::VecDeque;
    use std::sync::mpsc;
    use std::time::Duration;

    use serde_json::{json, Value};
    use tauri::AppHandle;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
    use windows::core::HSTRING;

    use super::{Button, Input};

    /// Страница отвечает на событие, когда его разошлёт. Дольше этого — уже
    /// не ответит.
    const WAIT: Duration = Duration::from_secs(5);

    type Done = mpsc::Sender<Result<(), String>>;

    pub fn send(app: &AppHandle, root: &str, input: Input) -> Result<(), String> {
        let events = events(input);
        // Ответ DevTools приходит на главный поток позже, своим вызовом:
        // ждём его здесь, а не там.
        let done = crate::browser_page::ask(app, root, move |platform| {
            let webview = unsafe { platform.controller().CoreWebView2() }
                .map_err(|error| format!("до страницы не достучаться: {error}"))?;
            let (sender, receiver) = mpsc::channel();
            next(webview, events, sender);
            Ok(receiver)
        })?;
        done.recv_timeout(WAIT)
            .unwrap_or_else(|_| Err("страница не ответила на ввод".to_string()))
    }

    /// Точки — в CSS-пикселях страницы: так их и ждёт DevTools.
    fn events(input: Input) -> VecDeque<Value> {
        let (at, press) = match input {
            Input::Move(at) => (at, None),
            Input::Click { at, button, count } => (at, Some((button, count))),
        };
        let mut events = VecDeque::from([json!({
            "type": "mouseMoved", "x": at.x, "y": at.y, "button": "none", "buttons": 0,
        })]);
        if let Some((button, count)) = press {
            let (name, held) = match button {
                Button::Left => ("left", 1),
                Button::Right => ("right", 2),
            };
            for clicks in 1..=count {
                events.push_back(json!({
                    "type": "mousePressed", "x": at.x, "y": at.y,
                    "button": name, "buttons": held, "clickCount": clicks,
                }));
                events.push_back(json!({
                    "type": "mouseReleased", "x": at.x, "y": at.y,
                    "button": name, "buttons": 0, "clickCount": clicks,
                }));
            }
        }
        events
    }

    /// События по одному: следующее — когда страница разослала прошлое.
    fn next(webview: ICoreWebView2, mut events: VecDeque<Value>, done: Done) {
        let Some(event) = events.pop_front() else {
            let _ = done.send(Ok(()));
            return;
        };
        let failed = done.clone();
        let after = webview.clone();
        let handler =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, _answer| {
                match result {
                    Ok(()) => next(after, events, done),
                    Err(error) => {
                        let _ = done.send(Err(format!("ввод до страницы не дошёл: {error}")));
                    }
                }
                Ok(())
            }));
        let method = HSTRING::from("Input.dispatchMouseEvent");
        let params = HSTRING::from(event.to_string());
        if let Err(error) =
            unsafe { webview.CallDevToolsProtocolMethod(&method, &params, &handler) }
        {
            let _ = failed.send(Err(format!("ввод не начался: {error}")));
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::browser_input::Spot;

        #[test]
        fn a_double_click_is_two_presses_counted_up() {
            let at = Spot {
                x: 5.0,
                y: 6.0,
                width: 100.0,
                height: 100.0,
            };
            let events = events(Input::Click {
                at,
                button: Button::Left,
                count: 2,
            });
            let kinds: Vec<_> = events
                .iter()
                .map(|event| (event["type"].clone(), event["clickCount"].clone()))
                .collect();
            assert_eq!(
                kinds,
                [
                    (json!("mouseMoved"), Value::Null),
                    (json!("mousePressed"), json!(1)),
                    (json!("mouseReleased"), json!(1)),
                    (json!("mousePressed"), json!(2)),
                    (json!("mouseReleased"), json!(2)),
                ]
            );
        }
    }
}

/// Остальные системы: настоящего ввода нет, действует скрипт страницы.
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod system {
    use tauri::AppHandle;

    use super::Input;

    pub fn send(_app: &AppHandle, _root: &str, _input: Input) -> Result<(), String> {
        Err("настоящего ввода здесь нет".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_plan_the_page_script_wrote() {
        let plan = json!({
            "kind": "click", "x": 10.5, "y": 20, "width": 800, "height": 600,
            "button": "right", "count": 2,
        });
        assert_eq!(
            Input::from_plan(&plan),
            Ok(Input::Click {
                at: Spot {
                    x: 10.5,
                    y: 20.0,
                    width: 800.0,
                    height: 600.0
                },
                button: Button::Right,
                count: 2,
            })
        );
        let plan = json!({ "kind": "move", "x": 1, "y": 2, "width": 3, "height": 4 });
        assert!(matches!(Input::from_plan(&plan), Ok(Input::Move(_))));
    }

    #[test]
    fn refuses_a_plan_without_a_point() {
        let plan = json!({ "kind": "click", "x": 1, "width": 3, "height": 4 });
        assert_eq!(Input::from_plan(&plan), Err("в плане ввода нет y".into()));
        let plan = json!({ "kind": "drag", "x": 1, "y": 2, "width": 3, "height": 4 });
        assert_eq!(Input::from_plan(&plan), Err("ввод «drag» не знаю".into()));
    }

    #[test]
    fn a_fitted_page_scales_the_point_into_the_view() {
        let at = Spot {
            x: 100.0,
            y: 50.0,
            width: 1280.0,
            height: 800.0,
        };
        assert_eq!(scale((640.0, 400.0), &at), (0.5, 0.5));
        // Размера не знаем — точка как есть.
        assert_eq!(scale((0.0, 0.0), &at), (1.0, 1.0));
    }
}
