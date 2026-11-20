//! GitHub issue-form URLs for Help > Report a Bug / Request a Feature.
//! Field ids `version` and `os` must match the forms in farmprint-app.

pub const NEW_ISSUE_BASE: &str =
    "https://github.com/blackburndesigned/farmprint-app/issues/new";
pub const BUG_TEMPLATE: &str = "bug_report.yml";
pub const FEATURE_TEMPLATE: &str = "feature_request.yml";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IssueKind {
    Bug,
    Feature,
}

impl IssueKind {
    pub fn template(self) -> &'static str {
        match self {
            IssueKind::Bug => BUG_TEMPLATE,
            IssueKind::Feature => FEATURE_TEMPLATE,
        }
    }
}

/// Exact `os` values expected by the GitHub issue forms. No architecture suffix.
pub fn os_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Mac"
    } else if cfg!(target_os = "windows") {
        "Windows"
    } else {
        "Linux"
    }
}

/// Build a new-issue URL. The bug form pre-fills `version` and `os` (dropdown
/// labels: Mac, Windows, Linux). The feature form has none of those fields, so only
/// `template` is sent.
pub fn issue_url(kind: IssueKind, version: &str, os: &str) -> String {
    let mut url = format!("{NEW_ISSUE_BASE}?template={}", kind.template());
    if kind == IssueKind::Bug {
        url.push_str(&format!(
            "&version={}&os={}",
            encode_query(version),
            encode_query(os),
        ));
    }
    url
}

/// RFC 3986 query-component encoding (percent-encode everything except unreserved).
fn encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub const REPORT_BUG_ID: &str = "fp-report-bug";
pub const REQUEST_FEATURE_ID: &str = "fp-request-feature";

pub fn issue_kind_from_menu_id(id: &str) -> Option<IssueKind> {
    match id {
        REPORT_BUG_ID => Some(IssueKind::Bug),
        REQUEST_FEATURE_ID => Some(IssueKind::Feature),
        _ => None,
    }
}

/// Command used to open a URL in the system browser. Windows quotes via `cmd /C`
/// so `&` in the query string is not treated as a command separator.
pub fn browser_command(url: &str) -> std::process::Command {
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        cmd.arg(url);
        cmd
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "start", "", url]);
        cmd
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(url);
        cmd
    }
}

pub fn open_in_browser(url: &str) -> Result<(), String> {
    browser_command(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open system browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bug_url_for_macos_release() {
        assert_eq!(
            issue_url(IssueKind::Bug, "0.9.15", "Mac"),
            "https://github.com/blackburndesigned/farmprint-app/issues/new?template=bug_report.yml&version=0.9.15&os=Mac"
        );
    }

    #[test]
    fn bug_url_for_each_dropdown_os() {
        for os in ["Mac", "Windows", "Linux"] {
            let url = issue_url(IssueKind::Bug, "0.9.15", os);
            assert_eq!(
                url,
                format!(
                    "https://github.com/blackburndesigned/farmprint-app/issues/new?template=bug_report.yml&version=0.9.15&os={os}"
                )
            );
        }
    }

    #[test]
    fn feature_url_omits_version_and_os() {
        // Feature form has no version/os fields; passing them would just be ignored
        // or look like leftover query junk, so we only send the template.
        for os in ["Mac", "Windows", "Linux"] {
            let url = issue_url(IssueKind::Feature, "0.9.15", os);
            assert_eq!(
                url,
                "https://github.com/blackburndesigned/farmprint-app/issues/new?template=feature_request.yml"
            );
        }
    }

    #[test]
    fn urls_do_not_set_title_labels_or_body() {
        for kind in [IssueKind::Bug, IssueKind::Feature] {
            let url = issue_url(kind, "0.9.15", "Mac");
            assert!(!url.contains("body="));
            assert!(!url.contains("title="));
            assert!(!url.contains("labels="));
            assert!(!url.contains("aarch64"));
            assert!(!url.contains("x86_64"));
        }
    }

    #[test]
    fn query_values_are_percent_encoded() {
        let url = issue_url(IssueKind::Bug, "0.9.15+dev", "Mac OS");
        assert_eq!(
            url,
            "https://github.com/blackburndesigned/farmprint-app/issues/new?template=bug_report.yml&version=0.9.15%2Bdev&os=Mac%20OS"
        );
    }

    #[test]
    fn os_label_matches_this_platform() {
        let label = os_label();
        assert!(
            matches!(label, "Mac" | "Windows" | "Linux"),
            "unexpected os label {label}"
        );
        #[cfg(target_os = "linux")]
        assert_eq!(label, "Linux");
        #[cfg(target_os = "macos")]
        assert_eq!(label, "Mac");
        #[cfg(target_os = "windows")]
        assert_eq!(label, "Windows");
    }

    #[test]
    fn menu_ids_map_to_issue_kinds() {
        assert_eq!(issue_kind_from_menu_id(REPORT_BUG_ID), Some(IssueKind::Bug));
        assert_eq!(
            issue_kind_from_menu_id(REQUEST_FEATURE_ID),
            Some(IssueKind::Feature)
        );
        assert_eq!(issue_kind_from_menu_id("fpctx:edit"), None);
    }

    #[test]
    fn browser_command_targets_this_platform() {
        let url = issue_url(IssueKind::Bug, "0.9.15", os_label());
        let cmd = browser_command(&url);
        let program = cmd.get_program().to_string_lossy();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        #[cfg(target_os = "linux")]
        {
            assert_eq!(program, "xdg-open");
            assert_eq!(args, [url]);
        }
        #[cfg(target_os = "macos")]
        {
            assert_eq!(program, "open");
            assert_eq!(args, [url]);
        }
        #[cfg(target_os = "windows")]
        {
            assert_eq!(program, "cmd");
            assert_eq!(args, ["/C", "start", "", url]);
        }
    }
}
