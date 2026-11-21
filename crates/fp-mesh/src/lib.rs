use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read, Write};
use std::path::Path;

pub mod slice_info;
pub use slice_info::{
    parse_slice_info_config, per_object_estimates, read_slice_info_from_3mf, SlicedObjectEstimate,
    SlicedPlate,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriangleMesh {
    pub name: String,
    pub positions: Vec<[f32; 3]>,
    pub indices: Vec<[u32; 3]>,
}

#[derive(Debug, Clone)]
pub struct PlateBuildItem {
    pub name: String,
    pub filament_hex: String,
    pub mesh: TriangleMesh,
}

impl TriangleMesh {
    pub fn bounds(&self) -> ([f32; 3], [f32; 3]) {
        if self.positions.is_empty() {
            return ([-10.0, -10.0, 0.0], [10.0, 10.0, 10.0]);
        }
        let mut min = [f32::MAX; 3];
        let mut max = [f32::MIN; 3];
        for p in &self.positions {
            for i in 0..3 {
                if p[i] < min[i] {
                    min[i] = p[i];
                }
                if p[i] > max[i] {
                    max[i] = p[i];
                }
            }
        }
        (min, max)
    }

    pub fn dimensions_mm(&self) -> [f32; 3] {
        let (min, max) = self.bounds();
        [
            (max[0] - min[0]).max(1.0),
            (max[1] - min[1]).max(1.0),
            (max[2] - min[2]).max(1.0),
        ]
    }
}

pub fn load_stl_file(path: &Path, default_name: &str) -> Result<TriangleMesh, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    parse_stl_bytes(&bytes, default_name)
}

pub fn parse_stl_bytes(bytes: &[u8], default_name: &str) -> Result<TriangleMesh, String> {
    let mesh = parse_stl_bytes_unchecked(bytes, default_name)?;
    ensure_finite(std::slice::from_ref(&mesh), default_name)?;
    Ok(mesh)
}

/// NaN/Inf corners make bounds meaningless and would be written as "NaN" into the slicer's
/// plate XML, so a model with any is rejected outright.
fn ensure_finite(meshes: &[TriangleMesh], label: &str) -> Result<(), String> {
    for m in meshes {
        if m.positions.iter().any(|p| !p.iter().all(|c| c.is_finite())) {
            return Err(format!(
                "\"{label}\" has corners with invalid coordinates (NaN or infinity). Re-export the model and try again."
            ));
        }
    }
    Ok(())
}

fn parse_stl_bytes_unchecked(bytes: &[u8], default_name: &str) -> Result<TriangleMesh, String> {
    if bytes.len() >= 84 {
        let tri_count = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
        let expected_len = 84usize.saturating_add(tri_count.saturating_mul(50));
        if tri_count > 0 && expected_len <= bytes.len() && expected_len + 512 >= bytes.len() {
            let mut positions = Vec::with_capacity(tri_count * 3);
            let mut indices = Vec::with_capacity(tri_count);
            for t in 0..tri_count {
                let base = 84 + t * 50;
                let mut tri_idx = [0u32; 3];
                for (v, slot) in tri_idx.iter_mut().enumerate() {
                    let off = base + 12 + v * 12;
                    let x = f32::from_le_bytes([
                        bytes[off],
                        bytes[off + 1],
                        bytes[off + 2],
                        bytes[off + 3],
                    ]);
                    let y = f32::from_le_bytes([
                        bytes[off + 4],
                        bytes[off + 5],
                        bytes[off + 6],
                        bytes[off + 7],
                    ]);
                    let z = f32::from_le_bytes([
                        bytes[off + 8],
                        bytes[off + 9],
                        bytes[off + 10],
                        bytes[off + 11],
                    ]);
                    *slot = positions.len() as u32;
                    positions.push([x, y, z]);
                }
                indices.push(tri_idx);
            }
            return Ok(TriangleMesh {
                name: default_name.to_string(),
                positions,
                indices,
            });
        }
    }

    // Fallback ASCII STL parser
    let text = String::from_utf8_lossy(bytes);
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    let mut current_verts: Vec<u32> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("vertex") {
            let nums: Vec<f32> = rest
                .split_whitespace()
                .filter_map(|s| s.parse::<f32>().ok())
                .collect();
            if nums.len() >= 3 {
                let idx = positions.len() as u32;
                positions.push([nums[0], nums[1], nums[2]]);
                current_verts.push(idx);
                if current_verts.len() == 3 {
                    indices.push([current_verts[0], current_verts[1], current_verts[2]]);
                    current_verts.clear();
                }
            }
        }
    }
    if !indices.is_empty() {
        return Ok(TriangleMesh {
            name: default_name.to_string(),
            positions,
            indices,
        });
    }
    // Never substitute a stand-in shape: a broken model must surface as an error, or Print!
    // could hand the slicer a placeholder box.
    Err(format!(
        "No triangles found in \"{default_name}\". The STL file is empty, truncated, or not an STL."
    ))
}

/// Most a 3MF may unpack to across its model, relationship and settings files (1 GiB).
/// Real print models are a tiny fraction of this.
pub const MAX_3MF_UNPACKED_BYTES: u64 = 1 << 30;

fn too_large_3mf_message(max_unpacked: u64) -> String {
    format!(
        "This 3MF file is too large to import (it unpacks to more than {} MB).",
        max_unpacked / (1024 * 1024)
    )
}

pub fn load_3mf_parts(path: &Path) -> Result<Vec<TriangleMesh>, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    parse_3mf_parts(&bytes, path.file_stem().and_then(|s| s.to_str()))
}

pub fn parse_3mf_parts(bytes: &[u8], hint: Option<&str>) -> Result<Vec<TriangleMesh>, String> {
    let meshes = parse_3mf_parts_unchecked(bytes, hint, MAX_3MF_UNPACKED_BYTES)?;
    ensure_finite(&meshes, hint.unwrap_or("Part"))?;
    Ok(meshes)
}

