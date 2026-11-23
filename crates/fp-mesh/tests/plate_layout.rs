//! Plate layout: rotations survive a 3MF round trip, and the sample shop's real parts
//! arrange onto a typical bed.
use fp_mesh::plate::{
    auto_layout, check, plate_groups, quat_between, ArrangeItem, ArrangeSettings, BedSize,
    Footprint, Placement, PlannedPart, Sequence,
};
use fp_mesh::{load_stl_file, parse_3mf_parts, write_3mf_plate_with, PlateBuildItem, PlateOptions, TriangleMesh};
use std::path::PathBuf;

fn box_mesh(name: &str, w: f32, d: f32, h: f32) -> TriangleMesh {
    let p = vec![
        [0.0, 0.0, 0.0], [w, 0.0, 0.0], [w, d, 0.0], [0.0, d, 0.0],
        [0.0, 0.0, h], [w, 0.0, h], [w, d, h], [0.0, d, h],
    ];
    let i = vec![
        [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
        [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
    ];
    TriangleMesh { name: name.into(), positions: p, indices: i }
}

fn bounds(m: &TriangleMesh) -> ([f32; 3], [f32; 3]) {
    m.bounds()
}

#[test]
fn rotations_and_positions_survive_a_3mf_round_trip() {
    let a = box_mesh("a", 60.0, 20.0, 10.0);
    let b = box_mesh("b", 30.0, 30.0, 80.0);
    // b is laid on its side (front face down), then turned 30° on the plate.
    let qa = [0.0, 0.0, 0.0, 1.0];
    let qb = quat_between([0.0, -1.0, 0.0], [0.0, 0.0, -1.0]);
    let parts = vec![
        PlannedPart {
            orientation: qa,
            footprint: fp_mesh::plate::footprint(&a, qa),
            placement: Placement { plate: 0, x: 60.0, y: 40.0, rot_deg: 90.0 },
        },
        PlannedPart {
            orientation: qb,
            footprint: fp_mesh::plate::footprint(&b, qb),
            placement: Placement { plate: 0, x: 150.0, y: 120.0, rot_deg: 30.0 },
        },
    ];
    let items = vec![
        PlateBuildItem { name: "a".into(), filament_hex: "#FF0000".into(), mesh: a.clone() },
        PlateBuildItem { name: "b".into(), filament_hex: "#00FF00".into(), mesh: b.clone() },
    ];
    let opts = PlateOptions {
        transforms: parts.iter().map(|p| p.transform()).collect(),
        ..Default::default()
    };
    let bytes = write_3mf_plate_with(&items, &opts).unwrap();
    let back = parse_3mf_parts(&bytes, Some("plate")).unwrap();
    assert_eq!(back.len(), 2);
    for (got, part) in back.iter().zip(&parts) {
        let (lo, hi) = bounds(got);
        assert!(lo[2].abs() < 1e-3, "sits on the bed: {lo:?}");
        let cx = (lo[0] + hi[0]) / 2.0;
        let cy = (lo[1] + hi[1]) / 2.0;
        // The reference point is the centre of the outline's bounding box; for a box turned
        // by 90° that is the box centre. For the 30° part compare with the outline instead.
        let item = ArrangeItem::from_footprint(&part.footprint);
        let o = fp_mesh::plate::placed_outline(&item, &part.placement);
        let ob = fp_mesh::plate::bbox_2d(&o);
        assert!((lo[0] as f64 - ob[0]).abs() < 0.01 && (hi[0] as f64 - ob[2]).abs() < 0.01, "{lo:?} {hi:?} {ob:?}");
        assert!((lo[1] as f64 - ob[1]).abs() < 0.01 && (hi[1] as f64 - ob[3]).abs() < 0.01);
        let _ = (cx, cy);
    }
    // a: 60 wide turned 90° is 60 deep and 20 wide.
    let (lo, hi) = bounds(&back[0]);
    assert!((hi[0] - lo[0] - 20.0).abs() < 1e-3 && (hi[1] - lo[1] - 60.0).abs() < 1e-3);
    // b: laid down, its 80 mm height now lies flat, 30 mm tall.
    let (lo, hi) = bounds(&back[1]);
    assert!((hi[2] - lo[2] - 30.0).abs() < 1e-3, "{lo:?} {hi:?}");
}

#[test]
fn transforms_must_match_the_items() {
    let a = box_mesh("a", 10.0, 10.0, 10.0);
    let items = vec![PlateBuildItem { name: "a".into(), filament_hex: "#FF0000".into(), mesh: a }];
    let opts = PlateOptions { transforms: vec![[0.0; 12], [0.0; 12]], ..Default::default() };
    assert!(write_3mf_plate_with(&items, &opts).is_err());
}

fn sample(rel: &str) -> TriangleMesh {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/sample_shop");
    load_stl_file(&root.join(rel), rel).unwrap()
}

#[test]
fn sample_shop_parts_arrange_on_a_256_bed() {
    let names = [
        "sample-phone-stand/parts/stand.stl",
        "sample-phone-stand/parts/lip_pad.stl",
        "sample-planter/parts/pot.stl",
        "sample-planter/parts/drip_tray.stl",
        "sample-headphone-stand/parts/hanger.stl",
        "sample-keychain/parts/inlay.stl",
        "sample-keychain/parts/inlay.stl",
        "sample-keychain/parts/split_ring.stl",
        "sample-keychain/parts/split_ring.stl",
        "sample-keychain/parts/tag.stl",
    ];
    let meshes: Vec<TriangleMesh> = names.iter().map(|n| sample(n)).collect();
    let refs: Vec<&TriangleMesh> = meshes.iter().collect();
    let bed = BedSize { width_mm: 256.0, depth_mm: 256.0, height_mm: Some(256.0) };
    let s = ArrangeSettings::default();
    let t = std::time::Instant::now();
    let (parts, c) = auto_layout(&refs, &[], &bed, &s);
    eprintln!("arranged {} sample parts in {:?}", parts.len(), t.elapsed());
    assert_eq!(c.plates, 1, "{c:?}");
    assert!(c.fits(), "{c:?}");
    assert_eq!(plate_groups(&parts, &c).len(), 1);

    // A small bed needs more plates, and every plate is legal.
    let small = BedSize { width_mm: 180.0, depth_mm: 180.0, height_mm: None };
    let (parts2, c2) = auto_layout(&refs, &[], &small, &s);
    assert!(c2.plates >= 2, "{c2:?}");
    assert!(c2.fits(), "{c2:?}");
    assert_eq!(plate_groups(&parts2, &c2).iter().map(|g| g.len()).sum::<usize>(), names.len());

    // By object keeps the clearance between every pair.
    let obj = ArrangeSettings { sequence: Sequence::ByObject, ..Default::default() };
    let (p3, _) = auto_layout(&refs[5..], &[], &bed, &obj);
    let items: Vec<ArrangeItem> = p3.iter().map(|p| ArrangeItem::from_footprint(&p.footprint)).collect();
    let pl: Vec<Placement> = p3.iter().map(|p| p.placement).collect();
    let c3 = check(&items, &pl, &bed, &obj);
    assert!(c3.clearance_overlaps.is_empty(), "{c3:?}");
    let _: Option<Footprint> = None;
}
