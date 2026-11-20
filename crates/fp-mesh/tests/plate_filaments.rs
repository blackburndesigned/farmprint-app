//! Print! plates number each distinct filament for the slicer: loaded printer slots keep their
//! slot number, other colors take free numbers, and every slicer file agrees.

use fp_mesh::{
    assign_plate_filaments, normalize_hex, parse_3mf_parts, write_3mf_plate, write_3mf_plate_with,
    PlateBed, PlateBuildItem, PlateItemFilament, PlateOptions, PlateSlot, TriangleMesh,
};
use std::io::{Cursor, Read};

fn cube(name: &str, hex: &str) -> PlateBuildItem {
    let s = 10.0f32;
    let c = [
        [0., 0., 0.],
        [s, 0., 0.],
        [s, s, 0.],
        [0., s, 0.],
        [0., 0., s],
        [s, 0., s],
        [s, s, s],
        [0., s, s],
    ];
    let f: [[usize; 3]; 12] = [
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
            positions.push(c[v]);
        }
        indices.push([b, b + 1, b + 2]);
    }
    PlateBuildItem {
        name: name.into(),
        filament_hex: hex.into(),
        mesh: TriangleMesh {
            name: name.into(),
            positions,
            indices,
        },
    }
}

fn slot(n: u32, id: &str, hex: &str) -> PlateSlot {
    PlateSlot {
        slot: n,
        filament_id: id.into(),
        filament_hex: hex.into(),
        material: "PLA".into(),
    }
}

fn fil(id: &str) -> PlateItemFilament {
    PlateItemFilament {
        filament_id: id.into(),
        material: "PLA".into(),
    }
}

fn zip_text(bytes: &[u8], name: &str) -> String {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut out = String::new();
    z.by_name(name)
        .unwrap_or_else(|_| panic!("{name} missing"))
        .read_to_string(&mut out)
        .unwrap();
    out
}

fn zip_names(bytes: &[u8]) -> Vec<String> {
    let z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    z.file_names().map(String::from).collect()
}

/// Well-formed XML, or panic with the parser error.
fn assert_xml(name: &str, xml: &str) {
    let mut r = quick_xml::Reader::from_str(xml);
    loop {
        match r.read_event() {
            Ok(quick_xml::events::Event::Eof) => break,
            Ok(_) => {}
            Err(e) => panic!("{name} is not well-formed XML: {e}\n{xml}"),
        }
    }
}

/// `key="value"` metadata values of `key` in a config, in file order.
fn metadata_values(cfg: &str, key: &str) -> Vec<String> {
    let needle = format!("key=\"{key}\" value=\"");
    cfg.match_indices(&needle)
        .map(|(i, _)| {
            let rest = &cfg[i + needle.len()..];
            rest[..rest.find('"').unwrap()].to_string()
        })
        .collect()
}

/// Object-level `extruder` in model_settings.config (the part-level copy follows each one).
fn bambu_object_extruders(cfg: &str) -> Vec<String> {
    metadata_values(cfg, "extruder")
        .into_iter()
        .step_by(2)
        .collect()
}

#[test]
fn loaded_colors_take_their_slot_number() {
    let items = [
        cube("a", "#ff0000"),
        cube("b", "#00ff00"),
        cube("c", "#ff0000"),
    ];
    let opts = PlateOptions {
        loaded_slots: vec![
            slot(1, "white", "#FFFFFF"),
            slot(2, "green", "#00FF00"),
            slot(3, "red", "#FF0000"),
        ],
        item_filaments: vec![fil("red"), fil("green"), fil("red")],
        ..Default::default()
    };
    let (numbers, fils) = assign_plate_filaments(&items, &opts);
    assert_eq!(numbers, [3, 2, 3]);
    let got: Vec<(u32, &str, bool)> = fils
        .iter()
        .map(|f| (f.number, f.hex.as_str(), f.from_slot))
        .collect();
    assert_eq!(got, [(2, "#00FF00", true), (3, "#FF0000", true)]);
}