fn parse_3mf_parts_unchecked(
    bytes: &[u8],
    hint: Option<&str>,
    max_unpacked: u64,
) -> Result<Vec<TriangleMesh>, String> {
    let raw_hint = hint.unwrap_or("Part");
    let default_name = Path::new(raw_hint)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(raw_hint)
        .trim();
    let default_name = if default_name.is_empty() {
        "Part"
    } else {
        default_name
    };

    if let Ok(mut archive) = zip::ZipArchive::new(Cursor::new(bytes)) {
        let mut entries: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        // A 3MF is a zip, so a tiny file can unpack to gigabytes. Count the bytes actually
        // unpacked (the sizes a zip claims can be faked) and stop past the limit.
        let mut budget = max_unpacked;
        for i in 0..archive.len() {
            if let Ok(file) = archive.by_index(i) {
                let name = normalize_zip_path(file.name());
                if name.ends_with(".model") || name.ends_with(".rels") || name.ends_with(".config")
                {
                    let mut content = String::new();
                    let read = file.take(budget + 1).read_to_string(&mut content);
                    if content.len() as u64 > budget {
                        return Err(too_large_3mf_message(max_unpacked));
                    }
                    budget -= content.len() as u64;
                    if read.is_ok() {
                        entries.insert(name, content);
                    }
                }
            }
        }

        // 1. Parse Metadata/model_settings.config (Bambu Studio / OrcaSlicer / PrusaSlicer part names)
        let (config_obj_names, config_part_names) = entries
            .get("Metadata/model_settings.config")
            .map(|xml| parse_model_settings_config(xml))
            .unwrap_or_default();

        // 2. Determine root .model path from _rels/.rels or fallback to 3D/3dmodel.model
        let root_model_path = entries
            .get("_rels/.rels")
            .and_then(|rels| parse_rels_root_model(rels))
            .filter(|p| entries.contains_key(p))
            .or_else(|| {
                if entries.contains_key("3D/3dmodel.model") {
                    Some("3D/3dmodel.model".to_string())
                } else {
                    entries.keys().find(|k| k.ends_with(".model")).cloned()
                }
            });

        if let Some(root_path) = root_model_path {
            let mut models: std::collections::HashMap<String, ParsedThreeMFModel> =
                std::collections::HashMap::new();
            for (path, xml) in &entries {
                if path.ends_with(".model") {
                    models.insert(path.clone(), parse_single_3mf_model(xml));
                }
            }

            if let Some(root_model) = models.get(&root_path) {
                let mut out_meshes: Vec<TriangleMesh> = Vec::new();
                let build_items = if root_model.build_items.is_empty() {
                    let mut ids: Vec<String> = root_model.objects.keys().cloned().collect();
                    ids.sort_by_key(|k| k.parse::<u32>().unwrap_or(u32::MAX));
                    ids.into_iter()
                        .map(|object_id| ThreeMFBuildItem {
                            object_id,
                            transform: identity_matrix4(),
                        })
                        .collect::<Vec<_>>()
                } else {
                    root_model.build_items.clone()
                };

                for item in build_items {
                    let Some(root_obj) = root_model.objects.get(&item.object_id) else {
                        continue;
                    };
                    let parent_cfg_name = config_obj_names.get(&item.object_id).cloned();
                    let parent_name = root_obj.name.clone().or(parent_cfg_name).filter(|s| {
                        !s.trim().is_empty() && !s.to_ascii_lowercase().ends_with(".3mf")
                    });

                    if !root_obj.components.is_empty() {
                        let multi_comp = root_obj.components.len() > 1;
                        for (comp_idx, comp) in root_obj.components.iter().enumerate() {
                            let target_model_path = comp
                                .path
                                .as_deref()
                                .map(normalize_zip_path)
                                .unwrap_or_else(|| root_path.clone());
                            let Some(target_model) = models.get(&target_model_path) else {
                                continue;
                            };
                            let Some(child_obj) = target_model.objects.get(&comp.object_id) else {
                                continue;
                            };
                            if child_obj.positions.is_empty() || child_obj.indices.is_empty() {
                                continue;
                            }
                            let world = mul_matrix4(item.transform, comp.transform);
                            let transformed_positions = child_obj
                                .positions
                                .iter()
                                .map(|&p| transform_point(world, p))
                                .collect::<Vec<_>>();

                            // Resolve human-readable part name:
                            // 1) model_settings.config <object id=parent><part id=child> name
                            // 2) child <object name="...">
                            // 3) model_settings.config <object id=child> name
                            // 4) parent name (if single component) or Part N
                            let cfg_part_name = config_part_names
                                .get(&(item.object_id.clone(), comp.object_id.clone()))
                                .or_else(|| {
                                    config_part_names.get(&(String::new(), comp.object_id.clone()))
                                })
                                .or_else(|| config_obj_names.get(&comp.object_id))
                                .cloned();
                            let child_name = child_obj.name.clone().filter(|s| {
                                !s.trim().is_empty() && !s.to_ascii_lowercase().ends_with(".3mf")
                            });

                            let resolved_name = cfg_part_name
                                .or(child_name)
                                .or_else(|| {
                                    if !multi_comp {
                                        parent_name.clone()
                                    } else {
                                        parent_name
                                            .as_ref()
                                            .map(|pn| format!("{} {}", pn, comp_idx + 1))
                                    }
                                })
                                .unwrap_or_else(|| format!("Part {}", out_meshes.len() + 1));

                            out_meshes.push(TriangleMesh {
                                name: clean_part_display_name(&resolved_name, out_meshes.len() + 1),
                                positions: transformed_positions,
                                indices: child_obj.indices.clone(),
                            });
                        }
                    } else if !root_obj.positions.is_empty() && !root_obj.indices.is_empty() {
                        let transformed_positions = root_obj
                            .positions
                            .iter()
                            .map(|&p| transform_point(item.transform, p))
                            .collect::<Vec<_>>();
                        let cfg_part_name = config_part_names
                            .get(&(item.object_id.clone(), item.object_id.clone()))
                            .or_else(|| config_part_first(&config_part_names, &item.object_id))
                            .cloned();
                        let resolved_name = parent_name
                            .or(cfg_part_name)
                            .unwrap_or_else(|| format!("Part {}", out_meshes.len() + 1));
                        out_meshes.push(TriangleMesh {
                            name: clean_part_display_name(&resolved_name, out_meshes.len() + 1),
                            positions: transformed_positions,
                            indices: root_obj.indices.clone(),
                        });
                    }
                }

                // Fallback if build items didn't reference nested model objects directly
                if out_meshes.is_empty() {
                    let mut model_paths: Vec<String> = models.keys().cloned().collect();
                    model_paths.sort();
                    for mp in model_paths {
                        let Some(m) = models.get(&mp) else { continue };
                        let mut obj_ids: Vec<String> = m.objects.keys().cloned().collect();
                        obj_ids.sort_by_key(|k| k.parse::<u32>().unwrap_or(u32::MAX));
                        for oid in obj_ids {
                            let Some(obj) = m.objects.get(&oid) else {
                                continue;
                            };
                            if obj.positions.is_empty() || obj.indices.is_empty() {
                                continue;
                            }
                            let name = obj
                                .name
                                .clone()
                                .or_else(|| {
                                    config_part_names
                                        .get(&(String::new(), oid.clone()))
                                        .cloned()
                                })
                                .or_else(|| config_obj_names.get(&oid).cloned())
                                .unwrap_or_else(|| format!("Part {}", out_meshes.len() + 1));
                            out_meshes.push(TriangleMesh {
                                name: clean_part_display_name(&name, out_meshes.len() + 1),
                                positions: obj.positions.clone(),
                                indices: obj.indices.clone(),
                            });
                        }
                    }
                }

                if !out_meshes.is_empty() {
                    return Ok(out_meshes);
                }
            }
        }
    }

    // Raw XML fallback
    let raw_xml = String::from_utf8_lossy(bytes);
    if raw_xml.contains("<mesh") {
        let model = parse_single_3mf_model(&raw_xml);
        let mut out = Vec::new();
        let mut obj_ids: Vec<String> = model.objects.keys().cloned().collect();
        obj_ids.sort_by_key(|k| k.parse::<u32>().unwrap_or(u32::MAX));
        for oid in obj_ids {
            if let Some(obj) = model.objects.get(&oid) {
                if !obj.positions.is_empty() && !obj.indices.is_empty() {
                    let raw_name = obj
                        .name
                        .clone()
                        .unwrap_or_else(|| format!("Part {}", out.len() + 1));
                    out.push(TriangleMesh {
                        name: clean_part_display_name(&raw_name, out.len() + 1),
                        positions: obj.positions.clone(),
                        indices: obj.indices.clone(),
                    });
                }
            }
        }
        if !out.is_empty() {
            return Ok(out);
        }
    }

    Err(format!(
        "No triangles found in \"{default_name}\". The 3MF file is empty, damaged, or has no model."
    ))
}

