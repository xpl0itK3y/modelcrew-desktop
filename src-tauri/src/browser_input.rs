//! Настоящий ввод в страницу проекта: события мыши и клавиатуры системы.
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

/// Клавиша, как её назвал скрипт страницы: `key` и `code` — по DOM,
/// `key_code` — код клавиши Windows, он же `keyCode` в событии.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Key {
    pub key: String,
    pub code: String,
    pub key_code: u32,
    pub shift: bool,
    pub control: bool,
    pub alt: bool,
    pub meta: bool,
}

impl Key {
    /// Какой текст клавиша печатает. Ничего — если она служебная или зажат
    /// модификатор кроме Shift: тогда это сочетание, а не буква.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn typed(&self) -> Option<String> {
        if self.control || self.alt || self.meta {
            return None;
        }
        if self.key == "Enter" {
            return Some("\r".into());
        }
        let mut chars = self.key.chars();
        match (chars.next(), chars.next()) {
            (Some(_), None) => Some(self.key.clone()),
            _ => None,
        }
    }
}

/// Шаг ввода с клавиатуры — туда, где у страницы фокус.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stroke {
    /// Выделить всё в поле: то, что напечатают следом, встанет вместо.
    SelectAll,
    /// Напечатать текст так, как его вставляет метод ввода: без клавиш, но
    /// с настоящими `beforeinput` и `input`.
    Text(String),
    /// Нажать и отпустить клавишу.
    Key(Key),
}

impl Stroke {
    fn from_step(step: &Value) -> Result<Self, String> {
        if step.get("select").and_then(Value::as_str) == Some("all") {
            return Ok(Stroke::SelectAll);
        }
        if let Some(text) = step.get("text").and_then(Value::as_str) {
            return Ok(Stroke::Text(text.to_string()));
        }
        let Some(key) = step.get("key").and_then(Value::as_str) else {
            return Err("шаг ввода не разобрать".to_string());
        };
        let flag = |name: &str| step.get(name).and_then(Value::as_bool).unwrap_or(false);
        Ok(Stroke::Key(Key {
            key: key.to_string(),
            code: step
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            key_code: step
                .get("keyCode")
                .and_then(Value::as_u64)
                .and_then(|code| u32::try_from(code).ok())
                .unwrap_or(0),
            shift: flag("shift"),
            control: flag("control"),
            alt: flag("alt"),
            meta: flag("meta"),
        }))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    /// Подвести мышь.
    Move(Spot),
    /// Подвести и нажать. `count` — сколько нажатий подряд: два — двойное.
    Click { at: Spot, button: Button, count: u8 },
    /// Ввод с клавиатуры — по шагам, туда, где фокус.
    Keys(Vec<Stroke>),
}

impl Input {
    /// Что ввести — как это расписал скрипт страницы.
    pub fn from_plan(plan: &Value) -> Result<Self, String> {
        if plan.get("kind").and_then(Value::as_str) == Some("keys") {
            let steps = plan
                .get("steps")
                .and_then(Value::as_array)
                .ok_or_else(|| "в плане ввода нет шагов".to_string())?;
            return steps
                .iter()
                .map(Stroke::from_step)
                .collect::<Result<_, _>>()
                .map(Input::Keys);
        }
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
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSEvent, NSEventModifierFlags, NSEventType, NSStandardKeyBindingResponding,
    };
    use objc2_foundation::{NSPoint, NSProcessInfo, NSString};
    use objc2_web_kit::WKWebView;
    use tauri::AppHandle;

    use super::{Button, Input, Key, Spot, Stroke};

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
            Input::Keys(strokes) => return keys(webview, number, &strokes),
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

    /// Клавиатура — туда, где у страницы фокус: в какую рамку, WebKit решает
    /// сам.
    fn keys(webview: &WKWebView, window: isize, strokes: &[Stroke]) -> Result<(), String> {
        for stroke in strokes {
            match stroke {
                // Та же команда, что у пункта «Выделить всё» в меню «Правка».
                Stroke::SelectAll => unsafe { webview.selectAll(None) },
                // Так текст вставляет метод ввода, когда набор закончен.
                Stroke::Text(text) => {
                    let text = NSString::from_str(text);
                    let text: &AnyObject = &text;
                    unsafe { webview.insertText(text) };
                }
                Stroke::Key(key) => {
                    let time = NSProcessInfo::processInfo().systemUptime();
                    let (typed, plain) = characters(key);
                    let (typed, plain) = (NSString::from_str(&typed), NSString::from_str(&plain));
                    let event = |kind: NSEventType| -> Result<Retained<NSEvent>, String> {
                        NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                            kind,
                            NSPoint::ZERO,
                            flags(key),
                            time,
                            window,
                            None,
                            &typed,
                            &plain,
                            false,
                            virtual_code(&key.code),
                        )
                        .ok_or_else(|| "событие клавиши не собралось".to_string())
                    };
                    let (down, up) = (event(NSEventType::KeyDown)?, event(NSEventType::KeyUp)?);
                    webview.keyDown(&down);
                    webview.keyUp(&up);
                }
            }
        }
        Ok(())
    }

