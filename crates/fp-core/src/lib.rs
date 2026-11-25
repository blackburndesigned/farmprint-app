pub mod applock;
pub mod clearance;
pub mod delta;
pub mod feeders;
pub mod insights;
pub mod models;
pub mod order_edit;
pub mod print_areas;
pub mod sample;
pub mod seed;

pub use models::*;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Automatic launch backups kept in `<data>/backups/`.
pub const LAUNCH_BACKUPS_KEPT: usize = 5;
/// Pre-reset backups kept in `<data>/backups/`.
pub const RESET_BACKUPS_KEPT: usize = 10;
/// Source surface of undo events written before batch undo (they were stored as
/// ordinary, undoable transitions). Never offered as undoable.
const LEGACY_UNDO_SURFACE: &str = "Flow Ledger · One-Click Undo";

/// `VACUUM INTO <dir>/<stem>-<prefix><timestamp>.sqlite`, then prune that prefix's
/// files down to the newest `keep`. Returns the backup path.
pub fn backup_database(
    conn: &Connection,
    db_path: &Path,
    prefix: &str,
    keep: usize,
) -> CoreResult<PathBuf> {
    let dir = db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("backups");
    std::fs::create_dir_all(&dir)
        .map_err(|e| CoreError::Validation(format!("Could not create backup folder: {e}")))?;
    let stem = db_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("farmprint_shop_v2");
    let head = format!("{stem}-{prefix}");
    let ts = Utc::now().format("%Y%m%d-%H%M%S%.3f");
    let mut target = dir.join(format!("{head}{ts}.sqlite"));
    let mut n = 1;
    while target.exists() {
        target = dir.join(format!("{head}{ts}-{n}.sqlite"));
        n += 1;
    }
    conn.execute("VACUUM INTO ?1", params![target.to_string_lossy()])?;
    if !target.exists() {
        return Err(CoreError::Validation("Backup file was not written".into()));
    }
    prune_backups(&dir, &head, keep);
    Ok(target)
}

/// Bed size check shared by add/edit: both or neither, 50–2000 mm each.
pub fn validate_bed_size(x: Option<f64>, y: Option<f64>) -> CoreResult<(Option<f64>, Option<f64>)> {
    match (x, y) {
        (None, None) => Ok((None, None)),
        (Some(x), Some(y)) => {
            for v in [x, y] {
                if !v.is_finite() || !(50.0..=2000.0).contains(&v) {
                    return Err(CoreError::Validation(format!(
                        "Bed size {v} mm is out of range (50–2000 mm)."
                    )));
                }
            }
            Ok((Some(x), Some(y)))
        }
        _ => Err(CoreError::Validation(
            "Enter both bed width and depth, or leave both empty.".into(),
        )),
    }
}

/// Optional build height in mm: unset, or 50–2000 mm. Independent of width and depth.
pub fn validate_bed_height(z: Option<f64>) -> CoreResult<Option<f64>> {
    match z {
        None => Ok(None),
        Some(v) if v.is_finite() && (50.0..=2000.0).contains(&v) => Ok(Some(v)),
        Some(v) => Err(CoreError::Validation(format!(
            "Build height {v} mm is out of range (50–2000 mm)."
        ))),
    }
}

/// Days of history kept on top of the newest `keep` backups: the newest backup of each of
/// the last `DAILY_BACKUP_DAYS` days is never pruned, so a problem noticed a week later
/// still has a good copy to go back to.
pub const DAILY_BACKUP_DAYS: i64 = 14;

fn prune_backups(dir: &Path, head: &str, keep: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = rd
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                n.starts_with(head)
                    && n.ends_with(".sqlite")
                    // launch head "<stem>-" must not match "<stem>-reset-…" files
                    && n[head.len()..].starts_with(|c: char| c.is_ascii_digit())
            })
        })
        .collect();
    files.sort(); // timestamp names sort chronologically
    for p in backups_to_prune(&files, head, keep, Utc::now().date_naive()) {
        let _ = std::fs::remove_file(p);
    }
}

/// `files` sorted oldest → newest. Keeps the newest `keep`, plus the newest file of each
/// day within the last `DAILY_BACKUP_DAYS` days (by the UTC date in the file name).
fn backups_to_prune(
    files: &[PathBuf],
    head: &str,
    keep: usize,
    today: chrono::NaiveDate,
) -> Vec<PathBuf> {
    let day_of = |p: &PathBuf| -> Option<chrono::NaiveDate> {
        let name = p.file_name()?.to_str()?;
        let digits = name.get(head.len()..head.len() + 8)?;
        chrono::NaiveDate::parse_from_str(digits, "%Y%m%d").ok()
    };
    let mut keep_set: std::collections::HashSet<usize> =
        (files.len().saturating_sub(keep)..files.len()).collect();
    let mut seen_days = std::collections::HashSet::new();
    for (i, p) in files.iter().enumerate().rev() {
        if let Some(day) = day_of(p) {
            let age = (today - day).num_days();
            if (0..DAILY_BACKUP_DAYS).contains(&age) && seen_days.insert(day) {
                keep_set.insert(i);
            }
        }
    }
    files
        .iter()
        .enumerate()
        .filter(|(i, _)| !keep_set.contains(i))
        .map(|(_, p)| p.clone())
        .collect()
}

/// Backup files for `db_path` in `<dir>/backups/`, newest first (launch, reset and
/// manual backups alike).
pub fn list_backups(db_path: &Path) -> Vec<PathBuf> {
    let dir = db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("backups");
    let stem = db_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("farmprint_shop_v2");
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = rd
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                n.starts_with(&format!("{stem}-")) && n.ends_with(".sqlite") && !n.starts_with("._")
            })
        })
        .map(|p| {
            (
                std::fs::metadata(&p)
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH),
                p,
            )
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    files.into_iter().map(|(_, p)| p).collect()
}

/// Used when the shop file can't be opened. Moves the damaged file (and its -wal/-shm)
/// aside as `<name>.damaged-<timestamp>` (never deleted), then copies backups in,
/// newest first, until one opens. Returns the backup that was restored.
pub fn restore_latest_working_backup(db_path: &Path) -> CoreResult<PathBuf> {
    let candidates = list_backups(db_path);
    if candidates.is_empty() {
        return Err(CoreError::Validation(
            "No backups were found in the backups folder.".into(),
        ));
    }
    let ts = Utc::now().format("%Y%m%d-%H%M%S");
    for suffix in ["", "-wal", "-shm"] {
        let src = PathBuf::from(format!("{}{suffix}", db_path.display()));
        if src.exists() {
            let dst = PathBuf::from(format!("{}{suffix}.damaged-{ts}", db_path.display()));
            std::fs::rename(&src, &dst).map_err(|e| {
                CoreError::Validation(format!("Could not move the damaged shop file aside: {e}"))
            })?;
        }
    }
    for backup in candidates {
        if std::fs::copy(&backup, db_path).is_err() {
            continue;
        }
        match ShopLedger::open(db_path) {
            Ok(ledger) => {
                drop(ledger);
                return Ok(backup);
            }
            Err(_) => {
                for suffix in ["", "-wal", "-shm"] {
                    let _ = std::fs::remove_file(format!("{}{suffix}", db_path.display()));
                }
            }
        }
    }
    Err(CoreError::Validation(
        "None of the backups could be opened.".into(),
    ))
}

/// Dev-only switch: demo seed data (orders, catalog, spools, printers) is loaded only when
/// `FARMPRINT_DEMO_SEED=1`. Release builds for testers start with an empty shop.
pub fn demo_seed_enabled() -> bool {
    matches!(
        std::env::var("FARMPRINT_DEMO_SEED").as_deref(),
        Ok("1") | Ok("true")
    )
}

pub struct ShopLedger {
    conn: Connection,
    /// On-disk DB path (None for in-memory). Used for backups.
    db_path: Option<PathBuf>,
}

