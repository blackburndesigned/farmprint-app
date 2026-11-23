//! Printer feeders: named units on a printer that hold spools, each with its own number
//! of slots. Feeders only group the printer's existing slot numbers (slot N is still
//! filament N in the slicer, and `printer_slots` is unchanged); a dry box holds spools
//! that are not loaded, so they never take a slot number. Local only, never synced.
//!
//! A printer with no saved feeders reads as one default feeder holding its current
//! slots, so databases from before feeders need no data migration.

use crate::models::{
    CoreError, CoreResult, FeederInput, FeederNozzle, FilamentSwatch, PrinterFeeder, PrinterSlot,
};
use crate::ShopLedger;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use uuid::Uuid;

/// Slots in the default feeder when a printer has fewer loaded: the most the printer
/// settings offered before feeders existed.
pub const DEFAULT_FEEDER_SLOTS: i64 = 4;
/// Upper bound on one feeder's slot count (a typo guard, not a hardware limit).
pub const MAX_FEEDER_SLOTS: i64 = 64;
const DEFAULT_FEEDER_NAME: &str = "Feeder 1";
const OTHER_SLOTS_NAME: &str = "Other slots";

/// Id of the default feeder shown for a printer with no saved feeders. Saving the
/// feeder list with this id keeps the slots it holds.
pub fn default_feeder_id(printer_id: &str) -> String {
    format!("{printer_id}-feeder-1")
}

fn other_slots_id(printer_id: &str) -> String {
    format!("{printer_id}-other-slots")
}

/// A saved `printer_feeders` row.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FeederRow {
    pub id: String,
    pub printer_id: String,
    pub name: String,
    pub slot_count: i64,
    pub is_dry_box: bool,
    pub note: Option<String>,
    pub nozzle: Option<FeederNozzle>,
}

