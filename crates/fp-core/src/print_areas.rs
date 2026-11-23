//! Print areas: optional parts of a printer's bed that a print can use, for printers
//! whose nozzles each reach only part of the bed. The user types every size and offset;
//! FarmPrint never fills them in for a printer model. A printer with no print areas uses
//! its whole bed, exactly as before. Local only, never synced.
//!
//! Which area a part must sit in comes from the feeders its filament slots are in (each
//! feeder optionally says which nozzle it feeds). See [`print_area_for_slots`].

use crate::models::{
    AreaNozzle, CoreError, CoreResult, FeederNozzle, PrintArea, PrintAreaInput, Printer,
};
use crate::ShopLedger;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use uuid::Uuid;

/// Smallest and largest size (width, depth, height) of a print area, in mm.
pub const MIN_AREA_MM: f64 = 1.0;
pub const MAX_AREA_MM: f64 = 2000.0;
/// Largest offset of an area's front-left corner from the bed's front-left corner, in mm.
pub const MAX_AREA_OFFSET_MM: f64 = 2000.0;

/// Name used when the user leaves an area's name blank.
pub fn default_area_name(nozzle: AreaNozzle) -> &'static str {
    match nozzle {
        AreaNozzle::Left => "Left nozzle",
        AreaNozzle::Right => "Right nozzle",
        AreaNozzle::Both => "Both nozzles",
    }
}

/// Saved print areas by printer id, each list in position order.
pub(crate) fn load_print_areas(conn: &Connection) -> CoreResult<HashMap<String, Vec<PrintArea>>> {
    let mut stmt = conn.prepare(
        "SELECT printer_id, id, name, nozzle, width_mm, depth_mm, height_mm, x_mm, y_mm
         FROM printer_print_areas ORDER BY printer_id, position, id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                PrintArea {
                    id: r.get(1)?,
                    name: r.get(2)?,
                    nozzle: AreaNozzle::parse(&r.get::<_, String>(3)?).unwrap_or_default(),
                    width_mm: r.get(4)?,
                    depth_mm: r.get(5)?,
                    height_mm: r.get(6)?,
                    x_mm: r.get(7)?,
                    y_mm: r.get(8)?,
                },
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut out: HashMap<String, Vec<PrintArea>> = HashMap::new();
    for (pid, area) in rows {
        out.entry(pid).or_default().push(area);
    }
    Ok(out)
}

fn check_size(label: &str, what: &str, v: f64) -> CoreResult<()> {
    if v.is_finite() && (MIN_AREA_MM..=MAX_AREA_MM).contains(&v) {
        Ok(())
    } else {
        Err(CoreError::Validation(format!(
            "{label}: {what} needs to be between {MIN_AREA_MM} and {MAX_AREA_MM} mm."
        )))
    }
}

fn check_offset(label: &str, what: &str, v: f64) -> CoreResult<()> {
    if v.is_finite() && (0.0..=MAX_AREA_OFFSET_MM).contains(&v) {
        Ok(())
    } else {
        Err(CoreError::Validation(format!(
            "{label}: {what} needs to be between 0 and {MAX_AREA_OFFSET_MM} mm."
        )))
    }
}

/// Warnings (never errors) for areas that run past the printer's bed width or depth.
/// Empty when the bed size is not set.
pub fn print_area_fit_warnings(printer: &Printer) -> Vec<String> {
    let mut out = Vec::new();
    for a in &printer.print_areas {
        if let Some(bx) = printer.bed_x_mm {
            if a.x_mm + a.width_mm > bx + 1e-6 {
                out.push(format!(
                    "{} runs past the bed width ({} mm).",
                    a.name,
                    fmt_mm(bx)
                ));
            }
        }
        if let Some(by) = printer.bed_y_mm {
            if a.y_mm + a.depth_mm > by + 1e-6 {
                out.push(format!(
                    "{} runs past the bed depth ({} mm).",
                    a.name,
                    fmt_mm(by)
                ));
            }
        }
    }
    out
}

fn fmt_mm(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{v:.0}")
    } else {
        format!("{v}")
    }
}

/// Which nozzles a part needs, from the feeders holding the slots it prints with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NozzleNeed {
    /// Every slot is in a feeder set to the left nozzle.
    Left,
    /// Every slot is in a feeder set to the right nozzle.
    Right,
    /// Slots on both nozzles.
    Both,
    /// No slots, a slot outside every feeder, or a feeder with no nozzle set.
    Unknown,
}

