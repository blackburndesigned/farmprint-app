//! Which slicer Print! opens the plate in, and the commands tried to open it.
//!
//! The choice comes from Settings › Print library › Slicer (`slicer_app_name`,
//! `slicer_bundle_id`, `slicer_app_path` in the shop settings). With nothing set, Print!
//! uses Bambu Studio. When the chosen slicer can't be started, the plate is handed to
//! whatever app the computer opens .3mf files with; when that fails too, Print! reports it.
//!
//! `launch_plan` only builds the list of commands, so it can be tested on any platform;
//! `open_plate` runs them.

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

/// The slicers FarmPrint knows how to find without a chosen app location.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnownSlicer {
    BambuStudio,
    OrcaSlicer,
    PrusaSlicer,
}

impl KnownSlicer {
    /// Shown to the user.
    pub fn display_name(self) -> &'static str {
        match self {
            KnownSlicer::BambuStudio => "Bambu Studio",
            KnownSlicer::OrcaSlicer => "OrcaSlicer",
            KnownSlicer::PrusaSlicer => "PrusaSlicer",
        }
    }

    /// macOS app bundle name (`/Applications/<name>.app`), used with `open -a`.
    fn mac_app(self) -> &'static str {
        match self {
            KnownSlicer::BambuStudio => "BambuStudio",
            KnownSlicer::OrcaSlicer => "OrcaSlicer",
            KnownSlicer::PrusaSlicer => "PrusaSlicer",
        }
    }

    /// macOS bundle identifiers, newest first, used with `open -b`.
    /// OrcaSlicer changed its id in 2.x; older installs still use the SoftFever one.
    pub fn mac_bundle_ids(self) -> &'static [&'static str] {
        match self {
            KnownSlicer::BambuStudio => &["com.bambulab.bambu-studio"],
            KnownSlicer::OrcaSlicer => {
                &["com.orcaslicer.OrcaSlicer", "com.softfever3d.orca-slicer"]
            }
            KnownSlicer::PrusaSlicer => &["com.prusa3d.slic3r"],
        }
    }

    /// Windows install folder (under Program Files or LocalAppData) and executable.
    fn windows_exe(self) -> &'static [&'static str] {
        match self {
            KnownSlicer::BambuStudio => &["Bambu Studio", "bambu-studio.exe"],
            KnownSlicer::OrcaSlicer => &["OrcaSlicer", "orca-slicer.exe"],
            KnownSlicer::PrusaSlicer => &["Prusa3D", "PrusaSlicer", "prusa-slicer.exe"],
        }
    }

    /// Linux executables looked up on PATH (distro packages and AppImage launchers).
    fn linux_bins(self) -> &'static [&'static str] {
        match self {
            KnownSlicer::BambuStudio => &["bambu-studio", "BambuStudio"],
            KnownSlicer::OrcaSlicer => &["orca-slicer", "OrcaSlicer"],
            KnownSlicer::PrusaSlicer => &["prusa-slicer", "PrusaSlicer"],
        }
    }

    /// Flathub app ids; Flatpak puts a launcher for each under `exports/bin`.
    fn flatpak_ids(self) -> &'static [&'static str] {
        match self {
            KnownSlicer::BambuStudio => &["com.bambulab.BambuStudio"],
            KnownSlicer::OrcaSlicer => &[
                "com.orcaslicer.OrcaSlicer",
                "io.github.softfever.OrcaSlicer",
            ],
            KnownSlicer::PrusaSlicer => &["com.prusa3d.PrusaSlicer"],
        }
    }

    /// Recognises a slicer from a saved name, bundle id, or app file name
    /// ("OrcaSlicer", "orca-slicer.exe", "com.prusa3d.slic3r", "BambuStudio.app", ...).
    pub fn detect(text: &str) -> Option<KnownSlicer> {
        let t: String = text
            .to_ascii_lowercase()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect();
        if t.contains("orca") || t.contains("softfever") {
            Some(KnownSlicer::OrcaSlicer)
        } else if t.contains("prusa") {
            Some(KnownSlicer::PrusaSlicer)
        } else if t.contains("bambu") {
            Some(KnownSlicer::BambuStudio)
        } else {
            None
        }
    }
}