/// Lays a printer's feeders over its slots. `saved` is in position order; `loaded` is the
/// printer's loaded slots; `dry` maps a dry box id to its spools (by 1-based position).
pub(crate) fn layout_feeders(
    printer_id: &str,
    saved: &[FeederRow],
    loaded: &[PrinterSlot],
    dry: &HashMap<String, Vec<PrinterSlot>>,
) -> Vec<PrinterFeeder> {
    let mut loaded: Vec<PrinterSlot> = loaded
        .iter()
        .filter(|s| s.slot_index >= 1)
        .cloned()
        .collect();
    loaded.sort_by_key(|s| s.slot_index);
    if saved.is_empty() {
        let highest = loaded.last().map(|s| s.slot_index).unwrap_or(0);
        return vec![PrinterFeeder {
            id: default_feeder_id(printer_id),
            name: DEFAULT_FEEDER_NAME.to_string(),
            slot_count: highest.max(DEFAULT_FEEDER_SLOTS),
            is_dry_box: false,
            note: None,
            first_slot: Some(1),
            spools: loaded,
            auto: true,
            nozzle: None,
        }];
    }
    let mut out = Vec::with_capacity(saved.len() + 1);
    let mut next = 1i64;
    for row in saved {
        if row.is_dry_box {
            let mut spools: Vec<PrinterSlot> = dry
                .get(&row.id)
                .map(|v| {
                    v.iter()
                        .filter(|s| s.slot_index >= 1 && s.slot_index <= row.slot_count)
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            spools.sort_by_key(|s| s.slot_index);
            out.push(PrinterFeeder {
                id: row.id.clone(),
                name: row.name.clone(),
                slot_count: row.slot_count,
                is_dry_box: true,
                note: row.note.clone(),
                first_slot: None,
                spools,
                auto: false,
                nozzle: row.nozzle,
            });
        } else {
            let end = next + row.slot_count;
            out.push(PrinterFeeder {
                id: row.id.clone(),
                name: row.name.clone(),
                slot_count: row.slot_count,
                is_dry_box: false,
                note: row.note.clone(),
                first_slot: Some(next),
                spools: loaded
                    .iter()
                    .filter(|s| s.slot_index >= next && s.slot_index < end)
                    .cloned()
                    .collect(),
                auto: false,
                nozzle: row.nozzle,
            });
            next = end;
        }
    }
    // Loaded slots past the last feeder (never dropped from view).
    let extra: Vec<PrinterSlot> = loaded
        .iter()
        .filter(|s| s.slot_index >= next)
        .cloned()
        .collect();
    if let Some(last) = extra.last() {
        out.push(PrinterFeeder {
            id: other_slots_id(printer_id),
            name: OTHER_SLOTS_NAME.to_string(),
            slot_count: last.slot_index - next + 1,
            is_dry_box: false,
            note: None,
            first_slot: Some(next),
            spools: extra,
            auto: true,
            nozzle: None,
        });
    }
    out
}

fn tidy_note(note: &Option<String>) -> Option<String> {
    note.as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
}

pub(crate) fn load_feeder_rows(
    conn: &Connection,
    printer_id: Option<&str>,
) -> CoreResult<Vec<FeederRow>> {
    let sql =
        "SELECT id, printer_id, name, slot_count, is_dry_box, note, nozzle FROM printer_feeders
               WHERE ?1 IS NULL OR printer_id = ?1 ORDER BY printer_id, position, id";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map(params![printer_id], |r| {
            Ok(FeederRow {
                id: r.get(0)?,
                printer_id: r.get(1)?,
                name: r.get(2)?,
                slot_count: r.get(3)?,
                is_dry_box: r.get::<_, i64>(4)? != 0,
                note: r.get(5)?,
                nozzle: r
                    .get::<_, Option<String>>(6)?
                    .as_deref()
                    .and_then(FeederNozzle::parse),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Dry box spools by feeder id. `missing_hex` is the hex for a deleted swatch.
pub(crate) fn load_dry_box_spools(
    conn: &Connection,
    printer_id: Option<&str>,
    filament_map: Option<&HashMap<String, FilamentSwatch>>,
    missing_hex: &str,
) -> CoreResult<HashMap<String, Vec<PrinterSlot>>> {
    let mut stmt = conn.prepare(
        "SELECT s.feeder_id, s.position, s.filament_id, f.name, f.hex, f.material, f.brand
         FROM printer_feeder_spools s
         JOIN printer_feeders d ON d.id = s.feeder_id
         LEFT JOIN filaments f ON f.id = s.filament_id
         WHERE ?1 IS NULL OR d.printer_id = ?1
         ORDER BY s.feeder_id, s.position",
    )?;
    let rows = stmt
        .query_map(params![printer_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut out: HashMap<String, Vec<PrinterSlot>> = HashMap::new();
    for (feeder_id, position, fid, name, hex, material, brand) in rows {
        let fil = filament_map.and_then(|m| m.get(&fid));
        out.entry(feeder_id).or_default().push(PrinterSlot {
            slot_index: position,
            filament_name: fil.map(|f| f.name.clone()).or(name).unwrap_or_default(),
            filament_hex: fil
                .map(|f| f.hex.clone())
                .or(hex)
                .unwrap_or_else(|| missing_hex.to_string()),
            material: fil
                .map(|f| f.material.clone())
                .or(material)
                .unwrap_or_default(),
            brand: fil.map(|f| f.brand.clone()).or(brand).unwrap_or_default(),
            filament_id: fid,
        });
    }
    Ok(out)
}

/// Total slots in feeders that feed the printer (dry boxes excluded); None when the
/// printer has no saved feeders (any slot number is accepted, as before feeders).
pub(crate) fn saved_feeding_capacity(
    conn: &Connection,
    printer_id: &str,
) -> CoreResult<Option<i64>> {
    let (n, cap): (i64, Option<i64>) = conn.query_row(
        "SELECT COUNT(*), SUM(CASE WHEN is_dry_box = 0 THEN slot_count ELSE 0 END)
         FROM printer_feeders WHERE printer_id = ?1",
        params![printer_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok((n > 0).then(|| cap.unwrap_or(0)))
}

impl ShopLedger {
    /// A printer's feeders in order (the default feeder when none are saved).
    pub fn printer_feeders(&self, printer_id: &str) -> CoreResult<Vec<PrinterFeeder>> {
        let rows = load_feeder_rows(&self.conn, Some(printer_id))?;
        let loaded = self.printer_loaded_slots(printer_id)?;
        let dry = load_dry_box_spools(&self.conn, Some(printer_id), None, "")?;
        Ok(layout_feeders(printer_id, &rows, &loaded, &dry))
    }

    /// Replaces a printer's feeder list. A feeder keeps its spools by id (slot by slot
    /// from its first slot); spools that no longer fit (a removed feeder, fewer slots)
    /// are unloaded. Turning a feeder into a dry box (or back) keeps its spools in their
    /// positions. Feeding slots are renumbered so feeders stay consecutive.
    pub fn set_printer_feeders(
        &mut self,
        printer_id: &str,
        feeders: Vec<FeederInput>,
    ) -> CoreResult<crate::ShopSnapshot> {
        let exists: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM printers WHERE id = ?1",
                params![printer_id],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(CoreError::Validation(format!(
                "Unknown printer {printer_id}"
            )));
        }
        if feeders.is_empty() {
            return Err(CoreError::Validation(
                "A printer needs at least one feeder.".into(),
            ));
        }
        for (i, f) in feeders.iter().enumerate() {
            if f.slot_count < 1 || f.slot_count > MAX_FEEDER_SLOTS {
                let name = f.name.trim();
                let name = if name.is_empty() {
                    format!("Feeder {}", i + 1)
                } else {
                    name.to_string()
                };
                return Err(CoreError::Validation(format!(
                    "{name} needs between 1 and {MAX_FEEDER_SLOTS} slots."
                )));
            }
        }

        // What each current feeder holds, by offset inside the feeder (0-based).
        let old = self.printer_feeders(printer_id)?;
        let mut held: HashMap<String, Vec<(i64, String)>> = HashMap::new();
        for f in &old {
            let base = if f.is_dry_box {
                1
            } else {
                f.first_slot.unwrap_or(1)
            };
            held.insert(
                f.id.clone(),
                f.spools
                    .iter()
                    .map(|s| (s.slot_index - base, s.filament_id.clone()))
                    .collect(),
            );
        }

        type Row = (
            String,
            String,
            i64,
            bool,
            Option<String>,
            Option<FeederNozzle>,
        );
        let mut rows: Vec<Row> = Vec::new();
        let mut slots: Vec<(i64, String)> = Vec::new();
        let mut dry: Vec<(String, i64, String)> = Vec::new();
        let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut next = 1i64;
        for (i, f) in feeders.iter().enumerate() {
            let keep =
                f.id.as_deref()
                    .map(str::trim)
                    .filter(|id| !id.is_empty() && held.contains_key(*id) && !used.contains(*id))
                    .map(str::to_string);
            let id = keep
                .clone()
                .unwrap_or_else(|| format!("fdr-{}", &Uuid::new_v4().to_string()[..8]));
            used.insert(id.clone());
            let name = match f.name.trim() {
                "" => format!("Feeder {}", i + 1),
                n => n.to_string(),
            };
            if let Some(spools) = keep.as_ref().and_then(|k| held.get(k)) {
                for (offset, fid) in spools {
                    if *offset < 0 || *offset >= f.slot_count {
                        continue;
                    }
                    if f.is_dry_box {
                        dry.push((id.clone(), offset + 1, fid.clone()));
                    } else {
                        slots.push((next + offset, fid.clone()));
                    }
                }
            }
            if !f.is_dry_box {
                next += f.slot_count;
            }
            rows.push((
                id,
                name,
                f.slot_count,
                f.is_dry_box,
                tidy_note(&f.note),
                // A dry box feeds no nozzle.
                if f.is_dry_box { None } else { f.nozzle },
            ));
        }

        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM printer_feeder_spools WHERE feeder_id IN (SELECT id FROM printer_feeders WHERE printer_id = ?1)",
            params![printer_id],
        )?;
        tx.execute(
            "DELETE FROM printer_feeders WHERE printer_id = ?1",
            params![printer_id],
        )?;
        tx.execute(
            "DELETE FROM printer_slots WHERE printer_id = ?1",
            params![printer_id],
        )?;
        for (pos, (id, name, count, is_dry, note, nozzle)) in rows.iter().enumerate() {
            tx.execute(
                "INSERT INTO printer_feeders (id, printer_id, position, name, slot_count, is_dry_box, note, nozzle)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    id,
                    printer_id,
                    pos as i64,
                    name,
                    count,
                    *is_dry as i64,
                    note,
                    nozzle.map(FeederNozzle::as_str)
                ],
            )?;
        }
        for (idx, fid) in &slots {
            tx.execute(
                "INSERT INTO printer_slots (printer_id, slot_index, filament_id) VALUES (?1, ?2, ?3)",
                params![printer_id, idx, fid],
            )?;
        }
        for (fdr, pos, fid) in &dry {
            tx.execute(
                "INSERT INTO printer_feeder_spools (feeder_id, position, filament_id) VALUES (?1, ?2, ?3)",
                params![fdr, pos, fid],
            )?;
        }
        tx.commit()?;
        self.snapshot()
    }

    /// Sets the spools in a dry box by position (index k is position k + 1, "" empty).
    pub fn set_dry_box_spools(
        &mut self,
        feeder_id: &str,
        filament_ids: Vec<String>,
    ) -> CoreResult<crate::ShopSnapshot> {
        let row: Option<(i64, i64, String)> = self
            .conn
            .query_row(
                "SELECT slot_count, is_dry_box, name FROM printer_feeders WHERE id = ?1",
                params![feeder_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((slot_count, is_dry, name)) = row else {
            return Err(CoreError::Validation(format!("Unknown feeder {feeder_id}")));
        };
        if is_dry == 0 {
            return Err(CoreError::Validation(format!(
                "{name} feeds the printer; load it from the printer's slots."
            )));
        }
        if let Some(pos) = filament_ids
            .iter()
            .enumerate()
            .rposition(|(_, f)| !f.trim().is_empty())
        {
            if pos as i64 >= slot_count {
                return Err(CoreError::Validation(format!(
                    "{name} has {slot_count} slot{}.",
                    if slot_count == 1 { "" } else { "s" }
                )));
            }
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM printer_feeder_spools WHERE feeder_id = ?1",
            params![feeder_id],
        )?;
        for (idx, fid) in filament_ids.iter().enumerate() {
            if !fid.trim().is_empty() {
                tx.execute(
                    "INSERT INTO printer_feeder_spools (feeder_id, position, filament_id) VALUES (?1, ?2, ?3)",
                    params![feeder_id, (idx + 1) as i64, fid.trim()],
                )?;
            }
        }
        tx.commit()?;
        self.snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seed;

    fn ids(spools: &[PrinterSlot]) -> Vec<(i64, String)> {
        spools
            .iter()
            .map(|s| (s.slot_index, s.filament_id.clone()))
            .collect()
    }

    fn feeder(name: &str, slots: i64, dry: bool) -> FeederInput {
        FeederInput {
            id: None,
            name: name.into(),
            slot_count: slots,
            is_dry_box: dry,
            note: None,
            nozzle: None,
        }
    }

    /// The seeded demo ledger, its first printer, and two filament ids.
    fn setup() -> (ShopLedger, String, String, String) {
        let ledger = ShopLedger::open_in_memory().unwrap();
        let snap = ledger.snapshot().unwrap();
        let pid = snap.printers[0].id.clone();
        let a = snap.filaments[0].id.clone();
        let b = snap.filaments[1].id.clone();
        (ledger, pid, a, b)
    }

    #[test]
    fn printer_without_feeders_reads_as_one_default_feeder() {
        let (mut ledger, pid, a, b) = setup();
        ledger
            .set_printer_filament_slots(&pid, vec![a.clone(), String::new(), b.clone()])
            .unwrap();
        let fs = ledger.printer_feeders(&pid).unwrap();
        assert_eq!(fs.len(), 1);
        assert!(fs[0].auto && !fs[0].is_dry_box);
        assert_eq!(fs[0].id, default_feeder_id(&pid));
        assert_eq!(fs[0].slot_count, DEFAULT_FEEDER_SLOTS);
        assert_eq!(fs[0].first_slot, Some(1));
        assert_eq!(ids(&fs[0].spools), vec![(1, a.clone()), (3, b.clone())]);
        // More slots than the default: the default feeder grows to hold them all.
        let six = vec![
            a.clone(),
            a.clone(),
            a.clone(),
            a.clone(),
            String::new(),
            b.clone(),
        ];
        let snap = ledger.set_printer_filament_slots(&pid, six).unwrap();
        let p = snap.printers.iter().find(|p| p.id == pid).unwrap();
        assert_eq!(p.feeders.len(), 1);
        assert_eq!(p.feeders[0].slot_count, 6);
        assert_eq!(p.feeders[0].spools, p.loaded_slots);
    }

    #[test]
    fn feeders_group_consecutive_slots_and_leave_print_slots_unchanged() {
        let (mut ledger, pid, a, b) = setup();
        ledger
            .set_printer_filament_slots(&pid, vec![a.clone(), b.clone(), String::new(), a.clone()])
            .unwrap();
        let before = ledger.printer_loaded_slots(&pid).unwrap();
        // Keep the default feeder (and its slots), add a second feeder and a dry box.
        let mut first = feeder("Feeder 1", 4, false);
        first.id = Some(default_feeder_id(&pid));
        let snap = ledger
            .set_printer_feeders(
                &pid,
                vec![
                    first,
                    feeder("Dry box", 2, true),
                    feeder("Feeder 2", 4, false),
                ],
            )
            .unwrap();
        let p = snap.printers.iter().find(|p| p.id == pid).unwrap();
        assert_eq!(
            p.loaded_slots, before,
            "slot numbers Print! uses are unchanged"
        );
        assert_eq!(p.feeders.len(), 3);
        assert_eq!(p.feeders[0].first_slot, Some(1));
        assert_eq!(
            p.feeders[1].first_slot, None,
            "a dry box takes no slot numbers"
        );
        assert_eq!(
            p.feeders[2].first_slot,
            Some(5),
            "the next feeder starts after slot 4"
        );
        assert!(p.feeders.iter().all(|f| !f.auto));
        assert_eq!(ids(&p.feeders[0].spools), ids(&before));

        // A spool in the dry box is not loaded on the printer.
        let dry_id = p.feeders[1].id.clone();
        let snap = ledger
            .set_dry_box_spools(&dry_id, vec![String::new(), b.clone()])
            .unwrap();
        let p = snap.printers.iter().find(|p| p.id == pid).unwrap();
        assert_eq!(ids(&p.feeders[1].spools), vec![(2, b.clone())]);
        assert_eq!(p.loaded_slots, before);
        assert_eq!(ledger.printer_loaded_slots(&pid).unwrap(), before);
        assert!(
            ledger
                .set_dry_box_spools(&dry_id, vec![a.clone(); 3])
                .is_err(),
            "only 2 slots"
        );
        assert!(
            ledger
                .set_dry_box_spools(&p.feeders[0].id, vec![a.clone()])
                .is_err(),
            "not a dry box"
        );

        // Slot 5 (Feeder 2, slot 1) can be loaded; slot 9 is past the last feeder.
        let mut s = vec![a.clone(), b.clone(), String::new(), a.clone(), b.clone()];
        ledger.set_printer_filament_slots(&pid, s.clone()).unwrap();
        assert_eq!(
            ids(&ledger.printer_feeders(&pid).unwrap()[2].spools),
            vec![(5, b.clone())]
        );
        s.resize(9, String::new());
        s[8] = a.clone();
        assert!(ledger.set_printer_filament_slots(&pid, s).is_err());
    }

    #[test]
    fn reordering_and_resizing_feeders_keeps_each_feeders_spools() {
        let (mut ledger, pid, a, b) = setup();
        ledger
            .set_printer_feeders(
                &pid,
                vec![feeder("Left", 2, false), feeder("Right", 2, false)],
            )
            .unwrap();
        ledger
            .set_printer_filament_slots(&pid, vec![a.clone(), a.clone(), b.clone(), String::new()])
            .unwrap();
        let fs = ledger.printer_feeders(&pid).unwrap();
        let (left, right) = (fs[0].id.clone(), fs[1].id.clone());
        // Right first, Left shrunk to 1 slot: Right's spool moves to slot 1, Left keeps slot 1's spool.
        let snap = ledger
            .set_printer_feeders(
                &pid,
                vec![
                    FeederInput {
                        id: Some(right.clone()),
                        name: "Right".into(),
                        slot_count: 2,
                        ..Default::default()
                    },
                    FeederInput {
                        id: Some(left.clone()),
                        name: "Left".into(),
                        slot_count: 1,
                        ..Default::default()
                    },
                ],
            )
            .unwrap();
        let p = snap.printers.iter().find(|p| p.id == pid).unwrap();
        assert_eq!(p.feeders[0].id, right);
        assert_eq!(ids(&p.loaded_slots), vec![(1, b.clone()), (3, a.clone())]);
        // Turning Left into a dry box keeps its spool, but it is no longer loaded.
        let snap = ledger
            .set_printer_feeders(
                &pid,
                vec![
                    FeederInput {
                        id: Some(right.clone()),
                        name: "Right".into(),
                        slot_count: 2,
                        ..Default::default()
                    },
                    FeederInput {
                        id: Some(left.clone()),
                        name: "Left".into(),
                        slot_count: 1,
                        is_dry_box: true,
                        note: Some("  ".into()),
                        nozzle: None,
                    },
                ],
            )
            .unwrap();
        let p = snap.printers.iter().find(|p| p.id == pid).unwrap();
        assert_eq!(ids(&p.loaded_slots), vec![(1, b.clone())]);
        assert_eq!(ids(&p.feeders[1].spools), vec![(1, a.clone())]);
        assert_eq!(p.feeders[1].note, None, "a blank note is not saved");
        // Removing a feeder unloads it; a blank name gets a neutral one; bad counts refuse.
        let snap = ledger
            .set_printer_feeders(
                &pid,
                vec![FeederInput {
                    id: Some(left.clone()),
                    name: " ".into(),
                    slot_count: 1,
                    is_dry_box: true,
                    note: None,
                    nozzle: None,
                }],
            )
            .unwrap();
        let p = snap.printers.iter().find(|p| p.id == pid).unwrap();
        assert!(p.loaded_slots.is_empty());
        assert_eq!(p.feeders[0].name, "Feeder 1");
        assert!(ledger.set_printer_feeders(&pid, vec![]).is_err());
        assert!(ledger
            .set_printer_feeders(&pid, vec![feeder("X", 0, false)])
            .is_err());
        assert!(ledger
            .set_printer_feeders("prn-nope", vec![feeder("X", 1, false)])
            .is_err());
    }

    #[test]
    fn removing_a_printer_or_swatch_clears_its_feeders_and_dry_box_spools() {
        let (mut ledger, pid, a, b) = setup();
        let count =
            |l: &ShopLedger, sql: &str| -> i64 { l.conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        // Delete a swatch that only sits in a dry box: it leaves the box.
        let spare = ledger
            .add_filament_swatch(
                "Spare".into(),
                String::new(),
                "PLA".into(),
                "#123456".into(),
                20.0,
                1000.0,
            )
            .unwrap()
            .filaments
            .into_iter()
            .find(|f| f.name == "Spare")
            .unwrap()
            .id;
        let snap = ledger
            .set_printer_feeders(&pid, vec![feeder("Box", 3, true)])
            .unwrap();
        let dry = snap.printers.iter().find(|p| p.id == pid).unwrap().feeders[0]
            .id
            .clone();
        ledger
            .set_dry_box_spools(&dry, vec![a.clone(), spare.clone(), b.clone()])
            .unwrap();
        ledger.delete_filament_swatch(&spare).unwrap();
        let fs = ledger.printer_feeders(&pid).unwrap();
        assert_eq!(ids(&fs[0].spools), vec![(1, a.clone()), (3, b.clone())]);
        ledger.delete_printer(&pid).unwrap();
        assert_eq!(count(&ledger, "SELECT COUNT(*) FROM printer_feeders"), 0);
        assert_eq!(
            count(&ledger, "SELECT COUNT(*) FROM printer_feeder_spools"),
            0
        );
    }

    #[test]
    fn old_database_without_feeder_tables_upgrades_and_reads_its_slots() {
        // A database from before feeders: printers and slots only, no feeder tables.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE filaments (id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL,
                 material TEXT NOT NULL, hex TEXT NOT NULL, cost_per_kg REAL NOT NULL, grams_remaining REAL NOT NULL);
             CREATE TABLE printers (id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL,
                 nozzle_mm REAL NOT NULL, status TEXT NOT NULL, utilization_pct REAL NOT NULL DEFAULT 0.0);
             CREATE TABLE printer_slots (printer_id TEXT NOT NULL, slot_index INTEGER NOT NULL,
                 filament_id TEXT NOT NULL, PRIMARY KEY (printer_id, slot_index));
             INSERT INTO filaments VALUES ('fil-a', 'Teal', '', 'PLA', '#00AAAA', 20.0, 900.0);
             INSERT INTO filaments VALUES ('fil-b', 'Rose', '', 'PLA', '#FF88AA', 20.0, 900.0);
             INSERT INTO printers VALUES ('p-old', 'Old printer', '', 0.4, 'Idle', 0);
             INSERT INTO printer_slots VALUES ('p-old', 1, 'fil-a');
             INSERT INTO printer_slots VALUES ('p-old', 2, 'fil-b');",
        )
        .unwrap();
        seed::init_schema(&conn).unwrap();
        seed::init_schema(&conn).unwrap(); // safe to run twice
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(tables.iter().any(|t| t == "printer_feeders"), "{tables:?}");
        assert!(
            tables.iter().any(|t| t == "printer_feeder_spools"),
            "{tables:?}"
        );
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM printer_feeders", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "no rows are written on open");
        let mut ledger = ShopLedger {
            conn,
            db_path: None,
        };
        let snap = ledger.snapshot().unwrap();
        let p = snap.printers.iter().find(|p| p.id == "p-old").unwrap();
        assert_eq!(
            ids(&p.loaded_slots),
            vec![(1, "fil-a".into()), (2, "fil-b".into())]
        );
        assert_eq!(p.feeders.len(), 1);
        assert_eq!(p.feeders[0].name, "Feeder 1");
        assert_eq!(p.feeders[0].slot_count, DEFAULT_FEEDER_SLOTS);
        assert_eq!(p.feeders[0].spools, p.loaded_slots);
        // Saving the default feeder by its id keeps the old slots.
        let snap = ledger
            .set_printer_feeders(
                "p-old",
                vec![FeederInput {
                    id: Some(default_feeder_id("p-old")),
                    name: "Main".into(),
                    slot_count: 4,
                    ..Default::default()
                }],
            )
            .unwrap();
        let p = snap.printers.iter().find(|p| p.id == "p-old").unwrap();
        assert_eq!(
            ids(&p.loaded_slots),
            vec![(1, "fil-a".into()), (2, "fil-b".into())]
        );
        assert_eq!(p.feeders[0].name, "Main");
        assert!(!p.feeders[0].auto);
    }

    #[test]
    fn slots_past_the_last_feeder_show_in_an_other_slots_group() {
        let rows = vec![FeederRow {
            id: "f1".into(),
            printer_id: "p".into(),
            name: "One".into(),
            slot_count: 2,
            is_dry_box: false,
            note: None,
            nozzle: None,
        }];
        let slot = |i: i64| PrinterSlot {
            slot_index: i,
            filament_id: format!("fil-{i}"),
            filament_name: String::new(),
            filament_hex: String::new(),
            material: String::new(),
            brand: String::new(),
        };
        let fs = layout_feeders("p", &rows, &[slot(1), slot(5)], &HashMap::new());
        assert_eq!(fs.len(), 2);
        assert_eq!(ids(&fs[0].spools), vec![(1, "fil-1".into())]);
        assert!(fs[1].auto);
        assert_eq!((fs[1].first_slot, fs[1].slot_count), (Some(3), 3));
        assert_eq!(ids(&fs[1].spools), vec![(5, "fil-5".into())]);
    }
}