    fn flags(key: &Key) -> NSEventModifierFlags {
        let mut flags = NSEventModifierFlags::empty();
        for (held, flag) in [
            (key.shift, NSEventModifierFlags::Shift),
            (key.control, NSEventModifierFlags::Control),
            (key.alt, NSEventModifierFlags::Option),
            (key.meta, NSEventModifierFlags::Command),
        ] {
            if held {
                flags |= flag;
            }
        }
        flags
    }

    /// Что клавиша печатает — с модификаторами и без. Служебные клавиши AppKit
    /// пишет своими знаками из области для частного использования.
    fn characters(key: &Key) -> (String, String) {
        let special = |code: u32| char::from_u32(code).map(String::from).unwrap_or_default();
        let plain = match key.key.as_str() {
            "Enter" => "\r".to_string(),
            "Tab" => "\t".to_string(),
            "Backspace" => "\u{7f}".to_string(),
            "Escape" => "\u{1b}".to_string(),
            "ArrowUp" => special(0xF700),
            "ArrowDown" => special(0xF701),
            "ArrowLeft" => special(0xF702),
            "ArrowRight" => special(0xF703),
            "Insert" => special(0xF727),
            "Delete" => special(0xF728),
            "Home" => special(0xF729),
            "End" => special(0xF72B),
            "PageUp" => special(0xF72C),
            "PageDown" => special(0xF72D),
            name => match name.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
                Some(n @ 1..=12) => special(0xF704 + n - 1),
                _ if name.chars().count() == 1 => name.to_lowercase(),
                _ => String::new(),
            },
        };
        let typed = match plain.chars().next() {
            // Control с буквой печатает управляющий знак — как у настоящей
            // клавиатуры.
            Some(letter) if key.control && letter.is_ascii_alphabetic() && plain.len() == 1 => {
                char::from(letter.to_ascii_uppercase() as u8 & 0x1f).to_string()
            }
            Some('\t') if key.shift => "\u{19}".to_string(),
            _ if key.key.chars().count() == 1 => key.key.clone(),
            _ => plain.clone(),
        };
        (typed, plain)
    }

    /// Код клавиши на клавиатуре Mac по её `code` из DOM. По нему WebKit
    /// узнаёт, какая это клавиша, независимо от раскладки.
    fn virtual_code(code: &str) -> u16 {
        const LETTERS: [u16; 26] = [
            0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7,
            16, 6,
        ];
        const DIGITS: [u16; 10] = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25];
        const F_KEYS: [u16; 12] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];
        let indexed = |rest: Option<&str>, base: u8| {
            rest.and_then(|rest| rest.bytes().next().filter(|_| rest.len() == 1))
                .and_then(|byte| byte.checked_sub(base))
                .map(usize::from)
        };
        if let Some(code) = indexed(code.strip_prefix("Key"), b'A').and_then(|i| LETTERS.get(i)) {
            return *code;
        }
        if let Some(code) = indexed(code.strip_prefix("Digit"), b'0').and_then(|i| DIGITS.get(i)) {
            return *code;
        }
        if let Some(n) = code.strip_prefix('F').and_then(|n| n.parse::<usize>().ok()) {
            if let Some(code) = n.checked_sub(1).and_then(|i| F_KEYS.get(i)) {
                return *code;
            }
        }
        match code {
            "Enter" => 36,
            "Tab" => 48,
            "Space" => 49,
            "Backspace" => 51,
            "Escape" => 53,
            "MetaLeft" => 55,
            "ShiftLeft" => 56,
            "AltLeft" => 58,
            "ControlLeft" => 59,
            "Insert" => 114,
            "Home" => 115,
            "PageUp" => 116,
            "Delete" => 117,
            "End" => 119,
            "PageDown" => 121,
            "ArrowLeft" => 123,
            "ArrowRight" => 124,
            "ArrowDown" => 125,
            "ArrowUp" => 126,
            "Equal" => 24,
            "Minus" => 27,
            "BracketRight" => 30,
            "BracketLeft" => 33,
            "Quote" => 39,
            "Semicolon" => 41,
            "Backslash" => 42,
            "Comma" => 43,
            "Slash" => 44,
            "Period" => 47,
            "Backquote" => 50,
            // Буквы других раскладок: своей клавиши у них в US-коде нет, и
            // WebKit берёт знак из самого события.
            _ => 0,
        }
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

    #[cfg(test)]
    mod tests {
        use super::*;

        fn key(name: &str, code: &str) -> Key {
            Key {
                key: name.into(),
                code: code.into(),
                ..Key::default()
            }
        }

        fn both(typed: &str, plain: &str) -> (String, String) {
            (typed.into(), plain.into())
        }

        #[test]
        fn a_key_types_what_a_mac_keyboard_would() {
            // Без модификаторов буква — строчная, с Shift — какой её назвали.
            let upper = Key {
                shift: true,
                ..key("A", "KeyA")
            };
            assert_eq!(characters(&upper), both("A", "a"));
            assert_eq!(characters(&key("ж", "")), both("ж", "ж"));
            let control = Key {
                control: true,
                ..key("a", "KeyA")
            };
            assert_eq!(characters(&control), both("\u{1}", "a"));
            assert_eq!(characters(&key("Enter", "Enter")), both("\r", "\r"));
            assert_eq!(
                characters(&key("Backspace", "Backspace")),
                both("\u{7f}", "\u{7f}")
            );
            assert_eq!(
                characters(&key("ArrowLeft", "ArrowLeft")),
                both("\u{f702}", "\u{f702}")
            );
            assert_eq!(characters(&key("F5", "F5")), both("\u{f708}", "\u{f708}"));
            let back = Key {
                shift: true,
                ..key("Tab", "Tab")
            };
            assert_eq!(characters(&back), both("\u{19}", "\t"));
            // Клавиши, которой у Mac нет, нечем и напечатать.
            assert_eq!(characters(&key("F13", "F13")), both("", ""));
        }

        #[test]
        fn a_key_finds_its_place_on_a_mac_keyboard() {
            for (code, expected) in [
                ("KeyA", 0),
                ("KeyQ", 12),
                ("KeyZ", 6),
                ("Digit0", 29),
                ("Digit9", 25),
                ("F1", 122),
                ("F12", 111),
                ("Enter", 36),
                ("Backspace", 51),
                ("MetaLeft", 55),
                ("ArrowLeft", 123),
                ("ArrowUp", 126),
                ("Slash", 44),
            ] {
                assert_eq!(virtual_code(code), expected, "{code}");
            }
            for code in ["", "Keya", "KeyAB", "Digit10", "F0", "F13", "IntlRo"] {
                assert_eq!(virtual_code(code), 0, "{code}");
            }
        }

        #[test]
        fn held_modifiers_become_appkit_flags() {
            assert_eq!(flags(&Key::default()), NSEventModifierFlags::empty());
            let command = Key {
                meta: true,
                ..Key::default()
            };
            assert_eq!(flags(&command), NSEventModifierFlags::Command);
            let all = Key {
                shift: true,
                control: true,
                alt: true,
                meta: true,
                ..Key::default()
            };
            assert_eq!(
                flags(&all),
                NSEventModifierFlags::Shift
                    | NSEventModifierFlags::Control
                    | NSEventModifierFlags::Option
                    | NSEventModifierFlags::Command
            );
        }
    }
}