/// The nozzle need for a set of printer slot numbers (1-based, as in `loaded_slots` and
/// the slicer's filament numbers). Dry boxes never count: their spools have no slot.
pub fn nozzle_need_for_slots(printer: &Printer, slot_indexes: &[i64]) -> NozzleNeed {
    let nozzles = slot_indexes.iter().map(|&slot| {
        printer
            .feeders
            .iter()
            .filter(|f| !f.is_dry_box)
            .find(|f| {
                let first = f.first_slot.unwrap_or(1);
                slot >= first && slot < first + f.slot_count
            })
            .and_then(|f| f.nozzle)
    });
    need_from(nozzles)
}

/// The nozzle need for a set of feeder ids (unknown ids and dry boxes count as unknown).
pub fn nozzle_need_for_feeders(printer: &Printer, feeder_ids: &[&str]) -> NozzleNeed {
    let nozzles = feeder_ids.iter().map(|id| {
        printer
            .feeders
            .iter()
            .find(|f| f.id == *id && !f.is_dry_box)
            .and_then(|f| f.nozzle)
    });
    need_from(nozzles)
}

fn need_from(nozzles: impl Iterator<Item = Option<FeederNozzle>>) -> NozzleNeed {
    let (mut left, mut right, mut any) = (false, false, false);
    for n in nozzles {
        any = true;
        match n {
            Some(FeederNozzle::Left) => left = true,
            Some(FeederNozzle::Right) => right = true,
            None => return NozzleNeed::Unknown,
        }
    }
    match (any, left, right) {
        (false, _, _) => NozzleNeed::Unknown,
        (_, true, true) => NozzleNeed::Both,
        (_, true, false) => NozzleNeed::Left,
        (_, false, true) => NozzleNeed::Right,
        _ => NozzleNeed::Unknown,
    }
}

/// Id and name of the area synthesized from the left and right areas when a printer has
/// no "both" area (see [`overlap_area`]).
pub const OVERLAP_AREA_ID: &str = "overlap";
pub const OVERLAP_AREA_NAME: &str = "Overlap";

/// Where a part may sit on a printer.
#[derive(Debug, Clone, PartialEq)]
pub enum PartArea {
    /// The printer has no print areas: the whole bed, exactly as before print areas.
    Bed,
    /// Inside this area: a saved one, or the synthesized overlap (id [`OVERLAP_AREA_ID`]).
    Area(PrintArea),
    /// The printer has print areas, but none the part's nozzles can reach (for example no
    /// "both" area and the left and right areas don't overlap). The caller should flag it.
    Unreachable,
}

impl PartArea {
    /// The area, if the part has one (None for `Bed` and `Unreachable`).
    pub fn area(&self) -> Option<&PrintArea> {
        match self {
            PartArea::Area(a) => Some(a),
            _ => None,
        }
    }
    pub fn is_unreachable(&self) -> bool {
        matches!(self, PartArea::Unreachable)
    }
}

/// The rectangle both nozzles reach when the printer has no "both" area: the intersection
/// of every left and every right area (x/y rectangle intersection, height = the smallest).
/// None unless there is at least one left and one right area and they overlap.
pub fn overlap_area(printer: &Printer) -> Option<PrintArea> {
    let one_nozzle: Vec<&PrintArea> = printer
        .print_areas
        .iter()
        .filter(|a| a.nozzle != AreaNozzle::Both)
        .collect();
    let has = |n: AreaNozzle| one_nozzle.iter().any(|a| a.nozzle == n);
    if !has(AreaNozzle::Left) || !has(AreaNozzle::Right) {
        return None;
    }
    let (mut x0, mut y0, mut x1, mut y1, mut h) = (
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::INFINITY,
        f64::INFINITY,
    );
    for a in &one_nozzle {
        x0 = x0.max(a.x_mm);
        y0 = y0.max(a.y_mm);
        x1 = x1.min(a.x_mm + a.width_mm);
        y1 = y1.min(a.y_mm + a.depth_mm);
        h = h.min(a.height_mm);
    }
    let (w, d) = (x1 - x0, y1 - y0);
    if !(w > 1e-9 && d > 1e-9 && h > 0.0) {
        return None;
    }
    Some(PrintArea {
        id: OVERLAP_AREA_ID.to_string(),
        name: OVERLAP_AREA_NAME.to_string(),
        nozzle: AreaNozzle::Both,
        width_mm: w,
        depth_mm: d,
        height_mm: h,
        x_mm: x0,
        y_mm: y0,
    })
}