#[test]
fn unloaded_colors_take_the_next_numbers_no_slot_uses() {
    // Slots 1 and 3 hold spools; only slot 3's color is on this plate.
    let items = [
        cube("blue", "#0000ff"),
        cube("red", "#ff0000"),
        cube("pink", "#ff00ff"),
        cube("gold", "#ffd700"),
    ];
    let opts = PlateOptions {
        loaded_slots: vec![slot(1, "white", "#ffffff"), slot(3, "red", "#ff0000")],
        item_filaments: vec![fil("blue"), fil("red"), fil("pink"), fil("gold")],
        ..Default::default()
    };
    let (numbers, fils) = assign_plate_filaments(&items, &opts);
    // Blue skips slot 1 (white is loaded there), takes 2; pink skips 3, takes 4; gold 5.
    assert_eq!(numbers, [2, 3, 4, 5]);
    assert_eq!(
        fils.iter().map(|f| f.from_slot).collect::<Vec<_>>(),
        [false, true, false, false]
    );
}

#[test]
fn without_printer_info_colors_are_numbered_in_first_seen_order() {
    let items = [
        cube("a", "#00ff00"),
        cube("b", "#FF0000"),
        cube("c", "00FF00"),
        cube("d", "#0000ff"),
    ];
    let (numbers, fils) = assign_plate_filaments(&items, &PlateOptions::default());
    // "00FF00" and "#00ff00" are the same color once normalized.
    assert_eq!(numbers, [1, 2, 1, 3]);
    assert_eq!(
        fils.iter().map(|f| f.hex.as_str()).collect::<Vec<_>>(),
        ["#00FF00", "#FF0000", "#0000FF"]
    );
    assert!(fils.iter().all(|f| f.material == "PLA" && !f.from_slot));
}

#[test]
fn swatch_id_wins_over_hex_and_hex_matches_when_there_is_no_id() {
    // Two swatches with the same white hex: PLA in slot 1, PETG in slot 4.
    let items = [
        cube("petg", "#ffffff"),
        cube("pla", "#ffffff"),
        cube("noid", "#FFFFFF"),
    ];
    let opts = PlateOptions {
        loaded_slots: vec![
            slot(1, "white-pla", "#ffffff"),
            PlateSlot {
                material: "PETG".into(),
                ..slot(4, "white-petg", "#ffffff")
            },
        ],
        item_filaments: vec![
            PlateItemFilament {
                filament_id: "white-petg".into(),
                material: "PETG".into(),
            },
            fil("white-pla"),
            PlateItemFilament::default(),
        ],
        ..Default::default()
    };
    let (numbers, fils) = assign_plate_filaments(&items, &opts);
    assert_eq!(numbers, [4, 1, 1]);
    assert_eq!(fils.len(), 2);
    assert_eq!(fils[1].material, "PETG");
}

#[test]
fn a_swatch_loaded_under_another_id_still_matches_by_color_and_material() {
    let items = [cube("a", "#123456")];
    let opts = PlateOptions {
        loaded_slots: vec![slot(2, "dup-of-blue", "#123456")],
        item_filaments: vec![fil("blue")],
        ..Default::default()
    };
    assert_eq!(assign_plate_filaments(&items, &opts).0, [2]);
    // Same color, different material: not the same filament.
    let petg = PlateOptions {
        item_filaments: vec![PlateItemFilament {
            filament_id: "blue".into(),
            material: "PETG".into(),
        }],
        ..opts
    };
    assert_eq!(assign_plate_filaments(&items, &petg).0, [1]);
}

#[test]
fn hex_normalizing() {
    assert_eq!(normalize_hex("#abc").as_deref(), Some("#AABBCC"));
    assert_eq!(normalize_hex(" ff8d28 ").as_deref(), Some("#FF8D28"));
    assert_eq!(normalize_hex("#11223344").as_deref(), Some("#112233"));
    assert_eq!(normalize_hex("#zzzzzz"), None);
    assert_eq!(normalize_hex(""), None);
}