/// Linux: события GDK прямо в виджет WebKitGTK. Страница живёт в окне без
/// экрана, и мышь человека до неё не достаёт вовсе.
#[cfg(target_os = "linux")]
mod system {
    use gtk::gdk;
    use gtk::gdk::keys::{constants as keys, Key as Keyval};
    use gtk::glib;
    use gtk::glib::translate::{from_glib_full, IntoGlib, ToGlibPtr, ToGlibPtrMut};
    use gtk::prelude::*;
    use tauri::AppHandle;
    use webkit2gtk::WebViewExt;

    use super::{Button, Input, Key, Spot, Stroke};

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
            Input::Keys(strokes) => return type_in(webview, &window, &strokes),
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

    /// Клавиатура — туда, где у страницы фокус: в какую рамку, WebKit решает
    /// сам.
    fn type_in(
        webview: &webkit2gtk::WebView,
        window: &gdk::Window,
        strokes: &[Stroke],
    ) -> Result<(), String> {
        let display = window.display();
        let keyboard = display
            .default_seat()
            .and_then(|seat| seat.keyboard())
            .ok_or_else(|| "у системы нет клавиатуры".to_string())?;
        let keymap = gdk::Keymap::for_display(&display);
        for stroke in strokes {
            match stroke {
                // Те же команды, что у меню «Правка» и метода ввода.
                Stroke::SelectAll => webview.execute_editing_command("SelectAll"),
                Stroke::Text(text) => {
                    webview.execute_editing_command_with_argument("InsertText", text);
                }
                Stroke::Key(key) => {
                    let keyval = keyval(key);
                    // Код клавиши — из раскладки: по нему WebKit узнаёт
                    // `code`. Нет её в раскладке — знак берётся из keyval.
                    let entry = keymap
                        .as_ref()
                        .and_then(|keymap| keymap.entries_for_keyval(keyval).into_iter().next());
                    let time = (glib::monotonic_time() / 1000) as u32;
                    for kind in [gdk::EventType::KeyPress, gdk::EventType::KeyRelease] {
                        let mut event: gdk::Event =
                            unsafe { from_glib_full(gdk::ffi::gdk_event_new(kind.into_glib())) };
                        event.set_device(Some(&keyboard));
                        unsafe {
                            let raw: *mut gdk::ffi::GdkEvent = event.to_glib_none_mut().0;
                            let pressed = &mut (*raw).key;
                            pressed.window = window.to_glib_full();
                            pressed.time = time;
                            pressed.state = modifiers(key).into_glib();
                            pressed.keyval = keyval;
                            if let Some(entry) = &entry {
                                pressed.hardware_keycode = entry.keycode() as u16;
                                pressed.group = entry.group() as u8;
                            }
                        }
                        webview.event(&event);
                    }
                }
            }
        }
        Ok(())
    }

