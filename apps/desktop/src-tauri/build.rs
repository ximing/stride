fn main() {
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "window_intent",
            "window_set_project",
            "menu_new_window",
            "menu_new_project",
            "menu_open_project",
            "sync_recent_projects",
            "list_font_families",
            "shell_exec_spawn",
            "shell_exec_cancel",
        ]));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
