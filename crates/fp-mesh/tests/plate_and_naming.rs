//! 3MF part naming / transforms on import, and the Print! plate file read back in.

use fp_mesh::{
    parse_3mf_parts, write_3mf_plate, write_3mf_plate_on_bed, PlateBed, PlateBuildItem,
    TriangleMesh,
};
use std::io::{Cursor, Read, Write};

fn zip3mf(files: &[(&str, &str)]) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        for (name, body) in files {
            zip.start_file(*name, zip::write::FileOptions::default())
                .unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
    buf.into_inner()
}

const TET: &str = r#"<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh>"#;

#[test]
fn component_parts_get_config_names_and_world_transforms() {
    let model = format!(
        r#"<model><resources><object id="1" type="model">{TET}</object><object id="2" type="model">{TET}</object><object id="3" name="Assembly.3mf" type="model"><components><component objectid="1"/><component objectid="2" transform="1 0 0 0 1 0 0 0 1 100 0 0"/></components></object></resources><build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 5"/></build></model>"#
    );
    let cfg = r#"<config><object id="3"><metadata key="name" value="Assembly"/><part id="1" subtype="normal_part"><metadata key="name" value="Body"/></part><part id="2" subtype="normal_part"><metadata key="name" value="Lid"/></part></object></config>"#;
    let parts = parse_3mf_parts(
        &zip3mf(&[
            ("3D/3dmodel.model", &model),
            ("Metadata/model_settings.config", cfg),
        ]),
        Some("x"),
    )
    .unwrap();
    let names: Vec<&str> = parts.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["Body", "Lid"]);
    assert_eq!(parts[0].indices.len(), 4);
    // Build item lifts both by 5 mm; the second component is also shifted 100 mm in X.
    assert_eq!(parts[0].positions[0], [0.0, 0.0, 5.0]);
    assert_eq!(parts[1].positions[1], [110.0, 0.0, 5.0]);
}

fn cube(name: &str, size: f32) -> PlateBuildItem {
    // Unwelded, like STL: every triangle has its own corners.
    let c = [
        [0., 0., 0.],
        [1., 0., 0.],
        [1., 1., 0.],
        [0., 1., 0.],
        [0., 0., 1.],
        [1., 0., 1.],
        [1., 1., 1.],
        [0., 1., 1.],
    ];
    let f = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
    ];
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    for t in f {
        let b = positions.len() as u32;
        for v in t {
            let p: [f32; 3] = c[v];
            positions.push([p[0] * size - 50.0, p[1] * size, p[2] * size + 3.0]);
        }
        indices.push([b, b + 1, b + 2]);
    }
    PlateBuildItem {
        name: name.into(),
        filament_hex: "#112233".into(),
        mesh: TriangleMesh {
            name: name.into(),
            positions,
            indices,
        },
    }
}

fn entry(bytes: &[u8], name: &str) -> String {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut s = String::new();
    z.by_name(name).unwrap().read_to_string(&mut s).unwrap();
    s
}

#[test]
fn plate_parses_back_welded_named_and_on_the_bed() {
    let bytes = write_3mf_plate(&[cube("A&1", 20.0), cube("B<2>", 20.0)]).unwrap();
    let parts = parse_3mf_parts(&bytes, Some("plate")).unwrap();
    assert_eq!(parts.len(), 2);
    for p in &parts {
        assert_eq!(p.positions.len(), 8, "corners are welded");
        assert_eq!(p.indices.len(), 12);
        let (mn, _) = p.bounds();
        assert!(mn[2].abs() < 1e-3, "sits on the bed at z=0");
        assert!(mn[0] >= -1e-3 && mn[1] >= -1e-3);
    }
    // Names are XML-escaped in the file and come back intact.
    let cfg = entry(&bytes, "Metadata/model_settings.config");
    assert!(cfg.contains("A&amp;1") && cfg.contains("B&lt;2&gt;"));
    assert_eq!(parts[0].name, "A&1");
    assert_eq!(parts[1].name, "B<2>");
    assert!(!entry(&bytes, "3D/3dmodel.model").contains("NaN"));
}

#[test]
fn plate_rows_wrap_at_bed_width_and_check_depth() {
    let items: Vec<_> = (0..4).map(|i| cube(&format!("P{i}"), 50.0)).collect();
    let bed = PlateBed {
        width_mm: 120.0,
        depth_mm: 200.0,
    };
    let parts = parse_3mf_parts(&write_3mf_plate_on_bed(&items, bed).unwrap(), Some("p")).unwrap();
    for p in &parts {
        let (_, mx) = p.bounds();
        assert!(mx[0] <= 120.0 + 1e-3, "row fits the bed width");
    }
    let too_shallow = PlateBed {
        width_mm: 120.0,
        depth_mm: 80.0,
    };
    assert!(write_3mf_plate_on_bed(&items, too_shallow).is_err());
    assert!(write_3mf_plate_on_bed(
        &items,
        PlateBed {
            width_mm: 0.0,
            depth_mm: 10.0
        }
    )
    .is_err());
}

#[test]
fn part_wider_than_a_known_bed_is_an_error_but_not_on_the_default_bed() {
    let items = vec![cube("Big", 300.0)];
    let err = write_3mf_plate_on_bed(
        &items,
        PlateBed {
            width_mm: 256.0,
            depth_mm: 256.0,
        },
    )
    .unwrap_err();
    assert!(err.contains("wide"), "{err}");
    assert!(write_3mf_plate(&items).is_ok());
}