/// The area both nozzles reach: the first "both" area, else [`overlap_area`].
pub fn shared_area(printer: &Printer) -> Option<PrintArea> {
    printer
        .print_areas
        .iter()
        .find(|a| a.nozzle == AreaNozzle::Both)
        .cloned()
        .or_else(|| overlap_area(printer))
}

/// Where a part must sit.
///
/// For the plate view and arrange, per part: pass the printer slot numbers the part prints
/// with. All slots on left-nozzle feeders -> the first "left" area; all on right-nozzle
/// feeders -> the first "right" area; a mix, a slot with no nozzle set, or no slots -> the
/// shared area. The shared area is the first "both" area, else the overlap of the left and
/// right areas ([`overlap_area`]). A part whose one-nozzle area is missing also gets the
/// shared area. Nothing reachable -> `Unreachable`. `Bed` (the whole bed) only when the
/// printer has no print areas at all.
///
/// An area's rectangle on the bed is `x_mm..x_mm + width_mm` by `y_mm..y_mm + depth_mm`,
/// measured from the bed's front-left corner, and parts must be no taller than `height_mm`.
pub fn print_area_for_slots(printer: &Printer, slot_indexes: &[i64]) -> PartArea {
    print_area_for_need(printer, nozzle_need_for_slots(printer, slot_indexes))
}

/// [`print_area_for_slots`] keyed by feeder ids instead of slot numbers.
pub fn print_area_for_feeders(printer: &Printer, feeder_ids: &[&str]) -> PartArea {
    print_area_for_need(printer, nozzle_need_for_feeders(printer, feeder_ids))
}

/// The area for a known nozzle need (see [`print_area_for_slots`]).
pub fn print_area_for_need(printer: &Printer, need: NozzleNeed) -> PartArea {
    if printer.print_areas.is_empty() {
        return PartArea::Bed;
    }
    let find = |n: AreaNozzle| printer.print_areas.iter().find(|a| a.nozzle == n).cloned();
    let own = match need {
        NozzleNeed::Left => find(AreaNozzle::Left),
        NozzleNeed::Right => find(AreaNozzle::Right),
        NozzleNeed::Both | NozzleNeed::Unknown => None,
    };
    match own.or_else(|| shared_area(printer)) {
        Some(a) => PartArea::Area(a),
        None => PartArea::Unreachable,
    }
}

impl ShopLedger {
    /// A printer's print areas in order (empty when none are set).
    pub fn printer_print_areas(&self, printer_id: &str) -> CoreResult<Vec<PrintArea>> {
        Ok(load_print_areas(&self.conn)?
            .remove(printer_id)
            .unwrap_or_default())
    }