    fn modifiers(key: &Key) -> gdk::ModifierType {
        let mut state = gdk::ModifierType::empty();
        for (held, mask) in [
            (key.shift, gdk::ModifierType::SHIFT_MASK),
            (key.control, gdk::ModifierType::CONTROL_MASK),
            (key.alt, gdk::ModifierType::MOD1_MASK),
            (
                key.meta,
                gdk::ModifierType::SUPER_MASK | gdk::ModifierType::META_MASK,
            ),
        ] {
            if held {
                state |= mask;
            }
        }
        state
    }

    /// Клавиша в обозначениях X: служебные — по имени, знаки — по Юникоду.
    fn keyval(key: &Key) -> u32 {
        let named = match key.key.as_str() {
            "Enter" => keys::Return,
            "Tab" if key.shift => keys::ISO_Left_Tab,
            "Tab" => keys::Tab,
            "Escape" => keys::Escape,
            "Backspace" => keys::BackSpace,
            "Delete" => keys::Delete,
            "Insert" => keys::Insert,
            "Home" => keys::Home,
            "End" => keys::End,
            "PageUp" => keys::Page_Up,
            "PageDown" => keys::Page_Down,
            "ArrowLeft" => keys::Left,
            "ArrowUp" => keys::Up,
            "ArrowRight" => keys::Right,
            "ArrowDown" => keys::Down,
            "Shift" => keys::Shift_L,
            "Control" => keys::Control_L,
            "Alt" => keys::Alt_L,
            "Meta" => keys::Super_L,
            name => {
                let mut chars = name.chars();
                match (chars.next(), chars.next()) {
                    (Some(char), None) => Keyval::from_unicode(char),
                    _ => match name.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
                        Some(n @ 1..=12) => Keyval::from(*keys::F1 + n - 1),
                        _ => keys::VoidSymbol,
                    },
                }
            }
        };
        *named
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

    #[cfg(test)]
    mod tests {
        use super::*;

        fn key(name: &str) -> Key {
            Key {
                key: name.into(),
                ..Key::default()
            }
        }

        #[test]
        fn a_key_becomes_its_x_keyval() {
            for (name, expected) in [
                ("Enter", keys::Return),
                ("Tab", keys::Tab),
                ("Backspace", keys::BackSpace),
                ("ArrowLeft", keys::Left),
                ("PageDown", keys::Page_Down),
                ("Meta", keys::Super_L),
                ("F1", keys::F1),
                ("F12", keys::F12),
                ("a", keys::a),
                ("A", keys::A),
                ("ж", keys::Cyrillic_zhe),
                ("F13", keys::VoidSymbol),
                ("Nonsense", keys::VoidSymbol),
            ] {
                assert_eq!(keyval(&key(name)), *expected, "{name}");
            }
            // Shift+Tab у X — своя клавиша: по ней фокус и идёт назад.
            let back = Key {
                shift: true,
                ..key("Tab")
            };
            assert_eq!(keyval(&back), *keys::ISO_Left_Tab);
        }