fn config_part_first<'a>(
    map: &'a std::collections::HashMap<(String, String), String>,
    obj_id: &str,
) -> Option<&'a String> {
    map.iter()
        .find(|((oid, _), _)| oid == obj_id)
        .map(|(_, v)| v)
}

/// Names come from XML attributes, so "Top &amp; Bottom" must read "Top & Bottom".
fn unescape_xml(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_string();
    }
    raw.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn clean_part_display_name(raw: &str, idx: usize) -> String {
    let unescaped = unescape_xml(raw);
    let trimmed = unescaped
        .trim()
        .trim_end_matches(".3mf")
        .trim_end_matches(".3MF")
        .trim_end_matches(".stl")
        .trim_end_matches(".STL")
        .replace('_', " ")
        .trim()
        .to_string();
    if trimmed.is_empty() {
        format!("Part {}", idx)
    } else {
        trimmed
    }
}

fn normalize_zip_path(p: &str) -> String {
    p.trim_start_matches('/').replace('\\', "/")
}

#[derive(Debug, Clone)]
struct ThreeMFComponent {
    object_id: String,
    path: Option<String>,
    transform: [[f32; 4]; 4],
}

#[derive(Debug, Clone)]
struct ThreeMFObject {
    name: Option<String>,
    positions: Vec<[f32; 3]>,
    indices: Vec<[u32; 3]>,
    components: Vec<ThreeMFComponent>,
}

#[derive(Debug, Clone)]
struct ThreeMFBuildItem {
    object_id: String,
    transform: [[f32; 4]; 4],
}

#[derive(Debug, Clone, Default)]
struct ParsedThreeMFModel {
    objects: std::collections::HashMap<String, ThreeMFObject>,
    build_items: Vec<ThreeMFBuildItem>,
}

