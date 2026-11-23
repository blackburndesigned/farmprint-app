// A release build without tauri/custom-protocol points the window at devUrl
// (127.0.0.1:1420), which release builds no longer serve, so it opens blank.
// tauri-build sets cfg(dev) when custom-protocol is off; refuse that combo.
#[cfg(all(dev, not(debug_assertions)))]
compile_error!("Release builds need the bundled UI. Use `npm run tauri build`, or `cargo build --release --features custom-protocol`.");

mod applock;
mod datadir;
mod feedback;
mod feedback_url;
mod logo;
mod orderthumbs;
mod plate_view;
mod sample_shop;
mod slicer;

use fp_core::{
    CreateCatalogPartInput, CreateOrderInput, CreateProductInput, Product, ShopLedger,
    ShopSettings, ShopSnapshot, TransitionRequest,
};
use fp_mesh::{load_stl_file, parse_3mf_parts, parse_stl_bytes, PlateBuildItem};
use fp_sync::SyncStatus;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
static MENU_PENDING: Mutex<Option<mpsc::Sender<String>>> = Mutex::new(None);

/// Native context menu (Tauri v2 menu API). Returns {"id": chosen-or-null}.
/// Body: {"items":[{"id":"edit","label":"Edit…","enabled":true},{"separator":true}]}
fn show_native_context_menu(body: &[u8]) -> Result<Value, String> {
    let req: Value = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    let items = req
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if items.is_empty() {
        return Ok(json!({ "id": null }));
    }
    let handle = APP_HANDLE.get().cloned().ok_or("native menu unavailable")?;
    let (sel_tx, sel_rx) = mpsc::channel::<String>();
    *MENU_PENDING.lock().map_err(|e| e.to_string())? = Some(sel_tx);
    let (done_tx, done_rx) = mpsc::channel::<Result<(), String>>();
    let h2 = handle.clone();
    handle
        .run_on_main_thread(move || {
            let r = (|| -> Result<(), String> {
                use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
                use tauri::Manager;
                let menu = Menu::new(&h2).map_err(|e| e.to_string())?;
                for it in &items {
                    if it
                        .get("separator")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        let sep = PredefinedMenuItem::separator(&h2).map_err(|e| e.to_string())?;
                        menu.append(&sep).map_err(|e| e.to_string())?;
                        continue;
                    }
                    let id = it.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                    let label = it.get("label").and_then(|v| v.as_str()).unwrap_or(id);
                    let enabled = it.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
                    let mi =
                        MenuItem::with_id(&h2, format!("fpctx:{id}"), label, enabled, None::<&str>)
                            .map_err(|e| e.to_string())?;
                    menu.append(&mi).map_err(|e| e.to_string())?;
                }
                let win = h2
                    .get_webview_window("main")
                    .or_else(|| h2.webview_windows().into_values().next())
                    .ok_or("no window for context menu")?;
                win.popup_menu(&menu).map_err(|e| e.to_string())?;
                Ok(())
            })();
            let _ = done_tx.send(r);
        })
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    done_rx
        .recv_timeout(Duration::from_secs(300))
        .map_err(|_| "context menu timed out".to_string())??;
    // macOS popups block until dismissed; if it returned instantly, wait for the click.
    let wait = if start.elapsed() < Duration::from_millis(150) {
        Duration::from_secs(30)
    } else {
        Duration::from_millis(300)
    };
    Ok(json!({ "id": sel_rx.recv_timeout(wait).ok() }))
}

