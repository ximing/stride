//! Native File menu, and on macOS the Dock menu.
//!
//! Menu widgets live in a thread local. muda's submenu is `Rc`-backed, so it
//! cannot sit in the managed `Host`. AppKit calls `applicationDockMenu:` on
//! the main thread; menu rebuilds hop there too.
//!
//! The predefined Close item is omitted on purpose. It would claim Cmd+W,
//! which this app does not use as Close Window.

use std::cell::RefCell;

use tauri::menu::{
    AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
    WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::recent::{self, MenuCopy, RecentProject};
use crate::windows::{self, WindowIntent};

#[cfg(target_os = "macos")]
use muda::ContextMenu;

const ACCEL_NEW_WINDOW: &str = "CmdOrCtrl+Shift+N";
const ACCEL_OPEN_PROJECT: &str = "CmdOrCtrl+O";
const ACCEL_CLOSE_WINDOW: &str = "CmdOrCtrl+Shift+W";

struct MenuUi {
    file: Submenu<Wry>,
    new_window: MenuItem<Wry>,
    new_project: MenuItem<Wry>,
    open_project: MenuItem<Wry>,
    open_recent: Submenu<Wry>,
    close_window: MenuItem<Wry>,
}

thread_local! {
  static MENU_UI: RefCell<Option<MenuUi>> = const { RefCell::new(None) };
}

#[cfg(target_os = "macos")]
thread_local! {
  static DOCK: RefCell<Option<muda::Submenu>> = const { RefCell::new(None) };
}

pub fn install(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let (projects, copy) = windows::menu_state(app);
    let ui = build_menu(app, &copy)?;
    app.set_menu(ui.menu)?;
    MENU_UI.with(|slot| {
        *slot.borrow_mut() = Some(ui.widgets);
    });
    refill_open_recent(app, &projects, &copy)?;
    #[cfg(target_os = "macos")]
    {
        install_dock(app, &projects, &copy);
        install_dock_method();
    }
    app.on_menu_event(|app, event| handle_menu_event(app, event));
    Ok(())
}

struct BuiltMenu {
    menu: Menu<Wry>,
    widgets: MenuUi,
}

fn build_menu(app: &AppHandle, copy: &MenuCopy) -> Result<BuiltMenu, Box<dyn std::error::Error>> {
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app
            .config()
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    #[cfg(target_os = "macos")]
    let app_menu = Submenu::with_items(
        app,
        info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about.clone()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let new_window = MenuItem::with_id(
        app,
        recent::ID_NEW_WINDOW,
        &copy.new_window,
        true,
        Some(ACCEL_NEW_WINDOW),
    )?;
    let new_project = MenuItem::with_id(
        app,
        recent::ID_NEW_PROJECT,
        &copy.new_project,
        true,
        None::<&str>,
    )?;
    let open_project = MenuItem::with_id(
        app,
        recent::ID_OPEN_PROJECT,
        &copy.open_project,
        true,
        Some(ACCEL_OPEN_PROJECT),
    )?;
    let open_recent = Submenu::with_id(app, "file.open-recent", &copy.open_recent, true)?;
    let close_window = MenuItem::with_id(
        app,
        recent::ID_CLOSE_WINDOW,
        &copy.close_window,
        true,
        Some(ACCEL_CLOSE_WINDOW),
    )?;
    let file = Submenu::with_id(app, "file", &copy.file, true)?;
    file.append(&new_window)?;
    file.append(&new_project)?;
    file.append(&open_project)?;
    file.append(&PredefinedMenuItem::separator(app)?)?;
    file.append(&open_recent)?;
    file.append(&PredefinedMenuItem::separator(app)?)?;
    file.append(&close_window)?;
    #[cfg(not(target_os = "macos"))]
    file.append(&PredefinedMenuItem::quit(app, None)?)?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    let help = Submenu::with_id(app, HELP_SUBMENU_ID, "Help", true)?;
    #[cfg(not(target_os = "macos"))]
    help.append(&PredefinedMenuItem::about(app, None, Some(about))?)?;

    let menu = Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &app_menu,
            &file,
            &edit,
            #[cfg(target_os = "macos")]
            &view,
            &window_menu,
            &help,
        ],
    )?;

    Ok(BuiltMenu {
        menu,
        widgets: MenuUi {
            file,
            new_window,
            new_project,
            open_project,
            open_recent,
            close_window,
        },
    })
}

