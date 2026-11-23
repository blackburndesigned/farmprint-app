//! Plate view backend for Print!: loads the picked parts' models once per session, then
//! arranges, checks, orients and lists lay-on-face candidates with fp-mesh. The UI animates
//! and draws; every layout decision is made here so Print! and the plate view agree.

use crate::AppState;
use fp_mesh::plate::{
    self, ArrangeItem, ArrangeSettings, BedSize, FaceMode, Footprint, Placement, PlannedPart, Quat,
};
use fp_mesh::TriangleMesh;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// Models loaded for the plate view, by unit id. Cleared when a new set of parts opens.
fn cache() -> &'static Mutex<HashMap<String, Arc<TriangleMesh>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<TriangleMesh>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The bed used for layout: the printer's size, or the 220 mm square when it has none.
pub fn bed_for(state: &AppState, printer_id: Option<&str>) -> Result<(BedSize, bool), String> {
    let (x, y, z) = match printer_id.filter(|p| !p.is_empty()) {
        Some(pid) => {
            let ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            ledger.printer_build_volume_mm(pid).map_err(|e| e.to_string())?
        }
        None => (None, None, None),
    };
    let ok = |v: Option<f64>| v.filter(|n| n.is_finite() && *n > 0.0);
    Ok(match (ok(x), ok(y)) {
        (Some(w), Some(d)) => (BedSize { width_mm: w, depth_mm: d, height_mm: ok(z) }, true),
        _ => (BedSize { width_mm: 220.0, depth_mm: 220.0, height_mm: ok(z) }, false),
    })
}

/// The printer's remembered arrange settings (Settings → printer_plate), or the defaults.
pub fn settings_for(state: &AppState, printer_id: Option<&str>) -> ArrangeSettings {
    let Some(pid) = printer_id.filter(|p| !p.is_empty()) else {
        return ArrangeSettings::default();
    };
    crate::shop_settings_for_plate(state)
        .ok()
        .and_then(|s| s.printer_plate.get(pid).cloned())
        .and_then(|v| serde_json::from_value::<ArrangeSettings>(v).ok())
        .map(sanitize)
        .unwrap_or_default()
}

fn sanitize(mut s: ArrangeSettings) -> ArrangeSettings {
    let d = ArrangeSettings::default();
    let fix = |v: f64, dflt: f64, max: f64| if v.is_finite() && v >= 0.0 && v <= max { v } else { dflt };
    s.spacing_mm = fix(s.spacing_mm, d.spacing_mm, 100.0);
    s.clearance_radius_mm = fix(s.clearance_radius_mm, d.clearance_radius_mm, 500.0);
    s.clearance_height_mm = fix(s.clearance_height_mm, d.clearance_height_mm, 1000.0);
    s
}

/// Loads (and caches) the models for these units. Errors name the parts with no model.
pub fn load_meshes(
    state: &AppState,
    unit_ids: &[String],
) -> Result<(Vec<(fp_core::PartUnit, String)>, Vec<Arc<TriangleMesh>>), String> {
    let units = {
        let ledger = state.ledger.lock().map_err(|e| e.to_string())?;
        ledger.units_by_ids(unit_ids).map_err(|e| e.to_string())?
    };
    let mut have: Vec<Option<Arc<TriangleMesh>>> = {
        let c = cache().lock().map_err(|e| e.to_string())?;
        units.iter().map(|(u, _)| c.get(&u.id).cloned()).collect()
    };
    let missing: Vec<(fp_core::PartUnit, String)> = units
        .iter()
        .zip(&have)
        .filter(|(_, m)| m.is_none())
        .map(|(u, _)| u.clone())
        .collect();
    if !missing.is_empty() {
        let loaded = crate::load_unit_meshes(&state.tracker_root, &missing).map_err(|names| {
            format!("FarmPrint has no saved model for: {}.", names.join(", "))
        })?;
        let mut c = cache().lock().map_err(|e| e.to_string())?;
        // Units of the same part share one model in memory.
        let mut shared: HashMap<String, Arc<TriangleMesh>> = HashMap::new();
        for ((u, file), m) in missing.iter().zip(loaded) {
            let m = shared.entry(mesh_key(u, file)).or_insert_with(|| Arc::new(m)).clone();
            c.insert(u.id.clone(), m);
        }
        for (slot, (u, _)) in have.iter_mut().zip(&units) {
            if slot.is_none() {
                *slot = c.get(&u.id).cloned();
            }
        }
    }
    let meshes: Vec<Arc<TriangleMesh>> = have.into_iter().flatten().collect();
    if meshes.len() != units.len() {
        return Err("some parts have no saved model".to_string());
    }
    Ok((units, meshes))
}

