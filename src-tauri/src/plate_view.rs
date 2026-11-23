//! Plate view backend for Print!: loads the picked parts' models once per session, then
//! arranges, checks, orients and lists lay-on-face candidates with fp-mesh. The UI animates
//! and draws; every layout decision is made here so Print! and the plate view agree.

use crate::AppState;
use fp_mesh::plate::{
    self, ArrangeItem, ArrangeSettings, BedSize, FaceMode, Footprint, Placement, PlannedPart,
    PrintAreaSpec, Quat, Reach,
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
    let s = crate::shop_settings_for_plate(state)
        .ok()
        .and_then(|s| s.printer_plate.get(pid).cloned())
        .and_then(|v| serde_json::from_value::<ArrangeSettings>(v).ok())
        .map(sanitize)
        .unwrap_or_default();
    match state.ledger.lock() {
        Ok(ledger) => with_printer_clearance(&ledger, pid, s),
        Err(_) => s,
    }
}

/// The arrange settings with the printer's extruder clearance (its four printer fields;
/// empty ones fall back to the plate defaults). `printer_plate` only remembers spacing,
/// auto-rotate, align to Y and sequence; clearance there is read only as an old fallback.
pub fn with_printer_clearance(ledger: &fp_core::ShopLedger, printer_id: &str, mut s: ArrangeSettings) -> ArrangeSettings {
    if let Ok(Some(c)) = ledger.printer_effective_clearance(printer_id) {
        s.clearance_radius_mm = c.radius;
        s.clearance_height_mm = c.height_to_rod;
        s.clearance_dist_to_rod_mm = c.dist_to_rod;
        s.clearance_height_to_lid_mm = c.height_to_lid;
    }
    sanitize(s)
}

fn sanitize(mut s: ArrangeSettings) -> ArrangeSettings {
    let d = ArrangeSettings::default();
    let fix = |v: f64, dflt: f64, max: f64| if v.is_finite() && v >= 0.0 && v <= max { v } else { dflt };
    s.spacing_mm = fix(s.spacing_mm, d.spacing_mm, 100.0);
    s.clearance_radius_mm = fix(s.clearance_radius_mm, d.clearance_radius_mm, 500.0);
    s.clearance_height_mm = fix(s.clearance_height_mm, d.clearance_height_mm, 1000.0);
    s.clearance_dist_to_rod_mm = s.clearance_dist_to_rod_mm.filter(|v| v.is_finite() && *v >= 0.0 && *v <= 2000.0);
    s.clearance_height_to_lid_mm = s.clearance_height_to_lid_mm.filter(|v| v.is_finite() && *v > 0.0 && *v <= 2000.0);
    s
}

/// A printer's print areas as fp-mesh reads them (empty for a printer without areas).
pub fn area_specs(areas: &[fp_core::PrintArea]) -> Vec<PrintAreaSpec> {
    areas
        .iter()
        .filter(|a| a.width_mm > 0.0 && a.depth_mm > 0.0)
        .map(|a| PrintAreaSpec {
            name: a.name.clone(),
            x_mm: a.x_mm,
            y_mm: a.y_mm,
            width_mm: a.width_mm,
            depth_mm: a.depth_mm,
            height_mm: Some(a.height_mm).filter(|h| h.is_finite() && *h > 0.0),
            nozzle: Some(a.nozzle.as_str().to_string()),
        })
        .collect()
}

/// The printer slot each unit's filament gets in the slicer (the same slot match the plate
/// file uses), as a list for `fp_core::print_areas`: empty when the filament isn't loaded
/// (which counts as an unknown nozzle).
pub fn unit_slots(units: &[(fp_core::PartUnit, String)], slots: &[fp_core::models::PrinterSlot]) -> Vec<Vec<i64>> {
    let opts = crate::plate_options_for(units, None, slots);
    let items: Vec<fp_mesh::PlateBuildItem> = units
        .iter()
        .map(|(u, _)| fp_mesh::PlateBuildItem {
            name: String::new(),
            filament_hex: u.filament_hex.clone(),
            mesh: TriangleMesh { name: String::new(), positions: Vec::new(), indices: Vec::new() },
        })
        .collect();
    let (numbers, filaments) = fp_mesh::assign_plate_filaments(&items, &opts);
    numbers
        .iter()
        .map(|&n| {
            if filaments.iter().any(|f| f.number == n && f.from_slot) {
                vec![n as i64]
            } else {
                Vec::new()
            }
        })
        .collect()
}