fn refill_open_recent(
    app: &AppHandle,
    projects: &[RecentProject],
    copy: &MenuCopy,
) -> Result<(), String> {
    let refill = MENU_UI.with(|slot| {
        let borrowed = slot.borrow();
        let Some(ui) = borrowed.as_ref() else {
            return None;
        };
        Some((
            ui.file.clone(),
            ui.new_window.clone(),
            ui.new_project.clone(),
            ui.open_project.clone(),
            ui.open_recent.clone(),
            ui.close_window.clone(),
        ))
    });
    let Some((file, new_window, new_project, open_project, open_recent, close_window)) = refill
    else {
        return Ok(());
    };
    file.set_text(&copy.file)
        .map_err(|error| error.to_string())?;
    new_window
        .set_text(&copy.new_window)
        .map_err(|error| error.to_string())?;
    new_project
        .set_text(&copy.new_project)
        .map_err(|error| error.to_string())?;
    open_project
        .set_text(&copy.open_project)
        .map_err(|error| error.to_string())?;
    open_recent
        .set_text(&copy.open_recent)
        .map_err(|error| error.to_string())?;
    close_window
        .set_text(&copy.close_window)
        .map_err(|error| error.to_string())?;
    while open_recent.remove_at(0).ok().flatten().is_some() {}
    let labels = recent::recent_menu_labels(projects);
    if projects.is_empty() {
        let empty = MenuItem::with_id(
            app,
            recent::ID_RECENT_EMPTY,
            &copy.empty_recent,
            false,
            None::<&str>,
        )
        .map_err(|error| error.to_string())?;
        open_recent
            .append(&empty)
            .map_err(|error| error.to_string())?;
    } else {
        for (project, label) in projects.iter().zip(labels) {
            let item = MenuItem::with_id(
                app,
                recent::recent_menu_id(&project.path),
                label,
                true,
                None::<&str>,
            )
            .map_err(|error| error.to_string())?;
            open_recent
                .append(&item)
                .map_err(|error| error.to_string())?;
        }
    }
    open_recent
        .append(&PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let clear = MenuItem::with_id(
        app,
        recent::ID_CLEAR_RECENT,
        &copy.clear_recent,
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    open_recent
        .append(&clear)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn refresh_on_main(
    app: &AppHandle,
    projects: Vec<RecentProject>,
    copy: MenuCopy,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let result = refill_open_recent(&app_handle, &projects, &copy).and_then(|_| {
            #[cfg(target_os = "macos")]
            refill_dock(&projects, &copy);
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (&projects, &copy);
            }
            Ok(())
        });
        let _ = tx.send(result);
    })
    .map_err(|error| error.to_string())?;
    rx.recv().map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn sync_recent_projects(
    app: AppHandle,
    projects: Vec<RecentProject>,
    copy: MenuCopy,
) -> Result<(), String> {
    let prepared = recent::prepare_recent(projects);
    let signature = recent::menu_signature(&prepared, &copy);
    if !windows::update_recent(&app, prepared.clone(), copy.clone(), signature) {
        return Ok(());
    }
    windows::save_recent_file(&app, &prepared)?;
    refresh_on_main(&app, prepared, copy)
}

pub fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id.as_ref();
    if id == recent::ID_NEW_WINDOW {
        windows::spawn_deliver(app.clone(), WindowIntent::Fresh);
    } else if id == recent::ID_NEW_PROJECT {
        windows::spawn_deliver(app.clone(), WindowIntent::PickCreate);
    } else if id == recent::ID_OPEN_PROJECT {
        windows::spawn_deliver(app.clone(), WindowIntent::PickOpen);
    } else if id == recent::ID_CLOSE_WINDOW {
        close_focused(app);
    } else if id == recent::ID_CLEAR_RECENT {
        if let Err(error) = clear_recent(app) {
            eprintln!("stride recent: {error}");
        }
    } else if let Some(path) = recent::path_from_menu_id(id) {
        windows::spawn_deliver(
            app.clone(),
            WindowIntent::Open {
                path: path.to_string(),
            },
        );
    }
}

fn close_focused(app: &AppHandle) {
    let windows = app.webview_windows();
    let window = windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| windows.values().next());
    if let Some(window) = window {
        let _ = window.close();
    }
}

