// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Хук агента запускает это же приложение: на Windows `.sh` не программа, а
    // exe запускает любая оболочка. Ответ уходит в унаследованные каналы, окно
    // при этом не поднимается — агент ждёт ответа считаные секунды.
    if let Some(code) = modelcrew_desktop_lib::run_agent_hook() {
        std::process::exit(code);
    }
    modelcrew_desktop_lib::run()
}