        #[test]
        fn held_modifiers_become_gdk_state() {
            assert_eq!(modifiers(&key("a")), gdk::ModifierType::empty());
            let meta = Key {
                meta: true,
                ..key("a")
            };
            assert_eq!(
                modifiers(&meta),
                gdk::ModifierType::SUPER_MASK | gdk::ModifierType::META_MASK
            );
            let rest = Key {
                shift: true,
                control: true,
                alt: true,
                ..key("a")
            };
            assert_eq!(
                modifiers(&rest),
                gdk::ModifierType::SHIFT_MASK
                    | gdk::ModifierType::CONTROL_MASK
                    | gdk::ModifierType::MOD1_MASK
            );
        }
    }
}

/// Windows: события мыши и клавиатуры через DevTools самого WebView2 — те же,
/// что шлёт Playwright. Окно и курсор системы они не трогают.
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

    use super::{Button, Input, Key, Stroke};

    /// Страница отвечает на событие, когда его разошлёт. Дольше этого — уже
    /// не ответит.
    const WAIT: Duration = Duration::from_secs(5);

    const MOUSE: &str = "Input.dispatchMouseEvent";
    const KEY: &str = "Input.dispatchKeyEvent";
    const TEXT: &str = "Input.insertText";

    /// Вызов DevTools: метод и его параметры.
    type Call = (&'static str, Value);

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
    fn events(input: Input) -> VecDeque<Call> {
        let (at, press) = match input {
            Input::Move(at) => (at, None),
            Input::Click { at, button, count } => (at, Some((button, count))),
            Input::Keys(strokes) => return strokes.iter().flat_map(keys).collect(),
        };
        let mut events = VecDeque::from([(
            MOUSE,
            json!({ "type": "mouseMoved", "x": at.x, "y": at.y, "button": "none", "buttons": 0 }),
        )]);
        if let Some((button, count)) = press {
            let (name, held) = match button {
                Button::Left => ("left", 1),
                Button::Right => ("right", 2),
            };
            for clicks in 1..=count {
                events.push_back((
                    MOUSE,
                    json!({
                        "type": "mousePressed", "x": at.x, "y": at.y,
                        "button": name, "buttons": held, "clickCount": clicks,
                    }),
                ));
                events.push_back((
                    MOUSE,
                    json!({
                        "type": "mouseReleased", "x": at.x, "y": at.y,
                        "button": name, "buttons": 0, "clickCount": clicks,
                    }),
                ));
            }
        }
        events
    }

    /// Клавиатура уходит туда, где у страницы фокус, — в какую рамку,
    /// браузер решает сам.
    fn keys(stroke: &Stroke) -> Vec<Call> {
        match stroke {
            // Control+A выделяет всё в поле и на Windows, и в самом Chromium.
            Stroke::SelectAll => press(&Key {
                key: "a".into(),
                code: "KeyA".into(),
                key_code: 65,
                control: true,
                ..Key::default()
            }),
            Stroke::Text(text) => vec![(TEXT, json!({ "text": text }))],
            Stroke::Key(key) => press(key),
        }
    }

    fn press(key: &Key) -> Vec<Call> {
        let modifiers = [
            (key.alt, 1),
            (key.control, 2),
            (key.meta, 4),
            (key.shift, 8),
        ]
        .into_iter()
        .filter(|(held, _)| *held)
        .fold(0, |all, (_, bit)| all | bit);
        let mut down = json!({
            "type": "rawKeyDown",
            "key": key.key,
            "code": key.code,
            "windowsVirtualKeyCode": key.key_code,
            "nativeVirtualKeyCode": key.key_code,
            "modifiers": modifiers,
        });
        let mut up = down.clone();
        up["type"] = json!("keyUp");
        // Клавиша, которая печатает, — keyDown с текстом: из него браузер
        // делает keypress и ввод.
        if let Some(text) = key.typed() {
            down["type"] = json!("keyDown");
            down["text"] = json!(text);
            down["unmodifiedText"] = json!(text);
        }
        vec![(KEY, down), (KEY, up)]
    }

    /// События по одному: следующее — когда страница разослала прошлое.
    fn next(webview: ICoreWebView2, mut events: VecDeque<Call>, done: Done) {
        let Some((method, event)) = events.pop_front() else {
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
        let method = HSTRING::from(method);
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
                .map(|(_, event)| (event["type"].clone(), event["clickCount"].clone()))
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

        #[test]
        fn typing_selects_inserts_and_presses_enter_with_its_text() {
            let enter = Key {
                key: "Enter".into(),
                code: "Enter".into(),
                key_code: 13,
                ..Key::default()
            };
            let events = events(Input::Keys(vec![
                Stroke::SelectAll,
                Stroke::Text("слово".into()),
                Stroke::Key(enter),
            ]));
            let calls: Vec<_> = events
                .iter()
                .map(|(method, event)| (*method, event["type"].clone(), event["text"].clone()))
                .collect();
            assert_eq!(
                calls,
                [
                    (KEY, json!("rawKeyDown"), Value::Null),
                    (KEY, json!("keyUp"), Value::Null),
                    (TEXT, Value::Null, json!("слово")),
                    (KEY, json!("keyDown"), json!("\r")),
                    (KEY, json!("keyUp"), Value::Null),
                ]
            );
            assert_eq!(events[0].1["modifiers"], json!(2));
        }

        #[test]
        fn a_shortcut_carries_its_modifiers_and_types_nothing() {
            let all = Key {
                key: "a".into(),
                code: "KeyA".into(),
                key_code: 65,
                shift: true,
                control: true,
                alt: true,
                meta: true,
            };
            let calls = press(&all);
            assert_eq!(calls[0].1["type"], json!("rawKeyDown"));
            assert_eq!(calls[0].1["modifiers"], json!(15));
            assert_eq!(calls[0].1["windowsVirtualKeyCode"], json!(65));
            assert!(calls[0].1.get("text").is_none(), "{calls:?}");
            assert_eq!(calls[1].1["type"], json!("keyUp"));

            let letter = Key {
                key: "ж".into(),
                ..Key::default()
            };
            let calls = press(&letter);
            assert_eq!(
                (
                    &calls[0].1["type"],
                    &calls[0].1["text"],
                    &calls[0].1["unmodifiedText"]
                ),
                (&json!("keyDown"), &json!("ж"), &json!("ж"))
            );
            assert_eq!(calls[0].1["modifiers"], json!(0));
        }

        #[test]
        fn a_right_click_holds_the_right_button_and_a_move_presses_nothing() {
            let at = Spot {
                x: 5.0,
                y: 6.0,
                width: 100.0,
                height: 100.0,
            };
            let clicked = events(Input::Click {
                at,
                button: Button::Right,
                count: 1,
            });
            assert_eq!(clicked.len(), 3);
            assert_eq!(
                (&clicked[1].1["button"], &clicked[1].1["buttons"]),
                (&json!("right"), &json!(2))
            );
            assert_eq!(clicked[2].1["buttons"], json!(0));
            let moved = events(Input::Move(at));
            assert_eq!(moved.len(), 1);
            assert_eq!(
                (&moved[0].1["type"], &moved[0].1["x"], &moved[0].1["y"]),
                (&json!("mouseMoved"), &json!(5.0), &json!(6.0))
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
    fn reads_keystrokes_the_page_script_planned() {
        let plan = json!({
            "kind": "keys",
            "steps": [
                { "select": "all" },
                { "text": "привет" },
                { "key": "Tab", "code": "Tab", "keyCode": 9, "shift": true },
            ],
        });
        assert_eq!(
            Input::from_plan(&plan),
            Ok(Input::Keys(vec![
                Stroke::SelectAll,
                Stroke::Text("привет".into()),
                Stroke::Key(Key {
                    key: "Tab".into(),
                    code: "Tab".into(),
                    key_code: 9,
                    shift: true,
                    ..Key::default()
                }),
            ]))
        );
        let plan = json!({ "kind": "keys", "steps": [{ "nothing": 1 }] });
        assert_eq!(
            Input::from_plan(&plan),
            Err("шаг ввода не разобрать".into())
        );
    }

    #[test]
    fn a_key_types_its_letter_unless_it_is_a_shortcut() {
        let key = |name: &str| Key {
            key: name.into(),
            ..Key::default()
        };
        assert_eq!(key("ж").typed(), Some("ж".into()));
        assert_eq!(key("Enter").typed(), Some("\r".into()));
        assert_eq!(key("Tab").typed(), None);
        let shortcut = Key {
            control: true,
            ..key("a")
        };
        assert_eq!(shortcut.typed(), None);
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