    /// Replaces a printer's print areas. An empty list clears them (the whole bed is used).
    /// Sizes must be 1–2000 mm and offsets 0–2000 mm; an area running past the bed is
    /// allowed (see `print_area_fit_warnings`).
    pub fn set_printer_print_areas(
        &mut self,
        printer_id: &str,
        areas: Vec<PrintAreaInput>,
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
        // Only this printer's own area ids are kept (ids are unique across printers).
        let own: std::collections::HashSet<String> = self
            .printer_print_areas(printer_id)?
            .into_iter()
            .map(|a| a.id)
            .collect();
        let mut rows: Vec<PrintArea> = Vec::with_capacity(areas.len());
        let mut used = std::collections::HashSet::new();
        for (i, a) in areas.iter().enumerate() {
            let name = match a.name.trim() {
                "" => default_area_name(a.nozzle).to_string(),
                n => n.to_string(),
            };
            let label = if a.name.trim().is_empty() {
                format!("Print area {}", i + 1)
            } else {
                name.clone()
            };
            check_size(&label, "width", a.width_mm)?;
            check_size(&label, "depth", a.depth_mm)?;
            check_size(&label, "height", a.height_mm)?;
            check_offset(&label, "X offset", a.x_mm)?;
            check_offset(&label, "Y offset", a.y_mm)?;
            let id =
                a.id.as_deref()
                    .map(str::trim)
                    .filter(|id| own.contains(*id) && !used.contains(*id))
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("area-{}", &Uuid::new_v4().to_string()[..8]));
            used.insert(id.clone());
            rows.push(PrintArea {
                id,
                name,
                nozzle: a.nozzle,
                width_mm: a.width_mm,
                depth_mm: a.depth_mm,
                height_mm: a.height_mm,
                x_mm: a.x_mm,
                y_mm: a.y_mm,
            });
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM printer_print_areas WHERE printer_id = ?1",
            params![printer_id],
        )?;
        for (pos, a) in rows.iter().enumerate() {
            tx.execute(
                "INSERT INTO printer_print_areas
                    (id, printer_id, position, name, nozzle, width_mm, depth_mm, height_mm, x_mm, y_mm)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    a.id,
                    printer_id,
                    pos as i64,
                    a.name,
                    a.nozzle.as_str(),
                    a.width_mm,
                    a.depth_mm,
                    a.height_mm,
                    a.x_mm,
                    a.y_mm
                ],
            )?;
        }
        tx.commit()?;
        self.snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feeders::default_feeder_id;
    use crate::models::FeederInput;
    use crate::seed;

    fn area(name: &str, nozzle: AreaNozzle, w: f64, d: f64, h: f64) -> PrintAreaInput {
        PrintAreaInput {
            name: name.into(),
            nozzle,
            width_mm: w,
            depth_mm: d,
            height_mm: h,
            ..Default::default()
        }
    }

    /// The example sizes from a dual-nozzle printer (offsets left at 0: not known here).
    fn dual_areas() -> Vec<PrintAreaInput> {
        vec![
            area("Left nozzle", AreaNozzle::Left, 325.0, 320.0, 320.0),
            area("Right nozzle", AreaNozzle::Right, 305.0, 320.0, 325.0),
            area("Both nozzles", AreaNozzle::Both, 300.0, 320.0, 320.0),
        ]
    }

    fn feeder(name: &str, slots: i64, nozzle: Option<FeederNozzle>) -> FeederInput {
        FeederInput {
            name: name.into(),
            slot_count: slots,
            nozzle,
            ..Default::default()
        }
    }

    fn setup() -> (ShopLedger, String) {
        let ledger = ShopLedger::open_in_memory().unwrap();
        let pid = ledger.snapshot().unwrap().printers[0].id.clone();
        (ledger, pid)
    }

    fn printer(ledger: &ShopLedger, pid: &str) -> Printer {
        ledger
            .snapshot()
            .unwrap()
            .printers
            .into_iter()
            .find(|p| p.id == pid)
            .unwrap()
    }

    #[test]
    fn printers_start_with_no_print_areas() {
        let (ledger, _) = setup();
        let snap = ledger.snapshot().unwrap();
        assert!(snap.printers.iter().all(|p| p.print_areas.is_empty()));
        assert!(snap
            .printers
            .iter()
            .all(|p| p.feeders.iter().all(|f| f.nozzle.is_none())));
        // No areas: every part gets the whole bed.
        let p = &snap.printers[0];
        assert_eq!(print_area_for_slots(p, &[1, 2]), PartArea::Bed);
        assert_eq!(print_area_for_slots(p, &[]), PartArea::Bed);
        assert_eq!(print_area_for_need(p, NozzleNeed::Left), PartArea::Bed);
        assert_eq!(shared_area(p), None);
    }

    #[test]
    fn print_areas_save_in_order_and_round_trip() {
        let (mut ledger, pid) = setup();
        let mut input = dual_areas();
        input[1].x_mm = 20.0;
        input[1].y_mm = 2.5;
        input[2].name = "  ".into(); // blank name -> default for its nozzle
        let snap = ledger.set_printer_print_areas(&pid, input).unwrap();
        let p = snap.printers.iter().find(|p| p.id == pid).unwrap();
        let got: Vec<_> = p
            .print_areas
            .iter()
            .map(|a| {
                (
                    a.name.as_str(),
                    a.nozzle,
                    a.width_mm,
                    a.depth_mm,
                    a.height_mm,
                    a.x_mm,
                    a.y_mm,
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    "Left nozzle",
                    AreaNozzle::Left,
                    325.0,
                    320.0,
                    320.0,
                    0.0,
                    0.0
                ),
                (
                    "Right nozzle",
                    AreaNozzle::Right,
                    305.0,
                    320.0,
                    325.0,
                    20.0,
                    2.5
                ),
                (
                    "Both nozzles",
                    AreaNozzle::Both,
                    300.0,
                    320.0,
                    320.0,
                    0.0,
                    0.0
                ),
            ]
        );
        // Editing keeps ids; an empty list clears.
        let ids: Vec<String> = p.print_areas.iter().map(|a| a.id.clone()).collect();
        let mut again: Vec<PrintAreaInput> = p
            .print_areas
            .iter()
            .map(|a| PrintAreaInput {
                id: Some(a.id.clone()),
                name: a.name.clone(),
                nozzle: a.nozzle,
                width_mm: a.width_mm,
                depth_mm: a.depth_mm,
                height_mm: a.height_mm,
                x_mm: a.x_mm,
                y_mm: a.y_mm,
            })
            .collect();
        again[0].width_mm = 324.0;
        let snap = ledger.set_printer_print_areas(&pid, again).unwrap();
        let p = snap.printers.iter().find(|p| p.id == pid).unwrap();
        assert_eq!(
            p.print_areas
                .iter()
                .map(|a| a.id.clone())
                .collect::<Vec<_>>(),
            ids
        );
        assert_eq!(p.print_areas[0].width_mm, 324.0);
        let snap = ledger.set_printer_print_areas(&pid, vec![]).unwrap();
        assert!(snap
            .printers
            .iter()
            .find(|p| p.id == pid)
            .unwrap()
            .print_areas
            .is_empty());
        // Other printers are untouched.
        assert!(snap
            .printers
            .iter()
            .filter(|p| p.id != pid)
            .all(|p| p.print_areas.is_empty()));
    }

    #[test]
    fn print_area_sizes_and_offsets_are_checked() {
        let (mut ledger, pid) = setup();
        for bad in [
            area("A", AreaNozzle::Left, 0.0, 10.0, 10.0),
            area("A", AreaNozzle::Left, 10.0, 2001.0, 10.0),
            area("A", AreaNozzle::Left, 10.0, 10.0, f64::NAN),
            PrintAreaInput {
                x_mm: -1.0,
                ..area("A", AreaNozzle::Left, 10.0, 10.0, 10.0)
            },
            PrintAreaInput {
                y_mm: 2001.0,
                ..area("A", AreaNozzle::Left, 10.0, 10.0, 10.0)
            },
        ] {
            assert!(
                ledger
                    .set_printer_print_areas(&pid, vec![bad.clone()])
                    .is_err(),
                "{bad:?}"
            );
        }
        assert!(ledger.printer_print_areas(&pid).unwrap().is_empty());
        assert!(ledger
            .set_printer_print_areas("prn-nope", dual_areas())
            .is_err());
        // Limits are inclusive.
        ledger
            .set_printer_print_areas(&pid, vec![area("A", AreaNozzle::Both, 1.0, 2000.0, 1.0)])
            .unwrap();
    }

    #[test]
    fn areas_past_the_bed_warn_but_save() {
        let (mut ledger, pid) = setup();
        ledger
            .set_printer_bed_size(&pid, Some(310.0), Some(320.0), None)
            .unwrap();
        let mut input = dual_areas();
        input[1].x_mm = 10.0; // 10 + 305 = 315 > 310
        ledger.set_printer_print_areas(&pid, input).unwrap();
        let p = printer(&ledger, &pid);
        assert_eq!(p.print_areas.len(), 3);
        assert_eq!(
            print_area_fit_warnings(&p),
            vec![
                "Left nozzle runs past the bed width (310 mm).".to_string(),
                "Right nozzle runs past the bed width (310 mm).".to_string(),
            ]
        );
        // No bed size: nothing to compare against.
        ledger.set_printer_bed_size(&pid, None, None, None).unwrap();
        assert!(print_area_fit_warnings(&printer(&ledger, &pid)).is_empty());
    }

    #[test]
    fn feeder_nozzle_saves_and_a_dry_box_has_none() {
        let (mut ledger, pid) = setup();
        let mut first = feeder("Left unit", 4, Some(FeederNozzle::Left));
        first.id = Some(default_feeder_id(&pid));
        let mut dry = feeder("Dry box", 2, Some(FeederNozzle::Right));
        dry.is_dry_box = true;
        ledger
            .set_printer_feeders(
                &pid,
                vec![
                    first,
                    dry,
                    feeder("Right unit", 4, Some(FeederNozzle::Right)),
                    feeder("Spare", 1, None),
                ],
            )
            .unwrap();
        let p = printer(&ledger, &pid);
        let got: Vec<_> = p
            .feeders
            .iter()
            .map(|f| (f.name.as_str(), f.nozzle))
            .collect();
        assert_eq!(
            got,
            vec![
                ("Left unit", Some(FeederNozzle::Left)),
                ("Dry box", None),
                ("Right unit", Some(FeederNozzle::Right)),
                ("Spare", None),
            ]
        );
        // JSON: "left"/"right", and no key at all when unset.
        let json = serde_json::to_value(&p.feeders).unwrap();
        assert_eq!(json[0]["nozzle"], "left");
        assert_eq!(json[2]["nozzle"], "right");
        assert!(json[3].get("nozzle").is_none());
        // Input accepts absent, null, and the two names.
        let parsed: Vec<FeederInput> = serde_json::from_value(serde_json::json!([
            { "name": "A", "slot_count": 1 },
            { "name": "B", "slot_count": 1, "nozzle": null },
            { "name": "C", "slot_count": 1, "nozzle": "right" }
        ]))
        .unwrap();
        assert_eq!(
            parsed.iter().map(|f| f.nozzle).collect::<Vec<_>>(),
            vec![None, None, Some(FeederNozzle::Right)]
        );
    }

    /// Feeder 1 (slots 1-4) left, Feeder 2 (slots 5-8) right, Feeder 3 (slot 9) unset.
    fn dual_printer() -> Printer {
        let (mut ledger, pid) = setup();
        let mut first = feeder("Feeder 1", 4, Some(FeederNozzle::Left));
        first.id = Some(default_feeder_id(&pid));
        ledger
            .set_printer_feeders(
                &pid,
                vec![
                    first,
                    feeder("Feeder 2", 4, Some(FeederNozzle::Right)),
                    feeder("Feeder 3", 1, None),
                ],
            )
            .unwrap();
        ledger.set_printer_print_areas(&pid, dual_areas()).unwrap();
        printer(&ledger, &pid)
    }

    #[test]
    fn a_part_sits_in_the_area_its_nozzles_reach() {
        let p = dual_printer();
        let name = |slots: &[i64]| {
            print_area_for_slots(&p, slots)
                .area()
                .map(|a| a.name.clone())
        };
        assert_eq!(name(&[1, 4]).as_deref(), Some("Left nozzle"));
        assert_eq!(name(&[5, 8]).as_deref(), Some("Right nozzle"));
        assert_eq!(name(&[1, 5]).as_deref(), Some("Both nozzles"));
        // Unset nozzle, a slot outside every feeder, or no slots: the shared area.
        assert_eq!(name(&[9]).as_deref(), Some("Both nozzles"));
        assert_eq!(name(&[1, 9]).as_deref(), Some("Both nozzles"));
        assert_eq!(name(&[40]).as_deref(), Some("Both nozzles"));
        assert_eq!(name(&[]).as_deref(), Some("Both nozzles"));
        assert_eq!(nozzle_need_for_slots(&p, &[2, 3]), NozzleNeed::Left);
        assert_eq!(nozzle_need_for_slots(&p, &[3, 6]), NozzleNeed::Both);
        assert_eq!(nozzle_need_for_slots(&p, &[9]), NozzleNeed::Unknown);

        let ids: Vec<String> = p.feeders.iter().map(|f| f.id.clone()).collect();
        let by_feeder = |f: &[&str]| print_area_for_feeders(&p, f).area().map(|a| a.name.clone());
        assert_eq!(by_feeder(&[&ids[0]]).as_deref(), Some("Left nozzle"));
        assert_eq!(by_feeder(&[&ids[1]]).as_deref(), Some("Right nozzle"));
        assert_eq!(
            by_feeder(&[&ids[0], &ids[1]]).as_deref(),
            Some("Both nozzles")
        );
        assert_eq!(by_feeder(&[&ids[2]]).as_deref(), Some("Both nozzles"));
        assert_eq!(by_feeder(&["nope"]).as_deref(), Some("Both nozzles"));
    }

    #[test]
    fn missing_areas_fall_back_to_the_shared_area_or_the_overlap() {
        let mut p = dual_printer();
        let nozzle = |p: &Printer, s: &[i64]| print_area_for_slots(p, s).area().map(|a| a.nozzle);
        // No right-nozzle area: right-only parts use the "both" area.
        p.print_areas.retain(|a| a.nozzle != AreaNozzle::Right);
        assert_eq!(nozzle(&p, &[5]), Some(AreaNozzle::Both));
        // Only a left area: right-only, mixed and unknown parts can't be placed.
        p.print_areas.retain(|a| a.nozzle == AreaNozzle::Left);
        assert_eq!(nozzle(&p, &[1]), Some(AreaNozzle::Left));
        for s in [&[5][..], &[1, 5], &[9], &[]] {
            assert_eq!(print_area_for_slots(&p, s), PartArea::Unreachable, "{s:?}");
        }
        assert!(print_area_for_slots(&p, &[5]).is_unreachable());
        assert_eq!(print_area_for_slots(&p, &[5]).area(), None);
    }

    fn rect(nozzle: AreaNozzle, x: f64, y: f64, w: f64, d: f64, h: f64) -> PrintArea {
        PrintArea {
            id: format!("{nozzle:?}-{x}"),
            name: default_area_name(nozzle).into(),
            nozzle,
            width_mm: w,
            depth_mm: d,
            height_mm: h,
            x_mm: x,
            y_mm: y,
        }
    }

    #[test]
    fn without_a_both_area_shared_parts_use_the_left_right_overlap() {
        let mut p = dual_printer();
        // Left reaches x 0..325, right x 25..330 (offsets typed by the user).
        p.print_areas = vec![
            rect(AreaNozzle::Left, 0.0, 0.0, 325.0, 320.0, 320.0),
            rect(AreaNozzle::Right, 25.0, 5.0, 305.0, 320.0, 325.0),
        ];
        let expect = PrintArea {
            id: OVERLAP_AREA_ID.into(),
            name: OVERLAP_AREA_NAME.into(),
            nozzle: AreaNozzle::Both,
            width_mm: 300.0,
            depth_mm: 315.0,
            height_mm: 320.0,
            x_mm: 25.0,
            y_mm: 5.0,
        };
        assert_eq!(overlap_area(&p), Some(expect.clone()));
        assert_eq!(shared_area(&p), Some(expect.clone()));
        for s in [&[1, 5][..], &[9], &[]] {
            assert_eq!(
                print_area_for_slots(&p, s),
                PartArea::Area(expect.clone()),
                "{s:?}"
            );
        }
        // One-nozzle parts keep their own area.
        assert_eq!(
            print_area_for_slots(&p, &[1]).area().unwrap().nozzle,
            AreaNozzle::Left
        );
        assert_eq!(
            print_area_for_slots(&p, &[5]).area().unwrap().nozzle,
            AreaNozzle::Right
        );
        // Missing right area plus no both area: right part -> the overlap needs a right
        // area too, so it's unreachable.
        let mut left_only = p.clone();
        left_only.print_areas.truncate(1);
        assert_eq!(overlap_area(&left_only), None);
        assert!(print_area_for_slots(&left_only, &[5]).is_unreachable());
        // Several areas per nozzle: everything intersects.
        p.print_areas
            .push(rect(AreaNozzle::Left, 0.0, 0.0, 200.0, 320.0, 300.0));
        let o = overlap_area(&p).unwrap();
        assert_eq!((o.x_mm, o.width_mm, o.height_mm), (25.0, 175.0, 300.0));
        // A "both" area wins over the overlap.
        p.print_areas
            .push(rect(AreaNozzle::Both, 50.0, 0.0, 100.0, 100.0, 100.0));
        assert_eq!(print_area_for_slots(&p, &[1, 5]).area().unwrap().x_mm, 50.0);
    }

    #[test]
    fn areas_that_do_not_overlap_leave_shared_parts_unreachable() {
        let mut p = dual_printer();
        p.print_areas = vec![
            rect(AreaNozzle::Left, 0.0, 0.0, 100.0, 100.0, 100.0),
            rect(AreaNozzle::Right, 100.0, 0.0, 100.0, 100.0, 100.0), // touching, no overlap
        ];
        assert_eq!(overlap_area(&p), None);
        assert_eq!(print_area_for_slots(&p, &[1, 5]), PartArea::Unreachable);
        assert_eq!(print_area_for_slots(&p, &[9]), PartArea::Unreachable);
        assert_eq!(print_area_for_slots(&p, &[1]).area().unwrap().x_mm, 0.0);
        assert_eq!(print_area_for_feeders(&p, &["nope"]), PartArea::Unreachable);
    }

    #[test]
    fn removing_a_printer_removes_its_areas() {
        let (mut ledger, pid) = setup();
        ledger.set_printer_print_areas(&pid, dual_areas()).unwrap();
        ledger.delete_printer(&pid).unwrap();
        let n: i64 = ledger
            .conn
            .query_row("SELECT COUNT(*) FROM printer_print_areas", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    /// A database as v0.9.32 left it (feeders without a nozzle column, no print area
    /// table) opens with every printer, slot, feeder and dry box spool kept.
    #[test]
    fn a_v0_9_32_database_upgrades_keeping_all_data() {
        let (mut ledger, pid) = setup();
        let snap = ledger.snapshot().unwrap();
        let (a, b) = (snap.filaments[0].id.clone(), snap.filaments[1].id.clone());
        ledger
            .set_printer_bed_size(&pid, Some(330.0), Some(320.0), Some(325.0))
            .unwrap();
        ledger
            .set_printer_filament_slots(&pid, vec![a.clone(), String::new(), b.clone()])
            .unwrap();
        let mut first = feeder("Main", 4, None);
        first.id = Some(default_feeder_id(&pid));
        let mut dry = feeder("Dry box", 3, None);
        dry.is_dry_box = true;
        ledger
            .set_printer_feeders(&pid, vec![first, dry, feeder("Second", 2, None)])
            .unwrap();
        let dry_id = printer(&ledger, &pid).feeders[1].id.clone();
        ledger
            .set_dry_box_spools(&dry_id, vec![String::new(), b.clone()])
            .unwrap();
        // Everything the snapshot shows for printers before the upgrade (no areas and no
        // nozzles are set, so it matches what v0.9.32 showed).
        let before = serde_json::to_value(&ledger.snapshot().unwrap().printers).unwrap();
        let counts = |l: &ShopLedger| -> Vec<i64> {
            [
                "printers",
                "printer_slots",
                "printer_feeders",
                "printer_feeder_spools",
            ]
            .iter()
            .map(|t| {
                l.conn
                    .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
                    .unwrap()
            })
            .collect()
        };
        let rows_before = counts(&ledger);
        // Turn it back into a v0.9.32 database.
        ledger
            .conn
            .execute_batch(
                "DROP TABLE printer_print_areas;
                 ALTER TABLE printer_feeders DROP COLUMN nozzle;",
            )
            .unwrap();
        let cols = |l: &ShopLedger| -> Vec<String> {
            l.conn
                .prepare("PRAGMA table_info(printer_feeders)")
                .unwrap()
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert!(!cols(&ledger).iter().any(|c| c == "nozzle"));

        seed::init_schema(&ledger.conn).unwrap();
        seed::init_schema(&ledger.conn).unwrap(); // safe to run twice
        assert!(cols(&ledger).iter().any(|c| c == "nozzle"));
        assert_eq!(counts(&ledger), rows_before);
        let after_snap = ledger.snapshot().unwrap();
        let p = after_snap.printers.iter().find(|p| p.id == pid).unwrap();
        assert!(p.print_areas.is_empty());
        assert!(p.feeders.iter().all(|f| f.nozzle.is_none()));
        assert_eq!(
            serde_json::to_value(&after_snap.printers).unwrap(),
            before,
            "printers, slots, feeders and dry box spools are unchanged"
        );
        assert_eq!(p.feeders[1].spools.len(), 1);
        assert_eq!(
            (p.bed_x_mm, p.bed_y_mm, p.bed_z_mm),
            (Some(330.0), Some(320.0), Some(325.0))
        );
        // And the new fields work on the upgraded database.
        ledger.set_printer_print_areas(&pid, dual_areas()).unwrap();
        assert_eq!(printer(&ledger, &pid).print_areas.len(), 3);
    }
}
