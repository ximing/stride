//! Multi-window host. Menu widgets stay out of this type: muda menus are not
//! `Send`, and `AppHandle::manage` requires `Send + Sync`.
//!
//! A window is "reported" only after the frontend finishes its startup intent.
//! Menu clicks before that spawn another window instead of stealing a window
//! that is still restoring a vault.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, State, WebviewWindow, WebviewWindowBuilder,
};

use crate::recent::{self, MenuCopy, RecentProject};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WindowIntent {
    Restore,
    Fresh,
    Open { path: String },
    PickOpen,
    PickCreate,
}

#[derive(Debug, PartialEq)]
pub enum Delivery {
    Focus(String),
    Emit(String),
    Create,
}

struct HostInner {
    next_id: u32,
    intents: HashMap<String, WindowIntent>,
    reported: HashSet<String>,
    open_paths: HashMap<String, String>,
    recent: Vec<RecentProject>,
    copy: MenuCopy,
    signature: String,
}

pub struct Host {
    inner: Mutex<HostInner>,
}

pub fn install(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let recent = prepare_loaded(load_recent(app));
    let copy = MenuCopy::default();
    let signature = recent::menu_signature(&recent, &copy);
    app.manage(Host {
        inner: Mutex::new(HostInner {
            next_id: 2,
            intents: HashMap::new(),
            reported: HashSet::new(),
            open_paths: HashMap::new(),
            recent,
            copy,
            signature,
        }),
    });
    Ok(())
}

pub fn forget_window(app: &AppHandle, label: &str) {
    let Some(host) = app.try_state::<Host>() else {
        return;
    };
    let mut guard = host.inner.lock().unwrap_or_else(|error| error.into_inner());
    guard.reported.remove(label);
    guard.open_paths.remove(label);
    guard.intents.remove(label);
}

pub fn menu_state(app: &AppHandle) -> (Vec<RecentProject>, MenuCopy) {
    with_host(app, |host| (host.recent.clone(), host.copy.clone()))
}

pub fn update_recent(
    app: &AppHandle,
    projects: Vec<RecentProject>,
    copy: MenuCopy,
    signature: String,
) -> bool {
    with_host(app, |host| {
        if host.signature == signature {
            return false;
        }
        host.recent = projects;
        host.copy = copy;
        host.signature = signature;
        true
    })
}

pub fn take_cleared_recent(app: &AppHandle) -> (Vec<RecentProject>, MenuCopy) {
    with_host(app, |host| {
        let open: HashSet<String> = host.open_paths.values().cloned().collect();
        host.recent
            .retain(|project| open.contains(&recent::normalize_path(&project.path)));
        host.signature = recent::menu_signature(&host.recent, &host.copy);
        (host.recent.clone(), host.copy.clone())
    })
}

pub fn save_recent_file(app: &AppHandle, projects: &[RecentProject]) -> Result<(), String> {
    let path = recent_file(app)?;
    std::fs::write(&path, recent::recent_json(projects)).map_err(|error| error.to_string())
}

pub fn spawn_deliver(app: AppHandle, intent: WindowIntent) {
    std::thread::spawn(move || {
        if let Err(error) = deliver(&app, intent) {
            eprintln!("stride window: {error}");
        }
    });
}

pub fn reopen_or_fresh(app: AppHandle, has_visible_windows: bool) {
    if has_visible_windows {
        return;
    }
    std::thread::spawn(move || {
        let windows = app.webview_windows();
        if let Some(window) = windows.values().next() {
            focus_window(window);
            return;
        }
        if let Err(error) = deliver(&app, WindowIntent::Fresh) {
            eprintln!("stride window: {error}");
        }
    });
}

