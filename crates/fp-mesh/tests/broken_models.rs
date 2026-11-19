//! A model file that can't be read must be an error, never a stand-in shape. Print! relies on
//! this: its missing-model guard treats `Ok` as "real geometry", so a placeholder would reach
//! the slicer.

use fp_mesh::{parse_3mf_parts, parse_stl_bytes};
use std::io::{Cursor, Write};

fn binary_stl(tris: u32) -> Vec<u8> {
    let mut b = vec![0u8; 80];
    b.extend_from_slice(&tris.to_le_bytes());
    for t in 0..tris {
        b.extend_from_slice(&[0u8; 12]); // normal
        for v in [[0.0f32, 0.0, t as f32], [10.0, 0.0, 0.0], [0.0, 10.0, 0.0]] {
            for c in v {
                b.extend_from_slice(&c.to_le_bytes());
            }
        }
        b.extend_from_slice(&[0u8; 2]);
    }
    b
}

#[test]
fn valid_binary_stl_still_parses() {
    let m = parse_stl_bytes(&binary_stl(3), "ok").expect("valid STL");
    assert_eq!(m.indices.len(), 3);
}

#[test]
fn valid_ascii_stl_still_parses() {
    let s = b"solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";
    assert_eq!(
        parse_stl_bytes(s, "ok")
            .expect("valid ASCII STL")
            .indices
            .len(),
        1
    );
}

#[test]
fn truncated_binary_stl_is_err() {
    let mut b = binary_stl(20);
    b.truncate(84 + 50 * 7 + 13);
    assert!(parse_stl_bytes(&b, "cut").is_err());
}

#[test]
fn garbage_stl_is_err() {
    let b: Vec<u8> = (0..4096u32)
        .map(|i| (i.wrapping_mul(2654435761) >> 13) as u8)
        .collect();
    assert!(parse_stl_bytes(&b, "junk").is_err());
    assert!(parse_stl_bytes(b"not a model at all", "junk").is_err());
}

#[test]
fn empty_stl_is_err() {
    assert!(parse_stl_bytes(&[], "empty").is_err());
    assert!(parse_stl_bytes(&binary_stl(0), "zero").is_err());
}

#[test]
fn garbage_and_empty_3mf_are_err() {
    assert!(parse_3mf_parts(&[], Some("empty")).is_err());
    assert!(parse_3mf_parts(b"PK\x03\x04 broken zip bytes", Some("junk")).is_err());
    assert!(parse_3mf_parts(b"<model><resources></resources></model>", Some("nomesh")).is_err());
}

#[test]
fn truncated_3mf_is_err() {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let opt =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("3D/3dmodel.model", opt).unwrap();
        let body = "<model><resources><object id=\"1\"><mesh><vertices>".to_string()
            + &"<vertex x=\"1\" y=\"2\" z=\"3\"/>".repeat(400)
            + "</vertices><triangles>"
            + &"<triangle v1=\"0\" v2=\"1\" v3=\"2\"/>".repeat(400)
            + "</triangles></mesh></object></resources></model>";
        zip.write_all(body.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
    let mut bytes = buf.into_inner();
    bytes.truncate(bytes.len() / 2);
    assert!(parse_3mf_parts(&bytes, Some("cut")).is_err());
}

#[test]
fn zip_without_model_is_err() {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        zip.start_file("readme.txt", zip::write::FileOptions::default())
            .unwrap();
        zip.write_all(b"hello").unwrap();
        zip.finish().unwrap();
    }
    assert!(parse_3mf_parts(&buf.into_inner(), Some("nomodel")).is_err());
}

#[test]
fn nan_coordinates_are_err() {
    let mut b = binary_stl(2);
    b[84 + 12..84 + 16].copy_from_slice(&f32::NAN.to_le_bytes());
    assert!(parse_stl_bytes(&b, "nan").is_err());
    let mut b = binary_stl(2);
    b[84 + 50 + 16..84 + 50 + 20].copy_from_slice(&f32::INFINITY.to_le_bytes());
    assert!(parse_stl_bytes(&b, "inf").is_err());
    let ascii = b"solid t\nfacet normal 0 0 1\nouter loop\nvertex NaN 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";
    assert!(parse_stl_bytes(ascii, "nan").is_err());
    let xml = br#"<model><resources><object id="1"><mesh><vertices><vertex x="NaN" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources></model>"#;
    assert!(parse_3mf_parts(xml, Some("nan")).is_err());
}

#[test]
fn single_triangle_3mf_has_exactly_one_triangle() {
    let xml = br#"<model><resources><object id="1" name="Tri"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources></model>"#;
    let parts = parse_3mf_parts(xml, Some("tri")).expect("parse");
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].indices, vec![[0, 1, 2]]);
}

#[test]
fn triangle_missing_a_corner_is_skipped() {
    let xml = br#"<model><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="1" v2="2"/></triangles></mesh></object></resources></model>"#;
    assert_eq!(parse_3mf_parts(xml, Some("t")).unwrap()[0].indices.len(), 1);
}
