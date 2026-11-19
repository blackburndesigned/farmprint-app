//! Pictures for the built-in sample shop (see `fp_core::sample`). Neutral grey pictures
//! that the UI tints with each part's filament color, written to the user's catalog folder
//! when the sample shop is loaded and removed again by "Clear sample data". Regenerate
//! with `sample_shop/make_pictures.py`.

use std::path::Path;

/// (product id, file under `<catalog>/<product id>/parts/`, bytes)
const FILES: &[(&str, &str, &[u8])] = &[
    (
        "sample-cable-clip",
        "base.png",
        include_bytes!("../sample_shop/sample-cable-clip/parts/base.png"),
    ),
    (
        "sample-cable-clip",
        "clip.png",
        include_bytes!("../sample_shop/sample-cable-clip/parts/clip.png"),
    ),
    (
        "sample-cable-clip",
        "layer_base.png",
        include_bytes!("../sample_shop/sample-cable-clip/parts/layer_base.png"),
    ),
    (
        "sample-cable-clip",
        "layer_clip.png",
        include_bytes!("../sample_shop/sample-cable-clip/parts/layer_clip.png"),
    ),
    (
        "sample-cable-clip",
        "layers.json",
        include_bytes!("../sample_shop/sample-cable-clip/parts/layers.json"),
    ),
    (
        "sample-desk-organizer",
        "divider.png",
        include_bytes!("../sample_shop/sample-desk-organizer/parts/divider.png"),
    ),
    (
        "sample-desk-organizer",
        "layer_divider.png",
        include_bytes!("../sample_shop/sample-desk-organizer/parts/layer_divider.png"),
    ),
    (
        "sample-desk-organizer",
        "layer_pen_cup.png",
        include_bytes!("../sample_shop/sample-desk-organizer/parts/layer_pen_cup.png"),
    ),
    (
        "sample-desk-organizer",
        "layer_tray.png",
        include_bytes!("../sample_shop/sample-desk-organizer/parts/layer_tray.png"),
    ),
    (
        "sample-desk-organizer",
        "layers.json",
        include_bytes!("../sample_shop/sample-desk-organizer/parts/layers.json"),
    ),
    (
        "sample-desk-organizer",
        "pen_cup.png",
        include_bytes!("../sample_shop/sample-desk-organizer/parts/pen_cup.png"),
    ),
    (
        "sample-desk-organizer",
        "tray.png",
        include_bytes!("../sample_shop/sample-desk-organizer/parts/tray.png"),
    ),
    (
        "sample-phone-stand",
        "layer_pad.png",
        include_bytes!("../sample_shop/sample-phone-stand/parts/layer_pad.png"),
    ),
    (
        "sample-phone-stand",
        "layer_stand.png",
        include_bytes!("../sample_shop/sample-phone-stand/parts/layer_stand.png"),
    ),
    (
        "sample-phone-stand",
        "layers.json",
        include_bytes!("../sample_shop/sample-phone-stand/parts/layers.json"),
    ),
    (
        "sample-phone-stand",
        "pad.png",
        include_bytes!("../sample_shop/sample-phone-stand/parts/pad.png"),
    ),
    (
        "sample-phone-stand",
        "stand.png",
        include_bytes!("../sample_shop/sample-phone-stand/parts/stand.png"),
    ),
    (
        "sample-plant-pot",
        "layer_pot.png",
        include_bytes!("../sample_shop/sample-plant-pot/parts/layer_pot.png"),
    ),
    (
        "sample-plant-pot",
        "layer_saucer.png",
        include_bytes!("../sample_shop/sample-plant-pot/parts/layer_saucer.png"),
    ),
    (
        "sample-plant-pot",
        "layers.json",
        include_bytes!("../sample_shop/sample-plant-pot/parts/layers.json"),
    ),
    (
        "sample-plant-pot",
        "pot.png",
        include_bytes!("../sample_shop/sample-plant-pot/parts/pot.png"),
    ),
    (
        "sample-plant-pot",
        "saucer.png",
        include_bytes!("../sample_shop/sample-plant-pot/parts/saucer.png"),
    ),
];

/// Marker that lets "delete product" clean the folder up like any FarmPrint-written art.
const AUTHORED_MARKER: &str = ".farmprint-authored";

/// Writes every sample picture into `<catalog_dir>/<product id>/parts/`.
pub fn write_pictures(catalog_dir: &Path) -> Result<(), String> {
    for (pid, file, bytes) in FILES {
        let dir = catalog_dir.join(pid).join("parts");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Could not write sample pictures: {e}"))?;
        std::fs::write(dir.join(file), bytes)
            .map_err(|e| format!("Could not write sample pictures: {e}"))?;
        let _ = std::fs::write(catalog_dir.join(pid).join(AUTHORED_MARKER), b"");
    }
    Ok(())
}

/// Removes the picture folders of the given sample products (ids must be sample ids).
pub fn remove_pictures(catalog_dir: &Path, product_ids: &[&str]) {
    for pid in product_ids {
        if !pid.starts_with(fp_core::sample::SAMPLE_ID_PREFIX)
            || !fp_core::sample::SAMPLE_PRODUCT_IDS.contains(pid)
        {
            continue;
        }
        let _ = std::fs::remove_dir_all(catalog_dir.join(pid));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_sample_product_has_pictures_and_layers() {
        for pid in fp_core::sample::SAMPLE_PRODUCT_IDS {
            assert!(
                FILES
                    .iter()
                    .any(|(p, f, _)| *p == pid && *f == "layers.json"),
                "{pid}"
            );
            assert!(
                FILES
                    .iter()
                    .filter(|(p, f, _)| *p == pid && f.ends_with(".png"))
                    .count()
                    >= 2,
                "{pid}"
            );
        }
        for (_, f, b) in FILES {
            if f.ends_with(".png") {
                assert!(b.starts_with(b"\x89PNG"), "{f}");
            }
        }
    }

    #[test]
    fn write_then_remove() {
        let dir = std::env::temp_dir().join(format!("fp-sample-pics-{}", std::process::id()));
        write_pictures(&dir).unwrap();
        assert!(dir.join("sample-plant-pot/parts/layers.json").is_file());
        std::fs::create_dir_all(dir.join("own-product")).unwrap();
        remove_pictures(&dir, &["sample-plant-pot", "own-product"]);
        assert!(!dir.join("sample-plant-pot").exists());
        assert!(dir.join("own-product").exists());
        assert!(dir.join("sample-cable-clip/parts/clip.png").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
