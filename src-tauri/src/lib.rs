#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // На macOS Tauri ставит дефолтное меню, чей пункт Close Window съедает
    // Cmd+W раньше веб-вью. Собираем своё меню без Close/New, оставляя
    // системные роли редактирования — без них в веб-вью не работают Cmd+C/V/A.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|handle| {
        use tauri::menu::{AboutMetadata, MenuBuilder, SubmenuBuilder};

        let app_menu = SubmenuBuilder::new(handle, "ModelCrew")
            .about(Some(AboutMetadata::default()))
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        let edit_menu = SubmenuBuilder::new(handle, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;
        let window_menu = SubmenuBuilder::new(handle, "Window")
            .minimize()
            .fullscreen()
            .build()?;

        MenuBuilder::new(handle)
            .items(&[&app_menu, &edit_menu, &window_menu])
            .build()
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