#[test]
fn every_slicer_file_gets_the_same_numbers_and_parses() {
    let items = [
        cube("Red_Cup", "#FF0000"),
        cube("Green&Lid", "#00FF00"),
        cube("Blue <Base>", "#0000FF"),
        cube("Red_Cup_2", "#ff0000"),
    ];
    let opts = PlateOptions {
        bed: PlateBed {
            width_mm: 256.0,
            depth_mm: 256.0,
        },
        loaded_slots: vec![slot(3, "red", "#FF0000"), slot(1, "white", "#FFFFFF")],
        item_filaments: vec![fil("red"), fil("green"), fil("blue"), fil("red")],
    };
    let bytes = write_3mf_plate_with(&items, &opts).unwrap();
    let names = zip_names(&bytes);
    for f in [
        "3D/3dmodel.model",
        "Metadata/model_settings.config",
        "Metadata/Slic3r_PE_model.config",
    ] {
        assert!(names.iter().any(|n| n == f), "{f} missing: {names:?}");
        assert_xml(f, &zip_text(&bytes, f));
    }
    // No settings files: they would replace the user's printer and print profiles.
    assert!(!names
        .iter()
        .any(|n| n.ends_with("project_settings.config") || n.ends_with("Slic3r_PE.config")));

    // red = slot 3, green and blue skip slot 1 (white) and 3: 2 and 4.
    let model = zip_text(&bytes, "3D/3dmodel.model");
    // No core-spec colors: Bambu Studio would turn them into a color import and drop
    // every `extruder` below.
    assert!(
        !model.contains("basematerials") && !model.contains("pid="),
        "{model}"
    );
    for obj in 1..=4 {
        assert!(
            model.contains(&format!(
                "<object id=\"{obj}\" name=\"{}\" type=\"model\">",
                match obj {
                    1 => "Red_Cup",
                    2 => "Green&amp;Lid",
                    3 => "Blue &lt;Base&gt;",
                    _ => "Red_Cup_2",
                }
            )),
            "object {obj}: {model}"
        );
    }

    let bambu = zip_text(&bytes, "Metadata/model_settings.config");
    assert_eq!(bambu_object_extruders(&bambu), ["3", "2", "4", "3"]);
    assert_eq!(
        metadata_values(&bambu, "extruder").len(),
        8,
        "part-level too"
    );

    let prusa = zip_text(&bytes, "Metadata/Slic3r_PE_model.config");
    assert_eq!(metadata_values(&prusa, "extruder"), ["3", "2", "4", "3"]);
    assert_eq!(
        prusa
            .matches("<volume firstid=\"0\" lastid=\"11\">")
            .count(),
        4
    );
    assert_eq!(
        prusa
            .matches("key=\"volume_type\" value=\"ModelPart\"")
            .count(),
        4
    );
    assert!(prusa.contains("value=\"Green&amp;Lid\""));
}

#[test]
fn plate_round_trips_through_the_importer_with_names_and_shapes() {
    let items = [
        cube("A", "#FF0000"),
        cube("B", "#00FF00"),
        cube("C", "#0000FF"),
    ];
    let opts = PlateOptions {
        loaded_slots: vec![slot(2, "g", "#00FF00")],
        item_filaments: vec![fil("r"), fil("g"), fil("b")],
        ..Default::default()
    };
    let bytes = write_3mf_plate_with(&items, &opts).unwrap();
    let parts = parse_3mf_parts(&bytes, Some("plate")).unwrap();
    let names: Vec<&str> = parts.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["A", "B", "C"]);
    for p in &parts {
        assert_eq!(p.indices.len(), 12);
        assert_eq!(p.positions.len(), 8, "welded corners");
    }
    let cfg = zip_text(&bytes, "Metadata/model_settings.config");
    assert_eq!(bambu_object_extruders(&cfg), ["1", "2", "3"]);
}

#[test]
fn single_color_plates_and_old_entry_points_still_work() {
    let bytes = write_3mf_plate(&[cube("x", "#ffffff"), cube("y", "#FFFFFF")]).unwrap();
    let cfg = zip_text(&bytes, "Metadata/model_settings.config");
    assert_eq!(bambu_object_extruders(&cfg), ["1", "1"]);
    assert_eq!(parse_3mf_parts(&bytes, Some("p")).unwrap().len(), 2);
    // An empty plate still writes a valid (if useless) file.
    let empty = write_3mf_plate(&[]).unwrap();
    assert_xml("empty model", &zip_text(&empty, "3D/3dmodel.model"));
}

#[test]
fn importer_reads_object_ids_written_after_pid() {
    // Other tools write `pid` before `id`; `id` must not be read out of `pid`.
    let mut buf = Cursor::new(Vec::new());
    {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(&mut buf);
        zip.start_file("3D/3dmodel.model", zip::write::FileOptions::default())
            .unwrap();
        zip.write_all(br##"<model><resources><basematerials id="9"><base name="r" displaycolor="#FF0000FF"/></basematerials><object pid="9" pindex="0" id="1" name="Widget" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>"##).unwrap();
        zip.finish().unwrap();
    }
    let parts = parse_3mf_parts(&buf.into_inner(), Some("w")).unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].name, "Widget");
}