fn mesh_key(u: &fp_core::PartUnit, file: &str) -> String {
    format!("{}:{}:{}", u.product_id, u.part_id, file)
}

fn mesh_for(unit_id: &str) -> Result<Arc<TriangleMesh>, String> {
    cache()
        .lock()
        .map_err(|e| e.to_string())?
        .get(unit_id)
        .cloned()
        .ok_or_else(|| "That part's model isn't loaded. Close the plate view and open it again.".to_string())
}

fn str_list(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

fn printer_arg(args: &Value) -> Option<String> {
    args.get("printer_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

fn settings_arg(state: &AppState, args: &Value, printer: Option<&str>) -> ArrangeSettings {
    args.get("settings")
        .and_then(|v| serde_json::from_value::<ArrangeSettings>(v.clone()).ok())
        .map(sanitize)
        .unwrap_or_else(|| settings_for(state, printer))
}

fn bed_json(bed: &BedSize, known: bool) -> Value {
    json!({ "width_mm": bed.width_mm, "depth_mm": bed.depth_mm, "height_mm": bed.height_mm, "known": known })
}

fn check_json(c: &plate::PlateCheck, ids: &[String]) -> Value {
    let id = |i: &usize| ids.get(*i).cloned().unwrap_or_default();
    let pairs = |v: &Vec<[usize; 2]>| v.iter().map(|p| json!([id(&p[0]), id(&p[1])])).collect::<Vec<_>>();
    json!({
        "plates": c.plates,
        "fits": c.fits(),
        "off_plate": c.off_plate.iter().map(id).collect::<Vec<_>>(),
        "collisions": pairs(&c.collisions),
        "clearance_overlaps": pairs(&c.clearance_overlaps),
        "too_tall": c.too_tall.iter().map(id).collect::<Vec<_>>(),
        "taller_than_gantry": c.taller_than_gantry.iter().map(id).collect::<Vec<_>>(),
        "order": c.order.iter().map(|o| o.iter().map(id).collect::<Vec<_>>()).collect::<Vec<_>>(),
        "plate1_fill": c.plate1_fill,
        "tallest_mm": c.tallest_mm,
    })
}

/// `plate_prepare {unit_ids, printer_id?}`: loads the models and returns everything the
/// plate view needs to draw: parts with colors, meshes (welded), the printer's bed and
/// remembered settings, and an automatic layout.
pub fn prepare(state: &AppState, args: &Value) -> Result<Value, String> {
    let unit_ids = str_list(args, "unit_ids");
    let printer = printer_arg(args);
    {
        // A new plate view session: forget models of parts that aren't in it.
        let mut c = cache().lock().map_err(|e| e.to_string())?;
        c.retain(|k, _| unit_ids.contains(k));
    }
    let (units, meshes) = load_meshes(state, &unit_ids)?;
    let (bed, known) = bed_for(state, printer.as_deref())?;
    let settings = settings_for(state, printer.as_deref());
    let refs: Vec<&TriangleMesh> = meshes.iter().map(|m| m.as_ref()).collect();
    let (planned, c) = plate::auto_layout(&refs, &[], &bed, &settings);
    let ids: Vec<String> = units.iter().map(|(u, _)| u.id.clone()).collect();
    let mut mesh_json: serde_json::Map<String, Value> = serde_json::Map::new();
    let mut parts = Vec::new();
    for (((u, file), m), pl) in units.iter().zip(&meshes).zip(&planned) {
        let key = mesh_key(u, file);
        if !mesh_json.contains_key(&key) {
            let (pos, tris) = fp_mesh::weld_mesh(m);
            mesh_json.insert(
                key.clone(),
                json!({
                    "positions": pos.iter().flat_map(|p| p.iter().map(|v| (*v as f64 * 1000.0).round() / 1000.0)).collect::<Vec<f64>>(),
                    "indices": tris.iter().flatten().copied().collect::<Vec<u32>>(),
                }),
            );
        }
        parts.push(json!({
            "unit_id": u.id,
            "mesh_key": key,
            "name": u.part_name,
            "product_name": u.product_name,
            "order_code": u.order_code,
            "customer_name": u.customer_name,
            "hex": u.filament_hex,
            "filament_name": u.filament_name,
            "orientation": pl.orientation,
            "footprint": pl.footprint,
            "placement": pl.placement,
        }));
    }
    Ok(json!({
        "parts": parts,
        "meshes": mesh_json,
        "bed": bed_json(&bed, known),
        "settings": settings,
        "check": check_json(&c, &ids),
    }))
}

#[derive(Debug, Deserialize)]
struct PartState {
    unit_id: String,
    #[serde(default = "identity")]
    orientation: Quat,
    #[serde(default)]
    placement: Option<Placement>,
    #[serde(default)]
    pinned: bool,
}

fn identity() -> Quat {
    plate::IDENTITY
}

fn part_states(args: &Value) -> Result<Vec<PartState>, String> {
    serde_json::from_value(args.get("parts").cloned().unwrap_or(Value::Array(vec![])))
        .map_err(|e| format!("bad plate parts: {e}"))
}

fn bed_arg(state: &AppState, args: &Value, printer: Option<&str>) -> Result<BedSize, String> {
    if let Some(b) = args.get("bed").and_then(|v| serde_json::from_value::<BedSize>(v.clone()).ok()) {
        if b.width_mm > 0.0 && b.depth_mm > 0.0 {
            return Ok(b);
        }
    }
    Ok(bed_for(state, printer)?.0)
}

/// `plate_arrange {parts:[{unit_id, orientation, placement?, pinned?}], printer_id?, bed?, settings?}`
/// → `{placements: {unit_id: Placement}, footprints, check}`. Pinned parts keep their spot.
pub fn arrange(state: &AppState, args: &Value) -> Result<Value, String> {
    let printer = printer_arg(args);
    let parts = part_states(args)?;
    let bed = bed_arg(state, args, printer.as_deref())?;
    let s = settings_arg(state, args, printer.as_deref());
    let mut feet: Vec<Footprint> = Vec::new();
    let mut items: Vec<ArrangeItem> = Vec::new();
    for p in &parts {
        let m = mesh_for(&p.unit_id)?;
        let f = plate::footprint(&m, p.orientation);
        let mut it = ArrangeItem::from_footprint(&f);
        it.rot_deg = p.placement.map(|q| q.rot_deg).unwrap_or(0.0);
        if p.pinned {
            it.pinned = p.placement;
        }
        items.push(it);
        feet.push(f);
    }
    let placements = plate::arrange(&items, &bed, &s);
    let c = plate::check(&items, &placements, &bed, &s);
    let ids: Vec<String> = parts.iter().map(|p| p.unit_id.clone()).collect();
    Ok(json!({
        "placements": ids.iter().cloned().zip(placements.iter().map(|p| json!(p))).collect::<serde_json::Map<_, _>>(),
        "footprints": ids.iter().cloned().zip(feet.iter().map(|f| json!(f))).collect::<serde_json::Map<_, _>>(),
        "check": check_json(&c, &ids),
    }))
}

/// `plate_check {parts, printer_id?, bed?, settings?}` → check for the given placements.
pub fn check(state: &AppState, args: &Value) -> Result<Value, String> {
    let printer = printer_arg(args);
    let parts = part_states(args)?;
    let bed = bed_arg(state, args, printer.as_deref())?;
    let s = settings_arg(state, args, printer.as_deref());
    let mut items = Vec::new();
    let mut placements = Vec::new();
    for p in &parts {
        let m = mesh_for(&p.unit_id)?;
        items.push(ArrangeItem::from_footprint(&plate::footprint(&m, p.orientation)));
        placements.push(p.placement.unwrap_or_default());
    }
    let ids: Vec<String> = parts.iter().map(|p| p.unit_id.clone()).collect();
    Ok(check_json(&plate::check(&items, &placements, &bed, &s), &ids))
}

/// `plate_auto_orient {unit_ids}` → `{unit_id: {orientation, footprint}}`.
pub fn auto_orient(_state: &AppState, args: &Value) -> Result<Value, String> {
    let mut out = serde_json::Map::new();
    for id in str_list(args, "unit_ids") {
        let m = mesh_for(&id)?;
        let q = plate::auto_orient(&m).map(|c| c.orientation).unwrap_or(plate::IDENTITY);
        out.insert(id, json!({ "orientation": q, "footprint": plate::footprint(&m, q) }));
    }
    Ok(Value::Object(out))
}

/// `plate_footprint {unit_id, orientation}` → footprint.
pub fn footprint(_state: &AppState, args: &Value) -> Result<Value, String> {
    let id = args.get("unit_id").and_then(|v| v.as_str()).unwrap_or_default();
    let q: Quat = args
        .get("orientation")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or(plate::IDENTITY);
    let m = mesh_for(id)?;
    Ok(json!(plate::footprint(&m, q)))
}

/// `plate_face_candidates {unit_id, mode: "convex_hull" | "triangle"}` → candidate faces
/// (triangles in the saved model's coordinates) with the orientation that puts each down.
pub fn face_candidates(_state: &AppState, args: &Value) -> Result<Value, String> {
    let id = args.get("unit_id").and_then(|v| v.as_str()).unwrap_or_default();
    let mode: FaceMode = args
        .get("mode")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let m = mesh_for(id)?;
    let (lo, hi) = m.bounds();
    let diag = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2) + (hi[2] - lo[2]).powi(2)).sqrt() as f64;
    // Ignore faces smaller than ~1% of the part's size squared, and at most 40 faces.
    let min_area = (diag * diag * 0.004).max(4.0);
    let list = plate::face_candidates(&m, mode, min_area, 40);
    Ok(json!(list
        .iter()
        .map(|c| json!({
            "normal": c.normal,
            "area": c.area,
            "stable": c.stable,
            "height": c.height,
            "orientation": c.orientation,
            "triangles": c.triangles.iter().flat_map(|t| t.iter().flat_map(|v| v.iter().copied())).collect::<Vec<f64>>(),
            "footprint": plate::footprint(&m, c.orientation),
        }))
        .collect::<Vec<_>>()))
}

/// `plate_fit_summary {unit_ids, printer_ids}` → one automatic-layout summary per printer,
/// for the printer picker: plates needed, fill, tallest part, and top-down outlines.
pub fn fit_summary(state: &AppState, args: &Value) -> Result<Value, String> {
    let unit_ids = str_list(args, "unit_ids");
    let printer_ids = str_list(args, "printer_ids");
    let (units, meshes) = load_meshes(state, &unit_ids)?;
    let refs: Vec<&TriangleMesh> = meshes.iter().map(|m| m.as_ref()).collect();
    let ids: Vec<String> = units.iter().map(|(u, _)| u.id.clone()).collect();
    let mut out = serde_json::Map::new();
    for pid in printer_ids {
        let (bed, known) = bed_for(state, Some(&pid))?;
        let s = settings_for(state, Some(&pid));
        let (planned, c) = plate::auto_layout(&refs, &[], &bed, &s);
        let outlines: Vec<Value> = planned
            .iter()
            .zip(&units)
            .map(|(p, (u, _))| {
                let item = ArrangeItem::from_footprint(&p.footprint);
                json!({
                    "unit_id": u.id,
                    "hex": u.filament_hex,
                    "plate": p.placement.plate,
                    "outline": plate::placed_outline(&item, &p.placement),
                })
            })
            .collect();
        out.insert(
            pid,
            json!({
                "bed": bed_json(&bed, known),
                "settings": s,
                "check": check_json(&c, &ids),
                "outlines": outlines,
            }),
        );
    }
    Ok(Value::Object(out))
}

/// A plate layout sent with Print! from the plate view.
#[derive(Debug, Deserialize)]
pub struct PrintLayout {
    pub parts: Vec<PrintLayoutPart>,
    #[serde(default)]
    pub order: Vec<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct PrintLayoutPart {
    pub unit_id: String,
    #[serde(default = "identity")]
    pub orientation: Quat,
    pub placement: Placement,
}

/// Groups units into plates with exact 3MF transforms. With `layout` (from the plate view)
/// its placements are used as they are (parts it leaves out stay out of the job's plates);
/// without, the parts are arranged automatically with the printer's settings. Returns, per
/// plate, `(index into units, transform)` in print order.
pub fn plan_plates(
    units: &[(fp_core::PartUnit, String)],
    meshes: &[TriangleMesh],
    layout: Option<&PrintLayout>,
    bed: &BedSize,
    s: &ArrangeSettings,
) -> Result<Vec<Vec<(usize, [f64; 12])>>, String> {
    match layout {
        Some(l) => {
            let mut by_plate: Vec<Vec<(usize, [f64; 12])>> = Vec::new();
            let mut placed_ids: Vec<String> = Vec::new();
            let mut entries: Vec<(usize, PlannedPart)> = Vec::new();
            for lp in &l.parts {
                let Some(i) = units.iter().position(|(u, _)| u.id == lp.unit_id) else { continue };
                let q = plate::quat_normalize(lp.orientation);
                entries.push((
                    i,
                    PlannedPart { orientation: q, footprint: plate::footprint(&meshes[i], q), placement: lp.placement },
                ));
                placed_ids.push(lp.unit_id.clone());
            }
            if entries.len() != units.len() {
                return Err("the plate layout doesn't include every part".to_string());
            }
            // Order: the plate view's print order when given, else as listed.
            let rank = |id: &str| -> usize {
                l.order
                    .iter()
                    .flat_map(|o| o.iter())
                    .position(|x| x == id)
                    .unwrap_or(usize::MAX)
            };
            entries.sort_by_key(|(i, p)| (p.placement.plate, rank(&units[*i].0.id)));
            for (i, p) in entries {
                let pl = p.placement.plate;
                if by_plate.len() <= pl {
                    by_plate.resize(pl + 1, Vec::new());
                }
                by_plate[pl].push((i, p.transform()));
            }
            Ok(by_plate.into_iter().filter(|g| !g.is_empty()).collect())
        }
        None => {
            let refs: Vec<&TriangleMesh> = meshes.iter().collect();
            let (planned, c) = plate::auto_layout(&refs, &[], bed, s);
            Ok(plate::plate_groups(&planned, &c)
                .into_iter()
                .map(|g| g.into_iter().map(|i| (i, planned[i].transform())).collect())
                .collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(id: &str) -> (fp_core::PartUnit, String) {
        let u: fp_core::PartUnit = serde_json::from_value(json!({
            "id": id, "order_id": "o", "order_code": "FP-1", "customer_name": "", "line_id": "l",
            "line_label": "", "product_id": "p", "product_name": "P", "part_id": "pt",
            "part_name": "Part", "unit_index": 1, "filament_id": "", "filament_name": "",
            "filament_hex": "#FF0000", "filament_material": "PLA", "state": "Queued",
            "printer_id": null, "printer_name": null, "plate_job_id": null,
            "reprint_count": 0, "unit_cost": 0.0, "print_minutes": 0, "grams": 0.0, "updated_at": ""
        }))
        .unwrap();
        (u, "part.stl".into())
    }

    fn cube(s: f32) -> TriangleMesh {
        let p = vec![
            [0.0, 0.0, 0.0], [s, 0.0, 0.0], [s, s, 0.0], [0.0, s, 0.0],
            [0.0, 0.0, s], [s, 0.0, s], [s, s, s], [0.0, s, s],
        ];
        let i = vec![
            [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
            [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
        ];
        TriangleMesh { name: "c".into(), positions: p, indices: i }
    }

    #[test]
    fn automatic_plan_overflows_onto_more_plates() {
        let units: Vec<_> = (0..5).map(|i| unit(&format!("u{i}"))).collect();
        let meshes: Vec<_> = (0..5).map(|_| cube(50.0)).collect();
        let bed = BedSize { width_mm: 110.0, depth_mm: 110.0, height_mm: None };
        let plates = plan_plates(&units, &meshes, None, &bed, &ArrangeSettings::default()).unwrap();
        assert_eq!(plates.len(), 2);
        assert_eq!(plates[0].len() + plates[1].len(), 5);
    }

    #[test]
    fn layout_from_the_plate_view_is_used_as_is() {
        let units: Vec<_> = (0..2).map(|i| unit(&format!("u{i}"))).collect();
        let meshes: Vec<_> = (0..2).map(|_| cube(20.0)).collect();
        let layout = PrintLayout {
            parts: vec![
                PrintLayoutPart { unit_id: "u1".into(), orientation: plate::IDENTITY, placement: Placement { plate: 1, x: 50.0, y: 60.0, rot_deg: 45.0 } },
                PrintLayoutPart { unit_id: "u0".into(), orientation: plate::IDENTITY, placement: Placement { plate: 0, x: 30.0, y: 40.0, rot_deg: 0.0 } },
            ],
            order: vec![],
        };
        let bed = BedSize { width_mm: 200.0, depth_mm: 200.0, height_mm: None };
        let plates = plan_plates(&units, &meshes, Some(&layout), &bed, &ArrangeSettings::default()).unwrap();
        assert_eq!(plates.len(), 2);
        assert_eq!(plates[0][0].0, 0);
        assert_eq!(plates[1][0].0, 1);
        let t = plates[0][0].1;
        assert!((t[9] - 20.0).abs() < 1e-9 && (t[10] - 30.0).abs() < 1e-9 && t[11].abs() < 1e-9, "{t:?}");
        // Missing parts are refused.
        let partial = PrintLayout { parts: vec![], order: vec![] };
        assert!(plan_plates(&units, &meshes, Some(&partial), &bed, &ArrangeSettings::default()).is_err());
    }
}
