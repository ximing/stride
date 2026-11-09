#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(desktop)]
mod fonts;
#[cfg(desktop)]
mod frame;
#[cfg(desktop)]
mod menu;
mod recent;
#[cfg(desktop)]
mod shell_exec;
#[cfg(desktop)]
mod windows;

#[cfg(desktop)]
use tauri::Manager;

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_keyring::init())
        // Remember each window's size across launches; position stays managed
        // by `windows::create_window` (cascade from the focused window).
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .enable_macos_default_menu(false)
        .on_page_load(|webview, payload| {
            // Document reload. Not macOS-only: every desktop target cancels
            // sessions for this label. Vite client routing does not emit this.
            #[cfg(desktop)]
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                shell_exec::cancel_label(webview, webview.label());
            }
            #[cfg(target_os = "macos")]
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let host = webview.window();
                if let Some(window) = webview.get_webview_window(host.label()) {
                    frame::kick(&window);
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (webview, payload);
        })
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
            #[cfg(desktop)]
            {
                app.manage(shell_exec::ShellHost::new());
                windows::install(app.handle())?;
                menu::install(app.handle())?;
                if let Some(window) = app.get_webview_window("main") {
                    frame::attach(&window);
                }
            }
            #[cfg(not(desktop))]
            {
                let _ = app;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if matches!(event, tauri::WindowEvent::Destroyed) {
                windows::forget_window(window.app_handle(), window.label());
                shell_exec::cancel_label(window.app_handle(), window.label());
            }
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                if let Some(webview) = window.get_webview_window(window.label()) {
                    frame::sync_after_resize(&webview);
                }
            }
            #[cfg(not(any(desktop, target_os = "macos")))]
            {
                let _ = (window, event);
            }
        });
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            windows::window_intent,
            windows::window_set_project,
            windows::menu_new_window,
            windows::menu_new_project,
            windows::menu_open_project,
            menu::sync_recent_projects,
            fonts::list_font_families,
            shell_exec::shell_exec_spawn,
            shell_exec::shell_exec_cancel,
        ]);
    builder
        .build(tauri::generate_context!())
        .expect("error while building Stride")
        .run(|app, event| {
            #[cfg(desktop)]
            if matches!(event, tauri::RunEvent::Exit) {
                shell_exec::cancel_all(app);
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                windows::reopen_or_fresh(app.clone(), has_visible_windows);
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app, event);
            }
        });
}