impl ShopLedger {
    pub fn open(path: impl AsRef<Path>) -> CoreResult<Self> {
        let path = path.as_ref().to_path_buf();
        let existed = std::fs::metadata(&path)
            .map(|m| m.len() > 0)
            .unwrap_or(false);
        let conn = Connection::open(&path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // Automatic launch backup before any migration/normalize touches the data.
        // Never blocks launch.
        if existed {
            if let Err(e) = backup_database(&conn, &path, "", LAUNCH_BACKUPS_KEPT) {
                eprintln!("FarmPrint: launch backup failed: {e}");
            }
        }
        seed::init_schema(&conn)?;
        // Fresh installs start empty. Generic demo seed data only when FARMPRINT_DEMO_SEED=1.
        if demo_seed_enabled() {
            seed::seed_if_empty(&conn)?;
        }
        Self::normalize_shop_data(&conn)?;
        Ok(Self {
            conn,
            db_path: Some(path),
        })
    }

    pub fn open_in_memory() -> CoreResult<Self> {
        let conn = Connection::open_in_memory()?;
        seed::init_schema(&conn)?;
        seed::seed_if_empty(&conn)?;
        Self::normalize_shop_data(&conn)?;
        Ok(Self {
            conn,
            db_path: None,
        })
    }

    /// Startup/import/reset integrity pass. Parts flagged thumbnail-only or color-only
    /// (`is_tracked = 0` or `is_color_only = 1`) get no new units. Queued units of such
    /// parts (never started) are removed and logged to Flow; units already staged,
    /// printing, printed or later are kept, so no work in progress is ever deleted.
    /// Filaments are never merged here: a shop may own two identical spools on purpose
    /// (see `merge_duplicate_filaments`).
    fn normalize_shop_data(conn: &Connection) -> CoreResult<()> {
        Self::prune_unprinted_queued_units(conn, "FarmPrint", "Startup check")?;
        Ok(())
    }

    /// Removes only `Queued` units whose catalog part is no longer printed (thumbnail-only
    /// or color-only). Writes one `PartRoleChanged` flow event per order and part.
    /// Returns the number of units removed.
    fn prune_unprinted_queued_units(
        conn: &Connection,
        actor_device: &str,
        source_surface: &str,
    ) -> CoreResult<usize> {
        #[allow(clippy::type_complexity)]
        let groups: Vec<(
            String,
            String,
            i64,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
            String,
        )> = {
            let mut stmt = conn.prepare(
                "SELECT u.order_id, u.part_id, COUNT(*), o.order_code, o.customer_name, u.product_id, p.name, cp.name
                 FROM part_units u
                 JOIN catalog_parts cp ON cp.id = u.part_id
                 LEFT JOIN orders o ON o.id = u.order_id
                 LEFT JOIN products p ON p.id = u.product_id
                 WHERE (cp.is_tracked = 0 OR cp.is_color_only = 1) AND u.state = 'Queued'
                 GROUP BY u.order_id, u.part_id
                 ORDER BY u.order_id, u.part_id",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        if groups.is_empty() {
            return Ok(0);
        }
        let now = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let batch_id = Uuid::new_v4().to_string();
        let mut removed = 0usize;
        for (
            order_id,
            part_id,
            n,
            order_code,
            customer_name,
            product_id,
            product_name,
            part_name,
        ) in groups
        {
            removed += n as usize;
            conn.execute(
                "INSERT INTO flow_events (
                    id, created_at, kind, order_id, order_code, customer_name, product_id, product_name,
                    part_id, part_name, filament_name, filament_hex, from_state, to_state, actor_device,
                    source_surface, action_label, failure_note, cost_impact_cents, can_undo, batch_id
                ) VALUES (?1, ?2, 'PartRoleChanged', ?3, ?4, ?5, ?6, ?7, ?8, ?9, '', '', 'Queued', 'Removed', ?10, ?11, ?12, ?13, 0, 0, ?14)",
                params![
                    Uuid::new_v4().to_string(),
                    now,
                    order_id,
                    order_code,
                    customer_name,
                    product_id,
                    product_name,
                    part_id,
                    part_name,
                    actor_device,
                    source_surface,
                    format!(
                        "Removed {n} queued {part_name} (part is no longer printed)"
                    ),
                    format!("removed_queued_units={n}"),
                    batch_id,
                ],
            )?;
        }
        conn.execute(
            "DELETE FROM part_units WHERE state = 'Queued' AND part_id IN (SELECT id FROM catalog_parts WHERE is_tracked = 0 OR is_color_only = 1)",
            [],
        )?;
        Ok(removed)
    }

    /// Display name of a printer, if it exists.
    pub fn printer_name(&self, printer_id: &str) -> CoreResult<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT name FROM printers WHERE id = ?1",
                params![printer_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// A printer's bed size `(bed_x_mm, bed_y_mm)`; `(None, None)` when unset or no such printer.
    pub fn printer_bed_mm(&self, printer_id: &str) -> CoreResult<(Option<f64>, Option<f64>)> {
        Ok(self
            .conn
            .query_row(
                "SELECT bed_x_mm, bed_y_mm FROM printers WHERE id = ?1",
                params![printer_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .unwrap_or((None, None)))
    }

    /// A printer's build volume `(x, y, z)` in mm; each is None when unset.
    pub fn printer_build_volume_mm(
        &self,
        printer_id: &str,
    ) -> CoreResult<(Option<f64>, Option<f64>, Option<f64>)> {
        Ok(self
            .conn
            .query_row(
                "SELECT bed_x_mm, bed_y_mm, bed_z_mm FROM printers WHERE id = ?1",
                params![printer_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .unwrap_or((None, None, None)))
    }

    /// The filaments loaded on a printer, by slot (1-based, as Settings shows "Slot 1").
    /// Empty when the printer has none loaded or doesn't exist. A slot whose swatch was
    /// deleted keeps its id with an empty name, hex and material.
    pub fn printer_loaded_slots(&self, printer_id: &str) -> CoreResult<Vec<PrinterSlot>> {
        let mut stmt = self.conn.prepare(
            "SELECT s.slot_index, s.filament_id, COALESCE(f.name, ''), COALESCE(f.hex, ''),
                    COALESCE(f.material, ''), COALESCE(f.brand, '')
             FROM printer_slots s LEFT JOIN filaments f ON f.id = s.filament_id
             WHERE s.printer_id = ?1 ORDER BY s.slot_index",
        )?;
        let slots = stmt
            .query_map(params![printer_id], |r| {
                Ok(PrinterSlot {
                    slot_index: r.get(0)?,
                    filament_id: r.get(1)?,
                    filament_name: r.get(2)?,
                    filament_hex: r.get(3)?,
                    material: r.get(4)?,
                    brand: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(slots)
    }

    /// Groups of filament rows that look like the same swatch: same brand, name and
    /// material (case/whitespace-insensitive) and same hex. The oldest row is the
    /// canonical id. Read-only.
    pub fn find_duplicate_filaments(&self) -> CoreResult<Vec<DuplicateFilamentGroup>> {
        Self::duplicate_filament_groups(&self.conn)
    }

    fn duplicate_filament_groups(conn: &Connection) -> CoreResult<Vec<DuplicateFilamentGroup>> {
        let mut stmt = conn.prepare(
            "SELECT f.id, (
                 SELECT c.id FROM filaments c
                 WHERE LOWER(TRIM(c.brand)) = LOWER(TRIM(f.brand))
                   AND LOWER(TRIM(c.name)) = LOWER(TRIM(f.name))
                   AND LOWER(TRIM(c.material)) = LOWER(TRIM(f.material))
                   AND UPPER(TRIM(c.hex)) = UPPER(TRIM(f.hex))
                 ORDER BY c.rowid LIMIT 1
             ) AS canon
             FROM filaments f ORDER BY f.rowid",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut groups: Vec<DuplicateFilamentGroup> = Vec::new();
        for (id, canon) in rows {
            if id == canon {
                continue;
            }
            match groups.iter_mut().find(|g| g.canonical_id == canon) {
                Some(g) => g.duplicate_ids.push(id),
                None => groups.push(DuplicateFilamentGroup {
                    canonical_id: canon,
                    duplicate_ids: vec![id],
                }),
            }
        }
        Ok(groups)
    }

    /// Explicit, user-triggered merge of `find_duplicate_filaments` groups. Every
    /// reference (part units, part defaults, printer slots) is repointed to the
    /// canonical row; overstock for the same product part is summed into one row.
    pub fn merge_duplicate_filaments(&mut self) -> CoreResult<ShopSnapshot> {
        let tx = self.conn.transaction()?;
        for g in Self::duplicate_filament_groups(&tx)? {
            for dup in &g.duplicate_ids {
                let canon = &g.canonical_id;
                for sql in [
                    "UPDATE part_units SET filament_id = ?1 WHERE filament_id = ?2",
                    "UPDATE catalog_parts SET default_filament_id = ?1 WHERE default_filament_id = ?2",
                    "UPDATE printer_slots SET filament_id = ?1 WHERE filament_id = ?2",
                    "UPDATE printer_feeder_spools SET filament_id = ?1 WHERE filament_id = ?2",
                ] {
                    tx.execute(sql, params![canon, dup])?;
                }
                // Overstock: add into an existing canonical row for the same part, else repoint.
                tx.execute(
                    "UPDATE overstock AS c SET quantity = c.quantity + (
                         SELECT COALESCE(SUM(d.quantity), 0) FROM overstock d
                         WHERE d.filament_id = ?2 AND d.product_id = c.product_id AND d.part_id = c.part_id)
                     WHERE c.filament_id = ?1",
                    params![canon, dup],
                )?;
                tx.execute(
                    "DELETE FROM overstock WHERE filament_id = ?2 AND EXISTS (
                         SELECT 1 FROM overstock c WHERE c.filament_id = ?1
                           AND c.product_id = overstock.product_id AND c.part_id = overstock.part_id)",
                    params![canon, dup],
                )?;
                tx.execute(
                    "UPDATE overstock SET filament_id = ?1 WHERE filament_id = ?2",
                    params![canon, dup],
                )?;
                tx.execute("DELETE FROM filaments WHERE id = ?1", params![dup])?;
            }
        }
        tx.commit()?;
        self.snapshot()
    }

    /// Destructive: wipes every order, product, filament, printer and flow event.
    /// Not reachable from the UI. Always writes a timestamped backup to
    /// `<data>/backups/` first (keeps the last 10) and aborts if that fails.
    pub fn reset_to_production_tracker(&mut self) -> CoreResult<ShopSnapshot> {
        let Some(path) = self.db_path.clone() else {
            return Err(CoreError::Validation(
                "Reset refused: no on-disk database to back up".into(),
            ));
        };
        backup_database(&self.conn, &path, "reset-", RESET_BACKUPS_KEPT)
            .map_err(|e| CoreError::Validation(format!("Reset aborted, backup failed: {e}")))?;
        self.conn.execute_batch(
            "
            DELETE FROM flow_events;
            DELETE FROM overstock;
            DELETE FROM part_units;
            DELETE FROM order_lines;
            DELETE FROM orders;
            DELETE FROM imported_store_orders;
            DELETE FROM printer_feeder_spools;
            DELETE FROM printer_feeders;
            DELETE FROM printer_print_areas;
            DELETE FROM printer_slots;
            DELETE FROM printers;
            DELETE FROM catalog_parts;
            DELETE FROM products;
            DELETE FROM filaments;
            ",
        )?;
        if demo_seed_enabled() {
            seed::seed_if_empty(&self.conn)?;
        }
        Self::normalize_shop_data(&self.conn)?;
        self.snapshot()
    }

    /// First-run setup on a data folder left over from an earlier install: clear
    /// leftover catalog/printers/filaments/settings so the new shop starts empty.
    /// Refuses when any order exists (a real shop is never wiped). Backs up first
    /// when an on-disk database exists; aborts if that backup fails.
    pub fn start_fresh_shop(&mut self) -> CoreResult<ShopSnapshot> {
        let orders: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))?;
        if orders > 0 {
            return Err(CoreError::Validation(
                "Fresh start refused: this shop has orders".into(),
            ));
        }
        if let Some(path) = self.db_path.clone() {
            backup_database(&self.conn, &path, "reset-", RESET_BACKUPS_KEPT).map_err(|e| {
                CoreError::Validation(format!("Fresh start aborted, backup failed: {e}"))
            })?;
        }
        self.conn.execute_batch(
            "
            DELETE FROM flow_events;
            DELETE FROM overstock;
            DELETE FROM part_units;
            DELETE FROM order_lines;
            DELETE FROM printer_feeder_spools;
            DELETE FROM printer_feeders;
            DELETE FROM printer_print_areas;
            DELETE FROM printer_slots;
            DELETE FROM printers;
            DELETE FROM catalog_parts;
            DELETE FROM products;
            DELETE FROM filaments;
            DELETE FROM shop_settings;
            ",
        )?;
        self.snapshot()
    }

    pub fn snapshot(&self) -> CoreResult<ShopSnapshot> {
        let filaments = self.load_filaments()?;
        let filament_map: HashMap<String, FilamentSwatch> = filaments
            .iter()
            .cloned()
            .map(|f| (f.id.clone(), f))
            .collect();
        let products = self.load_products()?;
        let product_map: HashMap<String, Product> = products
            .iter()
            .cloned()
            .map(|p| (p.id.clone(), p))
            .collect();
        let mut part_map: HashMap<String, CatalogPart> = HashMap::new();
        for p in &products {
            for part in &p.parts {
                part_map.insert(part.id.clone(), part.clone());
            }
        }

        let printers_meta = self.load_printers_meta(&filament_map)?;
        let printer_name_map: HashMap<String, String> = printers_meta
            .iter()
            .map(|p| (p.id.clone(), p.name.clone()))
            .collect();

        let mut orders =
            self.load_orders(&filament_map, &product_map, &part_map, &printer_name_map)?;
        for o in orders.iter_mut() {
            o.order_hash = delta::order_content_hash(o);
        }

        let mut all_units: Vec<PartUnit> = Vec::new();
        for o in &orders {
            for l in &o.lines {
                for u in &l.units {
                    all_units.push(u.clone());
                }
            }
        }

        // One pass over the units instead of one pass per printer.
        let mut by_printer: HashMap<&str, (Vec<PartUnit>, Vec<PartUnit>)> = HashMap::new();
        for u in &all_units {
            let Some(pid) = u.printer_id.as_deref() else {
                continue;
            };
            match u.state.as_str() {
                "Printing" => by_printer.entry(pid).or_default().0.push(u.clone()),
                "Staged" => by_printer.entry(pid).or_default().1.push(u.clone()),
                _ => {}
            }
        }
        let printers = printers_meta
            .into_iter()
            .map(|mut p| {
                let (active, staged) = by_printer.remove(p.id.as_str()).unwrap_or_default();
                p.active_units = active;
                p.staged_units = staged;
                p.remaining_minutes = p.active_units.iter().map(|u| u.print_minutes).sum();
                p.status = if !p.active_units.is_empty() {
                    "Printing".to_string()
                } else if !p.staged_units.is_empty() {
                    "Staged".to_string()
                } else {
                    "Idle".to_string()
                };
                p
            })
            .collect::<Vec<_>>();

        insights::record_printer_statuses(&self.conn, &printers)?;
        let overstock = self.load_overstock(&filament_map, &product_map, &part_map)?;
        let flow_events = self.load_flow_events()?;
        let analytics =
            Self::compute_analytics(&orders, &all_units, &printers, &flow_events, &filament_map);

        Ok(ShopSnapshot {
            filaments,
            products,
            printers,
            orders,
            overstock,
            flow_events,
            analytics,
        })
    }

    pub fn units_by_ids(&self, unit_ids: &[String]) -> CoreResult<Vec<(PartUnit, String)>> {
        let snap = self.snapshot()?;
        let mut part_mesh_map: HashMap<String, String> = HashMap::new();
        for prod in &snap.products {
            for pt in &prod.parts {
                part_mesh_map.insert(pt.id.clone(), pt.mesh_file.clone());
            }
        }
        let mut out = Vec::new();
        for ord in &snap.orders {
            for line in &ord.lines {
                for u in &line.units {
                    if unit_ids.iter().any(|id| id == &u.id) {
                        let mesh_file = part_mesh_map
                            .get(&u.part_id)
                            .cloned()
                            .unwrap_or_else(|| "main_body.stl".to_string());
                        out.push((u.clone(), mesh_file));
                    }
                }
            }
        }
        Ok(out)
    }

    pub fn transition_units(&mut self, mut req: TransitionRequest) -> CoreResult<ShopSnapshot> {
        // Each unit moves once per action, even if the request names it twice.
        let mut seen = std::collections::HashSet::new();
        req.unit_ids.retain(|id| seen.insert(id.clone()));
        let now = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let tx = self.conn.transaction()?;
        // One batch id per action, so Undo reverts every unit this call moved.
        let undo_batch_id = Uuid::new_v4().to_string();
        let batch_job_id = if req.to_state == "Printing" || req.to_state == "Staged" {
            Some(Uuid::new_v4().to_string().to_uppercase())
        } else {
            None
        };

        let mut order_cache: HashMap<String, (String, String)> = HashMap::new();
        let mut line_cache: HashMap<String, String> = HashMap::new();
        let mut product_cache: HashMap<String, String> = HashMap::new();
        let mut part_cache: HashMap<String, (String, f64)> = HashMap::new();
        let mut filament_cache: HashMap<String, (String, String)> = HashMap::new();
        let mut printer_cache: HashMap<String, Option<String>> = HashMap::new();
        let mut touched_orders: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for unit_id in &req.unit_ids {
            #[allow(clippy::type_complexity)]
            let row: Option<(String, String, String, String, String, String, Option<String>, i64, Option<String>)> = tx
                .query_row(
                    "SELECT order_id, line_id, product_id, part_id, filament_id, state, printer_id, reprint_count, plate_job_id
                     FROM part_units WHERE id = ?1",
                    params![unit_id],
                    |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                            r.get(6)?,
                            r.get(7)?,
                            r.get(8)?,
                        ))
                    },
                )
                .optional()?;

            let Some((
                order_id,
                line_id,
                product_id,
                part_id,
                prev_filament_id,
                from_state,
                prev_printer,
                reprints,
                prev_plate_job,
            )) = row
            else {
                continue;
            };

            let filament_id = req
                .filament_id
                .clone()
                .unwrap_or_else(|| prev_filament_id.clone());
            let is_failed = req.failure_reason.is_some() || req.to_state == "Failed";
            let effective_state = if is_failed {
                "Queued".to_string()
            } else {
                req.to_state.clone()
            };
            let new_reprints = if is_failed { reprints + 1 } else { reprints };
            let target_printer = match effective_state.as_str() {
                "Staged" | "Printing" => req.printer_id.clone().or(prev_printer.clone()),
                "Queued" => None,
                _ => prev_printer.clone(),
            };

            tx.execute(
                "UPDATE part_units SET state = ?1, printer_id = ?2, plate_job_id = COALESCE(?3, plate_job_id), filament_id = ?4, reprint_count = ?5, updated_at = ?6 WHERE id = ?7",
                params![effective_state, target_printer, batch_job_id, filament_id, new_reprints, now, unit_id],
            )?;
            if touched_orders.insert(order_id.clone()) {
                tx.execute(
                    "UPDATE orders SET updated_at = ?1 WHERE id = ?2",
                    params![now, order_id],
                )?;
            }
            // Reopening (a unit leaves Closed) clears the order's ship fields.
            if from_state == "Closed" && effective_state != "Closed" {
                Self::clear_ship_fields_tx(&tx, &order_id, &now)?;
            }

            // Looked up once per action, not once per unit (bulk actions touch many units
            // of the same order/product). Missing rows fall back to plain labels, never to a
            // made-up color or cost.
            let (order_code, customer_name) = match order_cache.get(&order_id) {
                Some(v) => v.clone(),
                None => {
                    let v: (String, String) = tx
                        .query_row(
                            "SELECT order_code, customer_name FROM orders WHERE id = ?1",
                            params![order_id],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional()?
                        .unwrap_or_else(|| (order_id.clone(), String::new()));
                    order_cache.insert(order_id.clone(), v.clone());
                    v
                }
            };
            let item_label: String = match line_cache.get(&line_id) {
                Some(v) => v.clone(),
                None => {
                    let v: String = tx
                        .query_row(
                            "SELECT item_label FROM order_lines WHERE id = ?1",
                            params![line_id],
                            |r| r.get(0),
                        )
                        .optional()?
                        .unwrap_or_default();
                    line_cache.insert(line_id.clone(), v.clone());
                    v
                }
            };
            let product_name: String = match product_cache.get(&product_id) {
                Some(v) => v.clone(),
                None => {
                    let v: String = tx
                        .query_row(
                            "SELECT name FROM products WHERE id = ?1",
                            params![product_id],
                            |r| r.get(0),
                        )
                        .optional()?
                        .unwrap_or_else(|| product_id.clone());
                    product_cache.insert(product_id.clone(), v.clone());
                    v
                }
            };
            let (part_name, unit_cost): (String, f64) = match part_cache.get(&part_id) {
                Some(v) => v.clone(),
                None => {
                    let v: (String, f64) = tx
                        .query_row(
                            "SELECT name, unit_cost FROM catalog_parts WHERE id = ?1",
                            params![part_id],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional()?
                        .unwrap_or_else(|| (part_id.clone(), 0.0));
                    part_cache.insert(part_id.clone(), v.clone());
                    v
                }
            };
            let (filament_name, filament_hex): (String, String) =
                match filament_cache.get(&filament_id) {
                    Some(v) => v.clone(),
                    None => {
                        let v: (String, String) = tx
                            .query_row(
                                "SELECT name, hex FROM filaments WHERE id = ?1",
                                params![filament_id],
                                |r| Ok((r.get(0)?, r.get(1)?)),
                            )
                            .optional()?
                            .unwrap_or_default();
                        filament_cache.insert(filament_id.clone(), v.clone());
                        v
                    }
                };
            let printer_name: Option<String> = match target_printer.as_deref() {
                Some(pid) => match printer_cache.get(pid) {
                    Some(v) => v.clone(),
                    None => {
                        let v: Option<String> = tx
                            .query_row(
                                "SELECT name FROM printers WHERE id = ?1",
                                params![pid],
                                |r| r.get(0),
                            )
                            .optional()?;
                        printer_cache.insert(pid.to_string(), v.clone());
                        v
                    }
                },
                None => None,
            };

            let kind = if is_failed {
                "FailedPrint"
            } else {
                match effective_state.as_str() {
                    "Staged" => "StagedToPrinter",
                    "Printing" => "StartedPrint",
                    "Printed" => "PrintedDone",
                    "Queued" => "RestoredToQueue",
                    "Post-Processing" => "PostProcessing",
                    "Ready" => "MarkedReady",
                    "Shipped" => "Shipped",
                    _ => "StatusChanged",
                }
            };

            let cost_impact_cents = if is_failed {
                (unit_cost * 100.0).round() as i64
            } else {
                0
            };

            tx.execute(
                "INSERT INTO flow_events (
                    id, created_at, kind, order_id, order_code, customer_name, line_id, item_label,
                    product_id, product_name, part_id, part_name, unit_id, filament_name, filament_hex,
                    from_state, to_state, printer_id, printer_name, actor_device, source_surface,
                    action_label, failure_reason, failure_note, cost_impact_cents, can_undo,
                    batch_id, prev_printer_id, prev_filament_id, prev_reprint_count, prev_plate_job_id
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                    ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                    ?16, ?17, ?18, ?19, ?20, ?21,
                    ?22, ?23, ?24, ?25, 1,
                    ?26, ?27, ?28, ?29, ?30
                )",
                params![
                    Uuid::new_v4().to_string(),
                    now,
                    kind,
                    order_id,
                    order_code,
                    customer_name,
                    line_id,
                    item_label,
                    product_id,
                    product_name,
                    part_id,
                    part_name,
                    unit_id,
                    filament_name,
                    filament_hex,
                    from_state,
                    effective_state,
                    target_printer,
                    printer_name,
                    req.actor_device,
                    req.source_surface,
                    req.action_label,
                    req.failure_reason,
                    req.failure_note,
                    cost_impact_cents,
                    undo_batch_id,
                    prev_printer,
                    prev_filament_id,
                    reprints,
                    prev_plate_job
                ],
            )?;
        }

        tx.commit()?;
        self.snapshot()
    }

    /// Undoes the whole action (batch) that `event_id` belongs to. Each unit goes back
    /// to its exact state before the action (state, printer, color, reprint count, plate
    /// job). Units that moved on since are left alone. Undo events are written with
    /// `can_undo = 0` and the original events are marked undone, so a second Undo goes
    /// to the previous action instead of redoing this one.
    pub fn undo_flow_event(
        &mut self,
        event_id: &str,
        actor_device: &str,
    ) -> CoreResult<ShopSnapshot> {
        let now = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let tx = self.conn.transaction()?;
        #[allow(clippy::type_complexity)]
        let head: Option<(Option<String>, i64, Option<String>, Option<String>, String)> = tx
            .query_row(
                "SELECT batch_id, can_undo, undone_at, unit_id, source_surface FROM flow_events WHERE id = ?1",
                params![event_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let Some((batch_id, can_undo, undone_at, unit_id, surface)) = head else {
            return Err(CoreError::Validation(
                "That history entry no longer exists.".to_string(),
            ));
        };
        if undone_at.is_some() {
            return Err(CoreError::Validation(
                "That action was already undone.".to_string(),
            ));
        }
        if can_undo == 0 || unit_id.is_none() || surface == LEGACY_UNDO_SURFACE {
            return Err(CoreError::Validation(
                "That history entry can't be undone.".to_string(),
            ));
        }

        #[allow(clippy::type_complexity)]
        let events: Vec<(
            String,
            Option<String>,
            Option<String>,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<String>,
        )> = {
            let sql = "SELECT id, unit_id, from_state, to_state, kind, printer_id, prev_printer_id,
                              prev_filament_id, prev_reprint_count, prev_plate_job_id
                       FROM flow_events WHERE ";
            let (cond, key) = match &batch_id {
                Some(b) => (
                    "batch_id = ?1 AND undone_at IS NULL AND can_undo = 1 ORDER BY seq DESC",
                    b.clone(),
                ),
                None => ("id = ?1", event_id.to_string()),
            };
            let mut stmt = tx.prepare(&format!("{sql}{cond}"))?;
            let rows = stmt
                .query_map(params![key], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let undo_batch = Uuid::new_v4().to_string();
        let mut restored = 0usize;
        for (
            ev_id,
            unit_id,
            from_state,
            to_state,
            kind,
            ev_printer,
            prev_printer,
            prev_filament,
            prev_reprints,
            prev_plate,
        ) in &events
        {
            let (Some(unit_id), Some(from_state)) = (unit_id, from_state) else {
                continue;
            };
            #[allow(clippy::type_complexity)]
            let cur: Option<(String, String, String, Option<String>, i64, Option<String>)> = tx
                .query_row(
                    "SELECT order_id, state, filament_id, printer_id, reprint_count, plate_job_id FROM part_units WHERE id = ?1",
                    params![unit_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                )
                .optional()?;
            let Some((order_id, cur_state, cur_filament, cur_printer, cur_reprints, cur_plate)) =
                cur
            else {
                continue; // unit was deleted since
            };
            if &cur_state != to_state {
                continue; // unit moved on since this action; leave it alone
            }
            // Events written before batch undo have no prev_* values; fall back sensibly.
            let (printer, filament, reprints, plate) = if let Some(prev_reprints) = prev_reprints {
                (
                    prev_printer.clone(),
                    prev_filament
                        .clone()
                        .unwrap_or_else(|| cur_filament.clone()),
                    *prev_reprints,
                    prev_plate.clone(),
                )
            } else {
                let printer = match from_state.as_str() {
                    "Queued" => None,
                    _ => ev_printer.clone().or_else(|| cur_printer.clone()),
                };
                let reprints = if kind == "FailedPrint" {
                    (cur_reprints - 1).max(0)
                } else {
                    cur_reprints
                };
                (printer, cur_filament.clone(), reprints, cur_plate.clone())
            };
            tx.execute(
                "UPDATE part_units SET state = ?1, printer_id = ?2, filament_id = ?3, reprint_count = ?4, plate_job_id = ?5, updated_at = ?6 WHERE id = ?7",
                params![from_state, printer, filament, reprints, plate, now, unit_id],
            )?;
            tx.execute(
                "UPDATE orders SET updated_at = ?1 WHERE id = ?2",
                params![now, order_id],
            )?;
            if cur_state == "Closed" && from_state != "Closed" {
                Self::clear_ship_fields_tx(&tx, &order_id, &now)?;
            }
            let printer_name: Option<String> = match &printer {
                Some(pid) => tx
                    .query_row(
                        "SELECT name FROM printers WHERE id = ?1",
                        params![pid],
                        |r| r.get(0),
                    )
                    .optional()?,
                None => None,
            };
            tx.execute(
                "INSERT INTO flow_events (
                    id, created_at, kind, order_id, order_code, customer_name, line_id, item_label,
                    product_id, product_name, part_id, part_name, unit_id, filament_name, filament_hex,
                    from_state, to_state, printer_id, printer_name, actor_device, source_surface,
                    action_label, failure_reason, failure_note, cost_impact_cents, can_undo, batch_id
                )
                SELECT ?1, ?2, 'Undo', order_id, order_code, customer_name, line_id, item_label,
                    product_id, product_name, part_id, part_name, unit_id, filament_name, filament_hex,
                    to_state, ?3, ?4, ?5, ?6, 'Flow Ledger · Undo',
                    'Undo: ' || action_label, NULL, NULL, 0, 0, ?7
                FROM flow_events WHERE id = ?8",
                params![
                    Uuid::new_v4().to_string(),
                    now,
                    from_state,
                    printer,
                    printer_name,
                    actor_device,
                    undo_batch,
                    ev_id
                ],
            )?;
            restored += 1;
        }

        for (ev_id, ..) in &events {
            tx.execute(
                "UPDATE flow_events SET undone_at = ?1 WHERE id = ?2",
                params![now, ev_id],
            )?;
        }
        tx.commit()?;
        if restored == 0 {
            return Err(CoreError::Validation(
                "Nothing was undone: those parts have changed since that action.".to_string(),
            ));
        }
        self.snapshot()
    }

    pub fn update_part_filament(
        &mut self,
        unit_id: &str,
        filament_id: &str,
        actor_device: &str,
    ) -> CoreResult<ShopSnapshot> {
        let now = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let tx = self.conn.transaction()?;
        let new_fil: Option<(String, String)> = tx
            .query_row(
                "SELECT name, hex FROM filaments WHERE id = ?1",
                params![filament_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((fil_name, fil_hex)) = new_fil else {
            return Err(CoreError::Validation(format!(
                "Unknown filament {filament_id}"
            )));
        };
        #[allow(clippy::type_complexity)]
        let unit: Option<(String, String, String, String, String, String, String, String, String, Option<String>)> = tx
            .query_row(
                "SELECT u.order_id, COALESCE(o.order_code, u.order_id), COALESCE(o.customer_name, ''), u.line_id,
                        COALESCE(l.item_label, ''), u.product_id, COALESCE(p.name, ''), u.part_id,
                        COALESCE(c.name, u.part_id), u.state
                 FROM part_units u
                 LEFT JOIN orders o ON o.id = u.order_id
                 LEFT JOIN order_lines l ON l.id = u.line_id
                 LEFT JOIN products p ON p.id = u.product_id
                 LEFT JOIN catalog_parts c ON c.id = u.part_id
                 WHERE u.id = ?1",
                params![unit_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            order_id,
            order_code,
            customer,
            line_id,
            item_label,
            product_id,
            product_name,
            part_id,
            part_name,
            state,
        )) = unit
        else {
            return Err(CoreError::Validation(format!(
                "Unknown part unit {unit_id}"
            )));
        };
        let old_name: String = tx
            .query_row(
                "SELECT COALESCE(f.name, '') FROM part_units u LEFT JOIN filaments f ON f.id = u.filament_id WHERE u.id = ?1",
                params![unit_id],
                |r| r.get(0),
            )
            .unwrap_or_default();
        tx.execute(
            "UPDATE part_units SET filament_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![filament_id, now, unit_id],
        )?;
        tx.execute(
            "UPDATE orders SET updated_at = ?1 WHERE id = ?2",
            params![now, order_id],
        )?;
        let state = state.unwrap_or_default();
        tx.execute(
            "INSERT INTO flow_events (
                id, created_at, kind, order_id, order_code, customer_name, line_id, item_label,
                product_id, product_name, part_id, part_name, unit_id, filament_name, filament_hex,
                from_state, to_state, actor_device, source_surface, action_label, failure_note,
                cost_impact_cents, can_undo
            ) VALUES (?1, ?2, 'FilamentChanged', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, ?16,
                      'Part · Filament', 'Changed Filament', ?17, 0, 0)",
            params![
                Uuid::new_v4().to_string(),
                now,
                order_id,
                order_code,
                customer,
                line_id,
                item_label,
                product_id,
                product_name,
                part_id,
                part_name,
                unit_id,
                fil_name,
                fil_hex,
                state,
                actor_device,
                format!("{old_name} → {fil_name}"),
            ],
        )?;
        tx.commit()?;
        self.snapshot()
    }

    pub fn create_product(&mut self, input: CreateProductInput) -> CoreResult<ShopSnapshot> {
        let pid = format!(
            "product-{}",
            Uuid::new_v4()
                .to_string()
                .split('-')
                .next()
                .unwrap_or("NEW")
                .to_uppercase()
        );
        self.conn.execute(
            "INSERT INTO products (id, name, sku, price_cents, packed_weight_oz, default_box_name, box_cost_cents, supports_custom_text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                pid,
                input.name,
                input.sku,
                input.price_cents,
                input.packed_weight_oz,
                input.default_box_name,
                input.box_cost_cents,
                if input.supports_custom_text { 1 } else { 0 }
            ],
        )?;
        self.snapshot()
    }

    pub fn upsert_product(&mut self, product: Product) -> CoreResult<ShopSnapshot> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO products (id, name, sku, price_cents, packed_weight_oz, default_box_name, box_cost_cents, supports_custom_text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                product.id,
                product.name,
                product.sku,
                product.price_cents,
                product.packed_weight_oz,
                product.default_box_name,
                product.box_cost_cents,
                if product.supports_custom_text { 1 } else { 0 }
            ],
        )?;
        if !product.parts.is_empty() {
            tx.execute(
                "DELETE FROM catalog_parts WHERE product_id = ?1",
                params![product.id],
            )?;
            for (idx, pt) in product.parts.iter().enumerate() {
                tx.execute(
                    "INSERT OR REPLACE INTO catalog_parts (id, product_id, name, is_tracked, is_color_only, default_filament_id, grams, print_minutes, unit_cost, mesh_file, sort_order)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        pt.id,
                        product.id,
                        pt.name,
                        if pt.is_tracked { 1 } else { 0 },
                        if pt.is_color_only { 1 } else { 0 },
                        pt.default_filament_id,
                        pt.grams,
                        pt.print_minutes,
                        pt.unit_cost,
                        pt.mesh_file,
                        if pt.sort_order > 0 { pt.sort_order } else { idx as i64 }
                    ],
                )?;
            }
        }
        // A role change (Prints -> Color only / Thumbnail only) stops new units. Only
        // never-started (Queued) units are removed, and each removal is logged to Flow.
        Self::prune_unprinted_queued_units(&tx, "FarmPrint", "Product Editor · Part role")?;
        tx.commit()?;
        self.snapshot()
    }

    pub fn add_catalog_part(&mut self, input: CreateCatalogPartInput) -> CoreResult<ShopSnapshot> {
        let partid = format!(
            "part-{}",
            Uuid::new_v4()
                .to_string()
                .split('-')
                .next()
                .unwrap_or("NEW")
                .to_uppercase()
        );
        let next_order: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM catalog_parts WHERE product_id = ?1",
            params![input.product_id],
            |r| r.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO catalog_parts (id, product_id, name, is_tracked, is_color_only, default_filament_id, grams, print_minutes, unit_cost, mesh_file, sort_order)
             VALUES (?1, ?2, ?3, 1, 0, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                partid,
                input.product_id,
                input.name,
                input.default_filament_id,
                input.grams,
                input.print_minutes,
                input.unit_cost,
                input.mesh_file,
                next_order
            ],
        )?;
        self.snapshot()
    }

    pub fn delete_product(&mut self, product_id: &str) -> CoreResult<ShopSnapshot> {
        self.conn.execute(
            "DELETE FROM catalog_parts WHERE product_id = ?1",
            params![product_id],
        )?;
        self.conn
            .execute("DELETE FROM products WHERE id = ?1", params![product_id])?;
        self.snapshot()
    }

    pub fn create_order(&mut self, input: CreateOrderInput) -> CoreResult<ShopSnapshot> {
        let now = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let oid = format!(
            "ord-{}",
            Uuid::new_v4()
                .to_string()
                .split('-')
                .next()
                .unwrap_or("new")
        );
        let raw_uuid = Uuid::new_v4().simple().to_string().to_uppercase();
        let code = format!("FP-{}-{}", &raw_uuid[..4], &raw_uuid[4..8]);
        let (resolved_pid, prod_name, price_cents): (String, String, i64) = self
            .conn
            .query_row(
                "SELECT id, name, price_cents FROM products WHERE id = ?1",
                params![input.product_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .or_else(|_| {
                self.conn.query_row(
                    "SELECT id, name, price_cents FROM products ORDER BY name LIMIT 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })?;

        // Shipping comes from the shop's own settings, never a built-in number.
        // Charged: the flat rate when shipping is enabled (0 when the order
        // reaches the free-shipping threshold). Cost: unknown until a label
        // is bought, so it stays 0.
        let settings = self.get_settings()?;
        let merchandise_cents = price_cents * input.quantity.max(1);
        let shipping_charged_cents = if !settings.shipping_enabled
            || (settings.free_shipping_threshold_active()
                && merchandise_cents >= settings.free_shipping_threshold_cents)
        {
            0
        } else {
            settings.checkout_flat_cents()
        };
        let shipping_cost_cents: i64 = 0;

        self.conn.execute(
            "INSERT INTO orders (id, order_code, customer_name, customer_email, source, is_rush, is_on_hold, notes, shipping_charged_cents, shipping_cost_cents, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'manual', ?5, 0, '', ?7, ?8, ?6, ?6)",
            params![oid, code, input.customer_name, input.customer_email, if input.is_rush { 1 } else { 0 }, now, shipping_charged_cents, shipping_cost_cents],
        )?;

        let mut part_stmt = self.conn.prepare(
            "SELECT id, name, default_filament_id FROM catalog_parts WHERE product_id = ?1 AND is_tracked = 1 AND is_color_only = 0 ORDER BY sort_order",
        )?;
        let parts: Vec<(String, String, String)> = part_stmt
            .query_map(params![resolved_pid], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let qty = input.quantity.max(1);
        for copy_idx in 1..=qty {
            let lid = format!("line-{}-{}", oid, copy_idx);
            let item_label = format!("{} #{}", prod_name, copy_idx);
            self.conn.execute(
                "INSERT INTO order_lines (id, order_id, product_id, item_label, quantity, unit_price_cents, custom_text)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)",
                params![lid, oid, resolved_pid, item_label, price_cents, input.custom_text],
            )?;
            for (partid, part_name, fid) in &parts {
                let uid = format!("unit-{}-{}-{}", oid, copy_idx, partid);
                self.conn.execute(
                    "INSERT INTO part_units (id, order_id, line_id, product_id, part_id, unit_index, filament_id, state, printer_id, plate_job_id, reprint_count, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'Queued', NULL, NULL, 0, ?8)",
                    params![uid, oid, lid, resolved_pid, partid, copy_idx, fid, now],
                )?;
                let (fname, fhex): (String, String) = self
                    .conn
                    .query_row(
                        "SELECT name, hex FROM filaments WHERE id = ?1",
                        params![fid],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .unwrap_or_else(|_| ("Orange".to_string(), "#FF8D28".to_string()));
                self.conn.execute(
                    "INSERT INTO flow_events (
                        id, created_at, kind, order_id, order_code, customer_name, line_id, item_label,
                        product_id, product_name, part_id, part_name, unit_id, filament_name, filament_hex,
                        from_state, to_state, printer_id, printer_name, actor_device, source_surface,
                        action_label, failure_reason, failure_note, cost_impact_cents, can_undo
                    ) VALUES (?1, ?2, 'OrderCreated', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, 'Queued', NULL, NULL, 'Mac Studio', 'Orders · New Order', 'Created Order & Queued Part', NULL, NULL, 0, 0)",
                    params![Uuid::new_v4().to_string(), now, oid, code, input.customer_name, lid, item_label, resolved_pid, prod_name, partid, part_name, uid, fname, fhex],
                )?;
            }
        }
        self.snapshot()
    }

    /// Stable per-install device id (`fprust-<uuid v4>`), created on first use and kept in
    /// local `shop_settings` (key `device_id`, never synced). Used as `store_orders.claimed_by`.
    pub fn device_id(&mut self) -> CoreResult<String> {
        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT value_json FROM shop_settings WHERE key = 'device_id'",
                [],
                |r| r.get(0),
            )
            .optional()?
            .and_then(|j: String| serde_json::from_str::<String>(&j).ok())
            .filter(|s| !s.trim().is_empty());
        if let Some(id) = existing {
            return Ok(id);
        }
        let id = format!("fprust-{}", Uuid::new_v4());
        self.conn.execute(
            "INSERT OR REPLACE INTO shop_settings (key, value_json) VALUES ('device_id', ?1)",
            params![serde_json::to_string(&id).unwrap_or_default()],
        )?;
        Ok(id)
    }

    /// `store_orders.id`s already imported (kept after a local delete). Dedupe set for ingest.
    pub fn imported_store_order_ids(&self) -> CoreResult<std::collections::HashSet<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT remote_id FROM imported_store_orders
             UNION SELECT remote_id FROM orders WHERE remote_id IS NOT NULL AND remote_id <> ''",
        )?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;
        Ok(ids)
    }

    /// Inserts one mapped website order (local only). Dedupes by `remote_id` inside the same
    /// transaction, so a repeated import never duplicates. Lines whose product no longer
    /// exists are skipped; if none remain, nothing is written. Thumbnail-only and color-only
    /// parts get no part units (same rule as `create_order`), so they never show in queues.
    pub fn import_website_order(
        &mut self,
        input: &WebsiteOrderImport,
    ) -> CoreResult<WebsiteImportOutcome> {
        let remote_id = input.remote_id.trim();
        if remote_id.is_empty() {
            return Ok(WebsiteImportOutcome::Skipped {
                reason: "missing store order id".into(),
            });
        }
        let now = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let tx = self.conn.transaction()?;
        let seen: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM imported_store_orders WHERE remote_id = ?1)
                 OR EXISTS(SELECT 1 FROM orders WHERE remote_id = ?1)",
            params![remote_id],
            |r| r.get(0),
        )?;
        if seen {
            return Ok(WebsiteImportOutcome::Duplicate);
        }

        struct Resolved<'a> {
            line: &'a WebsiteLineImport,
            product_name: String,
            parts: Vec<(String, String, String)>,
        }
        let mut resolved: Vec<Resolved> = Vec::new();
        for line in &input.lines {
            let name: Option<String> = tx
                .query_row(
                    "SELECT name FROM products WHERE id = ?1",
                    params![line.product_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(product_name) = name else { continue };
            let mut stmt = tx.prepare(
                "SELECT id, name, default_filament_id FROM catalog_parts WHERE product_id = ?1 AND is_tracked = 1 AND is_color_only = 0 ORDER BY sort_order",
            )?;
            let parts: Vec<(String, String, String)> = stmt
                .query_map(params![line.product_id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            let parts = match &line.only_part_ids {
                Some(ids) => parts
                    .into_iter()
                    .filter(|(id, _, _)| ids.contains(id))
                    .collect(),
                None => parts,
            };
            resolved.push(Resolved {
                line,
                product_name,
                parts,
            });
        }
        if resolved.is_empty() {
            return Ok(WebsiteImportOutcome::Skipped {
                reason: "no lines with a known product".into(),
            });
        }

        let oid = format!(
            "ord-{}",
            Uuid::new_v4()
                .to_string()
                .split('-')
                .next()
                .unwrap_or("web")
        );
        let code = match input
            .order_code
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        {
            Some(c) => c.to_string(),
            None => {
                let raw = Uuid::new_v4().simple().to_string().to_uppercase();
                format!("FP-{}-{}", &raw[..4], &raw[4..8])
            }
        };
        let created_at = if input.created_at.trim().is_empty() {
            now.clone()
        } else {
            input.created_at.trim().to_string()
        };
        tx.execute(
            "INSERT INTO orders (id, order_code, customer_name, customer_email, source, is_rush, is_on_hold, notes, shipping_charged_cents, shipping_cost_cents, created_at, updated_at, remote_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12)",
            params![
                oid, code, input.customer_name, input.customer_email, input.source,
                input.is_rush as i64, input.is_on_hold as i64, input.notes,
                input.shipping_charged_cents.max(0), created_at, now, remote_id
            ],
        )?;

        // Same expansion as create_order: one local line (quantity 1) per unit ordered.
        let mut n: i64 = 0;
        for r in &resolved {
            let vcam_json = r
                .line
                .view_camera
                .filter(ViewCamera::is_valid)
                .and_then(|c| serde_json::to_string(&c).ok());
            let title = if r.line.title.trim().is_empty() {
                r.product_name.clone()
            } else {
                r.line.title.trim().to_string()
            };
            for _ in 0..r.line.quantity.max(1) {
                n += 1;
                let lid = format!("line-{}-{}", oid, n);
                let item_label = format!("{} #{}", title, n);
                tx.execute(
                    "INSERT INTO order_lines (id, order_id, product_id, item_label, quantity, unit_price_cents, custom_text, view_camera_json)
                     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7)",
                    params![lid, oid, r.line.product_id, item_label, r.line.unit_price_cents.max(0), r.line.custom_text, vcam_json],
                )?;
                for (partid, part_name, default_fid) in &r.parts {
                    let fid = r
                        .line
                        .part_filaments
                        .get(partid)
                        .filter(|f| {
                            tx.query_row(
                                "SELECT 1 FROM filaments WHERE id = ?1",
                                params![f],
                                |_| Ok(()),
                            )
                            .optional()
                            .ok()
                            .flatten()
                            .is_some()
                        })
                        .cloned()
                        .unwrap_or_else(|| default_fid.clone());
                    let uid = format!("unit-{}-{}-{}", oid, n, partid);
                    tx.execute(
                        "INSERT INTO part_units (id, order_id, line_id, product_id, part_id, unit_index, filament_id, state, printer_id, plate_job_id, reprint_count, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'Queued', NULL, NULL, 0, ?8)",
                        params![uid, oid, lid, r.line.product_id, partid, n, fid, now],
                    )?;
                    let (fname, fhex): (String, String) = tx
                        .query_row(
                            "SELECT name, hex FROM filaments WHERE id = ?1",
                            params![fid],
                            |q| Ok((q.get(0)?, q.get(1)?)),
                        )
                        .unwrap_or_else(|_| (String::new(), String::new()));
                    tx.execute(
                        "INSERT INTO flow_events (
                            id, created_at, kind, order_id, order_code, customer_name, line_id, item_label,
                            product_id, product_name, part_id, part_name, unit_id, filament_name, filament_hex,
                            from_state, to_state, printer_id, printer_name, actor_device, source_surface,
                            action_label, failure_reason, failure_note, cost_impact_cents, can_undo
                        ) VALUES (?1, ?2, 'OrderCreated', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, 'Queued', NULL, NULL, 'Website', 'Orders · Website Import', 'Imported Website Order & Queued Part', NULL, NULL, 0, 0)",
                        params![Uuid::new_v4().to_string(), now, oid, code, input.customer_name, lid, item_label, r.line.product_id, r.product_name, partid, part_name, uid, fname, fhex],
                    )?;
                }
            }
        }
        tx.execute(
            "INSERT INTO imported_store_orders (remote_id, order_id, imported_at) VALUES (?1, ?2, ?3)",
            params![remote_id, oid, now],
        )?;
        tx.commit()?;
        Ok(WebsiteImportOutcome::Imported { order_id: oid })
    }

    pub fn delete_order(&mut self, order_id: &str) -> CoreResult<ShopSnapshot> {
        let tx = self.conn.transaction()?;
        let info: Option<(Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT order_code, customer_name FROM orders WHERE id = ?1",
                params![order_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((code, customer)) = info {
            let (units, done): (i64, i64) = tx.query_row(
                "SELECT COUNT(*), COALESCE(SUM(CASE WHEN state IN ('Printed','Post-Processing','PostProcessing','Ready','Packed','Shipped') THEN 1 ELSE 0 END), 0)
                 FROM part_units WHERE order_id = ?1",
                params![order_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let lines: i64 = tx.query_row(
                "SELECT COUNT(*) FROM order_lines WHERE order_id = ?1",
                params![order_id],
                |r| r.get(0),
            )?;
            tx.execute(
                "INSERT INTO flow_events (
                    id, created_at, kind, order_id, order_code, customer_name, item_label,
                    filament_name, filament_hex, from_state, to_state, actor_device, source_surface,
                    action_label, failure_note, cost_impact_cents, can_undo
                ) VALUES (?1, ?2, 'OrderDeleted', ?3, ?4, ?5, ?6, '', '', NULL, 'Deleted', 'Mac Studio', 'Orders · Delete', 'Deleted Order', ?7, 0, 0)",
                params![
                    Uuid::new_v4().to_string(),
                    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
                    order_id,
                    code,
                    customer,
                    format!("{lines} lines · {units} units"),
                    format!("units={units}; printed_or_later={done}; lines={lines}"),
                ],
            )?;
        }
        tx.execute(
            "DELETE FROM part_units WHERE order_id = ?1",
            params![order_id],
        )?;
        tx.execute(
            "DELETE FROM order_lines WHERE order_id = ?1",
            params![order_id],
        )?;
        tx.execute("DELETE FROM orders WHERE id = ?1", params![order_id])?;
        tx.commit()?;
        self.snapshot()
    }

    pub fn add_printer(
        &mut self,
        name: String,
        model: String,
        nozzle_mm: f64,
        slot_filament_ids: Vec<String>,
    ) -> CoreResult<ShopSnapshot> {
        self.add_printer_with_bed(name, model, nozzle_mm, slot_filament_ids, None, None, None)
    }

    /// `add_printer` with an optional bed size (width and depth, both or neither) and
    /// an optional build height in mm (see `validate_bed_size` and `validate_bed_height`).
    pub fn add_printer_with_bed(
        &mut self,
        name: String,
        model: String,
        nozzle_mm: f64,
        slot_filament_ids: Vec<String>,
        bed_x_mm: Option<f64>,
        bed_y_mm: Option<f64>,
        bed_z_mm: Option<f64>,
    ) -> CoreResult<ShopSnapshot> {
        let (bed_x_mm, bed_y_mm) = validate_bed_size(bed_x_mm, bed_y_mm)?;
        let bed_z_mm = validate_bed_height(bed_z_mm)?;
        // No built-in model names. A blank name becomes "Printer N"; a blank model stays blank.
        let name = {
            let t = name.trim();
            if !t.is_empty() {
                t.to_string()
            } else {
                let count: i64 = self
                    .conn
                    .query_row("SELECT COUNT(*) FROM printers", [], |r| r.get(0))?;
                format!("Printer {}", count + 1)
            }
        };
        let model = model.trim().to_string();
        let id = format!("prn-{}", &Uuid::new_v4().to_string()[..8]);
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO printers (id, name, model, nozzle_mm, status, utilization_pct, bed_x_mm, bed_y_mm, bed_z_mm)
             VALUES (?1, ?2, ?3, ?4, 'Idle', 0.0, ?5, ?6, ?7)",
            params![id, name, model, nozzle_mm, bed_x_mm, bed_y_mm, bed_z_mm],
        )?;
        for (idx, fid) in slot_filament_ids.iter().enumerate() {
            if !fid.trim().is_empty() {
                tx.execute(
                    "INSERT OR REPLACE INTO printer_slots (printer_id, slot_index, filament_id)
                     VALUES (?1, ?2, ?3)",
                    params![id, (idx + 1) as i64, fid.trim()],
                )?;
            }
        }
        tx.commit()?;
        self.snapshot()
    }

    /// Sets (or clears) a printer's bed size in mm. Width and depth are both or neither;
    /// build height is independent and optional. Each set value must be 50–2000 mm.
    pub fn set_printer_bed_size(
        &mut self,
        printer_id: &str,
        bed_x_mm: Option<f64>,
        bed_y_mm: Option<f64>,
        bed_z_mm: Option<f64>,
    ) -> CoreResult<ShopSnapshot> {
        let (x, y) = validate_bed_size(bed_x_mm, bed_y_mm)?;
        let z = validate_bed_height(bed_z_mm)?;
        let n = self.conn.execute(
            "UPDATE printers SET bed_x_mm = ?2, bed_y_mm = ?3, bed_z_mm = ?4 WHERE id = ?1",
            params![printer_id, x, y, z],
        )?;
        if n == 0 {
            return Err(CoreError::Validation(format!(
                "Unknown printer {printer_id}"
            )));
        }
        self.snapshot()
    }

    pub fn rename_printer(&mut self, printer_id: &str, name: &str) -> CoreResult<ShopSnapshot> {
        self.conn.execute(
            "UPDATE printers SET name = ?2 WHERE id = ?1",
            params![printer_id, name.trim()],
        )?;
        self.snapshot()
    }

    /// Sets the printer's model. A blank value is stored as blank (no built-in default).
    pub fn set_printer_model(&mut self, printer_id: &str, model: &str) -> CoreResult<ShopSnapshot> {
        self.conn.execute(
            "UPDATE printers SET model = ?2 WHERE id = ?1",
            params![printer_id, model.trim()],
        )?;
        self.snapshot()
    }

    pub fn delete_printer(&mut self, printer_id: &str) -> CoreResult<ShopSnapshot> {
        let now = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let tx = self.conn.transaction()?;
        // Log every staged/printing unit that goes back to the queue before the printer is gone.
        tx.execute(
            "INSERT INTO flow_events (
                id, created_at, kind, order_id, order_code, customer_name, line_id, item_label,
                product_id, product_name, part_id, part_name, unit_id, filament_name, filament_hex,
                from_state, to_state, printer_id, printer_name, actor_device, source_surface,
                action_label, failure_reason, failure_note, cost_impact_cents, can_undo, batch_id
            )
            SELECT lower(hex(randomblob(16))), ?2, 'RestoredToQueue', u.order_id, o.order_code, o.customer_name,
                u.line_id, l.item_label, u.product_id, p.name, u.part_id, cp.name, u.id,
                COALESCE(f.name, ''), COALESCE(f.hex, ''), u.state, 'Queued', u.printer_id, pr.name,
                'FarmPrint', 'Printers · Remove printer', 'Printer removed: back to In Queue',
                NULL, NULL, 0, 0, ?3
            FROM part_units u
            LEFT JOIN orders o ON o.id = u.order_id
            LEFT JOIN order_lines l ON l.id = u.line_id
            LEFT JOIN products p ON p.id = u.product_id
            LEFT JOIN catalog_parts cp ON cp.id = u.part_id
            LEFT JOIN filaments f ON f.id = u.filament_id
            LEFT JOIN printers pr ON pr.id = u.printer_id
            WHERE u.printer_id = ?1 AND u.state IN ('Staged','Printing')",
            params![printer_id, now, Uuid::new_v4().to_string()],
        )?;
        tx.execute(
            "UPDATE orders SET updated_at = ?2 WHERE id IN (SELECT order_id FROM part_units WHERE printer_id = ?1 AND state IN ('Staged','Printing'))",
            params![printer_id, now],
        )?;
        tx.execute(
            "UPDATE part_units SET printer_id = NULL, state = CASE WHEN state IN ('Staged','Printing') THEN 'Queued' ELSE state END WHERE printer_id = ?1",
            params![printer_id],
        )?;
        tx.execute(
            "DELETE FROM printer_slots WHERE printer_id = ?1",
            params![printer_id],
        )?;
        tx.execute(
            "DELETE FROM printer_feeder_spools WHERE feeder_id IN (SELECT id FROM printer_feeders WHERE printer_id = ?1)",
            params![printer_id],
        )?;
        tx.execute(
            "DELETE FROM printer_feeders WHERE printer_id = ?1",
            params![printer_id],
        )?;
        tx.execute(
            "DELETE FROM printer_print_areas WHERE printer_id = ?1",
            params![printer_id],
        )?;
        tx.execute("DELETE FROM printers WHERE id = ?1", params![printer_id])?;
        tx.commit()?;
        self.snapshot()
    }

    pub fn set_printer_filament_slots(
        &mut self,
        printer_id: &str,
        filament_ids: Vec<String>,
    ) -> CoreResult<ShopSnapshot> {
        // With saved feeders, a slot past the last feeding slot has nowhere to go.
        if let Some(cap) = feeders::saved_feeding_capacity(&self.conn, printer_id)? {
            if let Some(pos) = filament_ids.iter().rposition(|f| !f.trim().is_empty()) {
                if pos as i64 >= cap {
                    return Err(CoreError::Validation(format!(
                        "Slot {} is past the last feeder slot on this printer ({cap}). Add a feeder or more slots first.",
                        pos + 1
                    )));
                }
            }
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM printer_slots WHERE printer_id = ?1",
            params![printer_id],
        )?;
        for (idx, fid) in filament_ids.iter().enumerate() {
            if !fid.trim().is_empty() {
                tx.execute(
                    "INSERT INTO printer_slots (printer_id, slot_index, filament_id) VALUES (?1, ?2, ?3)",
                    params![printer_id, (idx + 1) as i64, fid.trim()],
                )?;
            }
        }
        tx.commit()?;
        self.snapshot()
    }

    fn existing_filament_brands(&self, exclude_id: Option<&str>) -> CoreResult<Vec<String>> {
        existing_filament_column(&self.conn, "brand", exclude_id, None)
    }

    fn existing_filament_vendors(&self, exclude_id: Option<&str>) -> CoreResult<Vec<String>> {
        existing_filament_column(&self.conn, "vendor", exclude_id, None)
    }

    pub fn add_filament_swatch(
        &mut self,
        name: String,
        brand: String,
        material: String,
        hex: String,
        cost_per_kg: f64,
        grams_remaining: f64,
    ) -> CoreResult<ShopSnapshot> {
        self.add_filament_swatch_with_vendor(
            name,
            brand,
            material,
            hex,
            cost_per_kg,
            grams_remaining,
            None,
        )
    }

    pub fn add_filament_swatch_with_vendor(
        &mut self,
        name: String,
        brand: String,
        material: String,
        hex: String,
        cost_per_kg: f64,
        grams_remaining: f64,
        vendor: Option<String>,
    ) -> CoreResult<ShopSnapshot> {
        let id = format!("color-{}", Uuid::new_v4().to_string()[..10].to_uppercase());
        let clean_hex = if hex.trim().starts_with('#') {
            hex.trim().to_uppercase()
        } else {
            format!("#{}", hex.trim().to_uppercase())
        };
        let brand = canonical_label(&brand, &self.existing_filament_brands(None)?);
        let vendor = store_vendor(vendor, &self.existing_filament_vendors(None)?);
        self.conn.execute(
            "INSERT INTO filaments (id, name, brand, material, hex, cost_per_kg, grams_remaining, vendor)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                name.trim(),
                brand,
                material.trim(),
                clean_hex,
                cost_per_kg,
                grams_remaining,
                vendor
            ],
        )?;
        self.snapshot()
    }

    /// How many open part units, product part defaults and overstock rows still use a
    /// filament. Shipped/closed history is not counted (it keeps its recorded color).
    pub fn filament_usage(&self, filament_id: &str) -> CoreResult<FilamentUsage> {
        let count = |sql: &str| -> CoreResult<i64> {
            Ok(self
                .conn
                .query_row(sql, params![filament_id], |r| r.get(0))?)
        };
        Ok(FilamentUsage {
            open_units: count(
                "SELECT COUNT(*) FROM part_units WHERE filament_id = ?1 AND state NOT IN ('Shipped','Closed')",
            )?,
            part_defaults: count("SELECT COUNT(*) FROM catalog_parts WHERE default_filament_id = ?1")?,
            overstock_rows: count("SELECT COUNT(*) FROM overstock WHERE filament_id = ?1 AND quantity > 0")?,
        })
    }

    /// Refuses while open orders, product defaults or overstock still use the color, so
    /// nothing is left pointing at a deleted swatch. Printer slots holding it are emptied.
    pub fn delete_filament_swatch(&mut self, filament_id: &str) -> CoreResult<ShopSnapshot> {
        let usage = self.filament_usage(filament_id)?;
        if usage.open_units > 0 || usage.part_defaults > 0 || usage.overstock_rows > 0 {
            let mut uses = Vec::new();
            if usage.open_units > 0 {
                uses.push(format!(
                    "{} part{} on open orders",
                    usage.open_units,
                    if usage.open_units == 1 { "" } else { "s" }
                ));
            }
            if usage.part_defaults > 0 {
                uses.push(format!(
                    "{} product part default{}",
                    usage.part_defaults,
                    if usage.part_defaults == 1 { "" } else { "s" }
                ));
            }
            if usage.overstock_rows > 0 {
                uses.push(format!(
                    "{} overstock item{}",
                    usage.overstock_rows,
                    if usage.overstock_rows == 1 { "" } else { "s" }
                ));
            }
            return Err(CoreError::Validation(format!(
                "This color is still used by {}. Change those to another color first, then delete it.",
                uses.join(", ")
            )));
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM printer_slots WHERE filament_id = ?1",
            params![filament_id],
        )?;
        tx.execute(
            "DELETE FROM printer_feeder_spools WHERE filament_id = ?1",
            params![filament_id],
        )?;
        tx.execute("DELETE FROM filaments WHERE id = ?1", params![filament_id])?;
        tx.commit()?;
        self.snapshot()
    }

    pub fn adjust_overstock(&mut self, overstock_id: &str, delta: i64) -> CoreResult<ShopSnapshot> {
        let cur: Option<i64> = self
            .conn
            .query_row(
                "SELECT quantity FROM overstock WHERE id = ?1",
                params![overstock_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(q) = cur {
            let next = (q + delta).max(0);
            if next == 0 {
                self.conn
                    .execute("DELETE FROM overstock WHERE id = ?1", params![overstock_id])?;
            } else {
                self.conn.execute(
                    "UPDATE overstock SET quantity = ?1 WHERE id = ?2",
                    params![next, overstock_id],
                )?;
            }
        }
        self.snapshot()
    }

    /// Saves an order's ship fields as given (`None` clears that field).
    pub fn set_order_ship_fields(
        &mut self,
        order_id: &str,
        ship: OrderShipFields,
    ) -> CoreResult<ShopSnapshot> {
        let now = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let n = self.conn.execute(
            "UPDATE orders SET ship_status = ?1, packed_at = ?2, shipped_at = ?3, tracking_number = ?4, box_preset_id = ?5, updated_at = ?6 WHERE id = ?7",
            params![ship.ship_status.map(|s| s.as_str()), ship.packed_at, ship.shipped_at, ship.tracking_number, ship.box_preset_id, now, order_id],
        )?;
        if n == 0 {
            return Err(CoreError::Validation(format!(
                "Order not found: {order_id}"
            )));
        }
        self.snapshot()
    }

    /// Reopens an order: clears all five ship fields (`OrderShipFields::clear`).
    pub fn reopen_order_shipping(&mut self, order_id: &str) -> CoreResult<ShopSnapshot> {
        self.set_order_ship_fields(order_id, OrderShipFields::default())
    }

    fn clear_ship_fields_tx(conn: &Connection, order_id: &str, now: &str) -> CoreResult<()> {
        conn.execute(
            "UPDATE orders SET ship_status = NULL, packed_at = NULL, shipped_at = NULL, tracking_number = NULL, box_preset_id = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, order_id],
        )?;
        Ok(())
    }

    pub fn get_settings(&self) -> CoreResult<ShopSettings> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT value_json FROM shop_settings WHERE key = 'default'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(json) = raw {
            if let Ok(parsed) = serde_json::from_str::<ShopSettings>(&json) {
                return Ok(parsed);
            }
        }
        Ok(ShopSettings::default())
    }

    pub fn save_settings(&mut self, settings: ShopSettings) -> CoreResult<ShopSettings> {
        let json = serde_json::to_string(&settings).unwrap_or_else(|_| "{}".to_string());
        self.conn.execute(
            "INSERT OR REPLACE INTO shop_settings (key, value_json) VALUES ('default', ?1)",
            params![json],
        )?;
        Ok(settings)
    }

    fn load_filaments(&self) -> CoreResult<Vec<FilamentSwatch>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, brand, material, hex, cost_per_kg, grams_remaining, vendor FROM filaments ORDER BY name",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(FilamentSwatch {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    brand: r.get(2)?,
                    material: r.get(3)?,
                    hex: r.get(4)?,
                    cost_per_kg: r.get(5)?,
                    grams_remaining: r.get(6)?,
                    vendor: r.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn load_products(&self) -> CoreResult<Vec<Product>> {
        let mut part_stmt = self.conn.prepare(
            "SELECT id, product_id, name, is_tracked, is_color_only, default_filament_id, grams, print_minutes, unit_cost, mesh_file, sort_order
             FROM catalog_parts ORDER BY sort_order",
        )?;
        let all_parts = part_stmt
            .query_map([], |r| {
                Ok(CatalogPart {
                    id: r.get(0)?,
                    product_id: r.get(1)?,
                    name: r.get(2)?,
                    is_tracked: r.get::<_, i64>(3)? != 0,
                    is_color_only: r.get::<_, i64>(4)? != 0,
                    default_filament_id: r.get(5)?,
                    grams: r.get(6)?,
                    print_minutes: r.get(7)?,
                    unit_cost: r.get(8)?,
                    mesh_file: r.get(9)?,
                    sort_order: r.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut stmt = self.conn.prepare(
            "SELECT id, name, sku, price_cents, packed_weight_oz, default_box_name, box_cost_cents, supports_custom_text
             FROM products ORDER BY name",
        )?;
        let products = stmt
            .query_map([], |r| {
                let pid: String = r.get(0)?;
                let parts = all_parts
                    .iter()
                    .filter(|p| p.product_id == pid)
                    .cloned()
                    .collect();
                Ok(Product {
                    id: pid,
                    name: r.get(1)?,
                    sku: r.get(2)?,
                    price_cents: r.get(3)?,
                    packed_weight_oz: r.get(4)?,
                    default_box_name: r.get(5)?,
                    box_cost_cents: r.get(6)?,
                    supports_custom_text: r.get::<_, i64>(7)? != 0,
                    parts,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(products)
    }

    fn load_printers_meta(
        &self,
        filament_map: &HashMap<String, FilamentSwatch>,
    ) -> CoreResult<Vec<Printer>> {
        let mut slot_stmt = self.conn.prepare(
            "SELECT printer_id, slot_index, filament_id FROM printer_slots ORDER BY slot_index",
        )?;
        let slot_rows = slot_stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let feeder_rows = feeders::load_feeder_rows(&self.conn, None)?;
        let mut area_rows = print_areas::load_print_areas(&self.conn)?;
        let dry_spools =
            feeders::load_dry_box_spools(&self.conn, None, Some(filament_map), "#888888")?;
        let mut stmt = self.conn.prepare(
            "SELECT id, name, model, nozzle_mm, status, utilization_pct, bed_x_mm, bed_y_mm, bed_z_mm,
                    extruder_clearance_radius, extruder_clearance_dist_to_rod,
                    extruder_clearance_height_to_rod, extruder_clearance_height_to_lid
             FROM printers ORDER BY id",
        )?;
        let printers = stmt
            .query_map([], |r| {
                let id: String = r.get(0)?;
                let loaded_slots = slot_rows
                    .iter()
                    .filter(|(pid, _, _)| *pid == id)
                    .map(|(_, idx, fid)| {
                        let fil = filament_map.get(fid);
                        PrinterSlot {
                            slot_index: *idx,
                            filament_id: fid.clone(),
                            filament_name: fil.map(|f| f.name.clone()).unwrap_or_default(),
                            filament_hex: fil
                                .map(|f| f.hex.clone())
                                .unwrap_or_else(|| "#888888".to_string()),
                            material: fil.map(|f| f.material.clone()).unwrap_or_default(),
                            brand: fil.map(|f| f.brand.clone()).unwrap_or_default(),
                        }
                    })
                    .collect::<Vec<_>>();
                let saved: Vec<feeders::FeederRow> = feeder_rows
                    .iter()
                    .filter(|f| f.printer_id == id)
                    .cloned()
                    .collect();
                let feeders = feeders::layout_feeders(&id, &saved, &loaded_slots, &dry_spools);
                let print_areas = area_rows.remove(&id).unwrap_or_default();
                Ok(Printer {
                    id,
                    name: r.get(1)?,
                    model: r.get(2)?,
                    nozzle_mm: r.get(3)?,
                    status: r.get(4)?,
                    loaded_slots,
                    active_units: Vec::new(),
                    staged_units: Vec::new(),
                    remaining_minutes: 0,
                    utilization_pct: r.get(5)?,
                    bed_x_mm: r.get(6)?,
                    bed_y_mm: r.get(7)?,
                    bed_z_mm: r.get(8)?,
                    feeders,
                    print_areas,
                    extruder_clearance: ExtruderClearance {
                        extruder_clearance_radius: r.get(9)?,
                        extruder_clearance_dist_to_rod: r.get(10)?,
                        extruder_clearance_height_to_rod: r.get(11)?,
                        extruder_clearance_height_to_lid: r.get(12)?,
                    },
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(printers)
    }

    fn load_orders(
        &self,
        filament_map: &HashMap<String, FilamentSwatch>,
        product_map: &HashMap<String, Product>,
        part_map: &HashMap<String, CatalogPart>,
        printer_name_map: &HashMap<String, String>,
    ) -> CoreResult<Vec<Order>> {
        let mut unit_stmt = self.conn.prepare(
            "SELECT id, order_id, line_id, product_id, part_id, unit_index, filament_id, state, printer_id, plate_job_id, reprint_count, updated_at
             FROM part_units ORDER BY id",
        )?;
        let unit_rows = unit_stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, Option<String>>(9)?,
                    r.get::<_, i64>(10)?,
                    r.get::<_, String>(11)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut line_stmt = self.conn.prepare(
            "SELECT id, order_id, product_id, item_label, quantity, unit_price_cents, custom_text, view_camera_json
             FROM order_lines ORDER BY id",
        )?;
        let line_rows = line_stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    // Malformed JSON reads as None (UI falls back to the product angle).
                    r.get::<_, Option<String>>(7)?
                        .and_then(|j| serde_json::from_str::<ViewCamera>(&j).ok())
                        .filter(ViewCamera::is_valid),
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut order_stmt = self.conn.prepare(
            "SELECT id, order_code, customer_name, customer_email, source, is_rush, is_on_hold, notes, shipping_charged_cents, shipping_cost_cents, created_at, updated_at,
                    ship_status, packed_at, shipped_at, tracking_number, box_preset_id, remote_id, ship_by
             FROM orders ORDER BY is_rush DESC, created_at ASC",
        )?;
        let mut running_queue_mins: i64 = 0;
        let packaging_cost_cents = self.get_settings()?.packaging_cost_cents;

        // Group once (rows keep their ORDER BY id order) so assembling every order is
        // O(orders + lines + units) instead of scanning every line/unit per order.
        let mut lines_by_order: HashMap<&str, Vec<&_>> = HashMap::new();
        for row in &line_rows {
            lines_by_order.entry(row.1.as_str()).or_default().push(row);
        }
        let mut units_by_line: HashMap<&str, Vec<&_>> = HashMap::new();
        for row in &unit_rows {
            units_by_line.entry(row.2.as_str()).or_default().push(row);
        }

        let orders = order_stmt
            .query_map([], |r| {
                let oid: String = r.get(0)?;
                let order_code: String = r.get(1)?;
                let customer_name: String = r.get(2)?;
                let is_rush = r.get::<_, i64>(5)? != 0;
                let shipping_charged_cents: i64 = r.get(8)?;
                let shipping_cost_cents: i64 = r.get(9)?;

                let lines: Vec<OrderLine> = lines_by_order
                    .get(oid.as_str())
                    .map(|v| v.as_slice())
                    .unwrap_or(&[])
                    .iter()
                    .copied()
                    .map(|(lid, _, pid, ilabel, qty, price_cents, ctext, vcam)| {
                        let prod_name = product_map
                            .get(pid)
                            .map(|p| p.name.clone())
                            .unwrap_or_else(|| pid.clone());
                        let units: Vec<PartUnit> = units_by_line
                            .get(lid.as_str())
                            .map(|v| v.as_slice())
                            .unwrap_or(&[])
                            .iter()
                            .copied()
                            .filter(|(_, _, l, _, partid, _, _, _, _, _, _, _)| {
                                if l != lid {
                                    return false;
                                }
                                if let Some(cp) = part_map.get(partid) {
                                    cp.is_tracked && !cp.is_color_only
                                } else {
                                    true
                                }
                            })
                            .map(
                                |(
                                    uid,
                                    _,
                                    _,
                                    upid,
                                    partid,
                                    u_idx,
                                    fid,
                                    st,
                                    prn_id,
                                    job_id,
                                    reprints,
                                    upd,
                                )| {
                                    let cpart = part_map.get(partid);
                                    let fil = filament_map.get(fid);
                                    let prn_name = prn_id
                                        .as_ref()
                                        .and_then(|id| printer_name_map.get(id).cloned());
                                    PartUnit {
                                        id: uid.clone(),
                                        order_id: oid.clone(),
                                        order_code: order_code.clone(),
                                        customer_name: customer_name.clone(),
                                        line_id: lid.clone(),
                                        line_label: ilabel.clone(),
                                        product_id: upid.clone(),
                                        product_name: prod_name.clone(),
                                        part_id: partid.clone(),
                                        part_name: cpart
                                            .map(|p| p.name.clone())
                                            .unwrap_or_else(|| partid.clone()),
                                        unit_index: *u_idx,
                                        filament_id: fid.clone(),
                                        filament_name: fil
                                            .map(|f| f.name.clone())
                                            .unwrap_or_default(),
                                        filament_hex: fil
                                            .map(|f| f.hex.clone())
                                            .unwrap_or_else(|| "#888888".to_string()),
                                        filament_material: fil
                                            .map(|f| f.material.clone())
                                            .unwrap_or_default(),
                                        state: st.clone(),
                                        printer_id: prn_id.clone(),
                                        printer_name: prn_name,
                                        plate_job_id: job_id.clone(),
                                        reprint_count: *reprints,
                                        unit_cost: cpart.map(|p| p.unit_cost).unwrap_or(0.5),
                                        print_minutes: cpart.map(|p| p.print_minutes).unwrap_or(20),
                                        grams: cpart.map(|p| p.grams).unwrap_or(10.0),
                                        updated_at: upd.clone(),
                                    }
                                },
                            )
                            .collect();
                        OrderLine {
                            id: lid.clone(),
                            order_id: oid.clone(),
                            product_id: pid.clone(),
                            product_name: prod_name,
                            item_label: ilabel.clone(),
                            quantity: *qty,
                            unit_price_cents: *price_cents,
                            custom_text: ctext.clone(),
                            view_camera: *vcam,
                            units,
                        }
                    })
                    .collect();

                let all_order_units: Vec<&PartUnit> =
                    lines.iter().flat_map(|l| l.units.iter()).collect();
                let is_completed_unit = |state: &str| {
                    matches!(
                        state,
                        "Printed"
                            | "PostProcess"
                            | "Post-Process"
                            | "Post-Processing"
                            | "PostProcessing"
                            | "PostProcessed"
                            | "Assembled"
                            | "Processed"
                            | "Ready"
                            | "Packed"
                            | "Closed"
                            | "Shipped"
                    )
                };
                let progress_pct = if all_order_units.is_empty() {
                    0.0
                } else {
                    let done = all_order_units
                        .iter()
                        .filter(|u| is_completed_unit(&u.state))
                        .count() as f64;
                    ((done / all_order_units.len() as f64) * 100.0).round()
                };

                let overall_state = if all_order_units.is_empty() {
                    "Queued"
                } else if all_order_units
                    .iter()
                    .all(|u| matches!(u.state.as_str(), "Shipped" | "Closed"))
                {
                    "Shipped"
                } else if all_order_units.iter().all(|u| {
                    matches!(
                        u.state.as_str(),
                        "Ready" | "Processed" | "Packed" | "Shipped" | "Closed"
                    )
                }) {
                    "Ready"
                } else if all_order_units.iter().any(|u| u.state == "Printing") {
                    "Printing"
                } else if all_order_units.iter().any(|u| u.state == "Staged") {
                    "Staged"
                } else if all_order_units.iter().any(|u| u.state == "Queued") {
                    "Queued"
                } else if all_order_units.iter().any(|u| {
                    matches!(
                        u.state.as_str(),
                        "Post-Processing"
                            | "PostProcess"
                            | "Post-Process"
                            | "PostProcessing"
                            | "Assembled"
                    )
                }) {
                    "Post-Processing"
                } else if all_order_units.iter().any(|u| u.state == "Printed") {
                    "Printed"
                } else {
                    "Queued"
                }
                .to_string();

                let unprinted: Vec<&&PartUnit> = all_order_units
                    .iter()
                    .filter(|u| u.state == "Queued" || u.state == "Staged" || u.state == "Printing")
                    .collect();
                let bottleneck_note = if unprinted.is_empty() {
                    None
                } else if unprinted.len() == 1 {
                    let u = unprinted[0];
                    Some(format!(
                        "1 part left: {} ({})",
                        u.part_name, u.filament_name
                    ))
                } else {
                    Some(format!("{} parts remaining across queue", unprinted.len()))
                };

                let order_mins: i64 = unprinted.iter().map(|u| u.print_minutes).sum();
                running_queue_mins += order_mins;
                let queue_hours_ahead =
                    ((running_queue_mins as f64 / 60.0) / 4.0 * 10.0).round() / 10.0;
                let ship_by_status = if overall_state == "Ready" || overall_state == "Shipped" {
                    "Ready Now".to_string()
                } else if is_rush && queue_hours_ahead > 1.5 {
                    "At Risk".to_string()
                } else {
                    "On Track".to_string()
                };

                let merch_cents: i64 = lines.iter().map(|l| l.unit_price_cents * l.quantity).sum();
                let total_revenue_cents = merch_cents + shipping_charged_cents;
                let base_parts_cost_cents: i64 = all_order_units
                    .iter()
                    .map(|u| (u.unit_cost * 100.0).round() as i64)
                    .sum();
                let reprint_loss_cents: i64 = all_order_units
                    .iter()
                    .map(|u| ((u.unit_cost * 100.0).round() as i64) * u.reprint_count)
                    .sum();
                // Packaging is the shop's setting; blank counts as 0 (no built-in cost).
                let estimated_cost_cents = base_parts_cost_cents
                    + reprint_loss_cents
                    + packaging_cost_cents.unwrap_or(0)
                    + shipping_cost_cents;
                let net_profit_cents = total_revenue_cents - estimated_cost_cents;
                let margin_pct = if total_revenue_cents > 0 {
                    ((net_profit_cents as f64 / total_revenue_cents as f64) * 100.0).round()
                } else {
                    0.0
                };

                let total_reprints: i64 = all_order_units.iter().map(|u| u.reprint_count).sum();
                let (has_margin_warning, margin_warning_note) = if total_reprints > 0 {
                    (
                        true,
                        Some(format!(
                            "{} reprint{} (-${:.2})",
                            total_reprints,
                            if total_reprints == 1 { "" } else { "s" },
                            reprint_loss_cents as f64 / 100.0
                        )),
                    )
                } else {
                    (false, None)
                };

                Ok(Order {
                    id: oid,
                    order_hash: String::new(),
                    order_code,
                    customer_name,
                    customer_email: r.get(3)?,
                    source: r.get(4)?,
                    remote_id: r.get(17)?,
                    is_rush,
                    is_on_hold: r.get::<_, i64>(6)? != 0,
                    notes: r.get(7)?,
                    shipping_charged_cents,
                    shipping_cost_cents,
                    created_at: r.get(10)?,
                    updated_at: r.get(11)?,
                    overall_state,
                    progress_pct,
                    bottleneck_note,
                    ship_by_status,
                    queue_hours_ahead,
                    total_revenue_cents,
                    estimated_cost_cents,
                    reprint_loss_cents,
                    net_profit_cents,
                    margin_pct,
                    has_margin_warning,
                    margin_warning_note,
                    ship_by: r.get(18)?,
                    packaging_cost_set: packaging_cost_cents.is_some(),
                    ship: OrderShipFields {
                        ship_status: r
                            .get::<_, Option<String>>(12)?
                            .as_deref()
                            .and_then(ShipStatus::parse),
                        packed_at: r.get(13)?,
                        shipped_at: r.get(14)?,
                        tracking_number: r.get(15)?,
                        box_preset_id: r.get(16)?,
                    },
                    lines,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(orders)
    }

    fn load_overstock(
        &self,
        filament_map: &HashMap<String, FilamentSwatch>,
        product_map: &HashMap<String, Product>,
        part_map: &HashMap<String, CatalogPart>,
    ) -> CoreResult<Vec<OverstockItem>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, product_id, part_id, filament_id, quantity FROM overstock")?;
        let items = stmt
            .query_map([], |r| {
                let pid: String = r.get(1)?;
                let partid: String = r.get(2)?;
                let fid: String = r.get(3)?;
                let fil = filament_map.get(&fid);
                Ok(OverstockItem {
                    id: r.get(0)?,
                    product_id: pid.clone(),
                    product_name: product_map.get(&pid).map(|p| p.name.clone()).unwrap_or(pid),
                    part_id: partid.clone(),
                    part_name: part_map
                        .get(&partid)
                        .map(|p| p.name.clone())
                        .unwrap_or(partid),
                    filament_id: fid,
                    filament_name: fil.map(|f| f.name.clone()).unwrap_or_default(),
                    filament_hex: fil
                        .map(|f| f.hex.clone())
                        .unwrap_or_else(|| "#888888".to_string()),
                    quantity: r.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(items)
    }

    fn load_flow_events(&self) -> CoreResult<Vec<FlowEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT seq, id, created_at, kind, order_id, order_code, customer_name, line_id, item_label,
                    product_id, product_name, part_id, part_name, unit_id, filament_name, filament_hex,
                    from_state, to_state, printer_id, printer_name, actor_device, source_surface,
                    action_label, failure_reason, failure_note, cost_impact_cents,
                    (can_undo = 1 AND undone_at IS NULL AND unit_id IS NOT NULL AND from_state IS NOT NULL
                     AND source_surface <> ?1) AS undoable,
                    batch_id, undone_at IS NOT NULL, prev_plate_job_id
             FROM flow_events ORDER BY seq DESC LIMIT 500",
        )?;
        let rows = stmt
            .query_map(params![LEGACY_UNDO_SURFACE], |r| {
                Ok(FlowEvent {
                    seq: r.get(0)?,
                    id: r.get(1)?,
                    created_at: r.get(2)?,
                    kind: r.get(3)?,
                    order_id: r.get(4)?,
                    order_code: r.get(5)?,
                    customer_name: r.get(6)?,
                    line_id: r.get(7)?,
                    item_label: r.get(8)?,
                    product_id: r.get(9)?,
                    product_name: r.get(10)?,
                    part_id: r.get(11)?,
                    part_name: r.get(12)?,
                    unit_id: r.get(13)?,
                    filament_name: r.get(14)?,
                    filament_hex: r.get(15)?,
                    from_state: r.get(16)?,
                    to_state: r.get(17)?,
                    printer_id: r.get(18)?,
                    printer_name: r.get(19)?,
                    actor_device: r.get(20)?,
                    source_surface: r.get(21)?,
                    action_label: r.get(22)?,
                    failure_reason: r.get(23)?,
                    failure_note: r.get(24)?,
                    cost_impact_cents: r.get(25)?,
                    can_undo: r.get::<_, i64>(26)? != 0,
                    batch_id: r.get(27)?,
                    undone: r.get::<_, i64>(28)? != 0,
                    prev_plate_job_id: r.get(29)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn compute_analytics(
        orders: &[Order],
        units: &[PartUnit],
        printers: &[Printer],
        flow_events: &[FlowEvent],
        filament_map: &HashMap<String, FilamentSwatch>,
    ) -> AnalyticsSummary {
        let total_orders = orders.len();
        let ready_to_ship_orders = orders.iter().filter(|o| o.overall_state == "Ready").count();
        let at_risk_orders = orders
            .iter()
            .filter(|o| o.ship_by_status == "At Risk")
            .count();
        let active_orders = orders
            .iter()
            .filter(|o| o.overall_state != "Shipped" && !o.is_on_hold)
            .count();

        let count_state = |s: &str| units.iter().filter(|u| u.state == s).count();
        let units_queued = count_state("Queued");
        let units_staged = count_state("Staged");
        let units_printing = count_state("Printing");
        let units_printed = count_state("Printed");
        let units_post_processing = count_state("Post-Processing");
        let units_ready = count_state("Ready");

        let total_revenue_cents: i64 = orders.iter().map(|o| o.total_revenue_cents).sum();
        let total_material_cost_cents: i64 = units
            .iter()
            .map(|u| (u.unit_cost * 100.0).round() as i64)
            .sum();
        // Undone actions (e.g. a "Mark Failed" that was undone) don't count.
        let total_reprint_loss_cents: i64 = flow_events
            .iter()
            .filter(|e| !e.undone)
            .map(|e| e.cost_impact_cents)
            .sum();
        let total_reprint_grams: f64 = units
            .iter()
            .map(|u| u.grams * (u.reprint_count as f64))
            .sum();
        let total_net_profit_cents: i64 = orders.iter().map(|o| o.net_profit_cents).sum();

        let average_margin_pct = if total_revenue_cents > 0 {
            ((total_net_profit_cents as f64 / total_revenue_cents as f64) * 100.0).round()
        } else {
            0.0
        };

        let fleet_utilization_pct = if printers.is_empty() {
            0.0
        } else {
            (printers.iter().map(|p| p.utilization_pct).sum::<f64>() / printers.len() as f64)
                .round()
        };

        let remaining_mins: i64 = units
            .iter()
            .filter(|u| u.state == "Queued" || u.state == "Staged" || u.state == "Printing")
            .map(|u| u.print_minutes)
            .sum();
        let active_printer_count = printers.len().max(1) as f64;
        let estimated_queue_hours =
            ((remaining_mins as f64 / 60.0) / active_printer_count * 10.0).round() / 10.0;

        let failed_count = flow_events
            .iter()
            .filter(|e| e.kind == "FailedPrint" && !e.undone)
            .count();
        let total_prints = units.len().max(1);
        let first_pass_yield_pct =
            (((total_prints.saturating_sub(failed_count)) as f64 / total_prints as f64) * 100.0)
                .round();

        let mut reason_map: HashMap<String, (usize, i64)> = HashMap::new();
        for ev in flow_events
            .iter()
            .filter(|e| e.kind == "FailedPrint" && !e.undone)
        {
            let reason = ev
                .failure_reason
                .clone()
                .unwrap_or_else(|| "other".to_string());
            let entry = reason_map.entry(reason).or_insert((0, 0));
            entry.0 += 1;
            entry.1 += ev.cost_impact_cents;
        }
        let failure_by_reason = reason_map
            .into_iter()
            .map(|(r, (c, loss))| (r, c, loss))
            .collect();

        let mut by_fil: HashMap<String, (usize, std::collections::HashSet<String>, i64)> =
            HashMap::new();
        for u in units.iter().filter(|u| u.state == "Queued") {
            let entry = by_fil.entry(u.filament_id.clone()).or_default();
            entry.0 += 1;
            entry.1.insert(u.order_id.clone());
            entry.2 += u.print_minutes;
        }
        let mut bottlenecks: Vec<BottleneckCallout> = Vec::new();
        for (fid, (cnt, ords, mins)) in by_fil {
            if cnt >= 2 {
                if let Some(fil) = filament_map.get(&fid) {
                    let hrs = ((mins as f64 / 60.0) * 10.0).round() / 10.0;
                    bottlenecks.push(BottleneckCallout {
                        filament_id: fid,
                        filament_name: fil.name.clone(),
                        filament_hex: fil.hex.clone(),
                        material: fil.material.clone(),
                        blocked_units: cnt,
                        affected_orders: ords.len(),
                        blocked_hours: hrs,
                        recommendation: format!(
                            "{} parts across {} order(s) waiting on {} {} — stage batch plate to clear {:.1} hrs",
                            cnt,
                            ords.len(),
                            fil.name,
                            fil.material,
                            hrs
                        ),
                    });
                }
            }
        }
        bottlenecks.sort_by_key(|b| std::cmp::Reverse(b.blocked_units));

        AnalyticsSummary {
            total_orders,
            active_orders,
            ready_to_ship_orders,
            at_risk_orders,
            units_queued,
            units_staged,
            units_printing,
            units_printed,
            units_post_processing,
            units_ready,
            total_revenue_cents,
            total_material_cost_cents,
            total_reprint_loss_cents,
            total_reprint_grams,
            total_net_profit_cents,
            average_margin_pct,
            fleet_utilization_pct,
            estimated_queue_hours,
            first_pass_yield_pct,
            failure_by_reason,
            bottlenecks,
        }
    }

    /// Sets or clears (`""`) an order's optional ship-by date (`YYYY-MM-DD`).
    pub fn set_order_ship_by(&mut self, order_id: &str, ship_by: &str) -> CoreResult<()> {
        self.conn.execute(
            "UPDATE orders SET ship_by = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                normalize_ship_by(ship_by)?,
                Utc::now().to_rfc3339(),
                order_id
            ],
        )?;
        Ok(())
    }

    pub fn update_order_metadata(
        &mut self,
        order_id: &str,
        customer_name: Option<String>,
        customer_email: Option<String>,
        is_rush: Option<bool>,
        is_on_hold: Option<bool>,
        notes: Option<String>,
    ) -> CoreResult<ShopSnapshot> {
        let now = Utc::now().to_rfc3339();
        if let Some(name) = customer_name {
            self.conn.execute(
                "UPDATE orders SET customer_name = ?1, updated_at = ?2 WHERE id = ?3",
                params![name, now, order_id],
            )?;
        }
        if let Some(email) = customer_email {
            self.conn.execute(
                "UPDATE orders SET customer_email = ?1, updated_at = ?2 WHERE id = ?3",
                params![email, now, order_id],
            )?;
        }
        if let Some(rush) = is_rush {
            self.conn.execute(
                "UPDATE orders SET is_rush = ?1, updated_at = ?2 WHERE id = ?3",
                params![if rush { 1 } else { 0 }, now, order_id],
            )?;
        }
        if let Some(hold) = is_on_hold {
            self.conn.execute(
                "UPDATE orders SET is_on_hold = ?1, updated_at = ?2 WHERE id = ?3",
                params![if hold { 1 } else { 0 }, now, order_id],
            )?;
        }
        if let Some(n) = notes {
            self.conn.execute(
                "UPDATE orders SET notes = ?1, updated_at = ?2 WHERE id = ?3",
                params![n, now, order_id],
            )?;
        }
        self.snapshot()
    }

    pub fn update_order_line(
        &mut self,
        line_id: &str,
        quantity: Option<i64>,
        custom_text: Option<String>,
    ) -> CoreResult<ShopSnapshot> {
        if let Some(txt) = custom_text {
            self.conn.execute(
                "UPDATE order_lines SET custom_text = ?1 WHERE id = ?2",
                params![
                    if txt.trim().is_empty() {
                        None
                    } else {
                        Some(txt)
                    },
                    line_id
                ],
            )?;
        }
        if let Some(new_qty) = quantity {
            let new_qty = new_qty.max(1);
            let row: Option<(String, String, i64)> = self
                .conn
                .query_row(
                    "SELECT order_id, product_id, quantity FROM order_lines WHERE id = ?1",
                    params![line_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            if let Some((order_id, product_id, old_qty)) = row {
                self.conn.execute(
                    "UPDATE order_lines SET quantity = ?1 WHERE id = ?2",
                    params![new_qty, line_id],
                )?;
                if new_qty < old_qty {
                    self.conn.execute(
                        "DELETE FROM part_units WHERE line_id = ?1 AND unit_index > ?2",
                        params![line_id, new_qty],
                    )?;
                } else if new_qty > old_qty {
                    let now = Utc::now().to_rfc3339();
                    let mut stmt = self.conn.prepare(
                        "SELECT id, default_filament_id FROM catalog_parts WHERE product_id = ?1 AND is_tracked = 1 AND is_color_only = 0 ORDER BY sort_order",
                    )?;
                    let parts: Vec<(String, String)> = stmt
                        .query_map(params![product_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                        .collect::<Result<Vec<_>, _>>()?;
                    for idx in (old_qty + 1)..=new_qty {
                        for (part_id, fil_id) in &parts {
                            let uid =
                                format!("unit-{}-{}-{}", Uuid::new_v4().simple(), part_id, idx);
                            self.conn.execute(
                                "INSERT INTO part_units (id, order_id, line_id, product_id, part_id, unit_index, filament_id, state, printer_id, plate_job_id, reprint_count, updated_at)
                                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'Queued', NULL, NULL, 0, ?8)",
                                params![uid, order_id, line_id, product_id, part_id, idx, fil_id, now],
                            )?;
                        }
                    }
                }
            }
        }
        self.snapshot()
    }

    pub fn add_order_line(
        &mut self,
        order_id: &str,
        product_id: &str,
        quantity: i64,
        custom_text: Option<String>,
        filament_overrides: Option<HashMap<String, String>>,
    ) -> CoreResult<ShopSnapshot> {
        let qty = quantity.max(1);
        let now = Utc::now().to_rfc3339();
        let (prod_name, price_cents): (String, i64) = self
            .conn
            .query_row(
                "SELECT name, price_cents FROM products WHERE id = ?1",
                params![product_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or_else(|_| ("Catalog Item".to_string(), 1000));
        let line_id = format!("line-{}", Uuid::new_v4().simple());
        self.conn.execute(
            "INSERT INTO order_lines (id, order_id, product_id, item_label, quantity, unit_price_cents, custom_text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![line_id, order_id, product_id, prod_name, qty, price_cents, custom_text],
        )?;
        let overrides = filament_overrides.unwrap_or_default();
        let mut stmt = self.conn.prepare(
            "SELECT id, default_filament_id FROM catalog_parts WHERE product_id = ?1 AND is_tracked = 1 AND is_color_only = 0 ORDER BY sort_order",
        )?;
        let parts: Vec<(String, String)> = stmt
            .query_map(params![product_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        for idx in 1..=qty {
            for (part_id, default_fil) in &parts {
                let fil_id = overrides
                    .get(part_id)
                    .cloned()
                    .unwrap_or_else(|| default_fil.clone());
                let uid = format!("unit-{}-{}", Uuid::new_v4().simple(), idx);
                self.conn.execute(
                    "INSERT INTO part_units (id, order_id, line_id, product_id, part_id, unit_index, filament_id, state, printer_id, plate_job_id, reprint_count, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'Queued', NULL, NULL, 0, ?8)",
                    params![uid, order_id, line_id, product_id, part_id, idx, fil_id, now],
                )?;
            }
        }
        self.snapshot()
    }

    pub fn delete_order_line(&mut self, line_id: &str) -> CoreResult<ShopSnapshot> {
        let now = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let tx = self.conn.transaction()?;
        #[allow(clippy::type_complexity)]
        let info: Option<(String, String, String, Option<String>, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT l.order_id, l.product_id, l.item_label, o.order_code, o.customer_name, p.name
                 FROM order_lines l LEFT JOIN orders o ON o.id = l.order_id LEFT JOIN products p ON p.id = l.product_id
                 WHERE l.id = ?1",
                params![line_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?;
        if let Some((order_id, product_id, item_label, order_code, customer_name, product_name)) =
            info
        {
            let (units, done): (i64, i64) = tx.query_row(
                "SELECT COUNT(*), COALESCE(SUM(CASE WHEN state <> 'Queued' THEN 1 ELSE 0 END), 0)
                 FROM part_units WHERE line_id = ?1",
                params![line_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            tx.execute(
                "INSERT INTO flow_events (
                    id, created_at, kind, order_id, order_code, customer_name, line_id, item_label,
                    product_id, product_name, filament_name, filament_hex, from_state, to_state,
                    actor_device, source_surface, action_label, failure_note, cost_impact_cents, can_undo
                ) VALUES (?1, ?2, 'LineRemoved', ?3, ?4, ?5, ?6, ?7, ?8, ?9, '', '', NULL, 'Removed',
                    'FarmPrint', 'Order editor · Remove Line', ?10, ?11, 0, 0)",
                params![
                    Uuid::new_v4().to_string(),
                    now,
                    order_id,
                    order_code,
                    customer_name,
                    line_id,
                    item_label,
                    product_id,
                    product_name,
                    format!("Removed line {item_label}"),
                    format!("units={units}; started_or_later={done}"),
                ],
            )?;
            tx.execute(
                "UPDATE orders SET updated_at = ?1 WHERE id = ?2",
                params![now, order_id],
            )?;
        }
        tx.execute(
            "DELETE FROM part_units WHERE line_id = ?1",
            params![line_id],
        )?;
        tx.execute("DELETE FROM order_lines WHERE id = ?1", params![line_id])?;
        tx.commit()?;
        self.snapshot()
    }

    // One optional value per editable column; a struct would only add ceremony for callers.
    #[allow(clippy::too_many_arguments)]
    pub fn update_filament_swatch(
        &mut self,
        filament_id: &str,
        name: Option<String>,
        brand: Option<String>,
        material: Option<String>,
        hex: Option<String>,
        cost_per_kg: Option<f64>,
        grams_remaining: Option<f64>,
        vendor: Option<String>,
    ) -> CoreResult<ShopSnapshot> {
        if let Some(v) = name {
            self.conn.execute(
                "UPDATE filaments SET name = ?1 WHERE id = ?2",
                params![v, filament_id],
            )?;
        }
        if let Some(v) = brand {
            let brand = canonical_label(&v, &self.existing_filament_brands(Some(filament_id))?);
            self.conn.execute(
                "UPDATE filaments SET brand = ?1 WHERE id = ?2",
                params![brand, filament_id],
            )?;
        }
        if let Some(v) = material {
            self.conn.execute(
                "UPDATE filaments SET material = ?1 WHERE id = ?2",
                params![v, filament_id],
            )?;
        }
        if let Some(v) = hex {
            self.conn.execute(
                "UPDATE filaments SET hex = ?1 WHERE id = ?2",
                params![v, filament_id],
            )?;
        }
        if let Some(v) = cost_per_kg {
            self.conn.execute(
                "UPDATE filaments SET cost_per_kg = ?1 WHERE id = ?2",
                params![v, filament_id],
            )?;
        }
        if let Some(v) = grams_remaining {
            self.conn.execute(
                "UPDATE filaments SET grams_remaining = ?1 WHERE id = ?2",
                params![v, filament_id],
            )?;
        }
        if let Some(v) = vendor {
            let vendor = store_vendor(Some(v), &self.existing_filament_vendors(Some(filament_id))?);
            self.conn.execute(
                "UPDATE filaments SET vendor = ?1 WHERE id = ?2",
                params![vendor, filament_id],
            )?;
        }
        self.snapshot()
    }

    pub fn add_overstock_entry(
        &mut self,
        product_id: &str,
        part_id: &str,
        filament_id: &str,
        quantity: i64,
    ) -> CoreResult<ShopSnapshot> {
        let existing: Option<(String, i64)> = self
            .conn
            .query_row(
                "SELECT id, quantity FROM overstock WHERE product_id = ?1 AND part_id = ?2 AND filament_id = ?3",
                params![product_id, part_id, filament_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((oid, q)) = existing {
            self.conn.execute(
                "UPDATE overstock SET quantity = ?1 WHERE id = ?2",
                params![(q + quantity).max(0), oid],
            )?;
        } else {
            let oid = format!("ov-{}", Uuid::new_v4().simple());
            self.conn.execute(
                "INSERT INTO overstock (id, product_id, part_id, filament_id, quantity) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![oid, product_id, part_id, filament_id, quantity.max(1)],
            )?;
        }
        self.snapshot()
    }

    pub fn pull_from_overstock(
        &mut self,
        overstock_id: &str,
        unit_id: &str,
        actor_device: &str,
    ) -> CoreResult<ShopSnapshot> {
        self.adjust_overstock(overstock_id, -1)?;
        self.transition_units(TransitionRequest {
            unit_ids: vec![unit_id.to_string()],
            to_state: "Ready".to_string(),
            printer_id: None,
            actor_device: actor_device.to_string(),
            source_surface: "Overstock Shelf".to_string(),
            action_label: "Pulled from Overstock -> Ready".to_string(),
            failure_reason: None,
            failure_note: None,
            filament_id: None,
        })
    }

    pub fn clear_flow_events(&mut self) -> CoreResult<ShopSnapshot> {
        self.conn.execute("DELETE FROM flow_events", [])?;
        self.snapshot()
    }

    pub fn rename_filament_brand(
        &mut self,
        old_brand: &str,
        new_brand: &str,
    ) -> CoreResult<ShopSnapshot> {
        // Empty new name leaves the existing brand alone (does not clear it).
        if collapse_whitespace(new_brand).is_empty() {
            return self.snapshot();
        }
        let others = existing_filament_column(&self.conn, "brand", None, Some(old_brand))?;
        let brand = canonical_label(new_brand, &others);
        self.conn.execute(
            "UPDATE filaments SET brand = ?1 WHERE brand = ?2",
            params![brand, old_brand],
        )?;
        self.snapshot()
    }

    pub fn rename_filament_material(
        &mut self,
        brand: &str,
        old_material: &str,
        new_material: &str,
    ) -> CoreResult<ShopSnapshot> {
        let trimmed = new_material.trim();
        if !trimmed.is_empty() {
            self.conn.execute(
                "UPDATE filaments SET material = ?1 WHERE brand = ?2 AND material = ?3",
                params![trimmed, brand, old_material],
            )?;
        }
        self.snapshot()
    }
}

/// Trim and collapse inner whitespace. Blank stays blank.
pub(crate) fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Case-insensitive key that also ignores spaces, used to group brand/vendor spellings.
pub(crate) fn label_match_key(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Reuse the most-used existing spelling that matches `input` (ignoring case and
/// spaces). Ties go to the alphabetically first spelling. No match: the trimmed
/// input. Blank input stays blank and is never rewritten to a real name.
pub(crate) fn canonical_label(input: &str, existing: &[String]) -> String {
    let trimmed = collapse_whitespace(input);
    if trimmed.is_empty() {
        return String::new();
    }
    let key = label_match_key(&trimmed);
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for e in existing {
        if !collapse_whitespace(e).is_empty() && label_match_key(e) == key {
            *counts.entry(e.as_str()).or_insert(0) += 1;
        }
    }
    counts
        .into_iter()
        .max_by(|(a, ca), (b, cb)| ca.cmp(cb).then_with(|| b.cmp(a)))
        .map(|(spelling, _)| spelling.to_string())
        .unwrap_or(trimmed)
}

fn store_vendor(vendor: Option<String>, existing: &[String]) -> Option<String> {
    let raw = vendor.unwrap_or_default();
    let value = canonical_label(&raw, existing);
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// `column` is only ever `"brand"` or `"vendor"`.
fn existing_filament_column(
    conn: &Connection,
    column: &str,
    exclude_id: Option<&str>,
    exclude_exact: Option<&str>,
) -> CoreResult<Vec<String>> {
    let sql = match (column, exclude_id.is_some(), exclude_exact.is_some()) {
        ("brand", false, false) => "SELECT brand FROM filaments",
        ("brand", true, false) => "SELECT brand FROM filaments WHERE id != ?1",
        ("brand", false, true) => "SELECT brand FROM filaments WHERE brand != ?1",
        ("vendor", false, false) => "SELECT vendor FROM filaments WHERE vendor IS NOT NULL",
        ("vendor", true, false) => {
            "SELECT vendor FROM filaments WHERE vendor IS NOT NULL AND id != ?1"
        }
        ("vendor", false, true) => {
            "SELECT vendor FROM filaments WHERE vendor IS NOT NULL AND vendor != ?1"
        }
        _ => {
            return Err(CoreError::Validation(
                "internal: unexpected filament label query".into(),
            ))
        }
    };
    let mut stmt = conn.prepare(sql)?;
    let bind = exclude_id.or(exclude_exact);
    let rows = if let Some(v) = bind {
        stmt.query_map(params![v], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(rows)
}

/// Ship-by input: "" = none, else must be a `YYYY-MM-DD` date.
pub fn normalize_ship_by(s: &str) -> CoreResult<Option<String>> {
    let s = s.trim();
    if s.is_empty() {
        return Ok(None);
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map(|d| Some(d.format("%Y-%m-%d").to_string()))
        .map_err(|_| {
            CoreError::Validation(format!(
                "Ship-by date must look like 2026-12-31 (got {s:?})."
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger_with_made_up_filaments() -> ShopLedger {
        let conn = Connection::open_in_memory().unwrap();
        seed::init_schema(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO filaments (id, name, brand, material, hex, cost_per_kg, grams_remaining) VALUES ('fil-a', 'Teal', 'AcmeFil', 'PLA', '#00AAAA', 20.0, 900.0);
             INSERT INTO filaments (id, name, brand, material, hex, cost_per_kg, grams_remaining) VALUES ('fil-b', ' teal ', 'acmefil', 'pla', '#00aaaa', 20.0, 500.0);
             INSERT INTO filaments (id, name, brand, material, hex, cost_per_kg, grams_remaining) VALUES ('fil-c', 'Teal', 'AcmeFil', 'PETG', '#00AAAA', 20.0, 100.0);
             INSERT INTO filaments (id, name, brand, material, hex, cost_per_kg, grams_remaining) VALUES ('fil-d', 'Teal', 'AcmeFil', 'PLA', '#00ABAB', 20.0, 100.0);
             INSERT INTO overstock VALUES ('ov-a', 'prod-x', 'part-x', 'fil-a', 3);
             INSERT INTO overstock VALUES ('ov-b', 'prod-x', 'part-x', 'fil-b', 2);
             INSERT INTO overstock VALUES ('ov-b2', 'prod-x', 'part-y', 'fil-b', 4);",
        )
        .unwrap();
        ShopLedger::normalize_shop_data(&conn).unwrap();
        ShopLedger {
            conn,
            db_path: None,
        }
    }

    fn filament_ids(l: &ShopLedger) -> Vec<String> {
        l.conn
            .prepare("SELECT id FROM filaments ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|c| c.unwrap())
            .collect()
    }

    #[test]
    fn startup_normalize_leaves_identical_filaments_untouched() {
        let l = ledger_with_made_up_filaments();
        assert_eq!(filament_ids(&l), vec!["fil-a", "fil-b", "fil-c", "fil-d"]);
        let n: i64 = l
            .conn
            .query_row("SELECT COUNT(*) FROM overstock", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 3);
    }

    #[test]
    fn explicit_merge_duplicate_filaments_repoints_and_sums_overstock() {
        let mut l = ledger_with_made_up_filaments();
        let groups = l.find_duplicate_filaments().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].canonical_id, "fil-a");
        assert_eq!(groups[0].duplicate_ids, vec!["fil-b".to_string()]);

        l.merge_duplicate_filaments().unwrap();
        // Different material (fil-c) and different hex (fil-d) stay separate.
        assert_eq!(filament_ids(&l), vec!["fil-a", "fil-c", "fil-d"]);
        let qty = |id: &str| -> (String, i64) {
            l.conn
                .query_row(
                    "SELECT filament_id, quantity FROM overstock WHERE id = ?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap()
        };
        assert_eq!(qty("ov-a"), ("fil-a".to_string(), 5));
        assert_eq!(qty("ov-b2"), ("fil-a".to_string(), 4));
        let gone: i64 = l
            .conn
            .query_row(
                "SELECT COUNT(*) FROM overstock WHERE id = 'ov-b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(gone, 0);
        assert!(l.find_duplicate_filaments().unwrap().is_empty());
    }

    fn new_manual_order(ledger: &mut ShopLedger, qty: i64) -> Order {
        let before: Vec<String> = ledger
            .snapshot()
            .unwrap()
            .orders
            .iter()
            .map(|o| o.id.clone())
            .collect();
        let pid = ledger.snapshot().unwrap().products[0].id.clone();
        let snap = ledger
            .create_order(CreateOrderInput {
                customer_name: "Test Customer".into(),
                customer_email: String::new(),
                product_id: pid,
                quantity: qty,
                is_rush: false,
                custom_text: None,
            })
            .expect("create");
        snap.orders
            .into_iter()
            .find(|o| !before.contains(&o.id))
            .expect("new order")
    }

    #[test]
    fn create_order_shipping_unset_without_settings() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let o = new_manual_order(&mut ledger, 1);
        assert_eq!(o.shipping_charged_cents, 0);
        assert_eq!(o.shipping_cost_cents, 0);
    }

    #[test]
    fn order_ship_fields_roundtrip_and_reopen_clears() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let o = new_manual_order(&mut ledger, 1);
        assert_eq!(o.ship, OrderShipFields::default());
        let f = OrderShipFields {
            ship_status: Some(ShipStatus::Packed),
            packed_at: Some("2026-01-02T00:00:00Z".into()),
            shipped_at: None,
            tracking_number: Some("TRK".into()),
            box_preset_id: Some("box-x".into()),
        };
        let snap = ledger.set_order_ship_fields(&o.id, f.clone()).unwrap();
        let got = snap.orders.iter().find(|x| x.id == o.id).unwrap();
        assert_eq!(got.ship, f);
        // A unit leaving Closed reopens the order and clears ship fields.
        let unit = got
            .lines
            .iter()
            .flat_map(|l| l.units.iter())
            .next()
            .map(|u| u.id.clone());
        if let Some(uid) = unit {
            let tr = |to: &str| TransitionRequest {
                unit_ids: vec![uid.clone()],
                to_state: to.into(),
                printer_id: None,
                actor_device: "t".into(),
                source_surface: "t".into(),
                action_label: "t".into(),
                failure_reason: None,
                failure_note: None,
                filament_id: None,
            };
            ledger.transition_units(tr("Closed")).unwrap();
            let s = ledger.snapshot().unwrap();
            assert_eq!(s.orders.iter().find(|x| x.id == o.id).unwrap().ship, f);
            let s = ledger.transition_units(tr("Ready")).unwrap();
            assert_eq!(
                s.orders.iter().find(|x| x.id == o.id).unwrap().ship,
                OrderShipFields::default()
            );
        }
        ledger.set_order_ship_fields(&o.id, f).unwrap();
        let s = ledger.reopen_order_shipping(&o.id).unwrap();
        assert_eq!(
            s.orders.iter().find(|x| x.id == o.id).unwrap().ship,
            OrderShipFields::default()
        );
        assert!(ledger
            .set_order_ship_fields("missing", OrderShipFields::default())
            .is_err());
    }

    #[test]
    fn ship_columns_migrate_on_old_db() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE orders (id TEXT PRIMARY KEY, order_code TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);").ok();
        // Older table missing ship columns (and others): migration adds the ship ones.
        let _ = seed::init_schema(&conn);
        seed::init_schema(&conn).ok();
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(orders)")
            .unwrap()
            .query_map([], |r| r.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for (c, _) in seed::ORDER_SHIP_COLUMNS {
            assert!(cols.iter().any(|x| x == c), "{c}");
        }
    }

    #[test]
    fn website_ingest_columns_migrate_on_old_db_and_bad_camera_reads_as_none() {
        let conn = Connection::open_in_memory().unwrap();
        // Pre-ingest shape: no orders.remote_id, no order_lines.view_camera_json, no map table.
        conn.execute_batch(
            "CREATE TABLE orders (id TEXT PRIMARY KEY, order_code TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, source TEXT NOT NULL, is_rush INTEGER NOT NULL DEFAULT 0, is_on_hold INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', shipping_charged_cents INTEGER NOT NULL DEFAULT 0, shipping_cost_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE order_lines (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, product_id TEXT NOT NULL, item_label TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL, custom_text TEXT);
             INSERT INTO orders VALUES ('ord-old', 'FP-OLD', 'Old Customer', '', 'manual', 0, 0, '', 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
             INSERT INTO order_lines VALUES ('line-old', 'ord-old', 'prod-x', 'Old #1', 1, 100, NULL);",
        ).unwrap();
        seed::init_schema(&conn).unwrap();
        seed::init_schema(&conn).unwrap(); // idempotent
        let cols = |t: &str| -> Vec<String> {
            conn.prepare(&format!("PRAGMA table_info({t})"))
                .unwrap()
                .query_map([], |r| r.get(1))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert!(cols("orders").iter().any(|c| c == "remote_id"));
        assert!(cols("order_lines").iter().any(|c| c == "view_camera_json"));
        conn.execute("INSERT INTO order_lines (id, order_id, product_id, item_label, quantity, unit_price_cents, view_camera_json) VALUES ('line-bad', 'ord-old', 'prod-x', 'Bad #2', 1, 100, '{not json')", []).unwrap();
        let ledger = ShopLedger {
            conn,
            db_path: None,
        };
        let snap = ledger.snapshot().unwrap();
        let o = snap.orders.iter().find(|o| o.id == "ord-old").unwrap();
        assert!(o.remote_id.is_none());
        assert_eq!(o.lines.len(), 2);
        assert!(o.lines.iter().all(|l| l.view_camera.is_none()));
        assert!(ledger.imported_store_order_ids().unwrap().is_empty());
    }

    #[test]
    fn device_id_is_created_once_and_stable() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let a = ledger.device_id().unwrap();
        assert!(
            a.starts_with("fprust-") && a.len() == "fprust-".len() + 36,
            "{a}"
        );
        assert_eq!(ledger.device_id().unwrap(), a);
        // Saving shop settings does not touch it.
        let s = ledger.get_settings().unwrap();
        ledger.save_settings(s).unwrap();
        assert_eq!(ledger.device_id().unwrap(), a);
    }

    #[test]
    fn import_website_order_dedupes_by_remote_id() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let pid = ledger.snapshot().unwrap().products[0].id.clone();
        let input = WebsiteOrderImport {
            remote_id: "cs_core_1".into(),
            source: "website".into(),
            order_code: Some("BD-CORE01".into()),
            customer_name: "Test".into(),
            customer_email: String::new(),
            notes: String::new(),
            is_rush: false,
            is_on_hold: false,
            shipping_charged_cents: 0,
            created_at: String::new(),
            lines: vec![WebsiteLineImport {
                product_id: pid,
                title: "T".into(),
                quantity: 1,
                unit_price_cents: 100,
                custom_text: None,
                view_camera: Some(ViewCamera {
                    position: [1.0, 2.0, 3.0],
                    target: [0.0, 0.0, 0.0],
                    fov: 32.0,
                }),
                part_filaments: Default::default(),
                only_part_ids: None,
            }],
        };
        assert!(matches!(
            ledger.import_website_order(&input).unwrap(),
            WebsiteImportOutcome::Imported { .. }
        ));
        assert_eq!(
            ledger.import_website_order(&input).unwrap(),
            WebsiteImportOutcome::Duplicate
        );
        let snap = ledger.snapshot().unwrap();
        let mine: Vec<_> = snap
            .orders
            .iter()
            .filter(|o| o.remote_id.as_deref() == Some("cs_core_1"))
            .collect();
        assert_eq!(mine.len(), 1);
        assert_eq!(
            mine[0].lines[0].view_camera.unwrap().position,
            [1.0, 2.0, 3.0]
        );
        // Unknown product only: nothing written.
        let mut ghost = input.clone();
        ghost.remote_id = "cs_core_2".into();
        ghost.lines[0].product_id = "no-such-product".into();
        assert!(matches!(
            ledger.import_website_order(&ghost).unwrap(),
            WebsiteImportOutcome::Skipped { .. }
        ));
        assert!(!ledger
            .imported_store_order_ids()
            .unwrap()
            .contains("cs_core_2"));
    }

    #[test]
    fn free_shipping_threshold_flag() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let mut s = ledger.get_settings().unwrap();
        s.shipping_enabled = true;
        s.flat_shipping_cents = 321;
        s.free_shipping_threshold_cents = 1;
        s.free_shipping_threshold_enabled = Some(false);
        ledger.save_settings(s.clone()).unwrap();
        assert_eq!(new_manual_order(&mut ledger, 1).shipping_charged_cents, 321);
        s.free_shipping_threshold_enabled = Some(true);
        ledger.save_settings(s.clone()).unwrap();
        assert_eq!(new_manual_order(&mut ledger, 1).shipping_charged_cents, 0);
        s.product_page_3d = true;
        ledger.save_settings(s).unwrap();
        assert!(ledger.get_settings().unwrap().product_page_3d);
    }

    #[test]
    fn zero_flat_rate_only_when_entered() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let mut s = ledger.get_settings().unwrap();
        s.shipping_enabled = true;
        s.free_shipping_threshold_enabled = Some(false);
        s.flat_shipping_cents = 0;
        ledger.save_settings(s.clone()).unwrap();
        // Not entered: same default the shop charges.
        assert_eq!(new_manual_order(&mut ledger, 1).shipping_charged_cents, 795);
        s.flat_shipping_cents_set = Some(true);
        ledger.save_settings(s.clone()).unwrap();
        assert_eq!(new_manual_order(&mut ledger, 1).shipping_charged_cents, 0);
        assert_eq!(
            ledger.get_settings().unwrap().flat_shipping_cents_set,
            Some(true)
        );
    }

    #[test]
    fn create_order_shipping_uses_shop_settings() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let mut s = ledger.get_settings().unwrap();
        s.shipping_enabled = true;
        s.flat_shipping_cents = 321;
        s.free_shipping_threshold_cents = 0;
        ledger.save_settings(s.clone()).unwrap();
        let o = new_manual_order(&mut ledger, 1);
        assert_eq!(o.shipping_charged_cents, 321);
        assert_eq!(o.shipping_cost_cents, 0);

        s.free_shipping_threshold_cents = 1;
        ledger.save_settings(s.clone()).unwrap();
        assert_eq!(new_manual_order(&mut ledger, 1).shipping_charged_cents, 0);

        s.shipping_enabled = false;
        s.free_shipping_threshold_cents = 0;
        ledger.save_settings(s).unwrap();
        assert_eq!(new_manual_order(&mut ledger, 1).shipping_charged_cents, 0);
    }

    #[test]
    fn test_ledger_seed_and_transition_with_undo() {
        let mut ledger = ShopLedger::open_in_memory().expect("open in memory");
        let snap = ledger.snapshot().expect("snapshot");
        assert_eq!(snap.orders.len(), 4);
        assert_eq!(snap.printers.len(), 4);
        assert!(snap.flow_events.len() >= 5);

        let updated = ledger
            .transition_units(TransitionRequest {
                unit_ids: vec!["unit-demo-1-base".to_string()],
                to_state: "Staged".to_string(),
                printer_id: Some("prn-demo-1".to_string()),
                actor_device: "Mac Studio".to_string(),
                source_surface: "Shop Floor · Parts Queue".to_string(),
                action_label: "Stage to Next Plate".to_string(),
                failure_reason: None,
                failure_note: None,
                filament_id: None,
            })
            .expect("transition");

        let latest_ev = &updated.flow_events[0];
        assert_eq!(latest_ev.to_state, "Staged");
        assert_eq!(latest_ev.item_label.as_deref(), Some("Widget #1"));

        let undone = ledger
            .undo_flow_event(&latest_ev.id, "Mac Studio")
            .expect("undo");
        assert_eq!(undone.flow_events[0].to_state, "Queued");
    }

    /// "Mark Printing" with no printer chosen: the parts still become one Printing job
    /// (one plate job id, Flow events, one undo batch), just with no printer yet. Picking a
    /// printer later moves the job onto it.
    #[test]
    fn printing_without_a_printer_is_one_unassigned_job() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let ids = ["unit-demo-1-base", "unit-demo-3-lid"];
        ledger
            .transition_units(tr(&ids, "Printing", None, None))
            .unwrap();
        let a = unit(&ledger, ids[0]).unwrap();
        let b = unit(&ledger, ids[1]).unwrap();
        assert_eq!(a.state, "Printing");
        assert_eq!(b.state, "Printing");
        assert_eq!(a.printer_id, None);
        assert_eq!(b.printer_id, None);
        let job = a.plate_job_id.clone().expect("a plate job id");
        assert_eq!(b.plate_job_id.as_deref(), Some(job.as_str()));
        let snap = ledger.snapshot().unwrap();
        let evs: Vec<&FlowEvent> = snap
            .flow_events
            .iter()
            .filter(|e| e.to_state == "Printing" && e.action_label == "To Printing")
            .collect();
        assert_eq!(evs.len(), 2);
        assert!(evs.iter().all(|e| e.printer_id.is_none()));
        assert!(evs.iter().all(|e| e.batch_id == evs[0].batch_id));

        // Assigning a printer later puts the job on that printer.
        ledger
            .transition_units(tr(&ids, "Printing", Some("prn-demo-2"), None))
            .unwrap();
        assert_eq!(
            unit(&ledger, ids[0]).unwrap().printer_id.as_deref(),
            Some("prn-demo-2")
        );

        // Undoing that move puts the job back under no printer, with its old job id.
        let latest = ledger.snapshot().unwrap().flow_events[0].id.clone();
        ledger.undo_flow_event(&latest, "Test").unwrap();
        for id in ids {
            let u = unit(&ledger, id).unwrap();
            assert_eq!(u.state, "Printing");
            assert_eq!(u.printer_id, None);
            assert_eq!(u.plate_job_id.as_deref(), Some(job.as_str()));
        }
    }

    fn unit(l: &ShopLedger, id: &str) -> Option<PartUnit> {
        l.snapshot()
            .unwrap()
            .orders
            .into_iter()
            .flat_map(|o| o.lines.into_iter().flat_map(|ln| ln.units))
            .find(|u| u.id == id)
    }

    fn tr(
        ids: &[&str],
        to: &str,
        printer: Option<&str>,
        failure: Option<&str>,
    ) -> TransitionRequest {
        TransitionRequest {
            unit_ids: ids.iter().map(|s| s.to_string()).collect(),
            to_state: to.to_string(),
            printer_id: printer.map(|s| s.to_string()),
            actor_device: "Test".to_string(),
            source_surface: "Test".to_string(),
            action_label: format!("To {to}"),
            failure_reason: failure.map(|s| s.to_string()),
            failure_note: None,
            filament_id: None,
        }
    }

    #[test]
    fn part_role_change_keeps_in_progress_units_and_logs_removed_queued_ones() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        ledger
            .transition_units(tr(
                &["unit-demo-1-base"],
                "Printing",
                Some("prn-demo-1"),
                None,
            ))
            .unwrap();
        ledger
            .transition_units(tr(&["unit-demo-3-base"], "Printed", None, None))
            .unwrap();
        assert_eq!(unit(&ledger, "unit-demo-2-base").unwrap().state, "Queued");

        let mut widget = ledger
            .snapshot()
            .unwrap()
            .products
            .into_iter()
            .find(|p| p.id == "prod-demo-widget")
            .unwrap();
        for pt in widget.parts.iter_mut().filter(|p| p.id == "part-demo-base") {
            pt.is_color_only = true;
        }
        let snap = ledger.upsert_product(widget).unwrap();

        // Work in progress survives the role change (kept in the ledger, hidden from the
        // snapshot while the part is not printed); never-started units are removed.
        let db_state = |l: &ShopLedger, id: &str| -> Option<String> {
            l.conn
                .query_row(
                    "SELECT state FROM part_units WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()
                .unwrap()
        };
        assert_eq!(
            db_state(&ledger, "unit-demo-1-base").as_deref(),
            Some("Printing")
        );
        assert_eq!(
            db_state(&ledger, "unit-demo-3-base").as_deref(),
            Some("Printed")
        );
        assert!(db_state(&ledger, "unit-demo-2-base").is_none());
        assert!(db_state(&ledger, "unit-demo-4-base").is_none());
        let logged: Vec<_> = snap
            .flow_events
            .iter()
            .filter(|e| e.kind == "PartRoleChanged")
            .collect();
        assert_eq!(logged.len(), 2, "one event per affected order");
        assert!(logged
            .iter()
            .all(|e| !e.can_undo && e.part_id.as_deref() == Some("part-demo-base")));

        // The launch pass must not delete in-progress work either.
        ShopLedger::normalize_shop_data(&ledger.conn).unwrap();
        assert_eq!(
            db_state(&ledger, "unit-demo-1-base").as_deref(),
            Some("Printing")
        );
        assert_eq!(
            db_state(&ledger, "unit-demo-3-base").as_deref(),
            Some("Printed")
        );

        // Switching the role back shows the kept units again.
        let mut widget = ledger
            .snapshot()
            .unwrap()
            .products
            .into_iter()
            .find(|p| p.id == "prod-demo-widget")
            .unwrap();
        for pt in widget.parts.iter_mut().filter(|p| p.id == "part-demo-base") {
            pt.is_color_only = false;
        }
        ledger.upsert_product(widget).unwrap();
        assert_eq!(unit(&ledger, "unit-demo-1-base").unwrap().state, "Printing");
    }

    #[test]
    fn undo_reverts_whole_batch_once_and_never_redoes() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let ids = ["unit-demo-1-base", "unit-demo-1-lid", "unit-demo-2-base"];
        ledger
            .transition_units(tr(&["unit-demo-4-base"], "Printed", None, None))
            .unwrap();
        let snap = ledger
            .transition_units(tr(&ids, "Printed", None, None))
            .unwrap();
        let newest = snap
            .flow_events
            .iter()
            .find(|e| e.can_undo)
            .unwrap()
            .clone();
        let batch = newest.batch_id.clone().expect("batch id");
        assert_eq!(
            snap.flow_events
                .iter()
                .filter(|e| e.batch_id.as_deref() == Some(&batch))
                .count(),
            3
        );

        let after = ledger.undo_flow_event(&newest.id, "Test").unwrap();
        for id in ids {
            assert_eq!(unit(&ledger, id).unwrap().state, "Queued", "{id} reverted");
        }
        assert_eq!(
            unit(&ledger, "unit-demo-4-base").unwrap().state,
            "Printed",
            "older action untouched"
        );
        // Undo events are not themselves undoable; the next undoable event is the older action.
        assert!(after
            .flow_events
            .iter()
            .filter(|e| e.kind == "Undo")
            .all(|e| !e.can_undo));
        let next = after.flow_events.iter().find(|e| e.can_undo).unwrap();
        assert_eq!(next.unit_id.as_deref(), Some("unit-demo-4-base"));
        // Pressing Undo again on the same action does not flip it forward.
        assert!(ledger.undo_flow_event(&newest.id, "Test").is_err());
        for id in ids {
            assert_eq!(unit(&ledger, id).unwrap().state, "Queued");
        }
    }

    #[test]
    fn undo_failed_print_restores_printer_reprints_and_cost() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        ledger
            .transition_units(tr(
                &["unit-demo-1-base"],
                "Printing",
                Some("prn-demo-2"),
                None,
            ))
            .unwrap();
        let snap = ledger
            .transition_units(tr(&["unit-demo-1-base"], "Failed", None, Some("Spaghetti")))
            .unwrap();
        assert!(snap.analytics.total_reprint_loss_cents > 0);
        let u = unit(&ledger, "unit-demo-1-base").unwrap();
        assert_eq!((u.state.as_str(), u.reprint_count), ("Queued", 1));

        let failed = snap
            .flow_events
            .iter()
            .find(|e| e.kind == "FailedPrint")
            .unwrap()
            .clone();
        let after = ledger.undo_flow_event(&failed.id, "Test").unwrap();
        let u = unit(&ledger, "unit-demo-1-base").unwrap();
        assert_eq!(u.state, "Printing");
        assert_eq!(u.printer_id.as_deref(), Some("prn-demo-2"));
        assert_eq!(u.reprint_count, 0);
        assert_eq!(after.analytics.total_reprint_loss_cents, 0);
    }

    #[test]
    fn failure_note_and_job_round_trip_to_flow_events() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        ledger
            .transition_units(tr(
                &["unit-demo-1-base"],
                "Printing",
                Some("prn-demo-2"),
                None,
            ))
            .unwrap();
        let job = unit(&ledger, "unit-demo-1-base")
            .unwrap()
            .plate_job_id
            .expect("Printing assigns a plate job");
        let mut req = tr(&["unit-demo-1-base"], "Failed", None, Some("Other"));
        req.failure_note = Some("Extruder Jam".to_string());
        let snap = ledger.transition_units(req).unwrap();
        let failed = snap
            .flow_events
            .iter()
            .find(|e| e.kind == "FailedPrint")
            .unwrap();
        assert_eq!(failed.failure_reason.as_deref(), Some("Other"));
        assert_eq!(failed.failure_note.as_deref(), Some("Extruder Jam"));
        assert_eq!(failed.prev_plate_job_id.as_deref(), Some(job.as_str()));
    }

    #[test]
    fn undo_skips_units_that_moved_on_and_order_deleted_is_not_undoable() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let snap = ledger
            .transition_units(tr(&["unit-demo-1-base"], "Printed", None, None))
            .unwrap();
        let ev = snap
            .flow_events
            .iter()
            .find(|e| e.can_undo)
            .unwrap()
            .clone();
        ledger
            .transition_units(tr(&["unit-demo-1-base"], "Ready", None, None))
            .unwrap();
        assert!(ledger.undo_flow_event(&ev.id, "Test").is_err());
        assert_eq!(unit(&ledger, "unit-demo-1-base").unwrap().state, "Ready");

        let snap = ledger.delete_order("ord-demo-2").unwrap();
        let del = snap
            .flow_events
            .iter()
            .find(|e| e.kind == "OrderDeleted")
            .unwrap();
        assert!(!del.can_undo);
        assert!(ledger.undo_flow_event(&del.id, "Test").is_err());
    }

    #[test]
    fn legacy_undo_events_and_old_rows_without_batch_still_work() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        // An old-style event: no batch id and no prev_* columns.
        ledger
            .transition_units(tr(&["unit-demo-1-base"], "Printed", None, None))
            .unwrap();
        ledger
            .conn
            .execute(
                "UPDATE flow_events SET batch_id = NULL, prev_printer_id = NULL, prev_filament_id = NULL, prev_reprint_count = NULL, prev_plate_job_id = NULL WHERE unit_id = 'unit-demo-1-base'",
                [],
            )
            .unwrap();
        let ev = ledger
            .snapshot()
            .unwrap()
            .flow_events
            .into_iter()
            .find(|e| e.can_undo)
            .unwrap();
        ledger.undo_flow_event(&ev.id, "Test").unwrap();
        assert_eq!(unit(&ledger, "unit-demo-1-base").unwrap().state, "Queued");

        // Undo rows written by the old one-click undo are never offered.
        ledger
            .transition_units(tr(&["unit-demo-2-base"], "Printed", None, None))
            .unwrap();
        ledger
            .conn
            .execute(
                "UPDATE flow_events SET source_surface = ?1 WHERE unit_id = 'unit-demo-2-base'",
                params![LEGACY_UNDO_SURFACE],
            )
            .unwrap();
        let snap = ledger.snapshot().unwrap();
        assert!(snap
            .flow_events
            .iter()
            .filter(|e| e.unit_id.as_deref() == Some("unit-demo-2-base"))
            .all(|e| !e.can_undo));
    }

    #[test]
    fn delete_filament_refuses_while_used_and_printer_remove_logs() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let err = ledger
            .delete_filament_swatch("fil-demo-red")
            .unwrap_err()
            .to_string();
        assert!(err.contains("still used"), "{err}");
        assert!(ledger
            .snapshot()
            .unwrap()
            .filaments
            .iter()
            .any(|f| f.id == "fil-demo-red"));
        let usage = ledger.filament_usage("fil-demo-red").unwrap();
        assert!(usage.open_units > 0 && usage.part_defaults > 0);

        ledger
            .transition_units(tr(
                &["unit-demo-1-base"],
                "Printing",
                Some("prn-demo-3"),
                None,
            ))
            .unwrap();
        let snap = ledger.delete_printer("prn-demo-3").unwrap();
        let u = unit(&ledger, "unit-demo-1-base").unwrap();
        assert_eq!(
            (u.state.as_str(), u.printer_id.as_deref()),
            ("Queued", None)
        );
        let ev = &snap.flow_events[0];
        assert_eq!(ev.source_surface, "Printers · Remove printer");
        assert_eq!(ev.from_state.as_deref(), Some("Printing"));
        assert_eq!(ev.printer_name.as_deref(), Some("Printer 3"));
    }

    #[test]
    fn delete_order_line_is_logged() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let snap = ledger.delete_order_line("line-demo-1").unwrap();
        assert!(unit(&ledger, "unit-demo-1-base").is_none());
        let ev = &snap.flow_events[0];
        assert_eq!(ev.kind, "LineRemoved");
        assert_eq!(ev.line_id.as_deref(), Some("line-demo-1"));
        assert!(!ev.can_undo);
    }

    /// Adds `n` made-up orders (2 lines × qty 2 of a 4-part product) straight through SQL.
    fn bulk_orders(l: &ShopLedger, start: usize, n: usize) {
        let tx = l.conn.unchecked_transaction().unwrap();
        for i in start..start + n {
            let oid = format!("ord-bulk-{i}");
            tx.execute(
                "INSERT INTO orders (id, order_code, customer_name, customer_email, source, is_rush, is_on_hold, notes, shipping_charged_cents, shipping_cost_cents, created_at, updated_at)
                 VALUES (?1, ?2, 'Bulk Customer', '', 'manual', 0, 0, '', 0, 0, ?3, ?3)",
                params![oid, format!("FP-BULK-{i:05}"), format!("2026-02-01T00:00:{:02}Z", i % 60)],
            )
            .unwrap();
            for ln in 0..2 {
                let lid = format!("line-bulk-{i}-{ln}");
                tx.execute(
                    "INSERT INTO order_lines (id, order_id, product_id, item_label, quantity, unit_price_cents) VALUES (?1, ?2, 'prod-demo-widget', 'Widget', 2, 1000)",
                    params![lid, oid],
                )
                .unwrap();
                for q in 1..=2 {
                    for part in ["base", "lid"] {
                        let state =
                            ["Queued", "Printing", "Printed", "Ready", "Shipped"][(i + q) % 5];
                        tx.execute(
                            "INSERT INTO part_units VALUES (?1, ?2, ?3, 'prod-demo-widget', ?4, ?5, 'fil-demo-red', ?6, NULL, NULL, 0, '2026-02-01T00:00:00Z')",
                            params![format!("unit-bulk-{i}-{ln}-{q}-{part}"), oid, lid, format!("part-demo-{part}"), q as i64, state],
                        )
                        .unwrap();
                    }
                }
            }
        }
        tx.commit().unwrap();
    }

    fn best_snapshot_time(l: &ShopLedger) -> std::time::Duration {
        (0..3)
            .map(|_| {
                let t = std::time::Instant::now();
                let snap = l.snapshot().unwrap();
                assert!(!snap.orders.is_empty());
                t.elapsed()
            })
            .min()
            .unwrap()
    }

    #[test]
    fn snapshot_of_500_orders_scales_linearly() {
        let ledger = ShopLedger::open_in_memory().unwrap();
        bulk_orders(&ledger, 0, 125);
        let small = best_snapshot_time(&ledger);
        bulk_orders(&ledger, 125, 375);
        let snap = ledger.snapshot().unwrap();
        assert_eq!(snap.orders.len(), 504);
        assert_eq!(
            snap.orders.iter().map(|o| o.lines.len()).sum::<usize>(),
            1004
        );
        let big = best_snapshot_time(&ledger);
        // 4x the orders: linear is ~4x, the old nested scan was ~16x. Allow noise.
        let ratio = big.as_secs_f64() / small.as_secs_f64().max(1e-6);
        eprintln!("snapshot 125 orders {small:?}, 500 orders {big:?}, ratio {ratio:.1}");
        assert!(
            ratio < 9.0,
            "snapshot grew {ratio:.1}x for 4x orders ({small:?} -> {big:?})"
        );
        assert!(
            big < std::time::Duration::from_secs(2),
            "500-order snapshot took {big:?}"
        );
    }

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("fpcore-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn backups(dir: &std::path::Path, head: &str) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir.join("backups"))
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();
        v.retain(|n| {
            n.starts_with(head) && n[head.len()..].starts_with(|c: char| c.is_ascii_digit())
        });
        v.sort();
        v
    }

    #[test]
    fn delete_order_writes_order_deleted_event() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let snap = ledger.snapshot().unwrap();
        let order = snap.orders.first().expect("seeded order").clone();
        let units: usize = order.lines.iter().map(|l| l.units.len()).sum();
        ledger.delete_order(&order.id).unwrap();
        let (kind, cust, label, note): (String, String, String, String) = ledger
            .conn
            .query_row(
                "SELECT kind, customer_name, action_label, failure_note FROM flow_events WHERE order_id = ?1 AND kind = 'OrderDeleted'",
                params![order.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(kind, "OrderDeleted");
        assert_eq!(cust, order.customer_name);
        assert_eq!(label, "Deleted Order");
        assert!(note.contains(&format!("units={units}")), "{note}");
        let left: i64 = ledger
            .conn
            .query_row(
                "SELECT COUNT(*) FROM orders WHERE id = ?1",
                params![order.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn launch_backup_keeps_last_five() {
        let d = tmp_dir("launch");
        let db = d.join("farmprint_shop_v2.sqlite");
        drop(ShopLedger::open(&db).unwrap()); // fresh file: no backup
        assert!(backups(&d, "farmprint_shop_v2-").is_empty());
        for _ in 0..7 {
            drop(ShopLedger::open(&db).unwrap());
        }
        assert_eq!(backups(&d, "farmprint_shop_v2-").len(), LAUNCH_BACKUPS_KEPT);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn filament_change_is_logged_with_the_device() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let snap = ledger.snapshot().unwrap();
        let unit = snap.orders[0].lines[0].units[0].clone();
        let other = snap
            .filaments
            .iter()
            .find(|f| f.id != unit.filament_id)
            .expect("second filament")
            .clone();
        ledger
            .update_part_filament(&unit.id, &other.id, "Shop iPad")
            .unwrap();
        let (kind, actor, fil): (String, String, String) = ledger
            .conn
            .query_row(
                "SELECT kind, actor_device, filament_name FROM flow_events WHERE unit_id = ?1 ORDER BY seq DESC LIMIT 1",
                params![unit.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (kind.as_str(), actor.as_str(), fil.as_str()),
            ("FilamentChanged", "Shop iPad", other.name.as_str())
        );
        assert!(ledger
            .update_part_filament(&unit.id, "fil-nope", "Shop iPad")
            .is_err());
    }

    #[test]
    fn printer_bed_mm_reads_the_saved_bed() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let pid = ledger.snapshot().unwrap().printers[0].id.clone();
        assert_eq!(ledger.printer_bed_mm(&pid).unwrap(), (None, None));
        ledger
            .set_printer_bed_size(&pid, Some(256.0), Some(240.0), None)
            .unwrap();
        assert_eq!(
            ledger.printer_bed_mm(&pid).unwrap(),
            (Some(256.0), Some(240.0))
        );
        assert_eq!(ledger.printer_bed_mm("prn-nope").unwrap(), (None, None));
    }

    #[test]
    fn printer_loaded_slots_reads_slot_numbers_and_swatches() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let snap = ledger.snapshot().unwrap();
        let pid = snap.printers[0].id.clone();
        let fils: Vec<_> = snap.filaments.iter().take(2).cloned().collect();
        assert_eq!(fils.len(), 2);
        // Slot 2 left empty: slots keep their own numbers.
        ledger
            .set_printer_filament_slots(
                &pid,
                vec![fils[0].id.clone(), String::new(), fils[1].id.clone()],
            )
            .unwrap();
        let slots = ledger.printer_loaded_slots(&pid).unwrap();
        let got: Vec<(i64, &str, &str)> = slots
            .iter()
            .map(|s| {
                (
                    s.slot_index,
                    s.filament_id.as_str(),
                    s.filament_hex.as_str(),
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                (1, fils[0].id.as_str(), fils[0].hex.as_str()),
                (3, fils[1].id.as_str(), fils[1].hex.as_str())
            ]
        );
        assert_eq!(slots[0].material, fils[0].material);
        assert_eq!(slots[0].brand, fils[0].brand);
        assert!(ledger.printer_loaded_slots("prn-nope").unwrap().is_empty());
    }

    #[test]
    fn printer_can_hold_the_same_filament_in_several_slots() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let snap = ledger.snapshot().unwrap();
        let pid = snap.printers[0].id.clone();
        let black = snap.filaments[0].id.clone();
        let other = snap.filaments[1].id.clone();
        // Two spools of the same color: slots 1 and 3, with another color in slot 2.
        let snap = ledger
            .set_printer_filament_slots(&pid, vec![black.clone(), other.clone(), black.clone()])
            .unwrap();
        let slots = ledger.printer_loaded_slots(&pid).unwrap();
        let got: Vec<(i64, &str)> = slots
            .iter()
            .map(|s| (s.slot_index, s.filament_id.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                (1, black.as_str()),
                (2, other.as_str()),
                (3, black.as_str())
            ]
        );
        // The snapshot shows every slot on its own, never merged by color.
        let printer = snap.printers.iter().find(|p| p.id == pid).unwrap();
        let snap_slots: Vec<(i64, &str)> = printer
            .loaded_slots
            .iter()
            .map(|s| (s.slot_index, s.filament_id.as_str()))
            .collect();
        assert_eq!(snap_slots, got);
        // Unloading one of the two keeps the other black slot on its own number.
        ledger
            .set_printer_filament_slots(&pid, vec![String::new(), other.clone(), black.clone()])
            .unwrap();
        let after: Vec<(i64, String)> = ledger
            .printer_loaded_slots(&pid)
            .unwrap()
            .into_iter()
            .map(|s| (s.slot_index, s.filament_id))
            .collect();
        assert_eq!(after, vec![(2, other), (3, black)]);
    }

    #[test]
    fn printer_bed_size_is_optional_and_validated() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let snap = ledger.snapshot().unwrap();
        let pid = snap.printers[0].id.clone();
        assert_eq!(
            (snap.printers[0].bed_x_mm, snap.printers[0].bed_y_mm),
            (None, None)
        );
        let snap = ledger
            .set_printer_bed_size(&pid, Some(256.0), Some(256.0), None)
            .unwrap();
        let p = snap.printers.iter().find(|p| p.id == pid).unwrap();
        assert_eq!((p.bed_x_mm, p.bed_y_mm), (Some(256.0), Some(256.0)));
        assert!(ledger
            .set_printer_bed_size(&pid, Some(256.0), None, None)
            .is_err());
        assert!(ledger
            .set_printer_bed_size(&pid, Some(5.0), Some(256.0), None)
            .is_err());
        assert!(ledger
            .set_printer_bed_size("prn-nope", Some(256.0), Some(256.0), None)
            .is_err());
        let snap = ledger.set_printer_bed_size(&pid, None, None, None).unwrap();
        assert_eq!(
            snap.printers.iter().find(|p| p.id == pid).unwrap().bed_x_mm,
            None
        );
        // Older printers tables (no bed columns) gain them on open.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE printers (id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL, nozzle_mm REAL NOT NULL, status TEXT NOT NULL, utilization_pct REAL NOT NULL DEFAULT 0.0); INSERT INTO printers VALUES ('p1','A','M',0.4,'Idle',0);").unwrap();
        seed::init_schema(&conn).unwrap();
        let x: Option<f64> = conn
            .query_row("SELECT bed_x_mm FROM printers WHERE id = 'p1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(x, None);
        let z: Option<f64> = conn
            .query_row("SELECT bed_z_mm FROM printers WHERE id = 'p1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(z, None);
    }

    #[test]
    fn printer_build_height_is_optional_and_upgrades() {
        // An older database that already has width and depth, but no height column.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE printers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                model TEXT NOT NULL,
                nozzle_mm REAL NOT NULL,
                status TEXT NOT NULL,
                utilization_pct REAL NOT NULL DEFAULT 0.0,
                bed_x_mm REAL,
                bed_y_mm REAL
            );
             INSERT INTO printers VALUES ('p1', 'A', 'M', 0.4, 'Idle', 0, 256.0, 240.0);",
        )
        .unwrap();
        seed::init_schema(&conn).unwrap();
        seed::init_schema(&conn).unwrap(); // idempotent
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(printers)")
            .unwrap()
            .query_map([], |r| r.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(cols.iter().any(|c| c == "bed_z_mm"), "{cols:?}");
        let ledger = ShopLedger {
            conn,
            db_path: None,
        };
        let snap = ledger.snapshot().unwrap();
        let p = snap.printers.iter().find(|p| p.id == "p1").unwrap();
        assert_eq!(
            (p.bed_x_mm, p.bed_y_mm, p.bed_z_mm),
            (Some(256.0), Some(240.0), None)
        );

        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let pid = ledger.snapshot().unwrap().printers[0].id.clone();
        assert_eq!(
            ledger
                .snapshot()
                .unwrap()
                .printers
                .iter()
                .find(|p| p.id == pid)
                .unwrap()
                .bed_z_mm,
            None
        );
        let snap = ledger
            .set_printer_bed_size(&pid, Some(256.0), Some(256.0), Some(256.0))
            .unwrap();
        let p = snap.printers.iter().find(|p| p.id == pid).unwrap();
        assert_eq!(
            (p.bed_x_mm, p.bed_y_mm, p.bed_z_mm),
            (Some(256.0), Some(256.0), Some(256.0))
        );
        // Plate-building still reads only width and depth.
        assert_eq!(
            ledger.printer_bed_mm(&pid).unwrap(),
            (Some(256.0), Some(256.0))
        );
        assert!(ledger
            .set_printer_bed_size(&pid, Some(256.0), Some(256.0), Some(5.0))
            .is_err());
        let snap = ledger
            .set_printer_bed_size(&pid, Some(256.0), Some(256.0), None)
            .unwrap();
        assert_eq!(
            snap.printers.iter().find(|p| p.id == pid).unwrap().bed_z_mm,
            None
        );
        assert_eq!(
            (
                snap.printers.iter().find(|p| p.id == pid).unwrap().bed_x_mm,
                snap.printers.iter().find(|p| p.id == pid).unwrap().bed_y_mm
            ),
            (Some(256.0), Some(256.0))
        );
    }

    #[test]
    fn add_printer_uses_a_neutral_name_and_blank_model() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let before = ledger.snapshot().unwrap();
        let existing = before.printers.len();
        let demo = before
            .printers
            .iter()
            .find(|p| p.name == "Printer 1")
            .expect("seeded demo printer");
        assert_eq!(demo.model, "Demo Printer");

        let snap = ledger
            .add_printer("  ".into(), "  ".into(), 0.4, vec![])
            .unwrap();
        let added = snap
            .printers
            .iter()
            .find(|p| p.name == format!("Printer {}", existing + 1))
            .expect("fallback-named printer");
        assert_eq!(added.model, "");
        assert_eq!(
            (added.bed_x_mm, added.bed_y_mm, added.bed_z_mm),
            (None, None, None)
        );

        let snap = ledger
            .add_printer_with_bed(
                "  Shop 1  ".into(),
                "  Custom  ".into(),
                0.4,
                vec![],
                Some(256.0),
                Some(256.0),
                Some(256.0),
            )
            .unwrap();
        let added = snap
            .printers
            .iter()
            .find(|p| p.name == "Shop 1")
            .expect("named printer");
        assert_eq!(added.model, "Custom");
        assert_eq!(
            (added.bed_x_mm, added.bed_y_mm, added.bed_z_mm),
            (Some(256.0), Some(256.0), Some(256.0))
        );

        // Existing printers keep the name and model they already had.
        let still = snap
            .printers
            .iter()
            .find(|p| p.id == demo.id)
            .expect("original printer");
        assert_eq!(still.name, "Printer 1");
        assert_eq!(still.model, "Demo Printer");

        let snap = ledger
            .set_printer_model(&added.id, "  Shop Model  ")
            .unwrap();
        assert_eq!(
            snap.printers
                .iter()
                .find(|p| p.id == added.id)
                .unwrap()
                .model,
            "Shop Model"
        );
        let snap = ledger.set_printer_model(&added.id, "  ").unwrap();
        assert_eq!(
            snap.printers
                .iter()
                .find(|p| p.id == added.id)
                .unwrap()
                .model,
            ""
        );
    }

    #[test]
    fn backup_pruning_keeps_one_per_day_for_two_weeks() {
        let head = "farmprint_shop_v2-";
        let today = chrono::NaiveDate::from_ymd_opt(2026, 11, 18).unwrap();
        let mut files = Vec::new();
        for day in 0..20 {
            let date = today - chrono::Duration::days(19 - day);
            for hour in 0..3 {
                files.push(PathBuf::from(format!(
                    "{head}{}-{hour:02}0000.000.sqlite",
                    date.format("%Y%m%d")
                )));
            }
        }
        let pruned = backups_to_prune(&files, head, LAUNCH_BACKUPS_KEPT, today);
        let kept: Vec<&PathBuf> = files.iter().filter(|p| !pruned.contains(p)).collect();
        // newest 5 (all of today + 2 from yesterday) + newest of each of the other 12 days
        assert_eq!(kept.len(), 5 + 12, "{kept:?}");
        assert!(kept
            .iter()
            .any(|p| p.to_string_lossy().contains("20261105-020000")));
        assert!(!kept
            .iter()
            .any(|p| p.to_string_lossy().contains("20261104")));
        assert!(!kept
            .iter()
            .any(|p| p.to_string_lossy().contains("20261110-000000")));
    }

    #[test]
    fn restore_skips_backups_that_do_not_open() {
        let d = tmp_dir("restore");
        let db = d.join("farmprint_shop_v2.sqlite");
        drop(ShopLedger::open(&db).unwrap());
        drop(ShopLedger::open(&db).unwrap()); // one good launch backup
        std::thread::sleep(std::time::Duration::from_millis(20));
        let bad = d
            .join("backups")
            .join("farmprint_shop_v2-29990101-000000.000.sqlite");
        std::fs::write(&bad, b"not a database at all, definitely not sqlite").unwrap();
        std::fs::write(&db, b"garbage garbage garbage garbage garbage garbage garbage garbage garbage garbage garbage").unwrap();
        assert!(ShopLedger::open(&db).is_err());
        let used = restore_latest_working_backup(&db).unwrap();
        assert_ne!(used, bad);
        assert!(ShopLedger::open(&db).is_ok());
        let damaged = std::fs::read_dir(&d)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains(".damaged-"));
        assert!(damaged, "damaged file kept aside");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn start_fresh_shop_clears_leftovers_but_refuses_with_orders() {
        let conn = Connection::open_in_memory().unwrap();
        seed::init_schema(&conn).unwrap();
        let mut ledger = ShopLedger {
            conn,
            db_path: None,
        };
        ledger
            .add_filament_swatch(
                "Old".into(),
                "B".into(),
                "PLA".into(),
                "#112233".into(),
                1.0,
                1.0,
            )
            .unwrap();
        let mut st = ledger.get_settings().unwrap();
        st.shop_name = "BD".into();
        ledger.save_settings(st).unwrap();
        let snap = ledger.start_fresh_shop().unwrap();
        assert!(snap.filaments.is_empty());
        assert_eq!(ledger.get_settings().unwrap().shop_name, "");
        let mut seeded = ShopLedger::open_in_memory().unwrap();
        let n = seeded.snapshot().unwrap().orders.len();
        assert!(n > 0);
        assert!(seeded.start_fresh_shop().is_err());
        assert_eq!(seeded.snapshot().unwrap().orders.len(), n);
    }

    #[test]
    fn reset_writes_backup_first_and_aborts_without_one() {
        // In-memory: no backup possible -> refuse, data untouched.
        let mut mem = ShopLedger::open_in_memory().unwrap();
        let before = mem.snapshot().unwrap().orders.len();
        assert!(before > 0);
        assert!(mem.reset_to_production_tracker().is_err());
        assert_eq!(mem.snapshot().unwrap().orders.len(), before);

        // On disk: backup holds the pre-reset orders.
        let d = tmp_dir("reset");
        let db = d.join("farmprint_shop_v2.sqlite");
        let mut ledger = ShopLedger::open(&db).unwrap();
        seed::seed_if_empty(&ledger.conn).unwrap();
        let n: i64 = ledger
            .conn
            .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
            .unwrap();
        assert!(n > 0);
        ledger.reset_to_production_tracker().unwrap();
        let files = backups(&d, "farmprint_shop_v2-reset-");
        assert_eq!(files.len(), 1);
        let b = Connection::open(d.join("backups").join(&files[0])).unwrap();
        let bn: i64 = b
            .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
            .unwrap();
        assert_eq!(bn, n);
        // Launch backups are not counted with reset backups.
        assert!(backups(&d, "farmprint_shop_v2-")
            .iter()
            .all(|f| !f.contains("reset")));

        // Backup failure aborts: make backups/ a file.
        let d2 = tmp_dir("resetfail");
        let db2 = d2.join("farmprint_shop_v2.sqlite");
        let mut l2 = ShopLedger::open(&db2).unwrap();
        seed::seed_if_empty(&l2.conn).unwrap();
        std::fs::write(d2.join("backups"), b"not a dir").unwrap();
        assert!(l2.reset_to_production_tracker().is_err());
        let n2: i64 = l2
            .conn
            .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
            .unwrap();
        assert!(n2 > 0);
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&d2);
    }

    fn empty_filament_ledger() -> ShopLedger {
        let conn = Connection::open_in_memory().unwrap();
        seed::init_schema(&conn).unwrap();
        ShopLedger {
            conn,
            db_path: None,
        }
    }

    #[test]
    fn canonical_label_uses_majority_spelling_and_leaves_blanks_and_others() {
        assert_eq!(canonical_label("  polymaker  ", &[]), "polymaker");
        assert_eq!(
            canonical_label(
                "POLYMAKER",
                &["Polymaker ".into(), "Polymaker".into(), "Polymaker".into()]
            ),
            "Polymaker"
        );
        // Tie: alphabetically first existing spelling ("PolyMaker" < "Polymaker").
        assert_eq!(
            canonical_label("polymaker", &["Polymaker".into(), "PolyMaker".into()]),
            "PolyMaker"
        );
        assert_eq!(canonical_label("   ", &["Polymaker".into()]), "");
        assert_eq!(canonical_label("", &[]), "");
        // Different brands are not rewritten.
        assert_eq!(
            canonical_label("Overture", &["Polymaker".into(), "eSun".into()]),
            "Overture"
        );
        // Spaces inside the name are ignored when matching.
        assert_eq!(
            canonical_label("Poly Maker", &["Polymaker".into()]),
            "Polymaker"
        );
    }

    #[test]
    fn add_filament_swatch_reuses_existing_brand_spelling_and_keeps_blank() {
        let mut ledger = empty_filament_ledger();
        ledger
            .add_filament_swatch_with_vendor(
                "Black".into(),
                "Polymaker".into(),
                "PLA".into(),
                "#111111".into(),
                20.0,
                1000.0,
                Some("  amazon  ".into()),
            )
            .unwrap();
        ledger
            .add_filament_swatch_with_vendor(
                "White".into(),
                "  polymaker ".into(),
                "PLA".into(),
                "#EEEEEE".into(),
                20.0,
                800.0,
                Some("AMAZON".into()),
            )
            .unwrap();
        ledger
            .add_filament_swatch_with_vendor(
                "Clear".into(),
                "POLYMAKER".into(),
                "PETG".into(),
                "#FFFFFF".into(),
                22.0,
                500.0,
                None,
            )
            .unwrap();
        ledger
            .add_filament_swatch_with_vendor(
                "Mystery".into(),
                "   ".into(),
                "PLA".into(),
                "#000000".into(),
                10.0,
                100.0,
                Some("  ".into()),
            )
            .unwrap();
        ledger
            .add_filament_swatch_with_vendor(
                "Other".into(),
                "eSun".into(),
                "PLA".into(),
                "#00AA00".into(),
                18.0,
                900.0,
                Some("Direct".into()),
            )
            .unwrap();
        let snap = ledger.snapshot().unwrap();
        let by_name = |n: &str| snap.filaments.iter().find(|f| f.name == n).unwrap();
        assert_eq!(by_name("Black").brand, "Polymaker");
        assert_eq!(by_name("White").brand, "Polymaker");
        assert_eq!(by_name("Clear").brand, "Polymaker");
        assert_eq!(by_name("Mystery").brand, "");
        assert_eq!(by_name("Other").brand, "eSun");
        assert_eq!(by_name("Black").vendor.as_deref(), Some("amazon"));
        assert_eq!(by_name("White").vendor.as_deref(), Some("amazon"));
        assert_eq!(by_name("Clear").vendor, None);
        assert_eq!(by_name("Mystery").vendor, None);
        assert_eq!(by_name("Other").vendor.as_deref(), Some("Direct"));
    }

    #[test]
    fn update_and_rename_filament_brand_reuse_existing_spelling() {
        let mut ledger = empty_filament_ledger();
        ledger
            .add_filament_swatch_with_vendor(
                "A".into(),
                "Polymaker".into(),
                "PLA".into(),
                "#111111".into(),
                20.0,
                1000.0,
                Some("Shop".into()),
            )
            .unwrap();
        ledger
            .add_filament_swatch_with_vendor(
                "B".into(),
                "eSun".into(),
                "PLA".into(),
                "#00AA00".into(),
                18.0,
                900.0,
                None,
            )
            .unwrap();
        let id_b = ledger
            .snapshot()
            .unwrap()
            .filaments
            .iter()
            .find(|f| f.name == "B")
            .unwrap()
            .id
            .clone();
        ledger
            .update_filament_swatch(
                &id_b,
                None,
                Some("  POLYMAKER ".into()),
                None,
                None,
                None,
                None,
                Some("  shop ".into()),
            )
            .unwrap();
        let snap = ledger.snapshot().unwrap();
        let b = snap.filaments.iter().find(|f| f.name == "B").unwrap();
        assert_eq!(b.brand, "Polymaker");
        assert_eq!(b.vendor.as_deref(), Some("Shop"));

        ledger
            .add_filament_swatch_with_vendor(
                "C".into(),
                "Overture".into(),
                "PETG".into(),
                "#123456".into(),
                20.0,
                100.0,
                None,
            )
            .unwrap();
        ledger
            .rename_filament_brand("Overture", "  overture ")
            .unwrap();
        let snap = ledger.snapshot().unwrap();
        let c = snap.filaments.iter().find(|f| f.name == "C").unwrap();
        // Only this brand existed, so the trimmed spelling the user typed is kept.
        assert_eq!(c.brand, "overture");
        ledger
            .rename_filament_brand("overture", "POLYMAKER")
            .unwrap();
        let snap = ledger.snapshot().unwrap();
        let c = snap.filaments.iter().find(|f| f.name == "C").unwrap();
        assert_eq!(c.brand, "Polymaker");
        // Clearing a brand on rename is a no-op.
        ledger.rename_filament_brand("Polymaker", "   ").unwrap();
        let snap = ledger.snapshot().unwrap();
        assert!(snap.filaments.iter().all(|f| f.brand == "Polymaker"));
    }

    #[test]
    fn filament_vendor_column_migrates_on_old_db_and_reads_as_none() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE filaments (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                brand TEXT NOT NULL,
                material TEXT NOT NULL,
                hex TEXT NOT NULL,
                cost_per_kg REAL NOT NULL,
                grams_remaining REAL NOT NULL
            );
             INSERT INTO filaments VALUES ('fil-old', 'Teal', 'Acme', 'PLA', '#00AAAA', 20.0, 900.0);",
        )
        .unwrap();
        seed::init_schema(&conn).unwrap();
        seed::init_schema(&conn).unwrap(); // idempotent
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(filaments)")
            .unwrap()
            .query_map([], |r| r.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(cols.iter().any(|c| c == "vendor"), "{cols:?}");
        let ledger = ShopLedger {
            conn,
            db_path: None,
        };
        let snap = ledger.snapshot().unwrap();
        let f = snap.filaments.iter().find(|f| f.id == "fil-old").unwrap();
        assert_eq!(f.brand, "Acme");
        assert_eq!(f.vendor, None);
    }
}