pub fn deliver(app: &AppHandle, intent: WindowIntent) -> Result<(), String> {
    if matches!(intent, WindowIntent::Restore) {
        return Ok(());
    }
    let focused = focused_label(app);
    let decision = with_host(app, |host| {
        plan_delivery(
            &intent,
            &host.open_paths,
            &host.reported,
            focused.as_deref(),
        )
    });
    match decision {
        Delivery::Focus(label) => {
            if let Some(window) = app.get_webview_window(&label) {
                focus_window(&window);
            }
            Ok(())
        }
        Delivery::Emit(label) => app
            .emit_to(&label, "stride://window-intent", intent)
            .map_err(|error| error.to_string()),
        Delivery::Create => create_window(app, intent),
    }
}

pub fn plan_delivery(
    intent: &WindowIntent,
    open_paths: &HashMap<String, String>,
    reported: &HashSet<String>,
    focused: Option<&str>,
) -> Delivery {
    match intent {
        WindowIntent::Fresh | WindowIntent::Restore => Delivery::Create,
        WindowIntent::Open { path } => {
            let path = recent::normalize_path(path);
            if let Some(label) = label_for_path(&path, open_paths, focused) {
                return Delivery::Focus(label);
            }
            empty_reported(open_paths, reported, focused)
                .map(Delivery::Emit)
                .unwrap_or(Delivery::Create)
        }
        WindowIntent::PickOpen | WindowIntent::PickCreate => {
            empty_reported(open_paths, reported, focused)
                .map(Delivery::Emit)
                .unwrap_or(Delivery::Create)
        }
    }
}

#[tauri::command]
pub fn window_intent(app: AppHandle, window: WebviewWindow) -> WindowIntent {
    let label = window.label().to_string();
    with_host(&app, |host| {
        host.intents.remove(&label).unwrap_or(WindowIntent::Restore)
    })
}

#[tauri::command]
pub fn window_set_project(app: AppHandle, window: WebviewWindow, path: Option<String>) {
    let label = window.label().to_string();
    with_host(&app, |host| {
        host.reported.insert(label.clone());
        match path {
            Some(path) if !path.is_empty() => {
                host.open_paths.insert(label, recent::normalize_path(&path));
            }
            _ => {
                host.open_paths.remove(&label);
            }
        }
    });
}

#[tauri::command]
pub fn menu_new_window(app: AppHandle) {
    spawn_deliver(app, WindowIntent::Fresh);
}

#[tauri::command]
pub fn menu_new_project(app: AppHandle) {
    spawn_deliver(app, WindowIntent::PickCreate);
}

#[tauri::command]
pub fn menu_open_project(app: AppHandle) {
    spawn_deliver(app, WindowIntent::PickOpen);
}

fn with_host<T>(app: &AppHandle, f: impl FnOnce(&mut HostInner) -> T) -> T {
    let host: State<'_, Host> = app.state::<Host>();
    let mut guard = host
        .inner
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    f(&mut guard)
}

fn label_for_path(
    path: &str,
    open_paths: &HashMap<String, String>,
    focused: Option<&str>,
) -> Option<String> {
    if let Some(label) = focused {
        if open_paths.get(label).is_some_and(|open| open == path) {
            return Some(label.to_string());
        }
    }
    open_paths
        .iter()
        .find(|(_, open)| *open == path)
        .map(|(label, _)| label.clone())
}

fn empty_reported(
    open_paths: &HashMap<String, String>,
    reported: &HashSet<String>,
    focused: Option<&str>,
) -> Option<String> {
    if let Some(label) = focused {
        if reported.contains(label) && !open_paths.contains_key(label) {
            return Some(label.to_string());
        }
    }
    reported
        .iter()
        .find(|label| !open_paths.contains_key(*label))
        .cloned()
}

fn focused_label(app: &AppHandle) -> Option<String> {
    app.webview_windows()
        .into_iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
}

fn focus_window(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn focused_origin(app: &AppHandle) -> Option<(f64, f64)> {
    let (_, window) = app
        .webview_windows()
        .into_iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))?;
    let position = window.outer_position().ok()?;
    let scale = window.scale_factor().ok()?;
    let logical = position.to_logical::<f64>(scale);
    Some((logical.x + 28.0, logical.y + 28.0))
}