/// A printer holding only what `fp_core::print_areas` reads (feeders and areas).
fn reach_printer(feeders: Vec<fp_core::models::PrinterFeeder>, areas: Vec<fp_core::PrintArea>) -> fp_core::Printer {
    fp_core::Printer {
        id: String::new(),
        name: String::new(),
        model: String::new(),
        nozzle_mm: 0.4,
        status: String::new(),
        loaded_slots: Vec::new(),
        active_units: Vec::new(),
        staged_units: Vec::new(),
        remaining_minutes: 0,
        utilization_pct: 0.0,
        bed_x_mm: None,
        bed_y_mm: None,
        bed_z_mm: None,
        feeders,
        print_areas: areas,
        extruder_clearance: Default::default(),
    }
}

fn reach_of(a: &fp_core::PrintArea) -> Reach {
    let spec = &area_specs(std::slice::from_ref(a))[..];
    match spec.first() {
        Some(sp) => Reach { rect: sp.rect(), height_mm: sp.height_mm, label: a.name.trim().to_string(), unreachable: false },
        None => Reach { rect: [a.x_mm, a.y_mm, a.x_mm, a.y_mm], height_mm: None, label: a.name.trim().to_string(), unreachable: false },
    }
}

/// fp-core's answer as fp-mesh reads it: the whole bed (None), an area, or a part no
/// area fits (never the whole bed).
fn reach_of_part(a: fp_core::print_areas::PartArea) -> Option<Reach> {
    if a.is_unreachable() {
        return Some(Reach::unreachable());
    }
    a.area().map(reach_of)
}

/// Where each part must sit, decided by `fp_core::print_areas`: all its slots on
/// left-nozzle feeders -> the left area, all right -> the right area, a mix or a slot with
/// no nozzle -> the "both" area; None = the whole bed. Also the nozzle label for the UI.
pub struct ReachContext {
    pub areas: Vec<PrintAreaSpec>,
    /// "left" | "right" | "both", None when unknown (index-aligned with the units).
    pub nozzles: Vec<Option<String>>,
    /// The automatic reach per unit.
    pub autos: Vec<Option<Reach>>,
    /// The area both nozzles reach (the printer's "both" area), if it has one.
    pub shared: Option<Reach>,
}

pub fn reach_context_for(
    printer: &fp_core::Printer,
    units: &[(fp_core::PartUnit, String)],
    slots: &[fp_core::models::PrinterSlot],
) -> ReachContext {
    use fp_core::print_areas::{nozzle_need_for_slots, print_area_for_slots, shared_area, NozzleNeed};
    let areas = area_specs(&printer.print_areas);
    if areas.is_empty() {
        return ReachContext { areas, nozzles: vec![None; units.len()], autos: vec![None; units.len()], shared: None };
    }
    let per = unit_slots(units, slots);
    let nozzles = per
        .iter()
        .map(|s| match nozzle_need_for_slots(printer, s) {
            NozzleNeed::Left => Some("left".to_string()),
            NozzleNeed::Right => Some("right".to_string()),
            NozzleNeed::Both => Some("both".to_string()),
            NozzleNeed::Unknown => None,
        })
        .collect();
    let autos = per.iter().map(|s| reach_of_part(print_area_for_slots(printer, s))).collect();
    // The "both" area, or the computed left/right overlap when there is none.
    let shared = shared_area(printer).as_ref().map(reach_of);
    ReachContext { areas, nozzles, autos, shared }
}

/// A printer's print areas and where each unit may sit (index-aligned with `units`).
pub fn reach_context(
    ledger: &fp_core::ShopLedger,
    printer_id: Option<&str>,
    units: &[(fp_core::PartUnit, String)],
) -> Result<ReachContext, String> {
    let none = || ReachContext { areas: Vec::new(), nozzles: vec![None; units.len()], autos: vec![None; units.len()], shared: None };
    let Some(pid) = printer_id.filter(|p| !p.is_empty()) else {
        return Ok(none());
    };
    let areas = ledger.printer_print_areas(pid).map_err(|e| e.to_string())?;
    if areas.is_empty() {
        return Ok(none());
    }
    let slots = ledger.printer_loaded_slots(pid).map_err(|e| e.to_string())?;
    let feeders = ledger.printer_feeders(pid).map_err(|e| e.to_string())?;
    Ok(reach_context_for(&reach_printer(feeders, areas), units, &slots))
}