fn identity_matrix4() -> [[f32; 4]; 4] {
    [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

/// 3MF transform is 12 whitespace-separated floats:
/// `m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32`
fn parse_3mf_transform(raw: Option<&str>) -> [[f32; 4]; 4] {
    let Some(s) = raw else {
        return identity_matrix4();
    };
    let v: Vec<f32> = s
        .split_whitespace()
        .filter_map(|t| t.parse::<f32>().ok())
        .collect();
    if v.len() != 12 {
        return identity_matrix4();
    }
    [
        [v[0], v[1], v[2], 0.0],
        [v[3], v[4], v[5], 0.0],
        [v[6], v[7], v[8], 0.0],
        [v[9], v[10], v[11], 1.0],
    ]
}

fn mul_matrix4(a: [[f32; 4]; 4], b: [[f32; 4]; 4]) -> [[f32; 4]; 4] {
    // Column-major style matching ThreeMFLoader.swift:
    // transform_point(m, p) uses rows 0..2 for linear and row 3 for translation:
    // p' = p.x * m[0] + p.y * m[1] + p.z * m[2] + m[3]
    // Wait: if p' = apply(a, apply(b, p)), then in row-vector convention:
    // apply(m, p) = p * M_row => apply(a, apply(b, p)) = p * B_row * A_row
    let mut out = [[0.0f32; 4]; 4];
    for r in 0..4 {
        for c in 0..4 {
            out[r][c] =
                b[r][0] * a[0][c] + b[r][1] * a[1][c] + b[r][2] * a[2][c] + b[r][3] * a[3][c];
        }
    }
    out
}

fn transform_point(m: [[f32; 4]; 4], p: [f32; 3]) -> [f32; 3] {
    [
        p[0] * m[0][0] + p[1] * m[1][0] + p[2] * m[2][0] + m[3][0],
        p[0] * m[0][1] + p[1] * m[1][1] + p[2] * m[2][1] + m[3][1],
        p[0] * m[0][2] + p[1] * m[1][2] + p[2] * m[2][2] + m[3][2],
    ]
}

fn parse_rels_root_model(xml: &str) -> Option<String> {
    for chunk in xml.split("<Relationship").skip(1) {
        let tag = chunk.split('>').next().unwrap_or("");
        let rel_type = extract_attr(tag, "Type").unwrap_or("");
        if rel_type.contains("3dmodel") {
            if let Some(target) = extract_attr(tag, "Target") {
                return Some(normalize_zip_path(target));
            }
        }
    }
    None
}

fn parse_model_settings_config(
    xml: &str,
) -> (
    std::collections::HashMap<String, String>,
    std::collections::HashMap<(String, String), String>,
) {
    let mut obj_names = std::collections::HashMap::new();
    let mut part_names = std::collections::HashMap::new();

    for obj_chunk in xml.split("<object").skip(1) {
        let Some(tag_end) = obj_chunk.find('>') else {
            continue;
        };
        let obj_attrs = &obj_chunk[..tag_end];
        let obj_id = extract_attr(obj_attrs, "id").unwrap_or("").to_string();
        let obj_body = obj_chunk[tag_end + 1..]
            .split("</object>")
            .next()
            .unwrap_or("");

        // Object-level metadata before first <part
        let before_parts = obj_body.split("<part").next().unwrap_or(obj_body);
        for line in before_parts.split("<metadata").skip(1) {
            let mtag = line.split('>').next().unwrap_or("");
            if extract_attr(mtag, "key") == Some("name") {
                if let Some(val) = extract_attr(mtag, "value") {
                    if !val.trim().is_empty() && !obj_id.is_empty() {
                        obj_names.insert(obj_id.clone(), val.trim().to_string());
                    }
                }
            }
        }

        for part_chunk in obj_body.split("<part").skip(1) {
            let Some(ptag_end) = part_chunk.find('>') else {
                continue;
            };
            let part_attrs = &part_chunk[..ptag_end];
            let part_id = extract_attr(part_attrs, "id").unwrap_or("").to_string();
            let part_body = part_chunk[ptag_end + 1..]
                .split("</part>")
                .next()
                .unwrap_or("");
            for line in part_body.split("<metadata").skip(1) {
                let mtag = line.split('>').next().unwrap_or("");
                if extract_attr(mtag, "key") == Some("name") {
                    if let Some(val) = extract_attr(mtag, "value") {
                        let clean = val.trim().to_string();
                        if !clean.is_empty() && !part_id.is_empty() {
                            if !obj_id.is_empty() {
                                part_names.insert((obj_id.clone(), part_id.clone()), clean.clone());
                            }
                            part_names.insert((String::new(), part_id.clone()), clean);
                        }
                    }
                }
            }
        }
    }

    (obj_names, part_names)
}

fn parse_single_3mf_model(xml: &str) -> ParsedThreeMFModel {
    let mut model = ParsedThreeMFModel::default();

    for obj_chunk in xml.split("<object").skip(1) {
        let Some(tag_end) = obj_chunk.find('>') else {
            continue;
        };
        let attrs = &obj_chunk[..tag_end];
        let Some(id) = extract_attr(attrs, "id").map(|s| s.to_string()) else {
            continue;
        };
        let name = extract_attr(attrs, "name")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let body = obj_chunk[tag_end + 1..]
            .split("</object>")
            .next()
            .unwrap_or("");

        let mut positions = Vec::new();
        let mut indices = Vec::new();
        if let Some(mesh_start) = body.find("<mesh") {
            let mesh_body = body[mesh_start..].split("</mesh>").next().unwrap_or("");
            for v_chunk in mesh_body.split("<vertex").skip(1) {
                let vtag = v_chunk.split('>').next().unwrap_or("");
                let x = extract_attr(vtag, "x")
                    .and_then(|s| s.parse::<f32>().ok())
                    .unwrap_or(0.0);
                let y = extract_attr(vtag, "y")
                    .and_then(|s| s.parse::<f32>().ok())
                    .unwrap_or(0.0);
                let z = extract_attr(vtag, "z")
                    .and_then(|s| s.parse::<f32>().ok())
                    .unwrap_or(0.0);
                positions.push([x, y, z]);
            }
            let v_count = positions.len() as u32;
            for t_chunk in mesh_body.split("<triangle").skip(1) {
                // "<triangles>" also matches the split; only real <triangle .../> tags count, and
                // a triangle missing any corner index is skipped rather than pointed at corner 0.
                if !t_chunk.starts_with(|c: char| c.is_whitespace() || c == '/') {
                    continue;
                }
                let ttag = t_chunk.split('>').next().unwrap_or("");
                let corner =
                    |k: &str| extract_attr(ttag, k).and_then(|s| s.trim().parse::<u32>().ok());
                let (Some(v1), Some(v2), Some(v3)) = (corner("v1"), corner("v2"), corner("v3"))
                else {
                    continue;
                };
                if v1 < v_count && v2 < v_count && v3 < v_count {
                    indices.push([v1, v2, v3]);
                }
            }
        }

        let mut components = Vec::new();
        if let Some(comp_start) = body.find("<components") {
            let comp_body = body[comp_start..]
                .split("</components>")
                .next()
                .unwrap_or("");
            for c_chunk in comp_body.split("<component").skip(1) {
                let ctag = c_chunk.split('>').next().unwrap_or("");
                let Some(object_id) = extract_attr(ctag, "objectid").map(|s| s.to_string()) else {
                    continue;
                };
                let path = extract_attr(ctag, "p:path")
                    .or_else(|| extract_attr(ctag, "path"))
                    .map(|s| s.to_string());
                let transform = parse_3mf_transform(extract_attr(ctag, "transform"));
                components.push(ThreeMFComponent {
                    object_id,
                    path,
                    transform,
                });
            }
        }

        model.objects.insert(
            id.clone(),
            ThreeMFObject {
                name,
                positions,
                indices,
                components,
            },
        );
    }

    if let Some(build_start) = xml.find("<build") {
        let build_body = xml[build_start..].split("</build>").next().unwrap_or("");
        for item_chunk in build_body.split("<item").skip(1) {
            let itag = item_chunk.split('>').next().unwrap_or("");
            if let Some(object_id) = extract_attr(itag, "objectid").map(|s| s.to_string()) {
                let transform = parse_3mf_transform(extract_attr(itag, "transform"));
                model.build_items.push(ThreeMFBuildItem {
                    object_id,
                    transform,
                });
            }
        }
    }

    model
}

fn extract_attr<'a>(tag: &'a str, key: &str) -> Option<&'a str> {
    for quote in ['"', '\''] {
        let pattern = format!("{}={}", key, quote);
        // Only a whole attribute name counts: `id` must not match inside `pid` or `objectid`.
        for (pos, _) in tag.match_indices(&pattern) {
            let starts_attr = tag[..pos]
                .chars()
                .next_back()
                .is_none_or(|c| c.is_whitespace());
            if !starts_attr {
                continue;
            }
            let start = pos + pattern.len();
            let rest = &tag[start..];
            if let Some(end) = rest.find(quote) {
                return Some(&rest[..end]);
            }
        }
    }
    None
}