fn create_window(app: &AppHandle, intent: WindowIntent) -> Result<(), String> {
    let position = focused_origin(app);
    let label = with_host(app, |host| {
        let label = format!("win{}", host.next_id);
        host.next_id += 1;
        host.intents.insert(label.clone(), intent.clone());
        label
    });
    let Some(mut config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
    else {
        with_host(app, |host| {
            host.intents.remove(&label);
        });
        return Err("missing main window config".to_string());
    };
    config.label = label.clone();
    config.title = "Stride".to_string();
    if let Some((x, y)) = position {
        config.x = Some(x);
        config.y = Some(y);
    }
    match WebviewWindowBuilder::from_config(app, &config).and_then(|builder| builder.build()) {
        Ok(window) => {
            if let Some((x, y)) = position {
                let _ = window.set_position(LogicalPosition::new(x, y));
            }
            Ok(())
        }
        Err(error) => {
            with_host(app, |host| {
                host.intents.remove(&label);
            });
            Err(error.to_string())
        }
    }
}

fn recent_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("recent-projects.json"))
}

fn load_recent(app: &AppHandle) -> Vec<RecentProject> {
    let Ok(path) = recent_file(app) else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    recent::parse_recent(&raw)
}

fn prepare_loaded(projects: Vec<RecentProject>) -> Vec<RecentProject> {
    recent::prepare_recent(projects)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(label, path)| ((*label).to_string(), (*path).to_string()))
            .collect()
    }

    fn reported(labels: &[&str]) -> HashSet<String> {
        labels.iter().map(|label| (*label).to_string()).collect()
    }

    #[test]
    fn focuses_a_window_that_already_has_the_vault() {
        let open = paths(&[("main", "/vaults/notes"), ("win2", "/vaults/other")]);
        let known = reported(&["main", "win2"]);
        assert_eq!(
            plan_delivery(
                &WindowIntent::Open {
                    path: "/vaults/notes/".to_string()
                },
                &open,
                &known,
                Some("win2")
            ),
            Delivery::Focus("main".to_string())
        );
        assert_eq!(
            plan_delivery(
                &WindowIntent::Open {
                    path: "/vaults/other".to_string()
                },
                &open,
                &known,
                Some("main")
            ),
            Delivery::Focus("win2".to_string())
        );
    }

    #[test]
    fn reuses_a_reported_empty_window_and_prefers_the_focused_one() {
        let open = paths(&[("main", "/vaults/notes")]);
        let known = reported(&["main", "win2", "win3"]);
        assert_eq!(
            plan_delivery(
                &WindowIntent::Open {
                    path: "/vaults/fresh".to_string()
                },
                &open,
                &known,
                Some("win3")
            ),
            Delivery::Emit("win3".to_string())
        );
        let one_empty = reported(&["main", "win2"]);
        assert_eq!(
            plan_delivery(&WindowIntent::PickCreate, &open, &one_empty, Some("main")),
            Delivery::Emit("win2".to_string())
        );
    }

    #[test]
    fn fresh_always_creates_and_a_busy_window_is_not_reused() {
        let open = paths(&[("main", "/vaults/notes")]);
        let known = reported(&["main"]);
        assert_eq!(
            plan_delivery(&WindowIntent::Fresh, &open, &known, Some("main")),
            Delivery::Create
        );
        assert_eq!(
            plan_delivery(&WindowIntent::PickOpen, &open, &known, Some("main")),
            Delivery::Create
        );
        assert_eq!(
            plan_delivery(
                &WindowIntent::Open {
                    path: "/vaults/other".to_string()
                },
                &open,
                &HashSet::new(),
                Some("chooser")
            ),
            Delivery::Create
        );
    }
}