/// Where each unit may sit: the picked area (`overrides`, by unit id: an area name, or
/// "both"/"shared" for the area both nozzles reach; "auto" or missing = automatic), or
/// None on a printer without areas.
pub fn reaches_for(
    ctx: &ReachContext,
    units: &[(fp_core::PartUnit, String)],
    overrides: &HashMap<String, String>,
) -> Vec<Option<Reach>> {
    units
        .iter()
        .enumerate()
        .map(|(i, (u, _))| {
            let auto = ctx.autos.get(i).cloned().flatten();
            let pick = overrides.get(&u.id).map(|s| s.trim()).filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("auto"));
            match pick {
                Some(p) if p.eq_ignore_ascii_case("shared") || p.eq_ignore_ascii_case("both") => ctx.shared.clone().or(auto),
                Some(name) => plate::reach_for_area_name(&ctx.areas, name).or(auto),
                None => auto,
            }
        })
        .collect()
}

fn areas_json(ctx: &ReachContext) -> Value {
    json!({
        "list": ctx.areas.iter().map(|a| json!({
            "name": a.name,
            "rect": a.rect(),
            "height_mm": a.height_mm,
            "nozzle": a.nozzle_side(),
        })).collect::<Vec<_>>(),
        "shared": ctx.shared,
    })
}

