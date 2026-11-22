//! Pictures and models for the built-in sample shop (see `fp_core::sample`): neutral grey
//! pictures that the UI tints with each part's filament color, plus each part's STL so
//! Print! can build a real plate. Written to the user's catalog folder when the sample shop
//! is loaded and removed again by "Clear sample data". Regenerate with
//! `sample_shop/make_models.py`; sources and license are in `sample_shop/SOURCES.md`.

use std::path::Path;

/// (product id, file under `<catalog>/<product id>/parts/`, bytes)
const FILES: &[(&str, &str, &[u8])] = &[
    (
        "sample-cable-organizer",
        "base.png",
        include_bytes!("../sample_shop/sample-cable-organizer/parts/base.png"),
    ),
    (
        "sample-cable-organizer",
        "base.stl",
        include_bytes!("../sample_shop/sample-cable-organizer/parts/base.stl"),
    ),
    (
        "sample-cable-organizer",
        "grip_pad.png",
        include_bytes!("../sample_shop/sample-cable-organizer/parts/grip_pad.png"),
    ),
    (
        "sample-cable-organizer",
        "grip_pad.stl",
        include_bytes!("../sample_shop/sample-cable-organizer/parts/grip_pad.stl"),
    ),
    (
        "sample-cable-organizer",
        "layer_base.png",
        include_bytes!("../sample_shop/sample-cable-organizer/parts/layer_base.png"),
    ),
    (
        "sample-cable-organizer",
        "layer_grip_pad.png",
        include_bytes!("../sample_shop/sample-cable-organizer/parts/layer_grip_pad.png"),
    ),
    (
        "sample-cable-organizer",
        "layers.json",
        include_bytes!("../sample_shop/sample-cable-organizer/parts/layers.json"),
    ),
    (
        "sample-desk-tray",
        "dividers.png",
        include_bytes!("../sample_shop/sample-desk-tray/parts/dividers.png"),
    ),
    (
        "sample-desk-tray",
        "dividers.stl",
        include_bytes!("../sample_shop/sample-desk-tray/parts/dividers.stl"),
    ),
    (
        "sample-desk-tray",
        "layer_dividers.png",
        include_bytes!("../sample_shop/sample-desk-tray/parts/layer_dividers.png"),
    ),
    (
        "sample-desk-tray",
        "layer_tray.png",
        include_bytes!("../sample_shop/sample-desk-tray/parts/layer_tray.png"),
    ),
    (
        "sample-desk-tray",
        "layers.json",
        include_bytes!("../sample_shop/sample-desk-tray/parts/layers.json"),
    ),
    (
        "sample-desk-tray",
        "tray.png",
        include_bytes!("../sample_shop/sample-desk-tray/parts/tray.png"),
    ),
    (
        "sample-desk-tray",
        "tray.stl",
        include_bytes!("../sample_shop/sample-desk-tray/parts/tray.stl"),
    ),
    (
        "sample-flexi-dragon",
        "body.png",
        include_bytes!("../sample_shop/sample-flexi-dragon/parts/body.png"),
    ),
    (
        "sample-flexi-dragon",
        "body.stl",
        include_bytes!("../sample_shop/sample-flexi-dragon/parts/body.stl"),
    ),
    (
        "sample-flexi-dragon",
        "head.png",
        include_bytes!("../sample_shop/sample-flexi-dragon/parts/head.png"),
    ),
    (
        "sample-flexi-dragon",
        "head.stl",
        include_bytes!("../sample_shop/sample-flexi-dragon/parts/head.stl"),
    ),
    (
        "sample-flexi-dragon",
        "layer_body.png",
        include_bytes!("../sample_shop/sample-flexi-dragon/parts/layer_body.png"),
    ),
    (
        "sample-flexi-dragon",
        "layer_head.png",
        include_bytes!("../sample_shop/sample-flexi-dragon/parts/layer_head.png"),
    ),
    (
        "sample-flexi-dragon",
        "layer_wings.png",
        include_bytes!("../sample_shop/sample-flexi-dragon/parts/layer_wings.png"),
    ),
    (
        "sample-flexi-dragon",
        "layers.json",
        include_bytes!("../sample_shop/sample-flexi-dragon/parts/layers.json"),
    ),
    (
        "sample-flexi-dragon",
        "wings.png",
        include_bytes!("../sample_shop/sample-flexi-dragon/parts/wings.png"),
    ),
    (
        "sample-flexi-dragon",
        "wings.stl",
        include_bytes!("../sample_shop/sample-flexi-dragon/parts/wings.stl"),
    ),
    (
        "sample-headphone-stand",
        "base.png",
        include_bytes!("../sample_shop/sample-headphone-stand/parts/base.png"),
    ),
    (
        "sample-headphone-stand",
        "base.stl",
        include_bytes!("../sample_shop/sample-headphone-stand/parts/base.stl"),
    ),
    (
        "sample-headphone-stand",
        "hanger.png",
        include_bytes!("../sample_shop/sample-headphone-stand/parts/hanger.png"),
    ),
    (
        "sample-headphone-stand",
        "hanger.stl",
        include_bytes!("../sample_shop/sample-headphone-stand/parts/hanger.stl"),
    ),
    (
        "sample-headphone-stand",
        "layer_base.png",
        include_bytes!("../sample_shop/sample-headphone-stand/parts/layer_base.png"),
    ),
    (
        "sample-headphone-stand",
        "layer_hanger.png",
        include_bytes!("../sample_shop/sample-headphone-stand/parts/layer_hanger.png"),
    ),
    (
        "sample-headphone-stand",
        "layer_post.png",
        include_bytes!("../sample_shop/sample-headphone-stand/parts/layer_post.png"),
    ),
    (
        "sample-headphone-stand",
        "layers.json",
        include_bytes!("../sample_shop/sample-headphone-stand/parts/layers.json"),
    ),
    (
        "sample-headphone-stand",
        "post.png",
        include_bytes!("../sample_shop/sample-headphone-stand/parts/post.png"),
    ),
    (
        "sample-headphone-stand",
        "post.stl",
        include_bytes!("../sample_shop/sample-headphone-stand/parts/post.stl"),
    ),
    (
        "sample-keychain",
        "inlay.png",
        include_bytes!("../sample_shop/sample-keychain/parts/inlay.png"),
    ),
    (
        "sample-keychain",
        "inlay.stl",
        include_bytes!("../sample_shop/sample-keychain/parts/inlay.stl"),
    ),
    (
        "sample-keychain",
        "layer_inlay.png",
        include_bytes!("../sample_shop/sample-keychain/parts/layer_inlay.png"),
    ),
    (
        "sample-keychain",
        "layer_ring.png",
        include_bytes!("../sample_shop/sample-keychain/parts/layer_ring.png"),
    ),
    (
        "sample-keychain",
        "layer_tag.png",
        include_bytes!("../sample_shop/sample-keychain/parts/layer_tag.png"),
    ),
    (
        "sample-keychain",
        "layers.json",
        include_bytes!("../sample_shop/sample-keychain/parts/layers.json"),
    ),
    (
        "sample-keychain",
        "ring.png",
        include_bytes!("../sample_shop/sample-keychain/parts/ring.png"),
    ),
    (
        "sample-keychain",
        "ring.stl",
        include_bytes!("../sample_shop/sample-keychain/parts/ring.stl"),
    ),
    (
        "sample-keychain",
        "tag.png",
        include_bytes!("../sample_shop/sample-keychain/parts/tag.png"),
    ),
    (
        "sample-keychain",
        "tag.stl",
        include_bytes!("../sample_shop/sample-keychain/parts/tag.stl"),
    ),
    (
        "sample-planter",
        "drip_tray.png",
        include_bytes!("../sample_shop/sample-planter/parts/drip_tray.png"),
    ),
    (
        "sample-planter",
        "drip_tray.stl",
        include_bytes!("../sample_shop/sample-planter/parts/drip_tray.stl"),
    ),
    (
        "sample-planter",
        "layer_drip_tray.png",
        include_bytes!("../sample_shop/sample-planter/parts/layer_drip_tray.png"),
    ),
    (
        "sample-planter",
        "layer_pot.png",
        include_bytes!("../sample_shop/sample-planter/parts/layer_pot.png"),
    ),
    (
        "sample-planter",
        "layers.json",
        include_bytes!("../sample_shop/sample-planter/parts/layers.json"),
    ),
    (
        "sample-planter",
        "pot.png",
        include_bytes!("../sample_shop/sample-planter/parts/pot.png"),
    ),
    (
        "sample-planter",
        "pot.stl",
        include_bytes!("../sample_shop/sample-planter/parts/pot.stl"),
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
        // Every part tile has its printable STL beside it, and it parses.
        for (pid, f, _) in FILES
            .iter()
            .filter(|(_, f, _)| f.ends_with(".png") && !f.starts_with("layer_"))
        {
            let stl = f.replace(".png", ".stl");
            let (_, _, bytes) = FILES
                .iter()
                .find(|(p, n, _)| p == pid && *n == stl)
                .unwrap_or_else(|| panic!("{pid}/{stl} missing"));
            let mesh = fp_mesh::parse_stl_bytes(bytes, &stl).unwrap();
            assert!(!mesh.indices.is_empty(), "{pid}/{stl}");
        }
    }

    #[test]
    fn write_then_remove() {
        let dir = std::env::temp_dir().join(format!("fp-sample-pics-{}", std::process::id()));
        write_pictures(&dir).unwrap();
        assert!(dir.join("sample-planter/parts/layers.json").is_file());
        assert!(dir.join("sample-planter/parts/pot.stl").is_file());
        std::fs::create_dir_all(dir.join("own-product")).unwrap();
        remove_pictures(&dir, &["sample-planter", "own-product"]);
        assert!(!dir.join("sample-planter").exists());
        assert!(dir.join("own-product").exists());
        assert!(dir.join("sample-cable-organizer/parts/base.png").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