/// The slicer chosen in Settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlicerChoice {
    /// `None` for an app FarmPrint doesn't know; then only `app_path` / `label` are tried.
    pub known: Option<KnownSlicer>,
    /// Shown to the user ("OrcaSlicer").
    pub label: String,
    /// The app picked with Choose…, when there is one.
    pub app_path: Option<String>,
}

/// Reads the saved slicer settings. Nothing saved means Bambu Studio.
pub fn slicer_choice(name: &str, bundle_id: &str, app_path: &str) -> SlicerChoice {
    let name = name.trim();
    let bundle_id = bundle_id.trim();
    let app_path = app_path.trim();
    let file_name = app_path
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or("");
    let path = (!app_path.is_empty()).then(|| app_path.to_string());
    let known = KnownSlicer::detect(name)
        .or_else(|| KnownSlicer::detect(bundle_id))
        .or_else(|| KnownSlicer::detect(file_name));
    match known {
        Some(k) => SlicerChoice {
            known: Some(k),
            label: k.display_name().to_string(),
            app_path: path,
        },
        None if !name.is_empty() || path.is_some() => SlicerChoice {
            known: None,
            label: if name.is_empty() {
                file_name.to_string()
            } else {
                name.to_string()
            },
            app_path: path,
        },
        None => SlicerChoice {
            known: Some(KnownSlicer::BambuStudio),
            label: KnownSlicer::BambuStudio.display_name().to_string(),
            app_path: None,
        },
    }
}

/// One command Print! tries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchStep {
    pub program: String,
    pub args: Vec<String>,
    /// Wait for the command and require success (`open`, `start`, `xdg-open` report a
    /// missing app through their exit status). Otherwise starting the program is enough.
    pub wait: bool,
    /// The computer's default app for .3mf, used only after the chosen slicer failed.
    pub default_app: bool,
}

impl LaunchStep {
    fn spawn(program: impl Into<String>, file: &str) -> Self {
        LaunchStep {
            program: program.into(),
            args: vec![file.to_string()],
            wait: false,
            default_app: false,
        }
    }
    fn waited(program: &str, args: &[&str], file: &str, default_app: bool) -> Self {
        let mut a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        a.push(file.to_string());
        LaunchStep {
            program: program.to_string(),
            args: a,
            wait: true,
            default_app,
        }
    }
}

/// The commands tried, in order, to open `file` in `choice` on `os`. The last step is
/// always the computer's default .3mf app. `env` reads environment variables and
/// `is_file` checks a path, so tests can stand in for a real computer.
pub fn launch_plan(
    choice: &SlicerChoice,
    os: Os,
    file: &str,
    env: &dyn Fn(&str) -> Option<String>,
    is_file: &dyn Fn(&Path) -> bool,
) -> Vec<LaunchStep> {
    let mut steps: Vec<LaunchStep> = Vec::new();
    fn push(s: LaunchStep, steps: &mut Vec<LaunchStep>) {
        if !steps.contains(&s) {
            steps.push(s);
        }
    }
    match os {
        Os::Mac => {
            if let Some(p) = &choice.app_path {
                push(
                    LaunchStep::waited("open", &["-a", p], file, false),
                    &mut steps,
                );
            }
            match choice.known {
                Some(k) => {
                    for id in k.mac_bundle_ids() {
                        push(
                            LaunchStep::waited("open", &["-b", id], file, false),
                            &mut steps,
                        );
                    }
                    push(
                        LaunchStep::waited("open", &["-a", k.mac_app()], file, false),
                        &mut steps,
                    );
                }
                None if choice.app_path.is_none() && !choice.label.is_empty() => {
                    push(
                        LaunchStep::waited("open", &["-a", &choice.label], file, false),
                        &mut steps,
                    );
                }
                None => {}
            }
            push(LaunchStep::waited("open", &[], file, true), &mut steps);
        }
        Os::Windows => {
            if let Some(p) = &choice.app_path {
                if is_file(Path::new(p)) {
                    push(LaunchStep::spawn(p.clone(), file), &mut steps);
                }
            }
            if let Some(k) = choice.known {
                for var in [
                    "ProgramFiles",
                    "ProgramW6432",
                    "ProgramFiles(x86)",
                    "LOCALAPPDATA",
                ] {
                    let Some(base) = env(var).filter(|b| !b.trim().is_empty()) else {
                        continue;
                    };
                    let base = PathBuf::from(base);
                    for root in [base.clone(), base.join("Programs")] {
                        let exe = k.windows_exe().iter().fold(root, |p, c| p.join(c));
                        if is_file(&exe) {
                            push(
                                LaunchStep::spawn(exe.to_string_lossy().to_string(), file),
                                &mut steps,
                            );
                        }
                    }
                }
            }
            push(
                LaunchStep::waited("cmd", &["/C", "start", ""], file, true),
                &mut steps,
            );
        }
        Os::Linux => {
            if let Some(p) = &choice.app_path {
                if is_file(Path::new(p)) {
                    push(LaunchStep::spawn(p.clone(), file), &mut steps);
                }
            }
            if let Some(k) = choice.known {
                for bin in k.linux_bins() {
                    push(LaunchStep::spawn(*bin, file), &mut steps);
                }
                let mut export_dirs = vec![PathBuf::from("/var/lib/flatpak/exports/bin")];
                if let Some(home) = env("HOME").filter(|h| !h.trim().is_empty()) {
                    export_dirs.push(PathBuf::from(home).join(".local/share/flatpak/exports/bin"));
                }
                for id in k.flatpak_ids() {
                    for dir in &export_dirs {
                        let launcher = dir.join(id);
                        if is_file(&launcher) {
                            push(
                                LaunchStep::spawn(launcher.to_string_lossy().to_string(), file),
                                &mut steps,
                            );
                        }
                    }
                }
            }
            push(LaunchStep::waited("xdg-open", &[], file, true), &mut steps);
        }
    }
    steps
}

