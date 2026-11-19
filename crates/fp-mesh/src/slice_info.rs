//! Real filament weight / print time from a Bambu Studio (or OrcaSlicer) sliced `.3mf`.
//!
//! Sliced archives carry `Metadata/slice_info.config`:
//! ```xml
//! <config><plate>
//!   <metadata key="index" value="1"/>
//!   <metadata key="prediction" value="2712"/>   <!-- seconds -->
//!   <metadata key="weight" value="9.84"/>        <!-- grams -->
//!   <object identify_id="76" name="Test Part" skipped="false"/>
//! </plate></config>
//! ```
//! Unsliced archives have no such file, and then nothing is guessed: parts stay blank (0).

use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SlicedPlate {
    pub index: u32,
    pub prediction_seconds: f64,
    pub weight_grams: f64,
    pub object_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SlicedObjectEstimate {
    pub name: String,
    pub grams: f64,
    pub minutes: i64,
}

fn attr(tag: &str, key: &str) -> Option<String> {
    let mut rest = tag;
    while let Some(pos) = rest.find(key) {
        let before_ok = pos == 0 || rest.as_bytes()[pos - 1].is_ascii_whitespace();
        let after = rest[pos + key.len()..].trim_start();
        if before_ok && after.starts_with('=') {
            let v = after[1..].trim_start();
            let q = v.chars().next()?;
            if q == '"' || q == '\'' {
                let end = v[1..].find(q)?;
                return Some(xml_unescape(&v[1..1 + end]));
            }
        }
        rest = &rest[pos + key.len()..];
    }
    None
}

fn xml_unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Parse the text of `Metadata/slice_info.config`. Skipped objects are left out.
pub fn parse_slice_info_config(xml: &str) -> Vec<SlicedPlate> {
    let mut plates = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<plate") {
        let after = &rest[start + 6..];
        let end = after.find("</plate>").unwrap_or(after.len());
        let body = &after[..end];
        let mut plate = SlicedPlate {
            index: plates.len() as u32 + 1,
            prediction_seconds: 0.0,
            weight_grams: 0.0,
            object_names: Vec::new(),
        };
        let mut b = body;
        while let Some(lt) = b.find('<') {
            let tail = &b[lt + 1..];
            let gt = match tail.find('>') {
                Some(g) => g,
                None => break,
            };
            let tag = &tail[..gt];
            if tag.starts_with("metadata") {
                if let (Some(k), Some(v)) = (attr(tag, "key"), attr(tag, "value")) {
                    let num = v.trim().parse::<f64>().unwrap_or(0.0);
                    match k.as_str() {
                        "index" => plate.index = num as u32,
                        "prediction" => plate.prediction_seconds = num,
                        "weight" => plate.weight_grams = num,
                        _ => {}
                    }
                }
            } else if tag.starts_with("object") {
                let skipped = attr(tag, "skipped").map(|s| s == "true").unwrap_or(false);
                if let Some(n) = attr(tag, "name") {
                    if !skipped {
                        plate.object_names.push(n);
                    }
                }
            }
            b = &tail[gt + 1..];
        }
        plates.push(plate);
        rest = &after[end..];
    }
    plates
}

/// Read `Metadata/slice_info.config` from a `.3mf` archive. `None` when the file was never sliced.
pub fn read_slice_info_from_3mf(bytes: &[u8]) -> Option<Vec<SlicedPlate>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    let name = archive
        .file_names()
        .find(|n| {
            n.trim_start_matches('/')
                .eq_ignore_ascii_case("Metadata/slice_info.config")
        })?
        .to_string();
    // The settings file is a few KB; never unpack more than 64 MB of it (zip bombs).
    const MAX_SLICE_INFO_BYTES: u64 = 64 << 20;
    let f = archive.by_name(&name).ok()?;
    let mut xml = String::new();
    f.take(MAX_SLICE_INFO_BYTES + 1)
        .read_to_string(&mut xml)
        .ok()?;
    if xml.len() as u64 > MAX_SLICE_INFO_BYTES {
        return None;
    }
    let plates = parse_slice_info_config(&xml);
    if plates
        .iter()
        .any(|p| p.weight_grams > 0.0 || p.prediction_seconds > 0.0)
    {
        Some(plates)
    } else {
        None
    }
}

/// Per-object grams/minutes. A plate with one object maps exactly; a plate holding several
/// objects is split evenly (Bambu only reports plate totals).
pub fn per_object_estimates(plates: &[SlicedPlate]) -> Vec<SlicedObjectEstimate> {
    let mut out = Vec::new();
    for p in plates {
        let n = p.object_names.len();
        if n == 0 {
            continue;
        }
        for name in &p.object_names {
            let grams = p.weight_grams / n as f64;
            out.push(SlicedObjectEstimate {
                name: name.clone(),
                grams: (grams * 100.0).round() / 100.0,
                minutes: (p.prediction_seconds / 60.0 / n as f64).round() as i64,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header><header_item key="X-BBL-Client-Type" value="slicer"/></header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="2712"/>
    <metadata key="weight" value="9.84"/>
    <object identify_id="76" name="Test Part" skipped="false" />
    <filament id="1" type="PLA" color="#FF0000" used_m="3.30" used_g="9.84" />
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="prediction" value="3600"/>
    <metadata key="weight" value="20.00"/>
    <object identify_id="80" name="Body &amp; Lid" skipped="false" />
    <object identify_id="81" name="Hinge" skipped="false" />
    <object identify_id="82" name="Spare" skipped="true" />
  </plate>
</config>"##;

    #[test]
    fn parses_bambu_slice_info_plates() {
        let plates = parse_slice_info_config(FIXTURE);
        assert_eq!(plates.len(), 2);
        assert_eq!(plates[0].index, 1);
        assert_eq!(plates[0].prediction_seconds, 2712.0);
        assert_eq!(plates[0].weight_grams, 9.84);
        assert_eq!(plates[0].object_names, vec!["Test Part"]);
        assert_eq!(plates[1].object_names, vec!["Body & Lid", "Hinge"]);
    }

    #[test]
    fn per_object_split() {
        let est = per_object_estimates(&parse_slice_info_config(FIXTURE));
        assert_eq!(
            est[0],
            SlicedObjectEstimate {
                name: "Test Part".into(),
                grams: 9.84,
                minutes: 45
            }
        );
        assert_eq!(est[1].grams, 10.0);
        assert_eq!(est[2].minutes, 30);
        assert_eq!(est.len(), 3);
    }

    #[test]
    fn unsliced_text_yields_nothing() {
        assert!(parse_slice_info_config("<config></config>").is_empty());
    }
}