/// Merge corners that sit at the same spot (to 1 micron) and drop triangles that collapse.
/// Welded vertex positions and triangles, as returned by `weld_mesh`.
type WeldedMesh = (Vec<[f32; 3]>, Vec<[u32; 3]>);

pub fn weld_mesh(mesh: &TriangleMesh) -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
    use std::collections::HashMap;
    let mut map: HashMap<(i64, i64, i64), u32> = HashMap::new();
    let mut pos: Vec<[f32; 3]> = Vec::new();
    let mut remap: Vec<u32> = Vec::with_capacity(mesh.positions.len());
    for v in &mesh.positions {
        let key = (
            (v[0] as f64 * 1000.0).round() as i64,
            (v[1] as f64 * 1000.0).round() as i64,
            (v[2] as f64 * 1000.0).round() as i64,
        );
        let id = *map.entry(key).or_insert_with(|| {
            pos.push(*v);
            (pos.len() - 1) as u32
        });
        remap.push(id);
    }
    let mut tris = Vec::with_capacity(mesh.indices.len());
    for t in &mesh.indices {
        let get = |i: u32| remap.get(i as usize).copied();
        if let (Some(a), Some(b), Some(c)) = (get(t[0]), get(t[1]), get(t[2])) {
            if a != b && b != c && a != c {
                tris.push([a, b, c]);
            }
        }
    }
    (pos, tris)
}

/// Usable bed area for plate layout, in mm. Comes from the printer's settings, never a
/// built-in printer model.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlateBed {
    pub width_mm: f32,
    pub depth_mm: f32,
}

impl Default for PlateBed {
    /// Only used when the printer has no bed size set: the historic 220 mm row width, and no
    /// depth check.
    fn default() -> Self {
        PlateBed {
            width_mm: 220.0,
            depth_mm: f32::INFINITY,
        }
    }
}

/// A filament loaded on the chosen printer (AMS, MMU or tool head). `slot` is the number
/// FarmPrint shows ("Slot 3"), 1-based, and becomes the filament number in the slicer.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlateSlot {
    pub slot: u32,
    pub filament_id: String,
    pub filament_hex: String,
    pub material: String,
}

/// Which filament swatch a plate item is printed in. `PlateOptions::item_filaments[i]`
/// belongs to `items[i]`; an empty id means "match by color only".
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlateItemFilament {
    pub filament_id: String,
    pub material: String,
}

/// Everything about the target printer the plate writer can use. `Default` is "nothing
/// known": the 220 mm default bed, no loaded slots, colors matched by hex only.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlateOptions {
    pub bed: PlateBed,
    /// The chosen printer's loaded slots. Empty when no printer was picked or it has none.
    pub loaded_slots: Vec<PlateSlot>,
    /// Swatch identity per item, index-aligned with the items. Missing entries match by hex.
    pub item_filaments: Vec<PlateItemFilament>,
}

impl From<PlateBed> for PlateOptions {
    fn from(bed: PlateBed) -> Self {
        PlateOptions {
            bed,
            ..Default::default()
        }
    }
}

impl From<Option<PlateBed>> for PlateOptions {
    fn from(bed: Option<PlateBed>) -> Self {
        bed.map(PlateOptions::from).unwrap_or_default()
    }
}

/// One filament the plate uses, as the slicer will number it.
#[derive(Debug, Clone, PartialEq)]
pub struct PlateFilament {
    /// 1-based filament / extruder number in the slicer.
    pub number: u32,
    /// `#RRGGBB`, upper case.
    pub hex: String,
    /// "PLA" when unknown.
    pub material: String,
    /// True when it came from a loaded printer slot (then `number` is that slot).
    pub from_slot: bool,
}