/// How the plate was opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    /// True when the chosen slicer didn't start and the default .3mf app was used.
    pub default_app: bool,
}

fn run_step(step: &LaunchStep) -> bool {
    let mut cmd = Command::new(&step.program);
    cmd.args(&step.args);
    if step.wait {
        cmd.status().map(|s| s.success()).unwrap_or(false)
    } else {
        cmd.spawn().is_ok()
    }
}

/// Opens `file` in the chosen slicer, falling back to the default .3mf app.
/// `None` when nothing could open it.
pub fn open_plate(choice: &SlicerChoice, file: &str) -> Option<Opened> {
    let env = |k: &str| std::env::var(k).ok();
    let is_file = |p: &Path| p.is_file();
    launch_plan(choice, Os::current(), file, &env, &is_file)
        .iter()
        .find(|s| run_step(s))
        .map(|s| Opened {
            default_app: s.default_app,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    const FILE: &str = "/tmp/FarmPrint_P1S_Blue_2parts.3mf";

    fn no_env(_: &str) -> Option<String> {
        None
    }
    fn nothing_installed(_: &Path) -> bool {
        false
    }
    fn cmdline(s: &LaunchStep) -> String {
        std::iter::once(s.program.clone())
            .chain(s.args.iter().cloned())
            .collect::<Vec<_>>()
            .join(" ")
    }
    fn plan(choice: &SlicerChoice, os: Os) -> Vec<String> {
        launch_plan(choice, os, FILE, &no_env, &nothing_installed)
            .iter()
            .map(cmdline)
            .collect()
    }

    #[test]
    fn nothing_saved_means_bambu_studio() {
        let c = slicer_choice("", "", "");
        assert_eq!(c.known, Some(KnownSlicer::BambuStudio));
        assert_eq!(c.label, "Bambu Studio");
        assert_eq!(c.app_path, None);
        assert_eq!(slicer_choice("  ", " ", " "), c);
    }

    #[test]
    fn saved_names_bundle_ids_and_app_files_are_recognised() {
        let k = |n: &str, b: &str, p: &str| slicer_choice(n, b, p).known;
        assert_eq!(k("OrcaSlicer", "", ""), Some(KnownSlicer::OrcaSlicer));
        assert_eq!(k("PrusaSlicer", "", ""), Some(KnownSlicer::PrusaSlicer));
        assert_eq!(k("Bambu Studio", "", ""), Some(KnownSlicer::BambuStudio));
        assert_eq!(
            k("", "com.prusa3d.slic3r", ""),
            Some(KnownSlicer::PrusaSlicer)
        );
        assert_eq!(
            k("", "com.softfever3d.orca-slicer", ""),
            Some(KnownSlicer::OrcaSlicer)
        );
        // Names the old Choose… button saved from the app's file name.
        assert_eq!(
            k(
                "orca-slicer",
                "",
                r"C:\Program Files\OrcaSlicer\orca-slicer.exe"
            ),
            Some(KnownSlicer::OrcaSlicer)
        );
        assert_eq!(
            k("", "", "/Applications/PrusaSlicer.app"),
            Some(KnownSlicer::PrusaSlicer)
        );
        assert_eq!(
            k("BambuStudio", "", "/Applications/BambuStudio.app/"),
            Some(KnownSlicer::BambuStudio)
        );
        // The name wins over a stale bundle id.
        assert_eq!(
            k("PrusaSlicer", "com.bambulab.bambu-studio", ""),
            Some(KnownSlicer::PrusaSlicer)
        );
    }

    #[test]
    fn unknown_app_with_a_location_is_used_as_is() {
        let c = slicer_choice("", "", "/opt/apps/MySlicer.AppImage");
        assert_eq!(c.known, None);
        assert_eq!(c.label, "MySlicer.AppImage");
        assert_eq!(c.app_path.as_deref(), Some("/opt/apps/MySlicer.AppImage"));
    }

    #[test]
    fn mac_tries_bundle_ids_then_app_name_then_default_app() {
        assert_eq!(
            plan(&slicer_choice("", "", ""), Os::Mac),
            vec![
                format!("open -b com.bambulab.bambu-studio {FILE}"),
                format!("open -a BambuStudio {FILE}"),
                format!("open {FILE}"),
            ]
        );
        assert_eq!(
            plan(&slicer_choice("OrcaSlicer", "", ""), Os::Mac),
            vec![
                format!("open -b com.orcaslicer.OrcaSlicer {FILE}"),
                format!("open -b com.softfever3d.orca-slicer {FILE}"),
                format!("open -a OrcaSlicer {FILE}"),
                format!("open {FILE}"),
            ]
        );
        assert_eq!(
            plan(
                &slicer_choice("PrusaSlicer", "", "/Applications/PrusaSlicer.app"),
                Os::Mac
            ),
            vec![
                format!("open -a /Applications/PrusaSlicer.app {FILE}"),
                format!("open -b com.prusa3d.slic3r {FILE}"),
                format!("open -a PrusaSlicer {FILE}"),
                format!("open {FILE}"),
            ]
        );
        // Every Mac step waits on `open`, which fails when the app isn't installed.
        let steps = launch_plan(
            &slicer_choice("", "", ""),
            Os::Mac,
            FILE,
            &no_env,
            &nothing_installed,
        );
        assert!(steps.iter().all(|s| s.wait));
        assert!(steps.last().unwrap().default_app);
        assert!(steps[..steps.len() - 1].iter().all(|s| !s.default_app));
    }

    #[test]
    fn windows_uses_installed_exes_then_the_3mf_file_association() {
        let env = |k: &str| match k {
            "ProgramFiles" => Some(r"C:\Program Files".to_string()),
            "LOCALAPPDATA" => Some(r"C:\Users\d\AppData\Local".to_string()),
            _ => None,
        };
        let installed: HashSet<PathBuf> = [
            PathBuf::from(r"C:\Program Files")
                .join("Prusa3D")
                .join("PrusaSlicer")
                .join("prusa-slicer.exe"),
            PathBuf::from(r"C:\Users\d\AppData\Local")
                .join("Programs")
                .join("OrcaSlicer")
                .join("orca-slicer.exe"),
        ]
        .into_iter()
        .collect();
        let is_file = |p: &Path| installed.contains(p);
        let run = |name: &str| -> Vec<String> {
            launch_plan(
                &slicer_choice(name, "", ""),
                Os::Windows,
                FILE,
                &env,
                &is_file,
            )
            .iter()
            .map(cmdline)
            .collect()
        };
        let prusa_exe = PathBuf::from(r"C:\Program Files")
            .join("Prusa3D")
            .join("PrusaSlicer")
            .join("prusa-slicer.exe");
        assert_eq!(
            run("PrusaSlicer"),
            vec![
                format!("{} {FILE}", prusa_exe.display()),
                format!("cmd /C start  {FILE}")
            ]
        );
        let orca_exe = PathBuf::from(r"C:\Users\d\AppData\Local")
            .join("Programs")
            .join("OrcaSlicer")
            .join("orca-slicer.exe");
        assert_eq!(
            run("OrcaSlicer"),
            vec![
                format!("{} {FILE}", orca_exe.display()),
                format!("cmd /C start  {FILE}")
            ]
        );
        // Bambu Studio not installed: straight to the default .3mf app.
        let steps = launch_plan(
            &slicer_choice("", "", ""),
            Os::Windows,
            FILE,
            &env,
            &is_file,
        );
        assert_eq!(steps.len(), 1);
        assert!(steps[0].default_app && steps[0].wait);
        assert_eq!(steps[0].args, vec!["/C", "start", "", FILE]);
    }

    #[test]
    fn linux_tries_path_then_flatpak_then_xdg_open() {
        let env = |k: &str| (k == "HOME").then(|| "/home/d".to_string());
        let installed: HashSet<PathBuf> = [
            PathBuf::from("/home/d/.local/share/flatpak/exports/bin/com.orcaslicer.OrcaSlicer"),
            PathBuf::from("/opt/Orca.AppImage"),
        ]
        .into_iter()
        .collect();
        let is_file = |p: &Path| installed.contains(p);
        let got: Vec<String> = launch_plan(
            &slicer_choice("OrcaSlicer", "", "/opt/Orca.AppImage"),
            Os::Linux,
            FILE,
            &env,
            &is_file,
        )
        .iter()
        .map(cmdline)
        .collect();
        assert_eq!(
            got,
            vec![
                format!("/opt/Orca.AppImage {FILE}"),
                format!("orca-slicer {FILE}"),
                format!("OrcaSlicer {FILE}"),
                format!(
                    "/home/d/.local/share/flatpak/exports/bin/com.orcaslicer.OrcaSlicer {FILE}"
                ),
                format!("xdg-open {FILE}"),
            ]
        );
        assert_eq!(
            plan(&slicer_choice("PrusaSlicer", "", ""), Os::Linux),
            vec![
                format!("prusa-slicer {FILE}"),
                format!("PrusaSlicer {FILE}"),
                format!("xdg-open {FILE}"),
            ]
        );
        assert_eq!(
            plan(&slicer_choice("", "", ""), Os::Linux),
            vec![
                format!("bambu-studio {FILE}"),
                format!("BambuStudio {FILE}"),
                format!("xdg-open {FILE}"),
            ]
        );
    }

    #[test]
    fn a_missing_chosen_app_file_is_skipped() {
        // Windows/Linux only run a chosen app location that exists.
        let c = slicer_choice("", "", "/gone/MySlicer");
        assert_eq!(plan(&c, Os::Linux), vec![format!("xdg-open {FILE}")]);
        assert_eq!(plan(&c, Os::Windows), vec![format!("cmd /C start  {FILE}")]);
        // macOS asks `open -a`, which fails cleanly when it's gone.
        assert_eq!(
            plan(&c, Os::Mac),
            vec![
                format!("open -a /gone/MySlicer {FILE}"),
                format!("open {FILE}")
            ]
        );
    }

    #[test]
    fn unknown_app_name_without_location_is_opened_by_name_on_mac() {
        let c = slicer_choice("Cura", "", "");
        assert_eq!(c.known, None);
        assert_eq!(
            plan(&c, Os::Mac),
            vec![format!("open -a Cura {FILE}"), format!("open {FILE}")]
        );
        assert_eq!(plan(&c, Os::Linux), vec![format!("xdg-open {FILE}")]);
    }

    #[test]
    fn last_step_is_always_the_default_app() {
        for os in [Os::Mac, Os::Windows, Os::Linux] {
            for name in ["", "OrcaSlicer", "PrusaSlicer", "Cura"] {
                let steps = launch_plan(
                    &slicer_choice(name, "", ""),
                    os,
                    FILE,
                    &no_env,
                    &nothing_installed,
                );
                let last = steps.last().unwrap();
                assert!(last.default_app && last.wait, "{os:?} {name}");
                assert_eq!(steps.iter().filter(|s| s.default_app).count(), 1);
                assert_eq!(last.args.last().unwrap(), FILE);
            }
        }
    }
}
