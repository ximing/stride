//! macOS window shadow for the undecorated transparent window.
//!
//! The border and the 12px radius are painted by the document (see
//! `index.html`) so they exist before the app bundle runs. AppKit samples a
//! transparent window's shadow from the webview alpha, then keeps that empty
//! sample until something invalidates it — which is why the shadow shows up
//! late. Rebuilding it after the plate has pixels closes the gap.

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{Runtime, WebviewWindow};

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

/// Where the first shadow kick may run. AppKit traps the whole process on
/// NSWindow calls from a background thread, and window delivery spawns a
/// thread per new window, so the inline kick is only for the main thread.
#[cfg(target_os = "macos")]
#[derive(Debug, PartialEq)]
enum KickPlan {
    Inline,
    HopToMainThread,
}

#[cfg(target_os = "macos")]
fn kick_plan() -> KickPlan {
    if macos::on_main_thread() {
        KickPlan::Inline
    } else {
        KickPlan::HopToMainThread
    }
}

/// Safe from any thread: the first kick follows `kick_plan`, and the retries
/// already hop through `run_on_main_thread`.
pub fn attach<R: Runtime>(window: &WebviewWindow<R>) {
    first_kick(window);
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

fn first_kick<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "macos")]
    match kick_plan() {
        KickPlan::Inline => kick(window),
        KickPlan::HopToMainThread => {
            let again = window.clone();
            let _ = window.run_on_main_thread(move || kick(&again));
        }
    }
    #[cfg(not(target_os = "macos"))]
    kick(window);
}

pub fn sync<R: Runtime>(window: &WebviewWindow<R>) {
    apply(window, false);
}

/// Refresh after a resize, then once more so the document can drop the radius
/// before AppKit samples the shadow. Live resizing only keeps the last pass.
pub fn sync_after_resize<R: Runtime>(window: &WebviewWindow<R>) {
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

pub fn kick<R: Runtime>(window: &WebviewWindow<R>) {
    apply(window, true);
}

fn apply<R: Runtime>(window: &WebviewWindow<R>, kick_shadow: bool) {
    #[cfg(target_os = "macos")]
    macos::apply(window, kick_shadow);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, kick_shadow);
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::rc::Retained;
    use objc2_app_kit::NSWindow;
    use tauri::{Runtime, WebviewWindow};

    /// True only on the process main thread (`pthread_main_np`).
    pub fn on_main_thread() -> bool {
        objc2::MainThreadMarker::new().is_some()
    }

    pub fn apply<R: Runtime>(window: &WebviewWindow<R>, kick_shadow: bool) {
        // Mock windows (unit tests) have no NSWindow; bail before the thread
        // check so tests can exercise the delivery path from any thread.
        let Ok(ptr) = window.ns_window() else {
            return;
        };
        debug_assert!(
            on_main_thread(),
            "frame: AppKit window calls must run on the main thread (window {})",
            window.label()
        );
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

    /// Window delivery runs on spawned threads; the main-thread guard must
    /// report them as background so `attach` hops instead of trapping.
    #[cfg(target_os = "macos")]
    #[test]
    fn spawned_threads_are_not_the_main_thread() {
        let on_main = std::thread::spawn(super::macos::on_main_thread)
            .join()
            .expect("probe thread panicked");
        assert!(!on_main);
    }

    /// The new-window crash regression: from a delivery thread the first
    /// shadow kick must hop to the main thread, never run inline.
    #[cfg(target_os = "macos")]
    #[test]
    fn background_threads_plan_a_main_thread_hop_for_the_first_kick() {
        let plan = std::thread::spawn(super::kick_plan)
            .join()
            .expect("probe thread panicked");
        assert_eq!(plan, super::KickPlan::HopToMainThread);
    }
}
