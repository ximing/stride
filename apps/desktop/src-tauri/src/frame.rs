//! macOS window shadow for the undecorated transparent window.
//!
//! The border and the 12px radius are painted by the document (see
//! `index.html`) so they exist before the app bundle runs. AppKit samples a
//! transparent window's shadow from the webview alpha, then keeps that empty
//! sample until something invalidates it — which is why the shadow shows up
//! late. Rebuilding it after the plate has pixels closes the gap.

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
static RESIZE_TICK: AtomicU64 = AtomicU64::new(0);

/// Matches `--sd-radius-lg` and the boot frame in `index.html`.
pub const RADIUS_PX: f64 = 12.0;

/// Delays after attach, each waited in sequence, before rebuilding the shadow.
/// The first paints are often still transparent; a later pass sees the plate.
pub const SHADOW_RETRY_MS: [u64; 5] = [16, 50, 120, 300, 700];

pub fn corner_radius(filled: bool) -> f64 {
    if filled {
        0.0
    } else {
        RADIUS_PX
    }
}

pub fn attach(window: &WebviewWindow) {
    kick(window);
    #[cfg(target_os = "macos")]
    {
        let window = window.clone();
        std::thread::spawn(move || {
            for wait in SHADOW_RETRY_MS {
                std::thread::sleep(std::time::Duration::from_millis(wait));
                let again = window.clone();
                let _ = window.run_on_main_thread(move || kick(&again));
            }
        });
    }
}

pub fn sync(window: &WebviewWindow) {
    apply(window, false);
}

/// Refresh after a resize, then once more so the document can drop the radius
/// before AppKit samples the shadow. Live resizing only keeps the last pass.
pub fn sync_after_resize(window: &WebviewWindow) {
    sync(window);
    #[cfg(target_os = "macos")]
    {
        let tick = RESIZE_TICK.fetch_add(1, Ordering::Relaxed) + 1;
        let window = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(32));
            if RESIZE_TICK.load(Ordering::Relaxed) != tick {
                return;
            }
            let again = window.clone();
            let _ = window.run_on_main_thread(move || sync(&again));
        });
    }
}

pub fn kick(window: &WebviewWindow) {
    apply(window, true);
}

fn apply(window: &WebviewWindow, kick_shadow: bool) {
    #[cfg(target_os = "macos")]
    macos::apply(window, kick_shadow);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, kick_shadow);
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::rc::Retained;
    use objc2_app_kit::NSWindow;
    use tauri::WebviewWindow;

    pub fn apply(window: &WebviewWindow, kick_shadow: bool) {
        let Ok(ptr) = window.ns_window() else {
            return;
        };
        let Some(ns_window) = (unsafe { Retained::<NSWindow>::retain(ptr.cast()) }) else {
            return;
        };
        // Drop the cached shadow and rebuild it from the current alpha.
        // A plain invalidate leaves the empty-window sample in place.
        // Both calls return before the run loop paints, so the off state
        // does not flash.
        if kick_shadow {
            ns_window.setHasShadow(false);
        }
        ns_window.setHasShadow(true);
        ns_window.invalidateShadow();
    }
}

#[cfg(test)]
mod tests {
    use super::{corner_radius, RADIUS_PX, SHADOW_RETRY_MS};

    #[test]
    fn resting_window_uses_the_shell_radius() {
        assert_eq!(corner_radius(false), RADIUS_PX);
        assert_eq!(RADIUS_PX, 12.0);
    }

    #[test]
    fn filled_window_is_square() {
        assert_eq!(corner_radius(true), 0.0);
    }

    #[test]
    fn shadow_retries_cover_the_first_paint_without_lingering() {
        assert!(SHADOW_RETRY_MS[0] <= 32);
        let total: u64 = SHADOW_RETRY_MS.iter().sum();
        assert!(total < 2_000);
    }
}