fn printer_reach(
    state: &AppState,
    printer: Option<&str>,
    units: &[(fp_core::PartUnit, String)],
) -> Result<ReachContext, String> {
    let ledger = state.ledger.lock().map_err(|e| e.to_string())?;
    reach_context(&ledger, printer, units)
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
        "out_of_area": c.out_of_area.iter().map(id).collect::<Vec<_>>(),
        "unreachable": c.unreachable.iter().map(id).collect::<Vec<_>>(),
        "taller_than_gantry": c.taller_than_gantry.iter().map(id).collect::<Vec<_>>(),
        "rod_conflicts": pairs(&c.rod_conflicts),
        "over_lid": c.over_lid.iter().map(id).collect::<Vec<_>>(),
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
    let ctx = printer_reach(state, printer.as_deref(), &units)?;
    let reaches = reaches_for(&ctx, &units, &HashMap::new());
    let refs: Vec<&TriangleMesh> = meshes.iter().map(|m| m.as_ref()).collect();
    let (planned, c) = plate::auto_layout_with_reach(&refs, &[], &reaches, &bed, &settings);
    let ids: Vec<String> = units.iter().map(|(u, _)| u.id.clone()).collect();
    let mut mesh_json: serde_json::Map<String, Value> = serde_json::Map::new();
    let mut parts = Vec::new();
    for (i, (((u, file), m), pl)) in units.iter().zip(&meshes).zip(&planned).enumerate() {
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
            "nozzle": ctx.nozzles.get(i).cloned().flatten(),
            "auto_reach": reaches.get(i).cloned().flatten(),
        }));
    }
    Ok(json!({
        "parts": parts,
        "meshes": mesh_json,
        "bed": bed_json(&bed, known),
        "areas": areas_json(&ctx),
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
    /// Where it may sit (the plate view sends the area it uses: auto or picked).
    #[serde(default)]
    reach: Option<Reach>,
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
        it.reach = p.reach.clone();
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
        items.push(ArrangeItem {
            reach: p.reach.clone(),
            ..ArrangeItem::from_footprint(&plate::footprint(&m, p.orientation))
        });
        placements.push(p.placement.unwrap_or_default());
    }
    let ids: Vec<String> = parts.iter().map(|p| p.unit_id.clone()).collect();
    Ok(check_json(&plate::check(&items, &placements, &bed, &s), &ids))
}

/// `plate_printer {unit_ids, printer_id?}` → the printer's bed, settings, print areas and
/// each part's nozzle and automatic reach, for switching printers inside the plate view.
pub fn printer(state: &AppState, args: &Value) -> Result<Value, String> {
    let unit_ids = str_list(args, "unit_ids");
    let printer = printer_arg(args);
    let units = {
        let ledger = state.ledger.lock().map_err(|e| e.to_string())?;
        ledger.units_by_ids(&unit_ids).map_err(|e| e.to_string())?
    };
    let (bed, known) = bed_for(state, printer.as_deref())?;
    let ctx = printer_reach(state, printer.as_deref(), &units)?;
    let reaches = reaches_for(&ctx, &units, &HashMap::new());
    let parts: serde_json::Map<String, Value> = units
        .iter()
        .enumerate()
        .map(|(i, (u, _))| (u.id.clone(), json!({ "nozzle": ctx.nozzles[i], "auto_reach": reaches[i] })))
        .collect();
    Ok(json!({
        "bed": bed_json(&bed, known),
        "settings": settings_for(state, printer.as_deref()),
        "areas": areas_json(&ctx),
        "parts": parts,
    }))
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
        let ctx = printer_reach(state, Some(&pid), &units)?;
        let reaches = reaches_for(&ctx, &units, &HashMap::new());
        let (planned, c) = plate::auto_layout_with_reach(&refs, &[], &reaches, &bed, &s);
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
                "areas": areas_json(&ctx),
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
    /// The print area picked for it in the plate view; None or "auto" = by its nozzle.
    #[serde(default)]
    pub area: Option<String>,
}

impl PrintLayout {
    /// Picked areas by unit id.
    pub fn area_overrides(&self) -> HashMap<String, String> {
        self.parts
            .iter()
            .filter_map(|p| p.area.clone().map(|a| (p.unit_id.clone(), a)))
            .collect()
    }
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
    reaches: &[Option<Reach>],
) -> Result<Vec<Vec<(usize, [f64; 12])>>, String> {
    // A part no nozzle area fits can't print on this printer, wherever it is put.
    let unreachable: Vec<&str> = reaches
        .iter()
        .enumerate()
        .filter(|(_, r)| r.as_ref().is_some_and(|r| r.unreachable))
        .filter_map(|(i, _)| units.get(i).map(|u| u.0.part_name.as_str()))
        .collect();
    if !unreachable.is_empty() {
        return Err(unreachable_error(&unreachable));
    }
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
            // A part where its nozzle can't reach would print in the air: refuse it.
            if reaches.iter().any(|r| r.is_some()) {
                for (i, p) in &entries {
                    let Some(r) = reaches.get(*i).cloned().flatten() else { continue };
                    let item = ArrangeItem { reach: Some(r.clone()), ..ArrangeItem::from_footprint(&p.footprint) };
                    let c = plate::check(std::slice::from_ref(&item), std::slice::from_ref(&p.placement), bed, s);
                    if !c.out_of_area.is_empty() {
                        return Err(format!("{} is where the {} can't reach", units[*i].0.part_name, r.label.to_lowercase()));
                    }
                    if !c.too_tall.is_empty() {
                        return Err(format!("{} is taller than the {} can print", units[*i].0.part_name, r.label.to_lowercase()));
                    }
                }
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
            let (planned, c) = plate::auto_layout_with_reach(&refs, &[], reaches, bed, s);
            Ok(plate::plate_groups(&planned, &c)
                .into_iter()
                .map(|g| g.into_iter().map(|i| (i, planned[i].transform())).collect())
                .collect())
        }
    }
}

