//! Recent-project list shared by the File menu and the Dock menu.
//!
//! Paths are normalized before they become menu ids so a trailing slash and a
//! Windows separator still name the same vault.

use serde::{Deserialize, Serialize};

pub const RECENT_LIMIT: usize = 10;
pub const ID_NEW_WINDOW: &str = "file.new-window";
pub const ID_NEW_PROJECT: &str = "file.new-project";
pub const ID_OPEN_PROJECT: &str = "file.open-project";
pub const ID_CLOSE_WINDOW: &str = "file.close-window";
pub const ID_CLEAR_RECENT: &str = "file.clear-recent";
pub const ID_RECENT_EMPTY: &str = "file.recent-empty";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub id: String,
    pub path: String,
    pub title: String,
    pub last_opened: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuCopy {
    pub file: String,
    pub new_window: String,
    pub new_project: String,
    pub open_project: String,
    pub open_recent: String,
    pub clear_recent: String,
    pub close_window: String,
    pub empty_recent: String,
}

impl Default for MenuCopy {
    fn default() -> Self {
        Self {
            file: "File".to_string(),
            new_window: "New Window".to_string(),
            new_project: "New Project…".to_string(),
            open_project: "Open Project…".to_string(),
            open_recent: "Open Recent".to_string(),
            clear_recent: "Clear Recently Opened".to_string(),
            close_window: "Close Window".to_string(),
            empty_recent: "No Recent Projects".to_string(),
        }
    }
}

pub fn normalize_path(path: &str) -> String {
    let mut value = path.replace('\\', "/");
    let drive = value.len() >= 2
        && value.as_bytes()[0].is_ascii_alphabetic()
        && value.as_bytes()[1] == b':';
    while value.len() > 1 && value.ends_with('/') {
        if drive && value.len() == 3 {
            break;
        }
        value.pop();
    }
    value
}

pub fn folder_title(path: &str) -> String {
    let normalized = normalize_path(path);
    match normalized.rsplit('/').next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => path.to_string(),
    }
}

pub fn parent_label(path: &str) -> Option<String> {
    let normalized = normalize_path(path);
    let (parent, _) = normalized.rsplit_once('/')?;
    if parent.is_empty() {
        return None;
    }
    Some(folder_title(parent))
}

pub fn recent_menu_id(path: &str) -> String {
    format!("recent:{}", normalize_path(path))
}