/// `#RRGGBB` upper case, or None when `hex` isn't a 6-digit color (`#RGB`, `RRGGBBAA` and a
/// missing `#` are accepted).
pub fn normalize_hex(hex: &str) -> Option<String> {
    let clean = hex.trim().trim_start_matches('#');
    let six: String = match clean.len() {
        3 => clean.chars().flat_map(|c| [c, c]).collect(),
        6 | 8 => clean[..6].to_string(),
        _ => return None,
    };
    if six.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(format!("#{}", six.to_ascii_uppercase()))
    } else {
        None
    }
}

/// Neutral grey for a plate item with no usable color.
const UNKNOWN_FILAMENT_HEX: &str = "#808080";

/// Gives every distinct filament on the plate a slicer filament number.
///
/// - A filament is one color: normalized hex plus material. Items from different swatch rows
///   with the same color share one filament number; the swatch id only helps find its slot.
/// - When the chosen printer has it loaded, it takes that slot's number, so FarmPrint's slot 3
///   is filament 3 in the slicer and the AMS lines up without remapping. A slot matches when it
///   holds the same swatch id, or the same hex and material. When several slots match (the
///   same color loaded twice, e.g. a backup spool), the lowest-numbered one wins.
/// - Filaments that aren't loaded take the lowest numbers no loaded slot uses, in the order
///   they first appear, so they never land on a spool holding another color.
/// - With no slot info that is simply 1, 2, 3 in first-seen order.
///
/// Returns the number for each item (index-aligned) and the filaments sorted by number.
pub fn assign_plate_filaments(
    items: &[PlateBuildItem],
    opts: &PlateOptions,
) -> (Vec<u32>, Vec<PlateFilament>) {
    let mat_eq = |a: &str, b: &str| {
        let (a, b) = (a.trim(), b.trim());
        a.is_empty() || b.is_empty() || a.eq_ignore_ascii_case(b)
    };
    let mut slots: Vec<&PlateSlot> = opts.loaded_slots.iter().filter(|s| s.slot > 0).collect();
    slots.sort_by_key(|s| s.slot);
    let used_slots: std::collections::BTreeSet<u32> = slots.iter().map(|s| s.slot).collect();

    // Distinct filaments in first-seen order. One color (hex + material) is one filament, even
    // when it comes from different swatch rows, so it never takes two filament numbers.
    // `keys` holds each group's (hex, material as the item gave it, possibly empty).
    let mut keys: Vec<(String, String)> = Vec::new();
    let mut filaments: Vec<PlateFilament> = Vec::new();
    let mut per_item_group: Vec<usize> = Vec::with_capacity(items.len());
    for (idx, item) in items.iter().enumerate() {
        let fil = opts.item_filaments.get(idx);
        let id = fil.map(|f| f.filament_id.trim()).unwrap_or("");
        let material = fil.map(|f| f.material.trim()).unwrap_or("");
        let hex = normalize_hex(&item.filament_hex);
        let group_hex = hex.as_deref().unwrap_or(UNKNOWN_FILAMENT_HEX);
        // Every slot holding this swatch or this color counts; the lowest-numbered one wins, so
        // a color loaded in two slots (a backup spool for auto-refill) prints from the first.
        let slot = slots
            .iter()
            .find(|s| {
                let same_id = !id.is_empty() && s.filament_id.trim() == id;
                let same_color = hex.as_deref().is_some_and(|h| {
                    normalize_hex(&s.filament_hex).as_deref() == Some(h)
                        && mat_eq(&s.material, material)
                });
                same_id || same_color
            })
            .copied();
        // An item that doesn't say its material takes the matched slot's, so it joins that
        // color's group instead of whichever same-hex group came first.
        let known_material = if !material.is_empty() {
            material.to_string()
        } else {
            slot.map(|s| s.material.trim().to_string())
                .unwrap_or_default()
        };
        if let Some(g) = keys
            .iter()
            .position(|(h, m)| h == group_hex && mat_eq(m, &known_material))
        {
            per_item_group.push(g);
            continue;
        }
        keys.push((group_hex.to_string(), known_material.clone()));
        let material = if known_material.is_empty() {
            "PLA".to_string()
        } else {
            known_material
        };
        per_item_group.push(filaments.len());
        filaments.push(PlateFilament {
            number: slot.map(|s| s.slot).unwrap_or(0),
            hex: hex.unwrap_or_else(|| UNKNOWN_FILAMENT_HEX.to_string()),
            material,
            from_slot: slot.is_some(),
        });
    }
    // Unloaded filaments: the lowest numbers that no loaded slot (on this plate or not) uses.
    let mut next = 1u32;
    for f in filaments.iter_mut().filter(|f| !f.from_slot) {
        while used_slots.contains(&next) {
            next += 1;
        }
        f.number = next;
        next += 1;
    }
    let numbers = per_item_group
        .iter()
        .map(|&g| filaments[g].number)
        .collect();
    let mut sorted = filaments;
    sorted.sort_by_key(|f| f.number);
    // Two different swatches can sit in one slot only by color match; keep one entry each.
    sorted.dedup_by_key(|f| f.number);
    (numbers, sorted)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn write_3mf_plate(items: &[PlateBuildItem]) -> Result<Vec<u8>, String> {
    write_3mf_plate_with(items, &PlateOptions::default())
}

/// Like `write_3mf_plate`, laying parts out in rows that fit `bed.width_mm`. Errors when the
/// parts don't fit in `bed.depth_mm` instead of placing some off the bed.
pub fn write_3mf_plate_on_bed(items: &[PlateBuildItem], bed: PlateBed) -> Result<Vec<u8>, String> {
    write_3mf_plate_with(items, &PlateOptions::from(bed))
}

/// Writes the plate for `opts.bed`, giving each object the filament number from
/// `assign_plate_filaments` so a mixed-color plate opens on the right filaments:
/// - `Metadata/model_settings.config` (Bambu Studio, OrcaSlicer): object and part `extruder`.
/// - `Metadata/Slic3r_PE_model.config` (PrusaSlicer): object `extruder` plus one volume.
///
/// No print/printer/filament settings files (`project_settings.config`, `Slic3r_PE.config`)
/// are written: all three slicers treat such a file as a whole project and fill every
/// setting it lacks with built-in defaults, replacing the user's printer and print profiles.
///
/// The model carries no core-spec colors (`<basematerials>`, `pid`/`pindex`) either: Bambu
/// Studio (2.9) treats a colored 3MF from another app as a color import, erases every
/// object's `extruder`, and maps the colors onto its own filament list instead, so the
/// numbers above are lost. Colors on screen come from the user's filament presets.
pub fn write_3mf_plate_with(
    items: &[PlateBuildItem],
    opts: &PlateOptions,
) -> Result<Vec<u8>, String> {
    let bed = opts.bed;
    // Written this way so a NaN size is rejected too.
    if bed.width_mm.is_nan() || bed.depth_mm.is_nan() || bed.width_mm <= 0.0 || bed.depth_mm <= 0.0
    {
        return Err("The printer's bed size must be greater than zero.".to_string());
    }
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let options =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        zip.start_file("[Content_Types].xml", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>"#,
        )
        .map_err(|e| e.to_string())?;

        zip.start_file("_rels/.rels", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"#,
        )
        .map_err(|e| e.to_string())?;

        let mut model_xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
"#,
        );
        let (item_numbers, _) = assign_plate_filaments(items, opts);
        // STL stores every triangle with its own three corners. 3MF needs shared corners, or the
        // slicer sees every edge as open. Weld identical corners, then drop collapsed triangles.
        let welded: Vec<WeldedMesh> = items.iter().map(|it| weld_mesh(&it.mesh)).collect();
        // Lay parts out on a grid by their real size, each sitting on the bed at z = 0.
        let mut placements: Vec<(f32, f32, f32)> = Vec::new();
        {
            let gap = 6.0f32;
            let (mut cx, mut cy, mut row_h) = (0.0f32, 0.0f32, 0.0f32);
            let row_limit = bed.width_mm;
            for (pos, _) in &welded {
                let (mut mn, mut mx) = ([f32::MAX; 3], [f32::MIN; 3]);
                for v in pos {
                    for k in 0..3 {
                        mn[k] = mn[k].min(v[k]);
                        mx[k] = mx[k].max(v[k]);
                    }
                }
                if pos.is_empty() {
                    mn = [0.0; 3];
                    mx = [0.0; 3];
                }
                let (w, d) = (mx[0] - mn[0], mx[1] - mn[1]);
                // A known bed (finite depth) can't take a part wider than it. The default
                // bed is "size unknown", so it never rejects a part.
                if bed.depth_mm.is_finite() && w > bed.width_mm {
                    return Err(format!(
                        "A part is about {:.0} mm wide, but the printer's bed is {:.0} mm wide.",
                        w, bed.width_mm
                    ));
                }
                if cx > 0.0 && cx + w > row_limit {
                    cx = 0.0;
                    cy += row_h + gap;
                    row_h = 0.0;
                }
                placements.push((cx - mn[0], cy - mn[1], -mn[2]));
                cx += w + gap;
                row_h = row_h.max(d);
            }
            let used_depth = cy + row_h;
            if used_depth > bed.depth_mm {
                return Err(format!(
                    "These parts need about {:.0} mm of bed depth, but the printer's bed is {:.0} mm. Print fewer parts at once.",
                    used_depth, bed.depth_mm
                ));
            }
        }
        for (idx, item) in items.iter().enumerate() {
            let obj_id = idx + 1;
            let name = xml_escape(&item.name);
            model_xml.push_str(&format!(
                "    <object id=\"{}\" name=\"{}\" type=\"model\">\n      <mesh>
        <vertices>
",
                obj_id, name
            ));
            for v in &welded[idx].0 {
                model_xml.push_str(&format!(
                    "          <vertex x=\"{:.4}\" y=\"{:.4}\" z=\"{:.4}\"/>\n",
                    v[0], v[1], v[2]
                ));
            }
            model_xml.push_str(
                "        </vertices>
        <triangles>
",
            );
            for t in &welded[idx].1 {
                model_xml.push_str(&format!(
                    "          <triangle v1=\"{}\" v2=\"{}\" v3=\"{}\"/>\n",
                    t[0], t[1], t[2]
                ));
            }
            model_xml.push_str(
                "        </triangles>
      </mesh>
    </object>
",
            );
        }
        model_xml.push_str(
            "  </resources>
  <build>
",
        );
        for (idx, _) in items.iter().enumerate() {
            let obj_id = idx + 1;
            let (tx, ty, tz) = placements[idx];
            model_xml.push_str(&format!(
                "    <item objectid=\"{}\" transform=\"1 0 0 0 1 0 0 0 1 {:.4} {:.4} {:.4}\"/>\n",
                obj_id, tx, ty, tz
            ));
        }
        model_xml.push_str(
            "  </build>
</model>
",
        );

        zip.start_file("3D/3dmodel.model", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(model_xml.as_bytes())
            .map_err(|e| e.to_string())?;
        // Bambu Studio / OrcaSlicer read this to keep each part its own object (named, on plate 1)
        // instead of offering to merge them into one multi-part object.
        // `extruder` is the 1-based filament number from assign_plate_filaments.
        let mut cfg = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<config>\n");
        for (idx, item) in items.iter().enumerate() {
            let name = xml_escape(&item.name);
            cfg.push_str(&format!(
                "  <object id=\"{id}\">\n    <metadata key=\"name\" value=\"{name}\"/>\n    <metadata key=\"extruder\" value=\"{ext}\"/>\n    <part id=\"{id}\" subtype=\"normal_part\">\n      <metadata key=\"name\" value=\"{name}\"/>\n      <metadata key=\"extruder\" value=\"{ext}\"/>\n    </part>\n  </object>\n",
                id = idx + 1, name = name, ext = item_numbers[idx]
            ));
        }
        cfg.push_str("  <plate>\n    <metadata key=\"plater_id\" value=\"1\"/>\n");
        for idx in 0..items.len() {
            cfg.push_str(&format!("    <model_instance>\n      <metadata key=\"object_id\" value=\"{}\"/>\n      <metadata key=\"instance_id\" value=\"0\"/>\n    </model_instance>\n", idx + 1));
        }
        cfg.push_str("  </plate>\n</config>\n");
        zip.start_file("Metadata/model_settings.config", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(cfg.as_bytes()).map_err(|e| e.to_string())?;
        // PrusaSlicer's per-object settings. Once an object is listed here PrusaSlicer builds
        // it only from the listed volumes, so each gets one volume spanning all its triangles
        // (an object with no triangles is left out and loads as plain geometry).
        let mut pe = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<config>\n");
        for (idx, item) in items.iter().enumerate() {
            let tris = welded[idx].1.len();
            if tris == 0 {
                continue;
            }
            let name = xml_escape(&item.name);
            pe.push_str(&format!(
                " <object id=\"{id}\" instances_count=\"1\">\n  <metadata type=\"object\" key=\"name\" value=\"{name}\"/>\n  <metadata type=\"object\" key=\"extruder\" value=\"{ext}\"/>\n  <volume firstid=\"0\" lastid=\"{last}\">\n   <metadata type=\"volume\" key=\"name\" value=\"{name}\"/>\n   <metadata type=\"volume\" key=\"volume_type\" value=\"ModelPart\"/>\n  </volume>\n </object>\n",
                id = idx + 1,
                name = name,
                ext = item_numbers[idx],
                last = tris - 1
            ));
        }
        pe.push_str("</config>\n");
        zip.start_file("Metadata/Slic3r_PE_model.config", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(pe.as_bytes()).map_err(|e| e.to_string())?;
        zip.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf.into_inner())
}

fn parse_hex_rgb(hex: &str) -> [u8; 3] {
    let clean = hex.trim().trim_start_matches('#');
    if clean.len() >= 6 {
        let r = u8::from_str_radix(&clean[0..2], 16).unwrap_or(255);
        let g = u8::from_str_radix(&clean[2..4], 16).unwrap_or(141);
        let b = u8::from_str_radix(&clean[4..6], 16).unwrap_or(40);
        [r, g, b]
    } else {
        [255, 141, 40]
    }
}

fn encode_rgba_png_data_url(width: u32, height: u32, rgba: &[u8]) -> Result<String, String> {
    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(format!(
        "data:image/png;base64,{}",
        BASE64.encode(&png_bytes)
    ))
}

pub fn tint_part_png_data_url(png_bytes: &[u8], hex: &str) -> Result<String, String> {
    let decoder = png::Decoder::new(Cursor::new(png_bytes));
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let bytes = &buf[..info.buffer_size()];
    let [tr, tg, tb] = parse_hex_rgb(hex);

    let width = info.width;
    let height = info.height;
    let mut out = vec![0u8; (width * height * 4) as usize];

    match info.color_type {
        png::ColorType::Rgba => {
            for (i, px) in bytes.as_chunks::<4>().0.iter().enumerate() {
                let lum =
                    (0.2126 * (px[0] as f32) + 0.7152 * (px[1] as f32) + 0.0722 * (px[2] as f32))
                        / 255.0;
                let shade = (lum * 1.15).clamp(0.0, 1.0);
                let highlight = if lum > 0.75 { (lum - 0.75) * 0.65 } else { 0.0 };
                out[i * 4] = (((tr as f32) * shade + 255.0 * highlight).clamp(0.0, 255.0)) as u8;
                out[i * 4 + 1] =
                    (((tg as f32) * shade + 255.0 * highlight).clamp(0.0, 255.0)) as u8;
                out[i * 4 + 2] =
                    (((tb as f32) * shade + 255.0 * highlight).clamp(0.0, 255.0)) as u8;
                out[i * 4 + 3] = px[3];
            }
        }
        _ => {
            return Ok(format!(
                "data:image/png;base64,{}",
                BASE64.encode(png_bytes)
            ));
        }
    }

    encode_rgba_png_data_url(width, height, &out)
}

#[cfg(test)]
mod weld_tests {
    use super::*;
    #[test]
    fn welded_cube_has_no_open_edges() {
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
        let (p, t) = weld_mesh(&TriangleMesh {
            name: "c".into(),
            positions,
            indices,
        });
        assert_eq!(p.len(), 8);
        let mut edges = std::collections::HashMap::new();
        for tr in &t {
            for k in 0..3 {
                let (a, b) = (tr[k].min(tr[(k + 1) % 3]), tr[k].max(tr[(k + 1) % 3]));
                *edges.entry((a, b)).or_insert(0) += 1;
            }
        }
        assert!(edges.values().all(|&n| n == 2));
    }

    #[test]
    fn oversized_3mf_is_refused_before_unpacking_it_all() {
        let mesh = TriangleMesh {
            name: "p".into(),
            positions: vec![
                [0.0, 0.0, 0.0],
                [10.0, 0.0, 0.0],
                [0.0, 10.0, 0.0],
                [0.0, 0.0, 10.0],
            ],
            indices: vec![[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
        };
        let bytes = write_3mf_plate(&[PlateBuildItem {
            name: "p".into(),
            filament_hex: "#ffffff".into(),
            mesh,
        }])
        .unwrap();
        assert!(parse_3mf_parts(&bytes, Some("p")).is_ok());
        let err = parse_3mf_parts_unchecked(&bytes, Some("p"), 64).unwrap_err();
        assert!(err.contains("too large"), "{err}");
    }
}
