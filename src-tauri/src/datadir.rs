//! Per-user FarmPrint data folder, named "FarmPrint" independent of the bundle id:
//!   macOS   ~/Library/Application Support/FarmPrint
//!   Windows %APPDATA%\FarmPrint
//!   Linux   $XDG_DATA_HOME/FarmPrint or ~/.local/share/FarmPrint
//! `FARMPRINT_DATA_DIR` overrides it (dev/tests).
//!
//! One-time migration: if the folder is empty and the legacy in-repo `ProductionTracker/`
//! exists, its contents are COPIED (never moved/deleted), plus any bundled catalog
//! meshes/pictures (ui/public/catalog) into <data>/catalog. A marker file stops reruns.
use std::path::{Path, PathBuf};

pub const MIGRATION_MARKER: &str = ".farmprint-data-v1";

pub fn user_data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("FARMPRINT_DATA_DIR") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    #[cfg(target_os = "macos")]
    {
        return home
            .join("Library")
            .join("Application Support")
            .join("FarmPrint");
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        return base.join("FarmPrint");
    }
    #[allow(unreachable_code)]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".local").join("share"));
        base.join("FarmPrint")
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum MigrationOutcome {
    AlreadyDone,
    CopiedLegacy,
    /// Folder was empty and there was nothing to copy: a brand-new shop (setup wizard).
    Fresh,
    /// Folder already had data from somewhere else; left untouched.
    ExistingData,
}

fn is_empty_dir(p: &Path) -> bool {
    match std::fs::read_dir(p) {
        Ok(mut it) => it.next().is_none(),
        Err(_) => true,
    }
}

/// Copies `src` into `dst` recursively; never overwrites files already in `dst`.
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<u64> {
    let mut n = 0;
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let s = name.to_string_lossy();
        if s == ".DS_Store" || s.starts_with("._") {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        let ft = entry.file_type()?;
        if ft.is_dir() {
            n += copy_tree(&from, &to)?;
        } else if ft.is_file() && !to.exists() {
            std::fs::copy(&from, &to)?;
            n += 1;
        }
    }
    Ok(n)
}

pub fn prepare_data_dir(
    data_dir: &Path,
    legacy_tracker: Option<&Path>,
    bundled_catalog: Option<&Path>,
) -> std::io::Result<MigrationOutcome> {
    let marker = data_dir.join(MIGRATION_MARKER);
    if marker.exists() {
        return Ok(MigrationOutcome::AlreadyDone);
    }
    let was_empty = is_empty_dir(data_dir);
    std::fs::create_dir_all(data_dir)?;
    let outcome = if !was_empty {
        MigrationOutcome::ExistingData
    } else if let Some(legacy) = legacy_tracker.filter(|p| p.is_dir() && !is_empty_dir(p)) {
        copy_tree(legacy, data_dir)?;
        if let Some(cat) = bundled_catalog.filter(|p| p.is_dir()) {
            copy_tree(cat, &data_dir.join("catalog"))?;
        }
        MigrationOutcome::CopiedLegacy
    } else {
        MigrationOutcome::Fresh
    };
    std::fs::create_dir_all(data_dir.join("catalog"))?;
    std::fs::write(
        &marker,
        format!(
            "{:?} from {}\n",
            outcome,
            legacy_tracker
                .map(|p| p.display().to_string())
                .unwrap_or_default()
        ),
    )?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migrates_once_and_never_touches_legacy() {
        let root = std::env::temp_dir().join(format!("fpdd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let legacy = root.join("ProductionTracker");
        let bundled = root.join("public_catalog");
        std::fs::create_dir_all(legacy.join("catalog/p1")).unwrap();
        std::fs::write(legacy.join("farmprint_shop_v2.sqlite"), b"db").unwrap();
        std::fs::write(legacy.join("catalog/p1/a.png"), b"legacy").unwrap();
        std::fs::create_dir_all(bundled.join("p1")).unwrap();
        std::fs::write(bundled.join("p1/a.png"), b"bundled").unwrap();
        std::fs::write(bundled.join("p1/b.stl"), b"mesh").unwrap();
        let data = root.join("FarmPrint");
        assert_eq!(
            prepare_data_dir(&data, Some(&legacy), Some(&bundled)).unwrap(),
            MigrationOutcome::CopiedLegacy
        );
        assert_eq!(
            std::fs::read(data.join("farmprint_shop_v2.sqlite")).unwrap(),
            b"db"
        );
        assert_eq!(
            std::fs::read(data.join("catalog/p1/a.png")).unwrap(),
            b"legacy"
        );
        assert_eq!(
            std::fs::read(data.join("catalog/p1/b.stl")).unwrap(),
            b"mesh"
        );
        assert!(legacy.join("farmprint_shop_v2.sqlite").exists());
        std::fs::write(legacy.join("new.json"), b"x").unwrap();
        assert_eq!(
            prepare_data_dir(&data, Some(&legacy), None).unwrap(),
            MigrationOutcome::AlreadyDone
        );
        assert!(!data.join("new.json").exists());
        let fresh = root.join("Fresh");
        // Fresh install: bundled catalog present in the build, but no legacy folder -> nothing copied.
        assert_eq!(
            prepare_data_dir(&fresh, Some(&root.join("nope")), Some(&bundled)).unwrap(),
            MigrationOutcome::Fresh
        );
        assert!(!fresh.join("catalog/p1").exists());
        assert!(fresh.join(MIGRATION_MARKER).exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
