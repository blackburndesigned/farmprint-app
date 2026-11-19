//! Help menu items that open the public farmprint-releases issue forms.

pub use crate::feedback_url::{
    issue_kind_from_menu_id, issue_url, open_in_browser, os_label, IssueKind, REPORT_BUG_ID,
    REQUEST_FEATURE_ID,
};

/// Default app / Edit / Window / Help menus, plus the two feedback items on Help.
pub fn build_app_menu<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID};

    let menu = Menu::default(handle)?;
    let report_bug = MenuItem::with_id(handle, REPORT_BUG_ID, "Report a Bug", true, None::<&str>)?;
    let request_feature = MenuItem::with_id(
        handle,
        REQUEST_FEATURE_ID,
        "Request a Feature",
        true,
        None::<&str>,
    )?;

    if let Some(kind) = menu.get(HELP_SUBMENU_ID) {
        if let Some(help) = kind.as_submenu() {
            // Windows/Linux Help already has About; keep it visually separate.
            if !help.items()?.is_empty() {
                help.append(&PredefinedMenuItem::separator(handle)?)?;
            }
            help.append_items(&[&report_bug, &request_feature])?;
            return Ok(menu);
        }
    }

    menu.append(&Submenu::with_id_and_items(
        handle,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[&report_bug, &request_feature],
    )?)?;
    Ok(menu)
}

pub fn open_issue<R: tauri::Runtime>(app: &tauri::AppHandle<R>, kind: IssueKind) {
    let version = app.package_info().version.to_string();
    let url = issue_url(kind, &version, os_label());
    if let Err(e) = open_in_browser(&url) {
        eprintln!("FarmPrint: could not open feedback form: {e}");
    }
}