pub fn path_from_menu_id(id: &str) -> Option<&str> {
    let path = id.strip_prefix("recent:")?;
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Dedupe by normalized path, keep the newest stamp, then cap the list.
pub fn prepare_recent(projects: Vec<RecentProject>) -> Vec<RecentProject> {
    let mut best: Vec<RecentProject> = Vec::new();
    for mut project in projects {
        project.path = normalize_path(&project.path);
        if project.path.is_empty() {
            continue;
        }
        if project.title.is_empty() {
            project.title = folder_title(&project.path);
        }
        if let Some(existing) = best.iter_mut().find(|item| item.path == project.path) {
            if project.last_opened >= existing.last_opened {
                *existing = project;
            }
            continue;
        }
        best.push(project);
    }
    best.sort_by(|left, right| {
        right
            .last_opened
            .cmp(&left.last_opened)
            .then_with(|| left.path.cmp(&right.path))
    });
    best.truncate(RECENT_LIMIT);
    best
}

pub fn recent_menu_labels(projects: &[RecentProject]) -> Vec<String> {
    let titles: Vec<String> = projects
        .iter()
        .map(|project| {
            if project.title.is_empty() {
                folder_title(&project.path)
            } else {
                project.title.clone()
            }
        })
        .collect();
    let mut counts = std::collections::HashMap::<String, usize>::new();
    for title in &titles {
        *counts.entry(title.clone()).or_insert(0) += 1;
    }
    titles
        .into_iter()
        .enumerate()
        .map(|(index, title)| {
            if counts.get(&title).copied().unwrap_or(0) <= 1 {
                return title;
            }
            match parent_label(&projects[index].path) {
                Some(parent) => format!("{title} — {parent}"),
                None => title,
            }
        })
        .collect()
}

pub fn menu_signature(projects: &[RecentProject], copy: &MenuCopy) -> String {
    let mut parts = Vec::with_capacity(8 + projects.len() * 2);
    parts.push(copy.file.clone());
    parts.push(copy.new_window.clone());
    parts.push(copy.new_project.clone());
    parts.push(copy.open_project.clone());
    parts.push(copy.open_recent.clone());
    parts.push(copy.clear_recent.clone());
    parts.push(copy.close_window.clone());
    parts.push(copy.empty_recent.clone());
    for project in projects {
        parts.push(project.path.clone());
        parts.push(project.title.clone());
    }
    parts.join("\u{1}")
}

pub fn parse_recent(raw: &str) -> Vec<RecentProject> {
    serde_json::from_str(raw).unwrap_or_default()
}

pub fn recent_json(projects: &[RecentProject]) -> String {
    serde_json::to_string(projects).unwrap_or_else(|_| "[]".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(path: &str, title: &str, opened: &str) -> RecentProject {
        RecentProject {
            id: path.to_string(),
            path: path.to_string(),
            title: title.to_string(),
            last_opened: opened.to_string(),
        }
    }

    #[test]
    fn normalizes_separators_and_keeps_a_drive_root() {
        assert_eq!(normalize_path("/Users/a/notes/"), "/Users/a/notes");
        assert_eq!(normalize_path("C:\\Users\\notes\\"), "C:/Users/notes");
        assert_eq!(normalize_path("C:/"), "C:/");
        assert_eq!(folder_title("/Users/a/notes"), "notes");
        assert_eq!(folder_title("C:/Users/notes"), "notes");
        assert_eq!(parent_label("/Users/a/notes").as_deref(), Some("a"));
        assert_eq!(parent_label("/notes"), None);
    }

    #[test]
    fn menu_ids_round_trip_the_normalized_path() {
        assert_eq!(recent_menu_id("/Users/a/notes/"), "recent:/Users/a/notes");
        assert_eq!(
            path_from_menu_id("recent:/Users/a/notes"),
            Some("/Users/a/notes")
        );
        assert_eq!(path_from_menu_id("file.new-window"), None);
        assert_eq!(path_from_menu_id("recent:"), None);
    }

    #[test]
    fn prepares_newest_unique_paths_up_to_ten() {
        let mut projects = vec![
            project("/vaults/old/", "old", "2026-01-01T00:00:00.000Z"),
            project("/vaults/old", "older-name", "2026-01-02T00:00:00.000Z"),
            project("C:\\vaults\\win\\", "", "2026-03-01T00:00:00.000Z"),
        ];
        for index in 0..8 {
            projects.push(project(
                &format!("/vaults/n{index}"),
                &format!("n{index}"),
                &format!("2026-02-{index:02}T00:00:00.000Z"),
            ));
        }
        let prepared = prepare_recent(projects);
        assert_eq!(prepared.len(), RECENT_LIMIT);
        assert_eq!(prepared[0].path, "C:/vaults/win");
        assert_eq!(prepared[0].title, "win");
        assert!(prepared
            .iter()
            .any(|item| item.path == "/vaults/old" && item.title == "older-name"));
        assert!(prepared
            .windows(2)
            .all(|pair| pair[0].last_opened >= pair[1].last_opened));
    }

    #[test]
    fn disambiguates_duplicate_folder_names_with_the_parent() {
        let projects = vec![
            project("/work/a/notes", "notes", "2026-02-01T00:00:00.000Z"),
            project("/work/b/notes", "notes", "2026-01-01T00:00:00.000Z"),
            project("/work/solo", "solo", "2026-03-01T00:00:00.000Z"),
        ];
        assert_eq!(
            recent_menu_labels(&projects),
            vec![
                "notes — a".to_string(),
                "notes — b".to_string(),
                "solo".to_string(),
            ]
        );
    }
}
