#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_keyring::init())
        .setup(|app| {
            // Dev builds have no Info.plist, so register `stride://` with the
            // OS at runtime for `open 'stride://...'` testing. Bundled apps
            // get CFBundleURLTypes from tauri.conf.json instead.
            #[cfg(all(desktop, debug_assertions))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(error) = app.deep_link().register_all() {
                    eprintln!("deep-link dev registration failed: {error:?}");
                }
            }
            #[cfg(not(all(desktop, debug_assertions)))]
            {
                let _ = app;
            }
            Ok(())
        });
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .run(tauri::generate_context!())
        .expect("error while running Stride");
}