/// The send error for parts no nozzle area fits.
pub fn unreachable_error(names: &[&str]) -> String {
    let what = if names.len() == 1 { "this part".to_string() } else { "these parts".to_string() };
    format!("{}: {}", names.join(", "), plate::UNREACHABLE_MESSAGE.replace("this part", &what))
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
        let plates = plan_plates(&units, &meshes, None, &bed, &ArrangeSettings::default(), &[]).unwrap();
        assert_eq!(plates.len(), 2);
        assert_eq!(plates[0].len() + plates[1].len(), 5);
    }

    #[test]
    fn layout_from_the_plate_view_is_used_as_is() {
        let units: Vec<_> = (0..2).map(|i| unit(&format!("u{i}"))).collect();
        let meshes: Vec<_> = (0..2).map(|_| cube(20.0)).collect();
        let layout = PrintLayout {
            parts: vec![
                PrintLayoutPart { unit_id: "u1".into(), orientation: plate::IDENTITY, placement: Placement { plate: 1, x: 50.0, y: 60.0, rot_deg: 45.0 }, area: None },
                PrintLayoutPart { unit_id: "u0".into(), orientation: plate::IDENTITY, placement: Placement { plate: 0, x: 30.0, y: 40.0, rot_deg: 0.0 }, area: None },
            ],
            order: vec![],
        };
        let bed = BedSize { width_mm: 200.0, depth_mm: 200.0, height_mm: None };
        let plates = plan_plates(&units, &meshes, Some(&layout), &bed, &ArrangeSettings::default(), &[]).unwrap();
        assert_eq!(plates.len(), 2);
        assert_eq!(plates[0][0].0, 0);
        assert_eq!(plates[1][0].0, 1);
        let t = plates[0][0].1;
        assert!((t[9] - 20.0).abs() < 1e-9 && (t[10] - 30.0).abs() < 1e-9 && t[11].abs() < 1e-9, "{t:?}");
        // Missing parts are refused.
        let partial = PrintLayout { parts: vec![], order: vec![] };
        assert!(plan_plates(&units, &meshes, Some(&partial), &bed, &ArrangeSettings::default(), &[]).is_err());
    }

    fn unit_fil(id: &str, fil: &str, hex: &str) -> (fp_core::PartUnit, String) {
        let (mut u, f) = unit(id);
        u.filament_id = fil.into();
        u.filament_hex = hex.into();
        (u, f)
    }

    fn slot(i: i64, fil: &str, hex: &str) -> fp_core::models::PrinterSlot {
        fp_core::models::PrinterSlot {
            slot_index: i,
            filament_id: fil.into(),
            filament_name: String::new(),
            filament_hex: hex.into(),
            material: "PLA".into(),
            brand: String::new(),
        }
    }

    fn feeder(first: i64, n: i64, nozzle: Option<&str>) -> fp_core::models::PrinterFeeder {
        fp_core::models::PrinterFeeder {
            id: format!("f{first}"),
            name: format!("F{first}"),
            slot_count: n,
            is_dry_box: false,
            note: None,
            first_slot: Some(first),
            spools: vec![],
            auto: false,
            nozzle: nozzle.and_then(fp_core::models::FeederNozzle::parse),
        }
    }

    /// Test data only, not any printer's real numbers.
    fn dual_areas() -> Vec<PrintAreaSpec> {
        let a = |name: &str, x: f64, w: f64| PrintAreaSpec {
            name: name.into(),
            x_mm: x,
            y_mm: 0.0,
            width_mm: w,
            depth_mm: 320.0,
            height_mm: Some(320.0),
            nozzle: None,
        };
        vec![a("Left nozzle", 0.0, 325.0), a("Right nozzle", 20.0, 305.0)]
    }

    /// Test data only (left 325 wide at x=0, right 305 at x=20, both 300 at x=20), not
    /// any printer's real numbers.
    fn core_areas() -> Vec<fp_core::PrintArea> {
        let a = |name: &str, nozzle: &str, x: f64, w: f64, h: f64| fp_core::PrintArea {
            id: name.to_lowercase(),
            name: name.into(),
            nozzle: fp_core::models::AreaNozzle::parse(nozzle).unwrap(),
            width_mm: w,
            depth_mm: 320.0,
            height_mm: h,
            x_mm: x,
            y_mm: 0.0,
        };
        vec![a("Left nozzle", "left", 0.0, 325.0, 320.0), a("Right nozzle", "right", 20.0, 305.0, 325.0), a("Both nozzles", "both", 20.0, 300.0, 320.0)]
    }

    #[test]
    fn each_part_takes_the_area_core_picks_for_its_slots() {
        let units = vec![
            unit_fil("a", "fil-red", "#FF0000"),
            unit_fil("b", "fil-blue", "#0000FF"),
            unit_fil("c", "fil-green", "#00FF00"),
            unit_fil("d", "fil-grey", "#777777"),
        ];
        let slots = vec![slot(1, "fil-red", "#FF0000"), slot(5, "fil-blue", "#0000FF"), slot(9, "fil-green", "#00FF00")];
        let feeders = vec![feeder(1, 4, Some("left")), feeder(5, 4, Some("right")), feeder(9, 4, None)];
        assert_eq!(unit_slots(&units, &slots), vec![vec![1], vec![5], vec![9], vec![]]);
        let printer = reach_printer(feeders.clone(), core_areas());
        let ctx = reach_context_for(&printer, &units, &slots);
        assert_eq!(ctx.nozzles, vec![Some("left".into()), Some("right".into()), None, None]);
        let reaches = reaches_for(&ctx, &units, &HashMap::new());
        let r = |i: usize| reaches[i].clone().unwrap();
        assert_eq!((r(0).rect, r(0).height_mm), ([0.0, 0.0, 325.0, 320.0], Some(320.0)));
        assert_eq!((r(1).label.as_str(), r(1).height_mm), ("Right nozzle", Some(325.0)));
        // A feeder with no nozzle set, or a filament not loaded: the "both" area.
        assert_eq!(r(2).rect, [20.0, 0.0, 320.0, 320.0]);
        assert_eq!(r(3), r(2));
        assert_eq!(ctx.shared.clone().unwrap().rect, [20.0, 0.0, 320.0, 320.0]);
        // Overrides: an area by name, "both", or auto.
        let picks = HashMap::from([
            ("b".to_string(), "Left nozzle".to_string()),
            ("a".to_string(), "auto".to_string()),
            ("d".to_string(), "both".to_string()),
        ]);
        let r2 = reaches_for(&ctx, &units, &picks);
        assert_eq!(r2[1].as_ref().unwrap().rect[0], 0.0);
        assert_eq!(r2[0], reaches[0]);
        assert_eq!(r2[3], ctx.shared);
        // No "both" area: a mixed/unknown part gets the computed left/right overlap, never
        // the whole bed.
        let two: Vec<_> = core_areas().into_iter().take(2).collect();
        let ctx2 = reach_context_for(&reach_printer(feeders.clone(), two), &units, &slots);
        let ov = ctx2.autos[2].clone().unwrap();
        assert_eq!((ov.rect, ov.height_mm, ov.unreachable), ([20.0, 0.0, 325.0, 320.0], Some(320.0), false));
        assert_eq!(ctx2.autos[3], ctx2.autos[2]);
        assert_eq!(ctx2.shared.as_ref().map(|r| r.rect), Some([20.0, 0.0, 325.0, 320.0]));
        assert_eq!(ctx2.autos[0].as_ref().unwrap().label, "Left nozzle");
        // A printer without areas: no reach at all (whole bed, as before).
        let ctx3 = reach_context_for(&reach_printer(feeders, Vec::new()), &units, &slots);
        assert!(reaches_for(&ctx3, &units, &HashMap::new()).iter().all(|r| r.is_none()));
    }

    #[test]
    fn a_part_no_area_fits_is_unreachable_and_never_sent() {
        let units = vec![unit_fil("a", "fil-red", "#FF0000"), unit_fil("b", "fil-blue", "#0000FF")];
        let slots = vec![slot(1, "fil-red", "#FF0000"), slot(5, "fil-blue", "#0000FF")];
        let feeders = vec![feeder(1, 4, Some("left")), feeder(5, 4, Some("right"))];
        // Only a left area: the right-nozzle part has nowhere to go.
        let left: Vec<_> = core_areas().into_iter().take(1).collect();
        let ctx = reach_context_for(&reach_printer(feeders, left), &units, &slots);
        assert!(!ctx.autos[0].as_ref().unwrap().unreachable);
        assert!(ctx.autos[1].as_ref().unwrap().unreachable, "{:?}", ctx.autos[1]);
        let reaches = reaches_for(&ctx, &units, &HashMap::new());
        assert!(reaches[1].as_ref().unwrap().unreachable);
        let meshes: Vec<_> = (0..2).map(|_| cube(10.0)).collect();
        let bed = BedSize { width_mm: 325.0, depth_mm: 320.0, height_mm: None };
        // Print! (auto layout) and a plate view layout both refuse it.
        let err = plan_plates(&units, &meshes, None, &bed, &ArrangeSettings::default(), &reaches).unwrap_err();
        assert!(err.contains("No nozzle area fits this part"), "{err}");
        let at = |x: f64| Placement { plate: 0, x, y: 100.0, rot_deg: 0.0 };
        let layout = PrintLayout {
            parts: vec![
                PrintLayoutPart { unit_id: "a".into(), orientation: plate::IDENTITY, placement: at(50.0), area: None },
                PrintLayoutPart { unit_id: "b".into(), orientation: plate::IDENTITY, placement: at(200.0), area: None },
            ],
            order: vec![],
        };
        assert!(plan_plates(&units, &meshes, Some(&layout), &bed, &ArrangeSettings::default(), &reaches).is_err());
        // The check flags it; the JSON the UI reads lists it as unreachable and out of area.
        let refs: Vec<&TriangleMesh> = meshes.iter().collect();
        let (_, c) = plate::auto_layout_with_reach(&refs, &[], &reaches, &bed, &ArrangeSettings::default());
        let j = check_json(&c, &["a".into(), "b".into()]);
        assert_eq!(j["unreachable"], json!(["b"]));
        assert_eq!(j["out_of_area"], json!(["b"]));
        assert_eq!(j["fits"], json!(false));
        // An explicit area pick is the user's override and can make it placeable.
        let picks = HashMap::from([("b".to_string(), "Left nozzle".to_string())]);
        assert!(!reaches_for(&ctx, &units, &picks)[1].as_ref().unwrap().unreachable);
        assert!(unreachable_error(&["A", "B"]).ends_with("No nozzle area fits these parts"));
    }

    #[test]
    fn print_refuses_a_layout_where_the_nozzle_cannot_reach() {
        let units: Vec<_> = (0..2).map(|i| unit(&format!("u{i}"))).collect();
        let meshes: Vec<_> = (0..2).map(|_| cube(10.0)).collect();
        let bed = BedSize { width_mm: 325.0, depth_mm: 320.0, height_mm: None };
        let right = plate::reach_for_nozzles(&dual_areas(), &[Some("right".into())]);
        let reaches = vec![right.clone(), None];
        let at = |x: f64| Placement { plate: 0, x, y: 100.0, rot_deg: 0.0 };
        let layout = |x: f64| PrintLayout {
            parts: vec![
                PrintLayoutPart { unit_id: "u0".into(), orientation: plate::IDENTITY, placement: at(x), area: None },
                PrintLayoutPart { unit_id: "u1".into(), orientation: plate::IDENTITY, placement: at(200.0), area: None },
            ],
            order: vec![],
        };
        let err = plan_plates(&units, &meshes, Some(&layout(10.0)), &bed, &ArrangeSettings::default(), &reaches).unwrap_err();
        assert!(err.contains("right nozzle can't reach"), "{err}");
        assert!(plan_plates(&units, &meshes, Some(&layout(100.0)), &bed, &ArrangeSettings::default(), &reaches).is_ok());
        // Print! with no layout keeps the part in its area.
        let plates = plan_plates(&units, &meshes, None, &bed, &ArrangeSettings::default(), &reaches).unwrap();
        let t = plates.iter().flatten().find(|(i, _)| *i == 0).unwrap().1;
        assert!(t[9] >= 20.0, "{t:?}");
    }

    #[test]
    fn clearance_comes_from_the_printer_fields_with_plate_defaults() {
        let mut ledger = fp_core::ShopLedger::open_in_memory().unwrap();
        let pid = ledger.snapshot().unwrap().printers[0].id.clone();
        let base = ArrangeSettings { sequence: plate::Sequence::ByObject, spacing_mm: 7.0, ..Default::default() };
        // Nothing set: the plate defaults; the rest of the settings untouched.
        let s = with_printer_clearance(&ledger, &pid, base);
        assert_eq!((s.spacing_mm, s.clearance_radius_mm, s.clearance_height_mm), (7.0, 35.0, 30.0));
        assert_eq!((s.clearance_dist_to_rod_mm, s.clearance_height_to_lid_mm), (None, None));
        assert_eq!(s.dist_to_rod(), None, "no distance to rod set: check skipped");
        ledger
            .set_printer_extruder_clearance(
                &pid,
                fp_core::ExtruderClearance {
                    extruder_clearance_radius: Some(40.0),
                    extruder_clearance_dist_to_rod: Some(60.0),
                    extruder_clearance_height_to_rod: Some(25.0),
                    extruder_clearance_height_to_lid: Some(120.0),
                },
            )
            .unwrap();
        let s = with_printer_clearance(&ledger, &pid, base);
        assert_eq!((s.clearance_radius_mm, s.clearance_height_mm), (40.0, 25.0));
        assert_eq!((s.clearance_dist_to_rod_mm, s.clearance_height_to_lid_mm), (Some(60.0), Some(120.0)));
    }
}