fn clear_recent(app: &AppHandle) -> Result<(), String> {
    let (projects, copy) = windows::take_cleared_recent(app);
    windows::save_recent_file(app, &projects)?;
    refresh_on_main(app, projects.clone(), copy)?;
    app.emit("stride://recent-replaced", projects)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn install_dock(app: &AppHandle, projects: &[RecentProject], copy: &MenuCopy) {
    let _ = app;
    let menu = muda::Submenu::with_id("dock", "Dock", true);
    refill_dock_menu(&menu, projects, copy);
    DOCK.with(|slot| {
        *slot.borrow_mut() = Some(menu);
    });
}

#[cfg(target_os = "macos")]
fn refill_dock(projects: &[RecentProject], copy: &MenuCopy) {
    DOCK.with(|slot| {
        let borrowed = slot.borrow();
        let Some(menu) = borrowed.as_ref() else {
            return;
        };
        refill_dock_menu(menu, projects, copy);
    });
}

#[cfg(target_os = "macos")]
fn refill_dock_menu(menu: &muda::Submenu, projects: &[RecentProject], copy: &MenuCopy) {
    while menu.remove_at(0).is_some() {}
    let new_window = muda::MenuItem::with_id(recent::ID_NEW_WINDOW, &copy.new_window, true, None);
    if menu.append(&new_window).is_err() {
        return;
    }
    let separator = muda::PredefinedMenuItem::separator();
    if menu.append(&separator).is_err() {
        return;
    }
    if projects.is_empty() {
        let empty =
            muda::MenuItem::with_id(recent::ID_RECENT_EMPTY, &copy.empty_recent, false, None);
        let _ = menu.append(&empty);
        return;
    }
    let labels = recent::recent_menu_labels(projects);
    for (project, label) in projects.iter().zip(labels) {
        let item =
            muda::MenuItem::with_id(recent::recent_menu_id(&project.path), label, true, None);
        if menu.append(&item).is_err() {
            return;
        }
    }
}

#[cfg(target_os = "macos")]
fn install_dock_method() {
    use std::sync::atomic::{AtomicBool, Ordering};

    static INSTALLED: AtomicBool = AtomicBool::new(false);
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(class) = objc2::runtime::AnyClass::get(c"TaoAppDelegateParent") else {
        eprintln!("stride dock menu: TaoAppDelegateParent is not registered");
        INSTALLED.store(false, Ordering::SeqCst);
        return;
    };
    let imp: objc2::runtime::Imp = unsafe {
        std::mem::transmute::<
            unsafe extern "C-unwind" fn(
                *mut objc2::runtime::AnyObject,
                objc2::runtime::Sel,
                *mut objc2::runtime::AnyObject,
            ) -> *mut objc2::runtime::AnyObject,
            objc2::runtime::Imp,
        >(application_dock_menu)
    };
    let added = unsafe {
        objc2::ffi::class_addMethod(
            std::ptr::from_ref(class).cast_mut(),
            objc2::runtime::Sel::register(c"applicationDockMenu:"),
            imp,
            c"@@:@".as_ptr().cast(),
        )
    };
    if !added.as_bool() {
        eprintln!("stride dock menu: applicationDockMenu: was already present");
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C-unwind" fn application_dock_menu(
    _this: *mut objc2::runtime::AnyObject,
    _cmd: objc2::runtime::Sel,
    _app: *mut objc2::runtime::AnyObject,
) -> *mut objc2::runtime::AnyObject {
    let ptr = dock_pointer();
    if ptr.is_null() {
        return std::ptr::null_mut();
    }
    match unsafe { objc2::rc::Retained::<objc2::runtime::AnyObject>::retain(ptr) } {
        Some(menu) => objc2::rc::Retained::autorelease_return(menu),
        None => std::ptr::null_mut(),
    }
}

#[cfg(target_os = "macos")]
fn dock_pointer() -> *mut objc2::runtime::AnyObject {
    DOCK.with(|slot| {
        let borrowed = slot.borrow();
        let Some(menu) = borrowed.as_ref() else {
            return std::ptr::null_mut();
        };
        // The submenu's NSMenu is the item list AppKit shows for the Dock.
        // Extra-retain it in the callback so AppKit's return does not free muda's menu.
        menu.ns_menu().cast()
    })
}