pub struct AppState {
    pub ledger: Mutex<ShopLedger>,
    pub tracker_root: PathBuf,
    pub ui_dist_dir: PathBuf,
    pub ui_public_dir: PathBuf,
    /// Per-user data folder (datadir::user_data_dir): ledger DB + catalog/.
    pub data_dir: PathBuf,
    /// Set when the shop file could not be opened at launch. Every command is refused
    /// (the ledger is only a placeholder) while the recovery dialog is up.
    pub open_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SlicerHandoffResult {
    pub snapshot: ShopSnapshot,
    /// The first plate's file (kept for older callers); see `plate_paths`.
    pub plate_path: String,
    /// One .3mf per plate, in plate order.
    pub plate_paths: Vec<String>,
    pub plate_count: usize,
    pub part_count: usize,
    /// True when the plate was opened (in the chosen slicer or the default .3mf app).
    pub slicer_launched: bool,
    /// The slicer chosen in Settings (Bambu Studio when none is set).
    pub slicer_name: String,
    /// True when the chosen slicer didn't start and the computer's default .3mf app
    /// opened the plate instead.
    pub opened_with_default_app: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlatParsedMesh {
    pub name: String,
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
}

fn resolve_repo_root() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(env_root) = std::env::var("FARMPRINT_REPO_ROOT") {
        candidates.push(PathBuf::from(env_root));
    }
    candidates.extend(cwd.ancestors().map(Path::to_path_buf));
    for c in candidates {
        if c.join("ui").exists() {
            return c;
        }
    }
    cwd
}

fn find_catalog_stl_path(
    tracker_root: &Path,
    product_id: &str,
    mesh_file: &str,
) -> Option<PathBuf> {
    let bases = [
        datadir::user_data_dir().join("catalog"),
        resolve_repo_root()
            .join("ProductionTracker")
            .join("catalog"),
        tracker_root.join("catalog"),
        resolve_repo_root()
            .join("ui")
            .join("public")
            .join("catalog"),
    ];
    find_part_stl_in(&bases, product_id, mesh_file)
}

/// Catalog parts store mesh_file as "<stem>.png" (the part icon); the mesh is "<stem>.stl"
/// beside it. With a product id, only that product's own `parts/` or `meshes/` folder counts,
/// so a same-named part in another product can never supply the geometry Print! sends to the
/// slicer. Without one, scan every folder.
fn find_part_stl_in(bases: &[PathBuf], product_id: &str, mesh_file: &str) -> Option<PathBuf> {
    let stem = Path::new(mesh_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(mesh_file);
    let stl_name = format!("{stem}.stl");
    if !product_id.is_empty() {
        return bases
            .iter()
            .flat_map(|b| {
                ["parts", "meshes"].map(|sub| b.join(product_id).join(sub).join(&stl_name))
            })
            .find(|c| c.is_file());
    }
    for base in bases {
        if let Ok(entries) = std::fs::read_dir(base) {
            for entry in entries.flatten() {
                for sub in ["meshes", "parts"] {
                    let candidate = entry.path().join(sub).join(&stl_name);
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod part_stl_scope_tests {
    use super::find_part_stl_in;
    use std::path::PathBuf;

    #[test]
    fn same_named_part_uses_own_product_stl_only() {
        let root: PathBuf =
            std::env::temp_dir().join(format!("fp-stl-scope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for prod in ["product-a", "product-b"] {
            std::fs::create_dir_all(root.join(prod).join("parts")).unwrap();
        }
        std::fs::write(root.join("product-a/parts/base.stl"), b"a").unwrap();
        std::fs::write(root.join("product-b/parts/base.stl"), b"b").unwrap();
        let bases = vec![root.clone()];

        // mesh_file is the part icon name; the STL beside it is found.
        let got = find_part_stl_in(&bases, "product-b", "base.png").unwrap();
        assert!(got.ends_with("product-b/parts/base.stl"));

        // Product B loses its model: A's same-named STL must not print in its place.
        std::fs::remove_file(root.join("product-b/parts/base.stl")).unwrap();
        assert!(find_part_stl_in(&bases, "product-b", "base.png").is_none());

        // B's model in its own meshes/ folder still counts.
        std::fs::create_dir_all(root.join("product-b/meshes")).unwrap();
        std::fs::write(root.join("product-b/meshes/base.stl"), b"b").unwrap();
        let got = find_part_stl_in(&bases, "product-b", "base.stl").unwrap();
        assert!(got.ends_with("product-b/meshes/base.stl"));

        // No product id: any folder may supply it (legacy callers only).
        assert!(find_part_stl_in(&bases, "", "base.png").is_some());
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod print_mesh_tests {
    use super::{
        build_plate_bytes, load_unit_meshes, meshes_from_upload, plate_bed_for, slicer_object_name,
    };
    use fp_mesh::{PlateBed, PlateBuildItem, TriangleMesh};

    #[test]
    fn bed_used_only_when_both_sizes_are_set() {
        assert_eq!(
            plate_bed_for(Some(256.0), Some(240.0)),
            Some(PlateBed {
                width_mm: 256.0,
                depth_mm: 240.0
            })
        );
        assert_eq!(plate_bed_for(Some(256.0), None), None);
        assert_eq!(plate_bed_for(None, Some(256.0)), None);
        assert_eq!(plate_bed_for(Some(0.0), Some(256.0)), None);
        assert_eq!(plate_bed_for(Some(256.0), Some(-1.0)), None);
        assert_eq!(plate_bed_for(Some(f64::NAN), Some(256.0)), None);
    }

    fn block(w: f32, d: f32) -> PlateBuildItem {
        PlateBuildItem {
            name: "block".into(),
            filament_hex: "#ffffff".into(),
            mesh: TriangleMesh {
                name: "block".into(),
                positions: vec![[0.0, 0.0, 0.0], [w, 0.0, 0.0], [w, d, 0.0], [0.0, d, 5.0]],
                indices: vec![[0, 1, 2], [0, 2, 3]],
            },
        }
    }

    #[test]
    fn too_big_for_the_printer_bed_is_an_error_but_unknown_bed_is_not() {
        let items = vec![block(150.0, 150.0), block(150.0, 150.0)];
        let small = plate_bed_for(Some(180.0), Some(180.0));
        assert!(build_plate_bytes(&items, small)
            .unwrap_err()
            .contains("bed"));
        let wide = vec![block(300.0, 20.0)];
        assert!(build_plate_bytes(&wide, small)
            .unwrap_err()
            .contains("wide"));
        assert!(build_plate_bytes(&items, plate_bed_for(Some(350.0), Some(350.0))).is_ok());
        assert!(build_plate_bytes(&items, None).is_ok());
        assert!(build_plate_bytes(&wide, None).is_ok());
    }

    /// Print! hands the plate writer the chosen printer's slots: a unit whose filament is
    /// loaded in slot 3 opens as filament 3, the others take numbers no loaded slot uses.
    #[test]
    fn plate_filaments_follow_the_chosen_printers_slots() {
        let mut ledger = fp_core::ShopLedger::open_in_memory().unwrap();
        let snap = ledger.snapshot().unwrap();
        let pid = snap.printers[0].id.clone();
        let f: Vec<_> = snap.filaments.iter().take(3).cloned().collect();
        assert_eq!(f.len(), 3);
        // Slot 1: f[2] (not on the plate), slot 3: f[0].
        ledger
            .set_printer_filament_slots(&pid, vec![f[2].id.clone(), String::new(), f[0].id.clone()])
            .unwrap();
        let slots = ledger.printer_loaded_slots(&pid).unwrap();
        let with = |i: usize, fil: &fp_core::FilamentSwatch| {
            let mut u = unit("p", "part", i as i64);
            u.filament_id = fil.id.clone();
            u.filament_hex = fil.hex.clone();
            u.filament_material = fil.material.clone();
            (u, "part.stl".to_string())
        };
        let units = vec![with(0, &f[0]), with(1, &f[1]), with(2, &f[0])];
        let opts =
            super::plate_options_for(&units, plate_bed_for(Some(256.0), Some(256.0)), &slots);
        assert_eq!(opts.bed.width_mm, 256.0);
        assert_eq!(
            opts.loaded_slots.iter().map(|s| s.slot).collect::<Vec<_>>(),
            [1, 3]
        );
        let items: Vec<PlateBuildItem> = units
            .iter()
            .map(|(u, _)| PlateBuildItem {
                filament_hex: u.filament_hex.clone(),
                ..block(20.0, 20.0)
            })
            .collect();
        assert_eq!(fp_mesh::assign_plate_filaments(&items, &opts).0, [3, 2, 3]);
        assert!(build_plate_bytes(&items, opts).is_ok());
        // No printer picked: plain 1, 2 in first-seen order.
        let none = super::plate_options_for(&units, None, &[]);
        assert!(none.loaded_slots.is_empty());
        assert_eq!(none.bed, fp_mesh::PlateBed::default());
        assert_eq!(fp_mesh::assign_plate_filaments(&items, &none).0, [1, 2, 1]);
    }

    fn stl(tris: &[[[f32; 3]; 3]]) -> Vec<u8> {
        let mut b = vec![0u8; 80];
        b.extend_from_slice(&(tris.len() as u32).to_le_bytes());
        for tri in tris {
            b.extend_from_slice(&[0u8; 12]);
            for v in tri {
                for c in v {
                    b.extend_from_slice(&c.to_le_bytes());
                }
            }
            b.extend_from_slice(&[0u8; 2]);
        }
        b
    }

    fn unit(product_id: &str, part: &str, idx: i64) -> fp_core::PartUnit {
        serde_json::from_value(serde_json::json!({
            "id": format!("u{idx}"), "order_id": "o", "order_code": "O-1", "customer_name": "c",
            "line_id": "l", "line_label": "l", "product_id": product_id, "product_name": "Prod",
            "part_id": part, "part_name": part, "unit_index": idx, "filament_id": "f",
            "filament_name": "f", "filament_hex": "#112233", "filament_material": "PLA",
            "state": "Queued", "printer_id": null, "printer_name": null, "plate_job_id": null,
            "reprint_count": 0, "unit_cost": 0.0, "print_minutes": 0, "grams": 0.0, "updated_at": ""
        }))
        .unwrap()
    }

    #[test]
    fn slicer_object_name_includes_filament_color() {
        let mut u = unit("p", "Front Arm", 2);
        u.order_code = "FP-1043".into();
        u.filament_name = "Blue".into();
        assert_eq!(slicer_object_name(&u), "FP-1043_Front_Arm_Blue_2");
        u.filament_name = "Matte Black".into();
        assert_eq!(slicer_object_name(&u), "FP-1043_Front_Arm_Matte_Black_2");
        // No filament set: the color is left off, as before.
        u.filament_name = "  ".into();
        assert_eq!(slicer_object_name(&u), "FP-1043_Front_Arm_2");
    }

    #[test]
    fn stl_upload_is_welded() {
        let sq = stl(&[
            [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]],
            [[1., 0., 0.], [1., 1., 0.], [0., 1., 0.]],
        ]);
        let v = meshes_from_upload(&sq, "sq.stl").unwrap();
        assert_eq!(v[0]["positions"].as_array().unwrap().len(), 4 * 3);
        assert_eq!(v[0]["indices"].as_array().unwrap().len(), 6);
    }

    #[test]
    fn unit_meshes_load_per_unit_and_never_stand_in() {
        let root = std::env::temp_dir().join(format!("fp-unit-meshes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let pid = format!("fp-test-product-{}", std::process::id());
        let parts = root.join("catalog").join(&pid).join("parts");
        std::fs::create_dir_all(&parts).unwrap();
        std::fs::write(
            parts.join("base.stl"),
            stl(&[[[0., 0., 0.], [5., 0., 0.], [0., 5., 0.]]]),
        )
        .unwrap();
        std::fs::write(parts.join("broken.stl"), b"not a model").unwrap();

        let units: Vec<_> = (0..3)
            .map(|i| (unit(&pid, "Base", i), "base.png".to_string()))
            .collect();
        let meshes = load_unit_meshes(&root, &units).unwrap();
        assert_eq!(meshes.len(), 3, "one mesh per unit, in order");
        assert!(meshes.iter().all(|m| m.indices.len() == 1));

        // A broken file or a part with no model is reported by name, never replaced.
        let bad = vec![
            (unit(&pid, "Base", 0), "base.png".to_string()),
            (unit(&pid, "Broken", 1), "broken.png".to_string()),
            (unit(&pid, "Gone", 2), "gone.png".to_string()),
        ];
        let missing = load_unit_meshes(&root, &bad).unwrap_err();
        assert_eq!(
            missing,
            vec!["Prod · Broken".to_string(), "Prod · Gone".to_string()]
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// The unit's saved part model: its catalog mesh_file stem first, then the plain part-name stem.
fn resolve_unit_stl(
    tracker_root: &Path,
    unit: &fp_core::PartUnit,
    mesh_file: &str,
) -> Option<PathBuf> {
    find_catalog_stl_path(tracker_root, &unit.product_id, mesh_file).or_else(|| {
        find_catalog_stl_path(
            tracker_root,
            &unit.product_id,
            &format!("{}.stl", safe_part_stem(&unit.part_name)),
        )
    })
}

/// Each unit's real model, read once per file (twenty units of one part = one parse), in
/// unit order. Err lists the names ("Product · Part") of units whose model can't be found
/// or read; nothing is ever replaced with a stand-in shape.
pub(crate) fn load_unit_meshes(
    tracker_root: &Path,
    units: &[(fp_core::PartUnit, String)],
) -> Result<Vec<fp_mesh::TriangleMesh>, Vec<String>> {
    let mut by_path: HashMap<PathBuf, Option<fp_mesh::TriangleMesh>> = HashMap::new();
    let mut meshes = Vec::with_capacity(units.len());
    let mut missing: Vec<String> = Vec::new();
    for (unit, mesh_file) in units {
        let mesh = resolve_unit_stl(tracker_root, unit, mesh_file).and_then(|path| {
            by_path
                .entry(path)
                .or_insert_with_key(|p| load_stl_file(p, &unit.part_name).ok())
                .clone()
        });
        match mesh {
            Some(m) => meshes.push(m),
            None => {
                let label = format!("{} · {}", unit.product_name, unit.part_name);
                if !missing.contains(&label) {
                    missing.push(label);
                }
            }
        }
    }
    if missing.is_empty() {
        Ok(meshes)
    } else {
        Err(missing)
    }
}

/// The optional plate view layout sent with Print! (`layout`).
fn layout_arg(args: &Value) -> Result<Option<plate_view::PrintLayout>, String> {
    match args.get("layout") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|e| format!("bad plate layout: {e}")),
    }
}

/// The printer's bed for plate layout, only when both sizes are set and above zero.
fn plate_bed_for(bed_x_mm: Option<f64>, bed_y_mm: Option<f64>) -> Option<fp_mesh::PlateBed> {
    match (bed_x_mm, bed_y_mm) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() && x > 0.0 && y > 0.0 => {
            Some(fp_mesh::PlateBed {
                width_mm: x as f32,
                depth_mm: y as f32,
            })
        }
        _ => None,
    }
}

/// Lays the plate out on the printer's bed when its size is known (errors if the parts
/// don't fit), otherwise on the 220 mm default, and numbers its filaments by the printer's
/// loaded slots when they're given. Takes a bare `Option<PlateBed>` too (no slot info).
fn build_plate_bytes(
    items: &[PlateBuildItem],
    plate: impl Into<fp_mesh::PlateOptions>,
) -> Result<Vec<u8>, String> {
    fp_mesh::write_3mf_plate_with(items, &plate.into())
}

/// What the plate writer knows about the chosen printer: its bed (if set), its loaded
/// filament slots, and which swatch each unit is printed in (index-aligned with `units`).
pub(crate) fn plate_options_for(
    units: &[(fp_core::PartUnit, String)],
    bed: Option<fp_mesh::PlateBed>,
    loaded_slots: &[fp_core::models::PrinterSlot],
) -> fp_mesh::PlateOptions {
    fp_mesh::PlateOptions {
        bed: bed.unwrap_or_default(),
        loaded_slots: loaded_slots
            .iter()
            .filter_map(|s| {
                Some(fp_mesh::PlateSlot {
                    slot: u32::try_from(s.slot_index).ok().filter(|n| *n > 0)?,
                    filament_id: s.filament_id.clone(),
                    filament_hex: s.filament_hex.clone(),
                    material: s.material.clone(),
                })
            })
            .collect(),
        item_filaments: units
            .iter()
            .map(|(u, _)| fp_mesh::PlateItemFilament {
                filament_id: u.filament_id.clone(),
                material: u.filament_material.clone(),
            })
            .collect(),
        transforms: Vec::new(),
    }
}

/// The object's name in the slicer: order, part, filament color (as the shop shows it),
/// then the unit number, joined by `_` with spaces turned into `_`, e.g.
/// `FP-1043_Front_Arm_Blue_0`. The color is left off when the unit has no filament set.
fn slicer_object_name(unit: &fp_core::PartUnit) -> String {
    let color = unit.filament_name.trim();
    if color.is_empty() {
        format!(
            "{}_{}_{}",
            unit.order_code,
            unit.part_name.replace(' ', "_"),
            unit.unit_index
        )
    } else {
        format!(
            "{}_{}_{}_{}",
            unit.order_code,
            unit.part_name.replace(' ', "_"),
            color.replace(' ', "_"),
            unit.unit_index
        )
    }
}

/// One plate object per unit, in order: each keeps its own name (order, part, color, unit)
/// and its own filament color, so a plate can mix orders and colors. Two units can share a
/// name (the same part on two lines of one order are both unit 1); the later ones get
/// `-2`, `-3`, ... so every object on the plate can be told apart.
fn plate_items_for(
    units_with_meshes: &[(fp_core::PartUnit, String)],
    meshes: &[fp_mesh::TriangleMesh],
) -> Vec<PlateBuildItem> {
    let mut used: HashMap<String, usize> = HashMap::new();
    units_with_meshes
        .iter()
        .zip(meshes)
        .map(|((unit, _), mesh)| {
            let base = slicer_object_name(unit);
            let n = used.entry(base.clone()).or_insert(0);
            *n += 1;
            let name = if *n == 1 { base } else { format!("{base}-{n}") };
            PlateBuildItem {
                name,
                filament_hex: unit.filament_hex.clone(),
                mesh: mesh.clone(),
            }
        })
        .collect()
}

/// The plate layout for Print!: the bed (with its height when set) and the printer's
/// remembered arrange settings.
struct PlateLayoutPlan {
    bed: fp_mesh::plate::BedSize,
    settings: fp_mesh::plate::ArrangeSettings,
    /// Where each part may sit (index-aligned with the units) on a printer with print
    /// areas; empty for a printer without.
    reaches: Vec<Option<fp_mesh::plate::Reach>>,
}

/// Builds one 3MF per plate, writes them to the handoff folder and opens each in the slicer
/// chosen in Settings (see `slicer`). Parts are placed as the plate view left them
/// (`layout`), or arranged automatically, so Print! stays one click. Returns
/// `(plate paths, part count, how the first plate opened)`, or a plain-language reason
/// when no plate file could be written. Takes no ledger lock.
fn stage_and_open_plate(
    units_with_meshes: &[(fp_core::PartUnit, String)],
    meshes: &[fp_mesh::TriangleMesh],
    printer_name: Option<&str>,
    mut options: fp_mesh::PlateOptions,
    plan: &PlateLayoutPlan,
    layout: Option<&plate_view::PrintLayout>,
    slicer_choice: &slicer::SlicerChoice,
) -> Result<(Vec<String>, usize, Option<slicer::Opened>), String> {
    if units_with_meshes.is_empty() {
        return Err("none of the selected parts were found".to_string());
    }
    // Never hand the slicer a stand-in shape: every unit must come with its real model,
    // loaded by load_unit_meshes.
    if meshes.len() != units_with_meshes.len() {
        return Err("some parts have no saved model".to_string());
    }
    if layout.is_none() {
        // One click: refuse only what no layout can fix (a part bigger than the bed or
        // taller than the printer); everything else spills onto more plates.
        let refs: Vec<&fp_mesh::TriangleMesh> = meshes.iter().collect();
        let (_, c) = fp_mesh::plate::auto_layout_with_reach(&refs, &[], &plan.reaches, &plan.bed, &plan.settings);
        let names = |ix: &[usize]| {
            let mut v: Vec<String> = Vec::new();
            for &i in ix {
                let u = &units_with_meshes[i].0;
                let n = format!("{} · {}", u.product_name, u.part_name);
                if !v.contains(&n) {
                    v.push(n);
                }
            }
            v.join(", ")
        };
        if !c.off_plate.is_empty() {
            return Err(format!(
                "{} {} bigger than the printer's bed ({:.0} × {:.0} mm)",
                names(&c.off_plate),
                if c.off_plate.len() == 1 { "is" } else { "are" },
                plan.bed.width_mm,
                plan.bed.depth_mm
            ));
        }
        if !c.too_tall.is_empty() {
            return Err(format!(
                "{} {} taller than the printer can print ({:.0} mm)",
                names(&c.too_tall),
                if c.too_tall.len() == 1 { "is" } else { "are" },
                plan.bed.height_mm.unwrap_or_default()
            ));
        }
        if let Some(&i) = c.out_of_area.first() {
            let r = plan.reaches.get(i).cloned().flatten();
            let (label, w, d) = r
                .map(|r| (r.label.to_lowercase(), r.rect[2] - r.rect[0], r.rect[3] - r.rect[1]))
                .unwrap_or_default();
            return Err(format!(
                "{} {} bigger than where the {label} can print ({w:.0} × {d:.0} mm)",
                names(&c.out_of_area),
                if c.out_of_area.len() == 1 { "is" } else { "are" },
            ));
        }
    }
    let plates = plate_view::plan_plates(units_with_meshes, meshes, layout, &plan.bed, &plan.settings, &plan.reaches)?;
    let all_items = plate_items_for(units_with_meshes, meshes);
    let all_filaments = std::mem::take(&mut options.item_filaments);
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string());
    let handoff_dir = PathBuf::from(home)
        .join("Desktop")
        .join("Parts to Print Queue")
        .join(".slicer_handoff");
    std::fs::create_dir_all(&handoff_dir)
        .map_err(|e| format!("could not create {}: {e}", handoff_dir.display()))?;
    let clean_printer = printer_name
        .unwrap_or("Plate")
        .replace([' ', '/', ':'], "_");
    let first_fil = units_with_meshes[0]
        .0
        .filament_name
        .replace([' ', '/', ':'], "_");
    let total = plates.len();
    let mut paths = Vec::with_capacity(total);
    let mut count = 0;
    for (pi, group) in plates.iter().enumerate() {
        let items: Vec<PlateBuildItem> = group.iter().map(|(i, _)| all_items[*i].clone()).collect();
        let mut opts = options.clone();
        opts.item_filaments = group
            .iter()
            .filter_map(|(i, _)| all_filaments.get(*i).cloned())
            .collect();
        opts.transforms = group.iter().map(|(_, t)| *t).collect();
        let bytes = build_plate_bytes(&items, opts).map_err(|e| {
            format!(
                "could not build the plate file: {}",
                e.trim_end_matches('.')
            )
        })?;
        let filename = if total == 1 {
            format!("FarmPrint_{}_{}_{}parts.3mf", clean_printer, first_fil, items.len())
        } else {
            format!(
                "FarmPrint_{}_{}_plate{}of{}_{}parts.3mf",
                clean_printer,
                first_fil,
                pi + 1,
                total,
                items.len()
            )
        };
        let out_path = handoff_dir.join(filename);
        std::fs::write(&out_path, bytes)
            .map_err(|e| format!("could not save {}: {e}", out_path.display()))?;
        count += items.len();
        paths.push(out_path.to_string_lossy().to_string());
    }
    // Every plate goes to the slicer together; how the first opened is what's reported.
    let mut first_opened = None;
    for (i, p) in paths.iter().enumerate() {
        let o = slicer::open_plate(slicer_choice, p);
        if i == 0 {
            first_opened = o;
        }
    }
    Ok((paths, count, first_opened))
}

/// Print! handoff without holding the ledger lock while the plate is built and the
/// slicer opens. Units move to Printing only after the plate file is written and the
/// slicer was opened. Returns the snapshot plus the handoff details.
fn print_handoff(
    state: &AppState,
    request: TransitionRequest,
    allow_without_slicer: bool,
    layout: Option<plate_view::PrintLayout>,
) -> Result<SlicerHandoffResult, String> {
    let (units_for_plate, prn_name, bed, choice, plan) = {
        let ledger = state.ledger.lock().map_err(|e| e.to_string())?;
        let settings = ledger.get_settings().map_err(|e| e.to_string())?;
        let choice = slicer::slicer_choice(
            &settings.slicer_app_name,
            &settings.slicer_bundle_id,
            &settings.slicer_app_path,
        );
        let units = ledger
            .units_by_ids(&request.unit_ids)
            .map_err(|e| e.to_string())?;
        let (name, bed, slots, z) = match request.printer_id.as_deref() {
            Some(pid) => {
                let (x, y, z) = ledger.printer_build_volume_mm(pid).map_err(|e| e.to_string())?;
                (
                    ledger.printer_name(pid).map_err(|e| e.to_string())?,
                    plate_bed_for(x, y),
                    ledger
                        .printer_loaded_slots(pid)
                        .map_err(|e| e.to_string())?,
                    z.filter(|v| v.is_finite() && *v > 0.0),
                )
            }
            None => (None, None, Vec::new(), None),
        };
        let arrange = request
            .printer_id
            .as_deref()
            .and_then(|pid| settings.printer_plate.get(pid).cloned())
            .and_then(|v| serde_json::from_value::<fp_mesh::plate::ArrangeSettings>(v).ok())
            .unwrap_or_default();
        // By-object clearance comes from the printer's own fields.
        let arrange = match request.printer_id.as_deref() {
            Some(pid) => plate_view::with_printer_clearance(&ledger, pid, arrange),
            None => arrange,
        };
        let b = bed.unwrap_or_default();
        let plan = PlateLayoutPlan {
            bed: fp_mesh::plate::BedSize {
                width_mm: b.width_mm as f64,
                depth_mm: b.depth_mm as f64,
                height_mm: z,
            },
            settings: arrange,
            reaches: Vec::new(),
        };
        let mut plan = plan;
        // Print areas: each part sits where the nozzle printing its filament reaches.
        let ctx = plate_view::reach_context(&ledger, request.printer_id.as_deref(), &units)?;
        if !ctx.areas.is_empty() {
            let picks = layout.as_ref().map(|l| l.area_overrides()).unwrap_or_default();
            plan.reaches = plate_view::reaches_for(&ctx, &units, &picks);
        }
        // The bed size plus the printer's loaded slots, so slot N is filament N in the slicer.
        let bed = plate_options_for(&units, bed, &slots);
        (units, name, bed, choice, plan)
    }; // ledger lock released here
       // Every model is read once, here, outside the ledger lock.
    let meshes = load_unit_meshes(&state.tracker_root, &units_for_plate).map_err(|missing| {
        format!(
            "Nothing was sent to the slicer. FarmPrint has no saved model for: {}. Open the product in the Product Editor, re-import its model, and save.",
            missing.join(", ")
        )
    })?;
    let (plate_paths, part_count, opened) = if units_for_plate.is_empty() {
        (Vec::new(), 0, None)
    } else {
        stage_and_open_plate(
            &units_for_plate,
            &meshes,
            prn_name.as_deref(),
            bed,
            &plan,
            layout.as_ref(),
            &choice,
        )
        .map_err(|e| format!("Nothing was sent to the slicer, and nothing was moved to Printing: {e}."))?
    };
    let plate_path = plate_paths.first().cloned().unwrap_or_default();
    if !units_for_plate.is_empty() && opened.is_none() && !allow_without_slicer {
        let saved = if plate_paths.len() > 1 {
            format!("The {} plates were saved to {}", plate_paths.len(), plate_paths.join(", "))
        } else {
            format!("The plate was saved to {plate_path}")
        };
        // The UI matches the start of this message to offer "Mark Printing anyway".
        return Err(format!(
            "Nothing was moved to Printing: the slicer could not be opened. {} didn't start, and no app on this computer opened the .3mf file. {saved}. Open it in your slicer, then mark the parts Printing.",
            choice.label
        ));
    }
    let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
    let snapshot = ledger
        .transition_units(request)
        .map_err(|e| e.to_string())?;
    Ok(SlicerHandoffResult {
        snapshot,
        plate_path,
        plate_count: plate_paths.len(),
        plate_paths,
        part_count,
        slicer_launched: opened.is_some(),
        slicer_name: choice.label,
        opened_with_default_app: opened.map(|o| o.default_app).unwrap_or(false),
    })
}

/// Recovery dialog when the shop file can't be opened at launch: restore the newest backup
/// that opens (the damaged file is kept aside, never deleted), open the data folder, or quit.
fn db_open_failed_dialog(handle: tauri::AppHandle, db_path: PathBuf, err: String) {
    use tauri_plugin_dialog::{
        DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
    };
    const RESTORE: &str = "Restore Latest Backup";
    const OPEN: &str = "Open Data Folder";
    const QUIT: &str = "Quit";
    let has_backups = !fp_core::list_backups(&db_path).is_empty();
    let buttons = if has_backups {
        MessageDialogButtons::YesNoCancelCustom(RESTORE.into(), OPEN.into(), QUIT.into())
    } else {
        MessageDialogButtons::OkCancelCustom(OPEN.into(), QUIT.into())
    };
    let backup_hint = if has_backups {
        "You can restore the most recent backup that works. The current file is kept next to it, renamed .damaged, so nothing is lost."
    } else {
        "No backups were found. Open the data folder to check the file, or send it to support."
    };
    let message = format!(
        "FarmPrint couldn't open your shop file:\n{}\n\n{backup_hint}\n\nDetails: {err}",
        db_path.display()
    );
    let choice = handle
        .dialog()
        .message(message)
        .title("FarmPrint can't open your shop")
        .kind(MessageDialogKind::Error)
        .buttons(buttons)
        .blocking_show_with_result();
    let picked = match choice {
        MessageDialogResult::Custom(label) => label,
        MessageDialogResult::Yes => RESTORE.to_string(),
        MessageDialogResult::No => OPEN.to_string(),
        MessageDialogResult::Ok if has_backups => RESTORE.to_string(),
        MessageDialogResult::Ok => OPEN.to_string(),
        _ => QUIT.to_string(),
    };
    let folder = db_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| db_path.clone());
    if picked == RESTORE {
        match fp_core::restore_latest_working_backup(&db_path) {
            Ok(backup) => {
                let name = backup
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                handle
                    .dialog()
                    .message(format!(
                        "Restored the backup {name}. FarmPrint will now restart."
                    ))
                    .title("Backup restored")
                    .kind(MessageDialogKind::Info)
                    .blocking_show();
                handle.restart();
            }
            Err(e) => {
                handle
                    .dialog()
                    .message(format!("The backup could not be restored: {e}\n\nThe data folder will open so you can check the files."))
                    .title("Restore failed")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
                let _ = reveal_in_file_manager(&folder.to_string_lossy());
            }
        }
    } else if picked == OPEN {
        let _ = reveal_in_file_manager(&db_path.to_string_lossy());
    }
    handle.exit(1);
}

/// Show `path` selected in the platform file manager.
fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg("-R").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let r = Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let r = {
        let p = std::path::Path::new(path);
        let dir = if p.is_dir() {
            p.to_path_buf()
        } else {
            p.parent()
                .map(|d| d.to_path_buf())
                .unwrap_or_else(|| p.to_path_buf())
        };
        Command::new("xdg-open").arg(dir).spawn()
    };
    r.map(|_| ()).map_err(|e| e.to_string())
}

fn decode_b64(input: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("thumbnail was not valid base64".into()),
        }
    }
    let bytes: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
        .collect();
    if bytes.len() % 4 == 1 {
        return Err("thumbnail was not valid base64".into());
    }
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let n = ((val(bytes[i])? as u32) << 18)
            | ((val(bytes[i + 1])? as u32) << 12)
            | ((val(bytes[i + 2])? as u32) << 6)
            | (val(bytes[i + 3])? as u32);
        out.push((n >> 16) as u8);
        out.push((n >> 8) as u8);
        out.push(n as u8);
        i += 4;
    }
    let rest = bytes.len() - i;
    if rest == 2 {
        let n = ((val(bytes[i])? as u32) << 18) | ((val(bytes[i + 1])? as u32) << 12);
        out.push((n >> 16) as u8);
    } else if rest == 3 {
        let n = ((val(bytes[i])? as u32) << 18)
            | ((val(bytes[i + 1])? as u32) << 12)
            | ((val(bytes[i + 2])? as u32) << 6);
        out.push((n >> 16) as u8);
        out.push((n >> 8) as u8);
    }
    Ok(out)
}

fn png_bytes_from_data_url(raw: &str) -> Result<Vec<u8>, String> {
    let payload = raw.split_once(',').map(|(_, body)| body).unwrap_or(raw);
    let bytes = decode_b64(payload)?;
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("thumbnail was not a PNG".into());
    }
    Ok(bytes)
}

fn safe_catalog_id(id: &str) -> Result<&str, String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("product id cannot be used as a thumbnail folder".into());
    }
    Ok(id)
}

fn safe_part_stem(raw: &str) -> String {
    let mut stem = String::new();
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() {
            stem.push(c.to_ascii_lowercase());
        } else if !stem.ends_with('_') {
            stem.push('_');
        }
    }
    let stem = stem.trim_matches('_').to_string();
    if stem.is_empty() {
        "part".to_string()
    } else {
        stem
    }
}

/// Resolves a catalog-relative path (no `..`, no absolute parts) to a file: the user's
/// data folder first; debug builds also fall back to the repo's ui/public/catalog.
fn resolve_catalog_file(rel: &str) -> Option<PathBuf> {
    let rel = percent_decode(rel.trim_start_matches('/'));
    let rel_path = std::path::Path::new(&rel);
    if rel.is_empty()
        || !rel_path
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
    {
        return None;
    }
    let mut roots = vec![datadir::user_data_dir().join("catalog")];
    if cfg!(debug_assertions) {
        roots.push(
            resolve_repo_root()
                .join("ui")
                .join("public")
                .join("catalog"),
        );
    }
    roots
        .into_iter()
        .map(|r| r.join(rel_path))
        .find(|p| p.is_file())
}

fn serve_catalog_file(path: &str) -> tauri::http::Response<Vec<u8>> {
    let builder = tauri::http::Response::builder()
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-cache");
    let Some(file) = resolve_catalog_file(path) else {
        return builder.status(404).body(Vec::new()).unwrap();
    };
    match std::fs::read(&file) {
        Ok(bytes) => {
            let mime = match file
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .as_deref()
            {
                Some("png") => "image/png",
                Some("jpg") | Some("jpeg") => "image/jpeg",
                Some("webp") => "image/webp",
                Some("json") => "application/json",
                Some("stl") => "model/stl",
                Some("glb") => "model/gltf-binary",
                Some("svg") => "image/svg+xml",
                _ => "application/octet-stream",
            };
            builder
                .status(200)
                .header("Content-Type", mime)
                .body(bytes)
                .unwrap()
        }
        Err(_) => builder.status(404).body(Vec::new()).unwrap(),
    }
}

/// App data catalog: `<user data dir>/catalog` (see datadir.rs), next to the shop ledger.
fn app_data_catalog_dir(state: &AppState) -> Option<PathBuf> {
    Some(state.data_dir.join("catalog"))
}

fn write_catalog_png(
    state: &AppState,
    product_id: &str,
    relative: &str,
    bytes: &[u8],
) -> Result<(), String> {
    // Imports and bakes go only to the user's data folder, never into ui/public or ui/dist.
    let data_root = app_data_catalog_dir(state).ok_or("no app data catalog folder")?;
    for root in std::iter::once(&data_root) {
        let path = root.join(product_id).join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        // Marks this folder as written by FarmPrint so deleting the product may clean it up.
        let _ = std::fs::write(root.join(product_id).join(AUTHORED_MARKER), b"");
    }
    Ok(())
}

const AUTHORED_MARKER: &str = ".farmprint-authored";

fn remove_authored_catalog_files(state: &AppState, product_id: &str) {
    let Ok(id) = safe_catalog_id(product_id) else {
        return;
    };
    // Only remove folders FarmPrint wrote itself (they carry the marker); hand-placed art is left alone.
    let roots: Vec<std::path::PathBuf> = app_data_catalog_dir(state)
        .into_iter()
        .chain([
            state.ui_public_dir.join("catalog"),
            state.ui_dist_dir.join("catalog"),
        ])
        .collect();
    for root in roots {
        let dir = root.join(id);
        if !dir.join(AUTHORED_MARKER).exists() {
            continue;
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Runs one UI command. When the UI sends `known_order_hashes` ({order id: order_hash})
/// with a command that returns the shop snapshot, orders it already has unchanged are left
/// out of the reply (`delta: true` + `order_ids`), so a click no longer ships every order.
pub fn dispatch_invoke(state: &AppState, cmd: &str, mut args: Value) -> Result<Value, String> {
    if let Some(err) = &state.open_error {
        return Err(format!("The shop file could not be opened: {err}"));
    }
    let known = args
        .as_object_mut()
        .and_then(|m| m.remove("known_order_hashes"));
    let mut reply = dispatch_invoke_inner(state, cmd, args)?;
    if let Some(known) = known {
        fp_core::delta::strip_known_orders(&mut reply, &known);
    }
    Ok(reply)
}

fn dispatch_invoke_inner(state: &AppState, cmd: &str, args: Value) -> Result<Value, String> {
    match cmd {
        "get_shop_snapshot" => {
            let ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger.snapshot().map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "transition_units" => {
            // Set by the UI's "Mark Printing anyway" after the slicer could not be opened.
            let allow_without_slicer = args
                .get("allow_without_slicer")
                .or_else(|| args.get("allowWithoutSlicer"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            // Set by "Mark Printing": the same job, printer and Flow history as Print!, but
            // no plate is built, no .3mf is written and no slicer is opened.
            let skip_slicer = args
                .get("skip_slicer")
                .or_else(|| args.get("skipSlicer"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let req_val = args.get("request").cloned().unwrap_or_else(|| args.clone());
            let request: TransitionRequest =
                serde_json::from_value(req_val).map_err(|e| e.to_string())?;
            let should_handoff =
                request.to_state == "Printing" && request.failure_reason.is_none() && !skip_slicer;
            if should_handoff {
                let result = print_handoff(state, request, allow_without_slicer, layout_arg(&args)?)?;
                return serde_json::to_value(result.snapshot).map_err(|e| e.to_string());
            }
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .transition_units(request)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "handoff_print_to_slicer" => {
            let unit_ids: Vec<String> = args
                .get("unit_ids")
                .or_else(|| args.get("unitIds"))
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let printer_id: Option<String> = args
                .get("printer_id")
                .or_else(|| args.get("printerId"))
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            let actor_device: Option<String> = args
                .get("actor_device")
                .or_else(|| args.get("actorDevice"))
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            let allow_without_slicer = args
                .get("allow_without_slicer")
                .or_else(|| args.get("allowWithoutSlicer"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let slicer_label = shop_settings(state)
                .map(|st| {
                    slicer::slicer_choice(
                        &st.slicer_app_name,
                        &st.slicer_bundle_id,
                        &st.slicer_app_path,
                    )
                    .label
                })
                .unwrap_or_else(|_| "Bambu Studio".to_string());
            let result = print_handoff(
                state,
                TransitionRequest {
                    unit_ids,
                    to_state: "Printing".to_string(),
                    printer_id,
                    actor_device: actor_device.unwrap_or_else(|| "Mac Studio".to_string()),
                    source_surface: "Print! Slicer Handoff".to_string(),
                    action_label: format!("Print! -> {slicer_label} (.3mf)"),
                    failure_reason: None,
                    failure_note: None,
                    filament_id: None,
                },
                allow_without_slicer,
                layout_arg(&args)?,
            )?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "plate_prepare" => plate_view::prepare(state, &args),
        "plate_fit_summary" => plate_view::fit_summary(state, &args),
        "plate_arrange" => plate_view::arrange(state, &args),
        "plate_check" => plate_view::check(state, &args),
        "plate_printer" => plate_view::printer(state, &args),
        "plate_auto_orient" => plate_view::auto_orient(state, &args),
        "plate_footprint" => plate_view::footprint(state, &args),
        "plate_face_candidates" => plate_view::face_candidates(state, &args),
        "undo_flow_event" => {
            let event_id = args
                .get("event_id")
                .or_else(|| args.get("eventId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let actor_device = args
                .get("actor_device")
                .or_else(|| args.get("actorDevice"))
                .and_then(|v| v.as_str())
                .unwrap_or("Mac Studio");
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .undo_flow_event(event_id, actor_device)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "update_part_filament" => {
            let unit_id = args
                .get("unit_id")
                .or_else(|| args.get("unitId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let filament_id = args
                .get("filament_id")
                .or_else(|| args.get("filamentId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let actor_device = args
                .get("actor_device")
                .or_else(|| args.get("actorDevice"))
                .and_then(|v| v.as_str())
                .unwrap_or("Mac Studio");
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .update_part_filament(unit_id, filament_id, actor_device)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "upsert_product" | "create_product" => {
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            if let Some(prod_val) = args.get("product") {
                if let Ok(prod) = serde_json::from_value::<Product>(prod_val.clone()) {
                    let snap = ledger.upsert_product(prod).map_err(|e| e.to_string())?;
                    return serde_json::to_value(snap).map_err(|e| e.to_string());
                }
            }
            if let Some(inp_val) = args.get("input") {
                if let Ok(inp) = serde_json::from_value::<CreateProductInput>(inp_val.clone()) {
                    let snap = ledger.create_product(inp).map_err(|e| e.to_string())?;
                    return serde_json::to_value(snap).map_err(|e| e.to_string());
                }
            }
            if let Ok(prod) = serde_json::from_value::<Product>(args.clone()) {
                let snap = ledger.upsert_product(prod).map_err(|e| e.to_string())?;
                return serde_json::to_value(snap).map_err(|e| e.to_string());
            }
            if let Ok(inp) = serde_json::from_value::<CreateProductInput>(args) {
                let snap = ledger.create_product(inp).map_err(|e| e.to_string())?;
                return serde_json::to_value(snap).map_err(|e| e.to_string());
            }
            // Never report success for a product that was not saved.
            Err(
                "The product could not be saved: FarmPrint did not understand the product data."
                    .to_string(),
            )
        }
        "add_catalog_part" => {
            let inp_val = args.get("input").cloned().unwrap_or(args);
            let input: CreateCatalogPartInput =
                serde_json::from_value(inp_val).map_err(|e| e.to_string())?;
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger.add_catalog_part(input).map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "save_product_thumbnail" => {
            let product_id = safe_catalog_id(
                args.get("product_id")
                    .or_else(|| args.get("productId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default(),
            )?;
            let composite = args
                .get("png_data_url")
                .or_else(|| args.get("pngDataUrl"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let png = png_bytes_from_data_url(composite)?;
            write_catalog_png(state, product_id, "product.png", &png)?;
            if let Some(parts) = args.get("parts").and_then(|v| v.as_array()) {
                for part in parts {
                    let stem = safe_part_stem(
                        part.get("stem")
                            .or_else(|| part.get("name"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("part"),
                    );
                    let Some(url) = part
                        .get("png_data_url")
                        .or_else(|| part.get("pngDataUrl"))
                        .and_then(|v| v.as_str())
                    else {
                        continue;
                    };
                    if url.is_empty() {
                        continue;
                    }
                    let part_png = png_bytes_from_data_url(url)?;
                    write_catalog_png(state, product_id, &format!("parts/{stem}.png"), &part_png)?;
                }
            }
            // Editor source (part meshes as binary STL + editor.json) so Edit can reopen the product.
            if let Some(parts) = args.get("parts").and_then(|v| v.as_array()) {
                for part in parts {
                    let Some(b64) = part.get("stl_b64").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    if b64.is_empty() {
                        continue;
                    }
                    let stem = safe_part_stem(
                        part.get("stem")
                            .or_else(|| part.get("name"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("part"),
                    );
                    let stl = decode_b64(b64)?;
                    if stl.len() < 84 {
                        return Err("part mesh was not a binary STL".into());
                    }
                    write_catalog_png(state, product_id, &format!("parts/{stem}.stl"), &stl)?;
                }
            }
            if let Some(editor_json) = args
                .get("editor_json")
                .or_else(|| args.get("editorJson"))
                .and_then(|v| v.as_str())
            {
                if !editor_json.is_empty()
                    && serde_json::from_str::<serde_json::Value>(editor_json).is_ok()
                {
                    write_catalog_png(state, product_id, "editor.json", editor_json.as_bytes())?;
                }
            }
            // Each part tile's camera (direction/up/zoom/pan), restored when the editor reopens.
            if let Some(cams_json) = args
                .get("part_icon_cameras_json")
                .or_else(|| args.get("partIconCamerasJson"))
                .and_then(|v| v.as_str())
            {
                if !cams_json.is_empty()
                    && serde_json::from_str::<serde_json::Value>(cams_json).is_ok()
                {
                    write_catalog_png(
                        state,
                        product_id,
                        "parts/part_icon_cameras.json",
                        cams_json.as_bytes(),
                    )?;
                }
            }
            // Per-part layer index (same camera as product.png) read by partThumbnails.
            if let Some(layers_json) = args
                .get("layers_json")
                .or_else(|| args.get("layersJson"))
                .and_then(|v| v.as_str())
            {
                if !layers_json.is_empty()
                    && serde_json::from_str::<serde_json::Value>(layers_json).is_ok()
                {
                    write_catalog_png(
                        state,
                        product_id,
                        "parts/layers.json",
                        layers_json.as_bytes(),
                    )?;
                }
            }
            Ok(json!({ "ok": true, "product_id": product_id }))
        }
        "delete_product" => {
            let product_id = args
                .get("product_id")
                .or_else(|| args.get("productId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .delete_product(product_id)
                .map_err(|e| e.to_string())?;
            remove_authored_catalog_files(state, product_id);
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "create_manual_order" | "create_order" => {
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let resolved_input = if let Some(inp_val) = args.get("input") {
                serde_json::from_value::<CreateOrderInput>(inp_val.clone())
                    .map_err(|e| e.to_string())?
            } else {
                let customer_name = args
                    .get("customer_name")
                    .or_else(|| args.get("customerName"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Walk-In Customer")
                    .to_string();
                let customer_email = args
                    .get("customer_email")
                    .or_else(|| args.get("customerEmail"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let product_id = args
                    .get("product_id")
                    .or_else(|| args.get("productId"))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "product_id is required".to_string())?
                    .to_string();
                let quantity = args
                    .get("quantity")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(1)
                    .max(1);
                let custom_text = args
                    .get("custom_text")
                    .or_else(|| args.get("customText"))
                    .and_then(|v| v.as_str().map(|s| s.to_string()));
                let is_rush = args
                    .get("rush")
                    .or_else(|| args.get("is_rush"))
                    .or_else(|| args.get("isRush"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                CreateOrderInput {
                    customer_name,
                    customer_email,
                    product_id,
                    quantity,
                    custom_text,
                    is_rush,
                }
            };
            let snap = ledger
                .create_order(resolved_input)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "delete_order" => {
            let order_id = args
                .get("order_id")
                .or_else(|| args.get("orderId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger.delete_order(order_id).map_err(|e| e.to_string())?;
            // The order's own pictures (local only) go with it.
            let _ = orderthumbs::delete(&state.data_dir, order_id, None);
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        // Per-order-line pictures from the 3D order builder. Local files only
        // (<data>/order_thumbs/<order_id>/<line_id>.png + .json); never synced to the shop.
        "save_order_line_thumbnail" => {
            let order_id = args
                .get("order_id")
                .or_else(|| args.get("orderId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let line_id = args
                .get("order_line_id")
                .or_else(|| args.get("orderLineId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let url = args
                .get("png_data_url")
                .or_else(|| args.get("pngDataUrl"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let png = png_bytes_from_data_url(url)?;
            let meta = args.get("meta").cloned().unwrap_or_else(|| json!({}));
            if !meta.is_object() {
                return Err("order picture meta must be an object".into());
            }
            let meta_text = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
            orderthumbs::save(&state.data_dir, order_id, line_id, &png, &meta_text)?;
            Ok(json!({ "ok": true, "order_id": order_id, "order_line_id": line_id }))
        }
        "load_order_line_thumbnails" => {
            let order_id = args
                .get("order_id")
                .or_else(|| args.get("orderId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let lines: Vec<Value> = orderthumbs::load(&state.data_dir, order_id)?
                .into_iter()
                .map(|l| {
                    let meta = l
                        .meta_json
                        .as_deref()
                        .and_then(|t| serde_json::from_str::<Value>(t).ok())
                        .unwrap_or(Value::Null);
                    json!({
                        "order_line_id": l.line_id,
                        "png_data_url": format!("data:image/png;base64,{}", orderthumbs::encode_b64(&l.png)),
                        "meta": meta,
                    })
                })
                .collect();
            Ok(json!({ "order_id": order_id, "lines": lines }))
        }
        "delete_order_line_thumbnails" => {
            let order_id = args
                .get("order_id")
                .or_else(|| args.get("orderId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let line_id = args
                .get("order_line_id")
                .or_else(|| args.get("orderLineId"))
                .and_then(|v| v.as_str());
            orderthumbs::delete(&state.data_dir, order_id, line_id)?;
            Ok(json!({ "ok": true }))
        }
        "update_order_metadata" => {
            let order_id = args
                .get("order_id")
                .or_else(|| args.get("orderId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let customer_name = args
                .get("customer_name")
                .or_else(|| args.get("customerName"))
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            let customer_email = args
                .get("customer_email")
                .or_else(|| args.get("customerEmail"))
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            let is_rush = args
                .get("is_rush")
                .or_else(|| args.get("isRush"))
                .and_then(|v| v.as_bool());
            let is_on_hold = args
                .get("is_on_hold")
                .or_else(|| args.get("isOnHold"))
                .and_then(|v| v.as_bool());
            let notes = args
                .get("notes")
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .update_order_metadata(
                    order_id,
                    customer_name,
                    customer_email,
                    is_rush,
                    is_on_hold,
                    notes,
                )
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "update_order_line" => {
            let line_id = args
                .get("line_id")
                .or_else(|| args.get("lineId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let quantity = args.get("quantity").and_then(|v| v.as_i64());
            let custom_text = args
                .get("custom_text")
                .or_else(|| args.get("customText"))
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .update_order_line(line_id, quantity, custom_text)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "add_order_line" => {
            let order_id = args
                .get("order_id")
                .or_else(|| args.get("orderId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let product_id = args
                .get("product_id")
                .or_else(|| args.get("productId"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "product_id is required".to_string())?;
            let quantity = args.get("quantity").and_then(|v| v.as_i64()).unwrap_or(1);
            let custom_text = args
                .get("custom_text")
                .or_else(|| args.get("customText"))
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            let filament_overrides: Option<HashMap<String, String>> = args
                .get("filament_overrides")
                .or_else(|| args.get("filamentOverrides"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .add_order_line(
                    order_id,
                    product_id,
                    quantity,
                    custom_text,
                    filament_overrides,
                )
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "delete_order_line" => {
            let line_id = args
                .get("line_id")
                .or_else(|| args.get("lineId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .delete_order_line(line_id)
                .map_err(|e| e.to_string())?;
            orderthumbs::delete_line_anywhere(&state.data_dir, line_id);
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "add_printer" => {
            // Blank name becomes "Printer N" in fp-core; a blank model stays blank.
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let model = args
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let nozzle_mm = args
                .get("nozzle_mm")
                .or_else(|| args.get("nozzleMm"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.4);
            let slot_filament_ids: Vec<String> = args
                .get("slot_filament_ids")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            // Optional bed size in mm (absent/null = not set). Height is independent of width/depth.
            let bed_x_mm = args.get("bed_x_mm").and_then(|v| v.as_f64());
            let bed_y_mm = args.get("bed_y_mm").and_then(|v| v.as_f64());
            let bed_z_mm = args.get("bed_z_mm").and_then(|v| v.as_f64());
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .add_printer_with_bed(
                    name,
                    model,
                    nozzle_mm,
                    slot_filament_ids,
                    bed_x_mm,
                    bed_y_mm,
                    bed_z_mm,
                )
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "set_printer_bed_size" => {
            // { printer_id, bed_x_mm, bed_y_mm, bed_z_mm }: numbers in mm, or null to clear.
            // Width and depth are both or neither; height is independent and optional.
            let printer_id = args
                .get("printer_id")
                .or_else(|| args.get("printerId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let bed_x_mm = args.get("bed_x_mm").and_then(|v| v.as_f64());
            let bed_y_mm = args.get("bed_y_mm").and_then(|v| v.as_f64());
            let bed_z_mm = args.get("bed_z_mm").and_then(|v| v.as_f64());
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .set_printer_bed_size(printer_id, bed_x_mm, bed_y_mm, bed_z_mm)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "delete_printer" => {
            let printer_id = args
                .get("printer_id")
                .or_else(|| args.get("printerId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .delete_printer(printer_id)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "set_printer_filament_slots" => {
            let printer_id = args
                .get("printer_id")
                .or_else(|| args.get("printerId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let filament_ids: Vec<String> = args
                .get("filament_ids")
                .or_else(|| args.get("filamentIds"))
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .set_printer_filament_slots(printer_id, filament_ids)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "set_printer_feeders" => {
            // { printer_id, feeders: [{ id?, name, slot_count, is_dry_box, note?, nozzle? }] }
            let printer_id = args
                .get("printer_id")
                .or_else(|| args.get("printerId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let feeders: Vec<fp_core::FeederInput> = args
                .get("feeders")
                .map(|v| serde_json::from_value(v.clone()))
                .transpose()
                .map_err(|e| format!("Feeders not saved: {e}"))?
                .unwrap_or_default();
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .set_printer_feeders(printer_id, feeders)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "set_printer_print_areas" => {
            // { printer_id, print_areas: [{ id?, name, nozzle: "left"|"right"|"both",
            //   width_mm, depth_mm, height_mm, x_mm, y_mm }] }. An empty list clears them.
            let printer_id = args
                .get("printer_id")
                .or_else(|| args.get("printerId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let areas: Vec<fp_core::PrintAreaInput> = args
                .get("print_areas")
                .or_else(|| args.get("printAreas"))
                .map(|v| serde_json::from_value(v.clone()))
                .transpose()
                .map_err(|e| format!("Print areas not saved: {e}"))?
                .unwrap_or_default();
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .set_printer_print_areas(printer_id, areas)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "set_printer_extruder_clearance" => {
            // { printer_id, extruder_clearance_radius, extruder_clearance_dist_to_rod,
            //   extruder_clearance_height_to_rod, extruder_clearance_height_to_lid }:
            // numbers in mm (0–2000), or null / absent for empty.
            let printer_id = args
                .get("printer_id")
                .or_else(|| args.get("printerId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let c: fp_core::ExtruderClearance = serde_json::from_value(args.clone())
                .map_err(|e| format!("Extruder clearance not saved: {e}"))?;
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .set_printer_extruder_clearance(printer_id, c)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "printer_effective_clearance" => {
            // { printer_id } -> { radius, height_to_rod, dist_to_rod, height_to_lid } in mm
            // (printer field, else the plate view's remembered value, else the plate
            // default), or null for an unknown printer.
            let printer_id = args
                .get("printer_id")
                .or_else(|| args.get("printerId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let c = ledger
                .printer_effective_clearance(printer_id)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(c).map_err(|e| e.to_string())
        }
        "set_dry_box_spools" => {
            // { feeder_id, filament_ids: ["fil-…", "", …] } by position in the dry box.
            let feeder_id = args
                .get("feeder_id")
                .or_else(|| args.get("feederId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let filament_ids: Vec<String> = args
                .get("filament_ids")
                .or_else(|| args.get("filamentIds"))
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .set_dry_box_spools(feeder_id, filament_ids)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "add_filament_swatch" => {
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("New Spool")
                .to_string();
            let brand = args
                .get("brand")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let material = args
                .get("material")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let hex = args
                .get("hex")
                .and_then(|v| v.as_str())
                .unwrap_or("#FF8D28")
                .to_string();
            let cost_per_kg = args
                .get("cost_per_kg")
                .and_then(|v| v.as_f64())
                .unwrap_or(22.99);
            let grams_remaining = args
                .get("grams_remaining")
                .and_then(|v| v.as_f64())
                .unwrap_or(1000.0);
            let vendor = args
                .get("vendor")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .add_filament_swatch_with_vendor(
                    name,
                    brand,
                    material,
                    hex,
                    cost_per_kg,
                    grams_remaining,
                    vendor,
                )
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "update_filament_swatch" => {
            let filament_id = args
                .get("filament_id")
                .or_else(|| args.get("filamentId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let name = args
                .get("name")
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            let brand = args
                .get("brand")
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            let material = args
                .get("material")
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            let hex = args
                .get("hex")
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            let cost_per_kg = args.get("cost_per_kg").and_then(|v| v.as_f64());
            let grams_remaining = args.get("grams_remaining").and_then(|v| v.as_f64());
            let vendor = args
                .get("vendor")
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .update_filament_swatch(
                    filament_id,
                    name,
                    brand,
                    material,
                    hex,
                    cost_per_kg,
                    grams_remaining,
                    vendor,
                )
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "delete_filament_swatch" => {
            let filament_id = args
                .get("filament_id")
                .or_else(|| args.get("filamentId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .delete_filament_swatch(filament_id)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "adjust_overstock" => {
            let overstock_id = args
                .get("overstock_id")
                .or_else(|| args.get("overstockId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let delta = args.get("delta").and_then(|v| v.as_i64()).unwrap_or(0);
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .adjust_overstock(overstock_id, delta)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "add_overstock_entry" => {
            let product_id = args
                .get("product_id")
                .or_else(|| args.get("productId"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "product_id is required".to_string())?;
            let part_id = args
                .get("part_id")
                .or_else(|| args.get("partId"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "part_id is required".to_string())?;
            let filament_id = args
                .get("filament_id")
                .or_else(|| args.get("filamentId"))
                .and_then(|v| v.as_str())
                .unwrap_or("color-8AC235A1-6");
            let quantity = args.get("quantity").and_then(|v| v.as_i64()).unwrap_or(1);
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .add_overstock_entry(product_id, part_id, filament_id, quantity)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "pull_from_overstock" => {
            let overstock_id = args
                .get("overstock_id")
                .or_else(|| args.get("overstockId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let unit_id = args
                .get("unit_id")
                .or_else(|| args.get("unitId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let actor_device = args
                .get("actor_device")
                .or_else(|| args.get("actorDevice"))
                .and_then(|v| v.as_str())
                .unwrap_or("Mac Studio");
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .pull_from_overstock(overstock_id, unit_id, actor_device)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "get_shop_settings" => {
            let ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let mut settings = ledger.get_settings().map_err(|e| e.to_string())?;
            settings.app_lock_password_hash.clear(); // never sent to the UI
            serde_json::to_value(settings).map_err(|e| e.to_string())
        }
        // --- App lock + first-run setup (BEGIN app-lock/setup block) ---
        "app_lock_status" => {
            let ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let s = ledger.get_settings().map_err(|e| e.to_string())?;
            Ok(json!({
                "os": std::env::consts::OS,
                "biometric": applock::biometric_kind(),
                "password_set": !s.app_lock_password_hash.is_empty(),
                "enabled": s.app_lock_enabled,
                "method": s.app_lock_method,
            }))
        }
        "app_lock_set_password" => {
            let pw = args
                .get("password")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let hash = fp_core::applock::hash_app_password(pw)?;
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let mut s = ledger.get_settings().map_err(|e| e.to_string())?;
            s.app_lock_password_hash = hash;
            ledger.save_settings(s).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "app_lock_clear_password" => {
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let mut s = ledger.get_settings().map_err(|e| e.to_string())?;
            s.app_lock_password_hash.clear();
            if s.app_lock_method == "password" {
                s.app_lock_enabled = false;
            }
            ledger.save_settings(s).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "app_lock_unlock" => {
            let method = args
                .get("method")
                .and_then(|v| v.as_str())
                .unwrap_or("password");
            if method == "biometric" {
                let ok = applock::biometric_unlock("unlock FarmPrint")?;
                return Ok(json!({ "ok": ok }));
            }
            let pw = args
                .get("password")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let hash = {
                let ledger = state.ledger.lock().map_err(|e| e.to_string())?;
                ledger
                    .get_settings()
                    .map_err(|e| e.to_string())?
                    .app_lock_password_hash
            };
            Ok(json!({ "ok": fp_core::applock::verify_app_password(pw, &hash) }))
        }
        // --- END app-lock/setup block ---
        "sample_shop_status" => {
            let ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let status = ledger.sample_shop_status().map_err(|e| e.to_string())?;
            serde_json::to_value(status).map_err(|e| e.to_string())
        }
        "load_sample_shop" => {
            // Empty shops only (fp-core refuses otherwise and backs up first). The sample
            // pictures go to the user's catalog folder, like imported product art.
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger.load_sample_shop().map_err(|e| e.to_string())?;
            if let Some(dir) = app_data_catalog_dir(state) {
                if let Err(e) = sample_shop::write_pictures(&dir) {
                    eprintln!("FarmPrint: {e}");
                }
            }
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "clear_sample_data" => {
            // Removes only rows with sample ids; sample products still used by the user's
            // own orders are kept and listed in `sample_kept_products`.
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let (snap, outcome) = ledger.clear_sample_data().map_err(|e| e.to_string())?;
            let gone = ledger
                .removed_sample_product_ids()
                .map_err(|e| e.to_string())?;
            if let Some(dir) = app_data_catalog_dir(state) {
                sample_shop::remove_pictures(&dir, &gone);
            }
            let mut v = serde_json::to_value(snap).map_err(|e| e.to_string())?;
            if let Some(obj) = v.as_object_mut() {
                obj.insert("sample_kept_products".into(), json!(outcome.kept_products));
                obj.insert(
                    "sample_removed_orders".into(),
                    json!(outcome.removed_orders),
                );
            }
            Ok(v)
        }
        "start_fresh_shop" => {
            // First-run setup only; fp-core refuses if any order exists and backs up first.
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger.start_fresh_shop().map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "save_shop_settings" => {
            let s_val = args.get("settings").cloned().unwrap_or(args);
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let mut settings = serde_json::from_value::<ShopSettings>(s_val)
                .map_err(|e| format!("settings did not parse: {e}"))?;
            // The password hash is only changed via app_lock_set_password / _clear_password.
            settings.app_lock_password_hash = ledger
                .get_settings()
                .map(|s| s.app_lock_password_hash)
                .unwrap_or_default();
            let mut saved = ledger.save_settings(settings).map_err(|e| e.to_string())?;
            saved.app_lock_password_hash.clear();
            serde_json::to_value(saved).map_err(|e| e.to_string())
        }
        // --- Settings window (General › Data, Printers, Print library, Branding) ---
        "get_shop_data_dir" => Ok(json!({ "path": state.data_dir.to_string_lossy() })),
        "rename_printer" => {
            let id = args
                .get("printer_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if id.is_empty() || name.trim().is_empty() {
                return Err("printer_id and name are required".into());
            }
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger.rename_printer(id, name).map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "set_printer_model" => {
            let id = args
                .get("printer_id")
                .or_else(|| args.get("printerId"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let model = args
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if id.is_empty() {
                return Err("printer_id is required".into());
            }
            let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
            let snap = ledger
                .set_printer_model(id, model)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        "settings_choose_path" => {
            // Native chooser via tauri-plugin-dialog (all platforms); { path: null } on cancel.
            // Runs on an HTTP worker thread, so the blocking dialog API is safe here.
            use tauri_plugin_dialog::DialogExt;
            let folder = args.get("folder").and_then(|v| v.as_bool()).unwrap_or(true);
            let prompt = args
                .get("prompt")
                .and_then(|v| v.as_str())
                .unwrap_or("Choose")
                .to_string();
            let handle = APP_HANDLE
                .get()
                .cloned()
                .ok_or("folder picker unavailable")?;
            let builder = handle.dialog().file().set_title(prompt);
            let picked = if folder {
                builder.blocking_pick_folder()
            } else {
                // The only file (not folder) pick is the branding logo: images only.
                builder
                    .add_filter("Images", logo::LOGO_EXTENSIONS)
                    .blocking_pick_file()
            };
            let path = picked
                .and_then(|fp| fp.into_path().ok())
                .filter(|p| !p.as_os_str().is_empty());
            if !folder {
                if let Some(p) = &path {
                    // Same checks as read_logo_image, so a bad pick is reported right away.
                    logo::read_logo(p)?;
                }
            }
            Ok(json!({ "path": path.map(|p| p.to_string_lossy().to_string()) }))
        }
        "save_text_file" => {
            // CSV and other exports: a blob download link does nothing in the app's webview,
            // so ask where to save with the native dialog and write the file here.
            // { path: null } on cancel.
            use tauri_plugin_dialog::DialogExt;
            let contents = args
                .get("contents")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let file_name = args
                .get("file_name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("export.csv")
                .to_string();
            let ext = Path::new(&file_name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("csv")
                .to_string();
            let handle = APP_HANDLE.get().cloned().ok_or("save dialog unavailable")?;
            let picked = handle
                .dialog()
                .file()
                .set_title("Save Export")
                .set_file_name(file_name)
                .add_filter(ext.to_uppercase(), &[ext.as_str()])
                .blocking_save_file();
            let Some(path) = picked.and_then(|fp| fp.into_path().ok()) else {
                return Ok(json!({ "path": null }));
            };
            std::fs::write(&path, contents.as_bytes())
                .map_err(|e| format!("Could not save {}: {e}", path.display()))?;
            Ok(json!({ "path": path.to_string_lossy() }))
        }
        "read_logo_image" => {
            // Branding logo → data URL so the webview can show a file outside the bundle.
            // Images only (extension + magic bytes, at most 10 MB); never a generic file reader.
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if path.is_empty() {
                return Ok(json!({ "data_url": null }));
            }
            let url =
                logo::read_logo_data_url(std::path::Path::new(path), orderthumbs::encode_b64)?;
            Ok(json!({ "data_url": url }))
        }
        "settings_reveal_in_finder" => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if path.is_empty() {
                return Err("path is required".into());
            }
            reveal_in_file_manager(path)?;
            Ok(json!({ "ok": true }))
        }
        "publish_catalog_dry_run" => publish_catalog_cmd(state, &args, true),
        "publish_catalog" => publish_catalog_cmd(state, &args, false),
        "shop_session_status" => shop_session_status_cmd(state),
        "shop_sign_in" => shop_sign_in_cmd(state, &args),
        "shop_sign_out" => fp_sync::session::SessionStore::new(&state.data_dir)
            .delete()
            .map(|_| json!({"signed_in": false})),
        "import_store_orders" => import_store_orders_cmd(state),
        "set_order_tracking" => set_order_tracking_cmd(state, &args),
        "get_device_label" => Ok(json!({ "label": device_label() })),
        "get_sync_status" => serde_json::to_value(SyncStatus::default()).map_err(|e| e.to_string()),
        other => Err(format!("Unknown invoke command: {other}")),
    }
}

// --- Shop catalog publish (store_catalog row id=current) ---
/// Shop owner's Supabase session (Windows Credential Manager, or `<data_dir>/shop_session.json` as the fallback;
/// see `fp_sync::session`), refreshed here when expired. Never a service key. None = not signed in.
fn read_shop_session_checked(
    state: &AppState,
    settings: &fp_core::models::ShopSettings,
) -> Result<Option<(String, Option<String>)>, fp_sync::session::SessionError> {
    use fp_sync::session::{valid_session, SessionError, SessionStore, SupabaseAuth};
    let auth = SupabaseAuth::new(&settings.supabase_url, &settings.supabase_anon_key)
        .map_err(SessionError::SignInAgain)?;
    Ok(valid_session(
        &auth,
        &SessionStore::new(&state.data_dir),
        chrono::Utc::now().timestamp(),
    )?
    .map(|s| (s.access_token, s.user_id)))
}

fn read_shop_session(
    state: &AppState,
    settings: &fp_core::models::ShopSettings,
) -> Result<Option<(String, Option<String>)>, String> {
    read_shop_session_checked(state, settings).map_err(String::from)
}

/// For `with_refresher`: after a 401, refresh the saved session even if it hasn't expired.
fn shop_token_refresher(
    state: &AppState,
    settings: &fp_core::models::ShopSettings,
) -> fp_sync::supabase::TokenRefresher {
    let (dir, url, key) = (
        state.data_dir.clone(),
        settings.supabase_url.clone(),
        settings.supabase_anon_key.clone(),
    );
    Box::new(move || {
        let auth = fp_sync::session::SupabaseAuth::new(&url, &key)?;
        fp_sync::session::force_refresh(
            &auth,
            &fp_sync::session::SessionStore::new(&dir),
            chrono::Utc::now().timestamp(),
        )
        .map(|s| s.access_token)
        .map_err(String::from)
    })
}

pub(crate) fn shop_settings_for_plate(state: &AppState) -> Result<fp_core::models::ShopSettings, String> {
    shop_settings(state)
}

fn shop_settings(state: &AppState) -> Result<fp_core::models::ShopSettings, String> {
    let ledger = state.ledger.lock().map_err(|e| e.to_string())?;
    ledger.get_settings().map_err(|e| e.to_string())
}

/// `shop_session_status` -> `{connected, signed_in, email?, user_id?, expires_at?, expired?}`. No tokens.
fn shop_session_status_cmd(state: &AppState) -> Result<Value, String> {
    let settings = shop_settings(state)?;
    let connected =
        !settings.supabase_url.trim().is_empty() && !settings.supabase_anon_key.trim().is_empty();
    let mut v = match fp_sync::session::SessionStore::new(&state.data_dir).read() {
        Some(s) => s.public_status(chrono::Utc::now().timestamp()),
        None => json!({"signed_in": false}),
    };
    v["connected"] = json!(connected);
    Ok(v)
}

/// `shop_sign_in {email, password}`: Supabase Auth password grant; saves the session
/// (Windows Credential Manager, or the 0600 file on Mac/Linux).
fn shop_sign_in_cmd(state: &AppState, args: &Value) -> Result<Value, String> {
    let settings = shop_settings(state)?;
    if settings.supabase_url.trim().is_empty() || settings.supabase_anon_key.trim().is_empty() {
        return Ok(json!({"connected": false, "signed_in": false}));
    }
    let email = args.get("email").and_then(Value::as_str).unwrap_or("");
    let password = args.get("password").and_then(Value::as_str).unwrap_or("");
    let auth =
        fp_sync::session::SupabaseAuth::new(&settings.supabase_url, &settings.supabase_anon_key)?;
    let now = chrono::Utc::now().timestamp();
    let s = fp_sync::session::sign_in(
        &auth,
        &fp_sync::session::SessionStore::new(&state.data_dir),
        email,
        password,
        now,
    )?;
    let mut v = s.public_status(now);
    v["connected"] = json!(true);
    Ok(v)
}

/// `set_order_tracking {orderId, trackingNumber}`: saves the pasted tracking text in the order's
/// existing `tracking_number` ship field. Other ship fields are kept as they
/// are. Blank clears it.
fn set_order_tracking_cmd(state: &AppState, args: &Value) -> Result<Value, String> {
    let order_id = args
        .get("orderId")
        .or_else(|| args.get("order_id"))
        .and_then(Value::as_str)
        .ok_or("orderId is required")?;
    let tracking = args
        .get("trackingNumber")
        .or_else(|| args.get("tracking_number"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| t.chars().take(120).collect::<String>());
    let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
    let snap = ledger.snapshot().map_err(|e| e.to_string())?;
    let order = snap
        .orders
        .iter()
        .find(|o| o.id == order_id)
        .ok_or_else(|| format!("Order not found: {order_id}"))?;
    let mut ship = order.ship.clone();
    ship.tracking_number = tracking;
    let snap = ledger
        .set_order_ship_fields(order_id, ship)
        .map_err(|e| e.to_string())?;
    serde_json::to_value(snap).map_err(|e| e.to_string())
}

/// This computer's name for activity logs (e.g. "Workshop Mac (FarmPrint)"); falls back to
/// "FarmPrint" when the OS doesn't say.
fn device_label() -> String {
    fn run(cmd: &str, args: &[&str]) -> Option<String> {
        let out = std::process::Command::new(cmd).args(args).output().ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !s.is_empty()).then_some(s)
    }
    let name = if cfg!(target_os = "macos") {
        run("scutil", &["--get", "ComputerName"]).or_else(|| run("hostname", &["-s"]))
    } else if cfg!(target_os = "windows") {
        std::env::var("COMPUTERNAME")
            .ok()
            .filter(|s| !s.trim().is_empty())
    } else {
        std::fs::read_to_string("/etc/hostname")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| run("hostname", &[]))
    };
    match name {
        Some(n) => format!("{} (FarmPrint)", n.chars().take(60).collect::<String>()),
        None => "FarmPrint".to_string(),
    }
}

/// Writes the publish preview without the shop's private access token, owner-only (0600) on
/// Mac/Linux.
fn write_publish_preview(path: &Path, next: &Value) -> Result<(), String> {
    let mut redacted = next.clone();
    if let Some(o) = redacted.as_object_mut() {
        if o.contains_key("access_token") {
            o.insert("access_token".into(), json!("(hidden)"));
        }
    }
    let body = serde_json::to_string_pretty(&redacted).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// `publish_catalog_dry_run` / `publish_catalog`. Args (optional): `{ "access_token": "<new shop
/// access token>" }`. Returns `{connected, published, diff, preview_path}`; on a fresh install
/// (no Supabase URL/anon key) returns `{connected:false, ...}` and does nothing.
fn publish_catalog_cmd(state: &AppState, args: &Value, dry_run: bool) -> Result<Value, String> {
    use fp_sync::publish::{
        build_snapshot, diff_snapshots, publish_catalog, CatalogUploader, PublishInput,
    };
    let (snap, settings) = {
        let ledger = state.ledger.lock().map_err(|e| e.to_string())?;
        (
            ledger.snapshot().map_err(|e| e.to_string())?,
            ledger.get_settings().map_err(|e| e.to_string())?,
        )
    };
    if settings.supabase_url.trim().is_empty() || settings.supabase_anon_key.trim().is_empty() {
        return Ok(json!({"connected": false, "published": false,
            "message": "No shop connected yet. Connect your shop website in Settings › Store."}));
    }
    let Some((jwt, user_id)) = read_shop_session(state, &settings)? else {
        return if dry_run {
            Err("Sign in to your shop account in Settings › Store to compare with the live catalog.".into())
        } else {
            Err("Sign in to your shop account in Settings › Store before publishing.".into())
        };
    };
    let mut uploader = fp_sync::supabase::SupabaseUploader::new(
        &settings.supabase_url,
        &settings.supabase_anon_key,
        &jwt,
        user_id,
    )
    .map_err(|e| e.to_string())?
    .with_refresher(shop_token_refresher(state, &settings));
    let input = PublishInput {
        filaments: &snap.filaments,
        products: &snap.products,
        settings: &settings,
        published_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        access_token: args
            .get("access_token")
            .and_then(Value::as_str)
            .filter(|t| !t.trim().is_empty())
            .map(str::to_owned),
        product_page_3d: settings
            .product_page_3d_set
            .then_some(settings.product_page_3d),
    };
    let current = uploader.fetch_current().map_err(|e| e.to_string())?;
    let next = build_snapshot(&input, current.as_ref()).map_err(|e| e.to_string())?;
    let diff = diff_snapshots(current.as_ref(), &next);
    // Local preview for the user to read. The shop access token is hidden in it.
    let preview = state.data_dir.join("catalog_publish_preview.json");
    write_publish_preview(&preview, &next)?;
    if !dry_run {
        publish_catalog(&input, &mut uploader).map_err(|e| e.to_string())?;
    }
    Ok(
        json!({"connected": true, "published": !dry_run, "diff": diff,
              "preview_path": preview.to_string_lossy()}),
    )
}

/// `import_store_orders`: pull paid, pending website orders from `store_orders` and add new
/// ones to the local ledger (dedupe: local `imported_store_orders`).
/// Claim setting on (`store_ingest_claim_enabled`, default): each new row is claimed FIRST
/// with a conditional PATCH (`imported_at=is.null`, `claimed_by` = this install's device id)
/// and imported only if the claim returned the row. Empty = another device has it (skip);
/// request error = retry next time; claimed but not saved locally = `claimed_not_saved`
/// (logged loudly, shown in the banner). Setting off: read-only, local dedupe only.
/// Owner session only (never the anon key as bearer, never a service key). Not configured ->
/// `{connected:false}`; not signed in -> `{signed_in:false, message:"Sign in to the shop to
/// import orders"}`. No status write-back. Never returns or logs tokens.
fn import_store_orders_cmd(state: &AppState) -> Result<Value, String> {
    use fp_sync::store_ingest::{
        apply_imports, claim_candidates, fetch_for_ingest, gate_result, import_gate, iso_utc_now,
        prepare_ingest, ImportGate,
    };
    let settings = shop_settings(state)?;
    let token = if settings.supabase_url.trim().is_empty()
        || settings.supabase_anon_key.trim().is_empty()
    {
        None
    } else {
        // Offline or a turned-down refresh says so; only a missing session reads as "Sign in".
        match read_shop_session_checked(state, &settings) {
            Ok(t) => t.map(|(t, _)| t),
            Err(e) => return Ok(e.import_result()),
        }
    };
    let gate = import_gate(
        &settings.supabase_url,
        &settings.supabase_anon_key,
        token.as_deref(),
    );
    if let Some(v) = gate_result(&gate) {
        return Ok(v);
    }
    let ImportGate::Ready(owner_jwt) = gate else {
        unreachable!()
    };
    let source = fp_sync::supabase::SupabaseStoreOrderReader::new(
        &settings.supabase_url,
        &settings.supabase_anon_key,
        &owner_jwt,
    )?
    .with_refresher(shop_token_refresher(state, &settings));
    let claim_on = settings.store_ingest_claim_on();
    // 1. Network reads, no ledger lock.
    let (rows, configs, catalog_warning) = fetch_for_ingest(&source)?;
    // 2. Local dedupe + mapping (lock), plus this install's device id.
    let (mut prep, device_id) = {
        let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
        let dev = if claim_on {
            Some(ledger.device_id().map_err(|e| e.to_string())?)
        } else {
            None
        };
        (prepare_ingest(&rows, &ledger, &configs)?, dev)
    };
    // 3. Claim each new row on the shop before saving it (network, no lock).
    let to_insert = match &device_id {
        Some(dev) => claim_candidates(&source, &mut prep, dev, &iso_utc_now()),
        None => std::mem::take(&mut prep.candidates),
    };
    // 4. Local insert (lock).
    let mut report = prep.report;
    let snapshot = {
        let mut ledger = state.ledger.lock().map_err(|e| e.to_string())?;
        apply_imports(&mut ledger, &to_insert, &mut report, claim_on);
        if report.imported > 0 {
            Some(ledger.snapshot().map_err(|e| e.to_string())?)
        } else {
            None
        }
    };
    report.warnings.extend(catalog_warning);
    for id in &report.claimed_not_saved {
        eprintln!("[store ingest] ERROR: website order {id} was CLAIMED on the shop but NOT SAVED locally. Add it by hand.");
    }
    for w in &report.warnings {
        eprintln!("[store ingest] warning: {w}");
    }
    let mut v = serde_json::to_value(&report).map_err(|e| e.to_string())?;
    v["connected"] = json!(true);
    v["signed_in"] = json!(true);
    if let Some(s) = snapshot {
        v["snapshot"] = serde_json::to_value(s).map_err(|e| e.to_string())?;
    }
    Ok(v)
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "glb" => "model/gltf-binary",
        "stl" => "model/stl",
        "3mf" => "model/3mf",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn query_param(raw_path: &str, key: &str) -> Option<String> {
    let query = raw_path.split_once('?')?.1;
    for pair in query.split('&') {
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        if name == key {
            return Some(percent_decode(value));
        }
    }
    None
}

fn meshes_from_upload(bytes: &[u8], filename: &str) -> Result<Value, String> {
    if bytes.is_empty() {
        return Err("The mesh file was empty.".to_string());
    }
    let lower = filename.to_ascii_lowercase();
    let is_3mf = lower.ends_with(".3mf")
        || lower.ends_with(".model")
        || bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"<?xml")
        || bytes.starts_with(b"<model");
    let meshes = if is_3mf {
        parse_3mf_parts(bytes, Some(filename))?
    } else {
        vec![parse_stl_bytes(
            bytes,
            Path::new(filename)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Imported Part"),
        )?]
    };
    // Weld shared corners here (STL repeats all three corners of every triangle), so about a
    // sixth as many numbers cross to the UI as JSON.
    let flat: Vec<FlatParsedMesh> = meshes
        .into_iter()
        .map(|mesh| {
            let (positions, indices) = fp_mesh::weld_mesh(&mesh);
            FlatParsedMesh {
                name: mesh.name,
                positions: positions.into_iter().flatten().collect(),
                indices: indices.into_iter().flatten().collect(),
            }
        })
        .filter(|mesh| mesh.positions.len() >= 9 && mesh.indices.len() >= 3)
        .collect();
    if flat.is_empty() {
        return Err(format!("No triangles found in {filename}."));
    }
    serde_json::to_value(flat).map_err(|err| err.to_string())
}

fn percent_decode(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let raw = input.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            if let Ok(hex_str) = std::str::from_utf8(&raw[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex_str, 16) {
                    bytes.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        bytes.push(raw[i]);
        i += 1;
    }
    String::from_utf8_lossy(&bytes).to_string()
}

/// Dev HTTP server gate: Host must be loopback on our port, Origin (if any) must be the
/// same loopback origin. Rejects DNS-rebinding hosts and cross-site pages.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn dev_http_request_allowed(host: Option<&str>, origin: Option<&str>, port: u16) -> bool {
    let allowed_hosts = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    let Some(host) = host else { return false };
    if !allowed_hosts.iter().any(|h| h == host) {
        return false;
    }
    match origin {
        None => true,
        Some(o) => allowed_hosts.iter().any(|h| o == format!("http://{h}")),
    }
}

/// Starts the legacy HTTP API/UI server, debug builds only (release builds use Tauri IPC
/// and the `fpcatalog` scheme). Always binds 127.0.0.1; a bind failure is not fatal.
#[cfg(debug_assertions)]
fn start_dev_http_server(state: Arc<AppState>) {
    if std::env::var("FARMPRINT_NO_DEV_HTTP").is_ok() {
        return;
    }
    let port = std::env::var("PORT").unwrap_or_else(|_| "1420".to_string());
    let port: u16 = match port.parse() {
        Ok(p) => p,
        Err(_) => {
            eprintln!("FarmPrint dev server: invalid PORT {port:?}; not started");
            return;
        }
    };
    let bind_addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = match std::net::TcpListener::bind(bind_addr) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("FarmPrint dev server not started on {bind_addr}: {e}");
            return;
        }
    };
    println!("FarmPrint dev HTTP API (debug build only) listening on http://{bind_addr}");
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let st = Arc::clone(&state);
            std::thread::spawn(move || {
                handle_http_client(stream, st);
            });
        }
    });
}

#[cfg(not(debug_assertions))]
fn start_dev_http_server(_state: Arc<AppState>) {}

/// Native print of the calling window. `window.print()` does nothing in the macOS
/// WKWebView, so the UI calls this instead; the page's `@media print` CSS decides what
/// prints (the kitting cards only).
#[tauri::command]
async fn print_current_window(webview_window: tauri::WebviewWindow) -> Result<(), String> {
    // Windows (WebView2) and Linux (WebKitGTK) support window.print(); macOS needs the
    // native print operation below.
    #[cfg(target_os = "macos")]
    let r = webview_window
        .with_webview(|wv| unsafe { macos_print_kitting(wv.inner(), wv.ns_window()) });
    #[cfg(not(target_os = "macos"))]
    let r = webview_window.eval("window.print()");
    r.map_err(|e| format!("Printing failed: {e}"))
}

/// Opens the macOS print panel for the WKWebView, starting on Letter with 0.5 in margins.
/// WKWebView's print takes the paper and margins from NSPrintInfo, not from CSS `@page`.
/// Letter is only the panel's starting value: the user can pick A4 or any other paper, and
/// the kitting card CSS is fluid, so it fills whatever page is chosen. Same flow as wry's
/// `print_with_options` otherwise. Runs on the main thread (`with_webview`).
#[cfg(target_os = "macos")]
unsafe fn macos_print_kitting(webview: *mut std::ffi::c_void, ns_window: *mut std::ffi::c_void) {
    use objc2_app_kit::{NSPaperOrientation, NSPrintInfo, NSWindow};
    use objc2_foundation::NSSize;
    use objc2_web_kit::WKWebView;

    let (Some(webview), Some(window)) = (
        (webview as *const WKWebView).as_ref(),
        (ns_window as *const NSWindow).as_ref(),
    ) else {
        return;
    };
    const IN: f64 = 72.0; // points per inch
    let info = NSPrintInfo::sharedPrintInfo();
    info.setPaperSize(NSSize::new(8.5 * IN, 11.0 * IN)); // US Letter
    info.setOrientation(NSPaperOrientation::Portrait);
    // Matches the CSS `@page { margin: 0.5in }`.
    info.setTopMargin(0.5 * IN);
    info.setBottomMargin(0.5 * IN);
    info.setLeftMargin(0.5 * IN);
    info.setRightMargin(0.5 * IN);
    info.setHorizontallyCentered(false);
    info.setVerticallyCentered(false);

    let op = webview.printOperationWithPrintInfo(&info);
    op.setShowsPrintPanel(true);
    op.setShowsProgressPanel(true);
    op.setCanSpawnSeparateThread(true);
    // WKWebView's print view can start with an empty frame, which prints blank pages.
    if let Some(view) = op.view() {
        view.setFrame(webview.frame());
    }
    op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
        window,
        None,
        None,
        std::ptr::null_mut(),
    );
}

/// IPC replacement for POST /api/invoke/<cmd>. Runs off the main thread because some
/// commands block (folder picker, Bambu staging).
#[tauri::command]
async fn fp_invoke(
    state: tauri::State<'_, Arc<AppState>>,
    cmd: String,
    args: Option<Value>,
) -> Result<Value, String> {
    let st = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        dispatch_invoke(&st, &cmd, args.unwrap_or_else(|| json!({})))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// IPC replacement for POST /api/parse-mesh. Body is the raw file bytes; the filename is
/// URI-encoded in the `x-fp-filename` header.
#[tauri::command]
async fn fp_parse_mesh(request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("expected raw file bytes".to_string()),
    };
    let filename = request
        .headers()
        .get("x-fp-filename")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_else(|| "mesh".to_string());
    tauri::async_runtime::spawn_blocking(move || meshes_from_upload(&bytes, &filename))
        .await
        .map_err(|e| e.to_string())?
}

/// IPC replacement for POST /api/context-menu. Blocks until the popup closes, so it
/// must not run on the main thread (the menu itself is built there).
#[tauri::command]
async fn fp_context_menu(items: Value) -> Result<Value, String> {
    let body = serde_json::to_vec(&json!({ "items": items })).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || show_native_context_menu(&body))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn handle_http_client(mut stream: TcpStream, state: Arc<AppState>) {
    let mut buf = vec![0u8; 65536];
    let mut total_read = 0usize;
    let header_end;
    loop {
        match stream.read(&mut buf[total_read..]) {
            Ok(0) => return,
            Ok(n) => {
                total_read += n;
                if let Some(pos) = buf[..total_read].windows(4).position(|w| w == b"\r\n\r\n") {
                    header_end = pos + 4;
                    break;
                }
                if total_read == buf.len() {
                    buf.resize(buf.len() * 2, 0);
                }
            }
            Err(_) => return,
        }
    }

    let header_str = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = header_str.lines();
    let req_line = match lines.next() {
        Some(l) => l,
        None => return,
    };
    let mut parts = req_line.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let raw_path = parts.next().unwrap_or("/");
    let clean_path = raw_path.split('?').next().unwrap_or("/");

    let mut content_length = 0usize;
    let mut host: Option<String> = None;
    let mut origin: Option<String> = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim();
            if k.eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse::<usize>().unwrap_or(0);
            } else if k.eq_ignore_ascii_case("host") {
                host = Some(v.trim().to_ascii_lowercase());
            } else if k.eq_ignore_ascii_case("origin") {
                origin = Some(v.trim().to_ascii_lowercase());
            }
        }
    }

    // Dev-only server: same-origin callers on loopback only. A foreign Host defeats
    // DNS rebinding; a foreign Origin blocks other web pages. No CORS headers are sent.
    let local_port = stream.local_addr().map(|a| a.port()).unwrap_or(0);
    if !dev_http_request_allowed(host.as_deref(), origin.as_deref(), local_port) {
        let msg = b"Forbidden";
        let header = format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            msg.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(msg);
        return;
    }

    let body_already = total_read.saturating_sub(header_end);
    if content_length > body_already {
        let needed = content_length - body_already;
        buf.resize(header_end + content_length, 0);
        let mut offset = total_read;
        while offset < header_end + content_length {
            match stream.read(&mut buf[offset..header_end + content_length]) {
                Ok(0) => break,
                Ok(n) => offset += n,
                Err(_) => break,
            }
            let _ = needed;
        }
    }
    let body_bytes = &buf[header_end..(header_end + content_length).min(buf.len())];

    if method == "OPTIONS" {
        // Same-origin callers never preflight; answer without any CORS allowance.
        let resp = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
        let _ = stream.write_all(resp.as_bytes());
        return;
    }

    if clean_path == "/api/health" {
        let payload = br#"{"ok":true,"service":"farmprint-rust-backend"}"#;
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            payload.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(payload);
        return;
    }

    if let Some(cmd) = clean_path.strip_prefix("/api/invoke/") {
        let args: Value = if body_bytes.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(body_bytes).unwrap_or_else(|_| json!({}))
        };
        match dispatch_invoke(&state, cmd, args) {
            Ok(val) => {
                let payload = serde_json::to_vec(&val).unwrap_or_else(|_| b"{}".to_vec());
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&payload);
            }
            Err(err) => {
                let payload = serde_json::to_vec(&json!({ "error": err })).unwrap_or_default();
                let header = format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&payload);
            }
        }
        return;
    }

    // Raw bytes, not a JSON number array. Bambu 3MF files are ZIP64 or store
    // sizes in a data descriptor, and the browser walker stops before any mesh.
    if method == "POST" && clean_path == "/api/context-menu" {
        let (status, val) = match show_native_context_menu(body_bytes) {
            Ok(v) => ("200 OK", v),
            Err(e) => ("400 Bad Request", json!({ "error": e })),
        };
        let payload = serde_json::to_vec(&val).unwrap_or_default();
        let header = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\n\r\n",
            payload.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(&payload);
        return;
    }

    if method == "POST" && clean_path == "/api/parse-mesh" {
        let filename = query_param(raw_path, "filename").unwrap_or_else(|| "mesh".to_string());
        match meshes_from_upload(body_bytes, &filename) {
            Ok(val) => {
                let payload = serde_json::to_vec(&val).unwrap_or_else(|_| b"[]".to_vec());
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&payload);
            }
            Err(err) => {
                let payload = serde_json::to_vec(&json!({ "error": err })).unwrap_or_default();
                let header = format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&payload);
            }
        }
        return;
    }

    // Serve static files from ui/dist or ui/public
    let decoded_rel = percent_decode(clean_path.trim_start_matches('/'));
    let rel_path = if decoded_rel.is_empty() {
        "index.html".to_string()
    } else {
        decoded_rel
    };

    let candidate_dist = state.ui_dist_dir.join(&rel_path);
    let candidate_pub = state.ui_public_dir.join(&rel_path);
    let candidate_data = rel_path
        .strip_prefix("catalog/")
        .filter(|rest| !rest.split('/').any(|seg| seg == ".."))
        .and_then(|rest| app_data_catalog_dir(&state).map(|dir| dir.join(rest)));
    // The user's own catalog files win over anything bundled with the app.
    let candidate_data = candidate_data.filter(|p| p.is_file());
    let target_file = if let Some(data_file) = candidate_data.clone() {
        Some(data_file)
    } else if candidate_dist.is_file() {
        Some(candidate_dist)
    } else if candidate_pub.is_file() {
        Some(candidate_pub)
    } else {
        let fallback_index = state.ui_dist_dir.join("index.html");
        if fallback_index.is_file() && !rel_path.starts_with("catalog/") {
            Some(fallback_index)
        } else {
            None
        }
    };

    if let Some(file_path) = target_file {
        if let Ok(bytes) = std::fs::read(&file_path) {
            let ctype = content_type_for_path(&file_path);
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nCache-Control: no-cache\r\nContent-Length: {}\r\n\r\n",
                ctype,
                bytes.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(&bytes);
            return;
        }
    }

    let not_found = b"Not Found";
    let header = format!(
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n",
        not_found.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(not_found);
}

pub fn run() {
    let repo_root = resolve_repo_root();
    // Per-user data folder; one-time COPY of the legacy in-repo ProductionTracker/ (never moved).
    let data_dir = datadir::user_data_dir();
    let legacy_tracker = repo_root.join("ProductionTracker");
    let bundled_catalog = repo_root.join("ui").join("public").join("catalog");
    match datadir::prepare_data_dir(&data_dir, Some(&legacy_tracker), Some(&bundled_catalog)) {
        Ok(outcome) => println!("FarmPrint data folder {} ({outcome:?})", data_dir.display()),
        Err(e) => eprintln!(
            "FarmPrint data folder {} not prepared: {e}",
            data_dir.display()
        ),
    }
    let db_path = data_dir.join("farmprint_shop_v2.sqlite");
    // A shop file that won't open must not crash the app with no explanation: start with a
    // placeholder (commands refused) and show a recovery dialog instead.
    let (ledger, open_error) = match ShopLedger::open(&db_path) {
        Ok(ledger) => (ledger, None),
        Err(e) => {
            eprintln!("FarmPrint: could not open {}: {e}", db_path.display());
            let placeholder = ShopLedger::open_in_memory().expect("in-memory placeholder ledger");
            (placeholder, Some(e.to_string()))
        }
    };

    let ui_dist_dir = repo_root.join("ui").join("dist");
    let ui_public_dir = repo_root.join("ui").join("public");

    let state = Arc::new(AppState {
        ledger: Mutex::new(ledger),
        tracker_root: ui_public_dir.clone(),
        ui_dist_dir,
        ui_public_dir,
        data_dir: data_dir.clone(),
        open_error: open_error.clone(),
    });

    // The HTTP API/UI server on 127.0.0.1 exists only in debug builds (see start_dev_http_server).
    if open_error.is_none() {
        start_dev_http_server(Arc::clone(&state));
    }

    // Tauri window + plugins on macOS, Windows and Linux (blocks on the main thread).
    tauri::Builder::default()
        .manage(Arc::clone(&state))
        .menu(feedback::build_app_menu)
        .invoke_handler(tauri::generate_handler![
            fp_invoke,
            fp_parse_mesh,
            fp_context_menu,
            print_current_window
        ])
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        // Catalog pictures/meshes from the user's data folder (<data>/catalog). Release
        // builds don't bundle ui/public/catalog, so the UI loads `fpcatalog://localhost/<rel>`
        // (Windows: `http://fpcatalog.localhost/<rel>`) instead of relative `/catalog/<rel>`.
        .register_uri_scheme_protocol("fpcatalog", |_ctx, request| {
            serve_catalog_file(request.uri().path())
        })
        .setup(move |app| {
            let _ = APP_HANDLE.set(app.handle().clone());
            if let Some(err) = open_error.clone() {
                use tauri::Manager;
                for (_, w) in app.webview_windows() {
                    let _ = w.hide();
                }
                let handle = app.handle().clone();
                let db_path = db_path.clone();
                // Blocking dialogs must not run on the main thread.
                std::thread::spawn(move || db_open_failed_dialog(handle, db_path, err));
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            if let Some(rest) = event.id().0.strip_prefix("fpctx:") {
                if let Ok(mut g) = MENU_PENDING.lock() {
                    if let Some(tx) = g.take() {
                        let _ = tx.send(rest.to_string());
                    }
                }
                return;
            }
            if let Some(kind) = feedback::issue_kind_from_menu_id(&event.id().0) {
                feedback::open_issue(app, kind);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running FarmPrint tauri application");
}

#[cfg(test)]
mod multi_select_handoff_tests {
    use super::{build_plate_bytes, plate_bed_for, plate_items_for};
    use fp_core::{models::TransitionRequest, ShopLedger};
    use fp_mesh::TriangleMesh;
    use std::io::Read;

    fn cube(s: f32) -> TriangleMesh {
        TriangleMesh {
            name: "cube".into(),
            positions: vec![
                [0.0, 0.0, 0.0],
                [s, 0.0, 0.0],
                [s, s, 0.0],
                [0.0, s, 0.0],
                [0.0, 0.0, s],
                [s, 0.0, s],
                [s, s, s],
                [0.0, s, s],
            ],
            indices: vec![
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
            ],
        }
    }

    fn zip_text(bytes: &[u8], name: &str) -> String {
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut out = String::new();
        z.by_name(name).unwrap().read_to_string(&mut out).unwrap();
        out
    }

    /// A multi-select send: parts from two orders in two colors, including the same part
    /// from both orders, go out as one action (one plate job) on one plate.
    #[test]
    fn one_handoff_from_two_orders_and_two_colors_is_one_job_on_one_plate() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let printer_id = ledger.snapshot().unwrap().printers[0].id.clone();
        let picked = ["unit-demo-1-base", "unit-demo-2-base", "unit-demo-2-lid"];
        // The same unit named twice must still move once.
        let mut ids: Vec<String> = picked.iter().map(|s| s.to_string()).collect();
        ids.push("unit-demo-2-lid".to_string());
        let snap = ledger
            .transition_units(TransitionRequest {
                unit_ids: ids,
                to_state: "Printing".into(),
                printer_id: Some(printer_id.clone()),
                actor_device: "Test".into(),
                source_surface: "Parts to Print (selection)".into(),
                action_label: "Print 3 selected parts".into(),
                failure_reason: None,
                failure_note: None,
                filament_id: None,
            })
            .unwrap();
        let units: Vec<&fp_core::PartUnit> = snap
            .orders
            .iter()
            .flat_map(|o| o.lines.iter())
            .flat_map(|l| l.units.iter())
            .filter(|u| picked.contains(&u.id.as_str()))
            .collect();
        assert_eq!(units.len(), 3);
        let job = units[0].plate_job_id.clone().expect("a plate job id");
        for u in &units {
            assert_eq!(u.state, "Printing", "{}", u.id);
            assert_eq!(u.plate_job_id.as_deref(), Some(job.as_str()), "{}", u.id);
            assert_eq!(u.printer_id.as_deref(), Some(printer_id.as_str()));
        }
        // Nothing else joined the job, and each picked unit was moved exactly once.
        let in_job = snap
            .orders
            .iter()
            .flat_map(|o| o.lines.iter())
            .flat_map(|l| l.units.iter())
            .filter(|u| u.plate_job_id.as_deref() == Some(job.as_str()))
            .count();
        assert_eq!(in_job, 3);
        let moved: Vec<&str> = snap
            .flow_events
            .iter()
            .filter(|e| {
                e.to_state == "Printing" && e.source_surface == "Parts to Print (selection)"
            })
            .filter_map(|e| e.unit_id.as_deref())
            .collect();
        assert_eq!(moved.len(), 3, "{moved:?}");
        let orders: std::collections::HashSet<_> = units.iter().map(|u| &u.order_id).collect();
        let colors: std::collections::HashSet<_> = units.iter().map(|u| &u.filament_hex).collect();
        assert_eq!((orders.len(), colors.len()), (2, 2));

        // The plate: one object per unit, each with its own name and color.
        let with_mesh = ledger.units_by_ids(&picked.map(String::from)).unwrap();
        assert_eq!(with_mesh.len(), 3);
        let meshes: Vec<TriangleMesh> = with_mesh.iter().map(|_| cube(20.0)).collect();
        let items = plate_items_for(&with_mesh, &meshes);
        let mut names: Vec<String> = items.iter().map(|i| i.name.clone()).collect();
        names.sort();
        let mut want: Vec<String> = with_mesh
            .iter()
            .map(|(u, _)| {
                format!(
                    "{}_{}_{}_{}",
                    u.order_code,
                    u.part_name.replace(' ', "_"),
                    u.filament_name.replace(' ', "_"),
                    u.unit_index
                )
            })
            .collect();
        want.sort();
        assert_eq!(names, want);
        assert_eq!(names.iter().filter(|n| n.contains("_Base_")).count(), 2);
        for (item, (u, _)) in items.iter().zip(&with_mesh) {
            assert_eq!(item.filament_hex, u.filament_hex);
            assert!(item.name.contains(&u.filament_name.replace(' ', "_")));
        }
        let bytes = build_plate_bytes(&items, plate_bed_for(Some(256.0), Some(256.0))).unwrap();
        let model = zip_text(&bytes, "3D/3dmodel.model");
        let cfg = zip_text(&bytes, "Metadata/model_settings.config");
        for n in &names {
            assert_eq!(model.matches(&format!("name=\"{n}\"")).count(), 1, "{n}");
            assert!(cfg.contains(&format!("value=\"{n}\"")), "{n}");
        }
        assert_eq!(model.matches("<item ").count(), 3);

        // The same part on two lines of one order shares a name; the second gets "-2".
        let twice = vec![with_mesh[0].clone(), with_mesh[0].clone()];
        let named: Vec<String> = plate_items_for(&twice, &meshes[..2])
            .into_iter()
            .map(|i| i.name)
            .collect();
        assert_eq!(named[1], format!("{}-2", named[0]));

        // Too many for the bed: the existing bed check refuses the plate.
        let big: Vec<TriangleMesh> = with_mesh.iter().map(|_| cube(150.0)).collect();
        let err = build_plate_bytes(
            &plate_items_for(&with_mesh, &big),
            plate_bed_for(Some(256.0), Some(256.0)),
        )
        .unwrap_err();
        assert!(err.contains("bed"), "{err}");
    }
}

#[cfg(test)]
mod mark_printing_tests {
    use super::{dispatch_invoke, AppState};
    use fp_core::ShopLedger;
    use serde_json::{json, Value};
    use std::sync::Mutex;

    /// An app state over the demo shop whose catalog folder has no saved models, so a real
    /// Print! handoff can never build a plate here.
    fn state_without_models() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "fp-mark-printing-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let state = AppState {
            ledger: Mutex::new(ShopLedger::open_in_memory().unwrap()),
            tracker_root: dir.clone(),
            ui_dist_dir: dir.clone(),
            ui_public_dir: dir.clone(),
            data_dir: dir.clone(),
            open_error: None,
        };
        (state, dir)
    }

    fn request(ids: &[&str], printer_id: Option<&str>) -> Value {
        json!({
            "unit_ids": ids,
            "to_state": "Printing",
            "printer_id": printer_id,
            "actor_device": "Test",
            "source_surface": "Parts to Print (selection)",
            "action_label": "Marked parts Printing (no slicer)",
            "failure_reason": null,
            "failure_note": null,
        })
    }

    fn units(snap: &Value) -> Vec<Value> {
        snap["orders"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|o| o["lines"].as_array().unwrap().iter())
            .flat_map(|l| l["units"].as_array().unwrap().iter().cloned())
            .collect()
    }

    #[test]
    fn mark_printing_skips_the_slicer_but_makes_the_same_job() {
        let (state, dir) = state_without_models();
        let printer_id = state.ledger.lock().unwrap().snapshot().unwrap().printers[0]
            .id
            .clone();
        let picked = ["unit-demo-1-base", "unit-demo-2-base", "unit-demo-2-lid"];
        // Print! needs a saved model for every part, so it refuses and nothing moves.
        let err = dispatch_invoke(
            &state,
            "transition_units",
            json!({ "request": request(&picked, Some(&printer_id)) }),
        )
        .unwrap_err();
        assert!(err.starts_with("Nothing was sent to the slicer"), "{err}");

        // Mark Printing never builds a plate, so the same parts move. Named twice = moved once.
        let mut ids = picked.to_vec();
        ids.push("unit-demo-2-lid");
        let snap = dispatch_invoke(
            &state,
            "transition_units",
            json!({ "request": request(&ids, Some(&printer_id)), "skip_slicer": true }),
        )
        .unwrap();
        let all = units(&snap);
        let moved: Vec<&Value> = all
            .iter()
            .filter(|u| picked.contains(&u["id"].as_str().unwrap()))
            .collect();
        assert_eq!(moved.len(), 3);
        let job = moved[0]["plate_job_id"].as_str().expect("a plate job id");
        for u in &moved {
            assert_eq!(u["state"], "Printing");
            assert_eq!(u["printer_id"].as_str(), Some(printer_id.as_str()));
            assert_eq!(u["plate_job_id"].as_str(), Some(job));
        }
        assert_eq!(
            all.iter()
                .filter(|u| u["plate_job_id"].as_str() == Some(job))
                .count(),
            3
        );
        // One Flow event per part, all in one undo batch.
        let events: Vec<&Value> = snap["flow_events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| {
                e["to_state"] == "Printing"
                    && e["action_label"] == "Marked parts Printing (no slicer)"
            })
            .collect();
        assert_eq!(events.len(), 3);
        let batch = events[0]["batch_id"].clone();
        assert!(events.iter().all(|e| e["batch_id"] == batch));
        // Nothing was written next to the shop: no plate, no handoff folder.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mark_printing_without_a_printer_is_an_unassigned_job() {
        let (state, dir) = state_without_models();
        let picked = ["unit-demo-1-base", "unit-demo-2-lid"];
        let snap = dispatch_invoke(
            &state,
            "transition_units",
            json!({ "request": request(&picked, None), "skipSlicer": true }),
        )
        .unwrap();
        let moved: Vec<Value> = units(&snap)
            .into_iter()
            .filter(|u| picked.contains(&u["id"].as_str().unwrap()))
            .collect();
        assert_eq!(moved.len(), 2);
        let job = moved[0]["plate_job_id"].as_str().unwrap().to_string();
        for u in &moved {
            assert_eq!(u["state"], "Printing");
            assert!(u["printer_id"].is_null(), "{u}");
            assert_eq!(u["plate_job_id"].as_str(), Some(job.as_str()));
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
