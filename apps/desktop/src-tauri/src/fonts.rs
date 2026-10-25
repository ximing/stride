//! Installed font families for the note font picker.
//! macOS reads Core Text, Windows walks GDI, and other Unix hosts use fontconfig.

fn finish(names: Vec<String>) -> Vec<String> {
    let mut cleaned = Vec::with_capacity(names.len());
    for name in names {
        let trimmed = name.trim();
        if trimmed.is_empty() || trimmed.starts_with('.') || trimmed.starts_with('@') {
            continue;
        }
        cleaned.push(trimmed.to_string());
    }
    cleaned.sort_by(|left, right| left.to_lowercase().cmp(&right.to_lowercase()));
    cleaned.dedup_by(|left, right| left.to_lowercase() == right.to_lowercase());
    cleaned
}

#[cfg(target_os = "macos")]
fn raw_font_families() -> Vec<String> {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;

    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontManagerCopyAvailableFontFamilyNames() -> CFArrayRef;
    }

    unsafe {
        let raw = CTFontManagerCopyAvailableFontFamilyNames();
        if raw.is_null() {
            return Vec::new();
        }
        let array: CFArray<CFString> = CFArray::wrap_under_create_rule(raw);
        let mut names = Vec::with_capacity(array.len() as usize);
        for item in &array {
            names.push(item.to_string());
        }
        names
    }
}

#[cfg(target_os = "windows")]
fn raw_font_families() -> Vec<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    #[repr(C)]
    struct LogFontW {
        height: i32,
        width: i32,
        escapement: i32,
        orientation: i32,
        weight: i32,
        italic: u8,
        underline: u8,
        strike_out: u8,
        char_set: u8,
        out_precision: u8,
        clip_precision: u8,
        quality: u8,
        pitch_and_family: u8,
        face_name: [u16; 32],
    }

    type Hdc = isize;

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateCompatibleDC(hdc: Hdc) -> Hdc;
        fn DeleteDC(hdc: Hdc) -> i32;
        fn EnumFontFamiliesExW(
            hdc: Hdc,
            log_font: *const LogFontW,
            proc: extern "system" fn(*const LogFontW, *const core::ffi::c_void, u32, isize) -> i32,
            param: isize,
            flags: u32,
        ) -> i32;
    }

    extern "system" fn on_family(
        font: *const LogFontW,
        _metric: *const core::ffi::c_void,
        _font_type: u32,
        param: isize,
    ) -> i32 {
        if font.is_null() || param == 0 {
            return 1;
        }
        let face = unsafe { &(*font).face_name };
        let end = face.iter().position(|unit| *unit == 0).unwrap_or(face.len());
        if end == 0 {
            return 1;
        }
        let name = OsString::from_wide(&face[..end]).to_string_lossy().into_owned();
        let names = unsafe { &mut *(param as *mut Vec<String>) };
        names.push(name);
        1
    }

    unsafe {
        let dc = CreateCompatibleDC(0);
        if dc == 0 {
            return Vec::new();
        }
        let mut log_font: LogFontW = std::mem::zeroed();
        log_font.char_set = 1;
        let mut names = Vec::new();
        EnumFontFamiliesExW(
            dc,
            &log_font,
            on_family,
            &mut names as *mut Vec<String> as isize,
            0,
        );
        DeleteDC(dc);
        names
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn raw_font_families() -> Vec<String> {
    let output = match std::process::Command::new("fc-list")
        .args(["-f", "%{family}\\n"])
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut names = Vec::new();
    for line in text.lines() {
        for part in line.split(',') {
            let name = part.trim();
            if !name.is_empty() {
                names.push(name.to_string());
            }
        }
    }
    names
}

#[cfg(not(any(target_os = "macos", target_os = "windows", unix)))]
fn raw_font_families() -> Vec<String> {
    Vec::new()
}

fn font_families() -> Vec<String> {
    finish(raw_font_families())
}

#[tauri::command]
pub async fn list_font_families() -> Vec<String> {
    match tauri::async_runtime::spawn_blocking(font_families).await {
        Ok(names) => names,
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::finish;

    #[test]
    fn finish_drops_private_names_and_keeps_one_casing() {
        let names = finish(vec![
            ".LastResort".into(),
            " Songti SC ".into(),
            "georgia".into(),
            "Georgia".into(),
            "  ".into(),
            "@Vertical".into(),
        ]);
        assert_eq!(names, vec!["georgia".to_string(), "Songti SC".to_string()]);
    }

    #[test]
    fn lists_sorted_unique_families_when_the_host_has_fonts() {
        let names = super::font_families();
        #[cfg(target_os = "macos")]
        assert!(
            !names.is_empty(),
            "Core Text should see at least one installed family"
        );
        let lowered: Vec<_> = names.iter().map(|name| name.to_lowercase()).collect();
        let mut sorted = lowered.clone();
        sorted.sort();
        assert_eq!(lowered, sorted);
        for pair in lowered.windows(2) {
            assert_ne!(pair[0], pair[1]);
        }
        assert!(names.iter().all(|name| {
            let trimmed = name.trim();
            !trimmed.is_empty() && !trimmed.starts_with('.') && !trimmed.starts_with('@')
        }));
    }
}
