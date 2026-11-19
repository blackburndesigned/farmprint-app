//! 3MF import tests that need no external files: a tiny 3MF is generated in memory.
//! Optionally set FARMPRINT_TEST_3MF_DIR to a folder of .3mf files to also exercise real archives.

use fp_mesh::parse_3mf_parts;
use std::io::{Cursor, Write};

fn tiny_3mf() -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let opt =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("[Content_Types].xml", opt).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>"#).unwrap();
        zip.start_file("_rels/.rels", opt).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>"#).unwrap();
        zip.start_file("3D/3dmodel.model", opt).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" name="Test Part" type="model"><mesh>
   <vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices>
   <triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles>
  </mesh></object>
 </resources>
 <build><item objectid="1"/></build>
</model>"#).unwrap();
        zip.finish().unwrap();
    }
    buf.into_inner()
}

#[test]
fn generated_3mf_yields_triangles() {
    let parts = parse_3mf_parts(&tiny_3mf(), Some("tiny")).expect("parse");
    let triangles: usize = parts.iter().map(|p| p.indices.len()).sum();
    assert!(
        !parts.is_empty() && triangles > 0,
        "parts={} triangles={}",
        parts.len(),
        triangles
    );
}

#[test]
fn optional_local_3mf_dir_yields_triangles() {
    let Ok(dir) = std::env::var("FARMPRINT_TEST_3MF_DIR") else {
        eprintln!("FARMPRINT_TEST_3MF_DIR not set; skipping");
        return;
    };
    for entry in std::fs::read_dir(dir).expect("read dir").flatten() {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("3mf") {
            continue;
        }
        let bytes = std::fs::read(&path).unwrap();
        let name = path.display().to_string();
        let parts = parse_3mf_parts(&bytes, Some(&name)).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(
            parts.iter().map(|p| p.indices.len()).sum::<usize>() > 0,
            "{name}: no triangles"
        );
    }
}
