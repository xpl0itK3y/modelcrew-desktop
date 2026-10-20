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
pub const AVAILABLE: bool = cfg!(target_os = "macos");

/// Отдать ввод странице проекта.
pub fn send(app: &AppHandle, root: &str, input: Input) -> Result<(), String> {
    system::send(app, root, input)
}

/// Во сколько раз точка webview больше CSS-пикселя страницы — по каждой оси.
#[cfg_attr(windows, allow(dead_code))]
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

/// Остальные системы: настоящего ввода нет, действует скрипт страницы.
#[cfg(not(target_os = "macos"))]
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
