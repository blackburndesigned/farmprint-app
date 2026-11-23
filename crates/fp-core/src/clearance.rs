//! By-object extruder clearance per printer, with the slicer's parameter names (values in
//! mm): `extruder_clearance_radius` (Max radius), `extruder_clearance_dist_to_rod`
//! (Distance to rod), `extruder_clearance_height_to_rod` (Height to rod) and
//! `extruder_clearance_height_to_lid` (Height to lid). All optional and empty by default;
//! FarmPrint has no built-in values for any printer.
//!
//! The plate view also remembers a clearance radius and height per printer in shop
//! settings (`printer_plate`). [`effective_extruder_clearance`] resolves which one applies.

use crate::models::{CoreError, CoreResult, ExtruderClearance, Printer};
use crate::ShopLedger;
use rusqlite::{params, Connection, OptionalExtension};

/// Largest clearance value accepted, in mm (a typo guard, not a hardware limit).
pub const MAX_CLEARANCE_MM: f64 = 2000.0;
/// The plate view's by-object defaults when nothing is set (keep in step with
/// fp-mesh `DEFAULT_CLEARANCE_RADIUS_MM` / `DEFAULT_CLEARANCE_HEIGHT_MM`).
pub const PLATE_DEFAULT_CLEARANCE_RADIUS_MM: f64 = 35.0;
pub const PLATE_DEFAULT_CLEARANCE_HEIGHT_MM: f64 = 30.0;

/// `shop_settings` key marking that plate clearance was copied into the printer fields.
const COPIED_KEY: &str = "printer_clearance_copied";

/// Clearance the plate view and arrange should use for one printer.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct EffectiveClearance {
    /// Max radius around the nozzle, mm: printer field, else `printer_plate`
    /// `clearance_radius_mm`, else the plate default (35).
    pub radius: f64,
    /// Height to rod, mm: printer field, else `printer_plate` `clearance_height_mm`,
    /// else the plate default (30).
    pub height_to_rod: f64,
    /// Distance to rod, mm; None when the printer field is empty (no fallback exists).
    pub dist_to_rod: Option<f64>,
    /// Height to lid, mm; None when the printer field is empty (no fallback exists).
    pub height_to_lid: Option<f64>,
}

fn plate_number(plate: Option<&serde_json::Value>, key: &str) -> Option<f64> {
    plate
        .and_then(|v| v.get(key))
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite() && *v >= 0.0)
}

/// Effective by-object clearance for a printer. `plate` is the printer's entry in shop
/// settings `printer_plate` (if any). Each value: the printer's own field, else the
/// plate view's remembered value, else the plate default.
pub fn effective_extruder_clearance(
    printer: &Printer,
    plate: Option<&serde_json::Value>,
) -> EffectiveClearance {
    effective_clearance_from(&printer.extruder_clearance, plate)
}

/// [`effective_extruder_clearance`] from the four fields alone.
pub fn effective_clearance_from(
    c: &ExtruderClearance,
    plate: Option<&serde_json::Value>,
) -> EffectiveClearance {
    EffectiveClearance {
        radius: c
            .extruder_clearance_radius
            .or_else(|| plate_number(plate, "clearance_radius_mm"))
            .unwrap_or(PLATE_DEFAULT_CLEARANCE_RADIUS_MM),
        height_to_rod: c
            .extruder_clearance_height_to_rod
            .or_else(|| plate_number(plate, "clearance_height_mm"))
            .unwrap_or(PLATE_DEFAULT_CLEARANCE_HEIGHT_MM),
        dist_to_rod: c.extruder_clearance_dist_to_rod,
        height_to_lid: c.extruder_clearance_height_to_lid,
    }
}

/// Empty, or 0–2000 mm.
fn check(label: &str, v: Option<f64>) -> CoreResult<Option<f64>> {
    match v {
        None => Ok(None),
        Some(v) if v.is_finite() && (0.0..=MAX_CLEARANCE_MM).contains(&v) => Ok(Some(v)),
        Some(_) => Err(CoreError::Validation(format!(
            "{label} needs to be between 0 and {MAX_CLEARANCE_MM} mm, or empty."
        ))),
    }
}

/// One-time upgrade: a clearance radius or height the user changed in the plate view
/// (not the 35 / 30 defaults) is copied into `extruder_clearance_radius` /
/// `extruder_clearance_height_to_rod`, only where that field is still empty. Runs once per
/// database (marked in local `shop_settings`); `printer_plate` itself is left as it is.
pub(crate) fn copy_plate_clearance_once(conn: &Connection) -> CoreResult<()> {
    let done: Option<String> = conn
        .query_row(
            "SELECT value_json FROM shop_settings WHERE key = ?1",
            params![COPIED_KEY],
            |r| r.get(0),
        )
        .optional()?;
    if done.is_some() {
        return Ok(());
    }
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM shop_settings WHERE key = 'default'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let plates = raw
        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
        .and_then(|v| v.get("printer_plate").cloned())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let changed = |plate: &serde_json::Value, key: &str, default: f64| {
        plate_number(Some(plate), key)
            .filter(|v| (*v - default).abs() > 1e-9 && *v <= MAX_CLEARANCE_MM)
    };
    for (pid, plate) in &plates {
        if let Some(r) = changed(
            plate,
            "clearance_radius_mm",
            PLATE_DEFAULT_CLEARANCE_RADIUS_MM,
        ) {
            conn.execute(
                "UPDATE printers SET extruder_clearance_radius = ?2
                 WHERE id = ?1 AND extruder_clearance_radius IS NULL",
                params![pid, r],
            )?;
        }
        if let Some(h) = changed(
            plate,
            "clearance_height_mm",
            PLATE_DEFAULT_CLEARANCE_HEIGHT_MM,
        ) {
            conn.execute(
                "UPDATE printers SET extruder_clearance_height_to_rod = ?2
                 WHERE id = ?1 AND extruder_clearance_height_to_rod IS NULL",
                params![pid, h],
            )?;
        }
    }
    conn.execute(
        "INSERT OR REPLACE INTO shop_settings (key, value_json) VALUES (?1, 'true')",
        params![COPIED_KEY],
    )?;
    Ok(())
}

impl ShopLedger {
    /// Sets a printer's four clearance fields (None = empty). Each set value is 0–2000 mm.
    pub fn set_printer_extruder_clearance(
        &mut self,
        printer_id: &str,
        c: ExtruderClearance,
    ) -> CoreResult<crate::ShopSnapshot> {
        let radius = check("Max radius", c.extruder_clearance_radius)?;
        let dist = check("Distance to rod", c.extruder_clearance_dist_to_rod)?;
        let rod = check("Height to rod", c.extruder_clearance_height_to_rod)?;
        let lid = check("Height to lid", c.extruder_clearance_height_to_lid)?;
        let n = self.conn.execute(
            "UPDATE printers SET extruder_clearance_radius = ?2, extruder_clearance_dist_to_rod = ?3,
                extruder_clearance_height_to_rod = ?4, extruder_clearance_height_to_lid = ?5
             WHERE id = ?1",
            params![printer_id, radius, dist, rod, lid],
        )?;
        if n == 0 {
            return Err(CoreError::Validation(format!(
                "Unknown printer {printer_id}"
            )));
        }
        self.snapshot()
    }

    /// A printer's four clearance fields; None for an unknown printer.
    pub fn printer_extruder_clearance(
        &self,
        printer_id: &str,
    ) -> CoreResult<Option<ExtruderClearance>> {
        Ok(self
            .conn
            .query_row(
                "SELECT extruder_clearance_radius, extruder_clearance_dist_to_rod,
                        extruder_clearance_height_to_rod, extruder_clearance_height_to_lid
                 FROM printers WHERE id = ?1",
                params![printer_id],
                |r| {
                    Ok(ExtruderClearance {
                        extruder_clearance_radius: r.get(0)?,
                        extruder_clearance_dist_to_rod: r.get(1)?,
                        extruder_clearance_height_to_rod: r.get(2)?,
                        extruder_clearance_height_to_lid: r.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    /// Effective by-object clearance for a printer (see [`effective_extruder_clearance`]),
    /// reading its `printer_plate` entry from shop settings. None for an unknown printer.
    pub fn printer_effective_clearance(
        &self,
        printer_id: &str,
    ) -> CoreResult<Option<EffectiveClearance>> {
        let Some(c) = self.printer_extruder_clearance(printer_id)? else {
            return Ok(None);
        };
        let settings = self.get_settings()?;
        Ok(Some(effective_clearance_from(
            &c,
            settings.printer_plate.get(printer_id),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seed;
    use serde_json::json;

    fn ledger_and_printers() -> (ShopLedger, Vec<String>) {
        let ledger = ShopLedger::open_in_memory().unwrap();
        let ids = ledger
            .snapshot()
            .unwrap()
            .printers
            .iter()
            .map(|p| p.id.clone())
            .collect();
        (ledger, ids)
    }

    fn fields(l: &ShopLedger, pid: &str) -> ExtruderClearance {
        l.printer_extruder_clearance(pid).unwrap().unwrap()
    }

    #[test]
    fn clearance_fields_start_empty_and_save() {
        let (mut ledger, ids) = ledger_and_printers();
        let snap = ledger.snapshot().unwrap();
        assert!(snap
            .printers
            .iter()
            .all(|p| p.extruder_clearance == ExtruderClearance::default()));
        let set = ExtruderClearance {
            extruder_clearance_radius: Some(40.0),
            extruder_clearance_dist_to_rod: Some(0.0),
            extruder_clearance_height_to_rod: Some(25.5),
            extruder_clearance_height_to_lid: None,
        };
        let snap = ledger.set_printer_extruder_clearance(&ids[0], set).unwrap();
        let p = snap.printers.iter().find(|p| p.id == ids[0]).unwrap();
        assert_eq!(p.extruder_clearance, set);
        // The slicer's names, at the top level of the printer in JSON.
        let v = serde_json::to_value(p).unwrap();
        assert_eq!(v["extruder_clearance_radius"], 40.0);
        assert_eq!(v["extruder_clearance_dist_to_rod"], 0.0);
        assert_eq!(v["extruder_clearance_height_to_rod"], 25.5);
        assert!(v["extruder_clearance_height_to_lid"].is_null());
        assert!(v.get("extruder_clearance").is_none());
        // Range: 0–2000 or empty.
        for bad in [-1.0, 2000.5, f64::NAN] {
            let c = ExtruderClearance {
                extruder_clearance_height_to_lid: Some(bad),
                ..Default::default()
            };
            assert!(ledger.set_printer_extruder_clearance(&ids[0], c).is_err());
        }
        assert_eq!(
            fields(&ledger, &ids[0]),
            set,
            "a rejected save changes nothing"
        );
        assert!(ledger
            .set_printer_extruder_clearance("prn-nope", ExtruderClearance::default())
            .is_err());
        // Clearing.
        ledger
            .set_printer_extruder_clearance(&ids[0], ExtruderClearance::default())
            .unwrap();
        assert_eq!(fields(&ledger, &ids[0]), ExtruderClearance::default());
    }

    #[test]
    fn effective_clearance_prefers_printer_then_plate_then_default() {
        let (mut ledger, ids) = ledger_and_printers();
        let pid = ids[0].clone();
        // Nothing set: plate defaults; no fallback for rod distance or lid.
        assert_eq!(
            ledger.printer_effective_clearance(&pid).unwrap().unwrap(),
            EffectiveClearance {
                radius: 35.0,
                height_to_rod: 30.0,
                dist_to_rod: None,
                height_to_lid: None
            }
        );
        // Plate view values.
        let mut s = ledger.get_settings().unwrap();
        s.printer_plate.insert(
            pid.clone(),
            json!({ "spacing_mm": 5, "clearance_radius_mm": 42, "clearance_height_mm": 28 }),
        );
        ledger.save_settings(s).unwrap();
        let e = ledger.printer_effective_clearance(&pid).unwrap().unwrap();
        assert_eq!((e.radius, e.height_to_rod), (42.0, 28.0));
        // Printer fields win.
        ledger
            .set_printer_extruder_clearance(
                &pid,
                ExtruderClearance {
                    extruder_clearance_radius: Some(57.0),
                    extruder_clearance_height_to_lid: Some(90.0),
                    ..Default::default()
                },
            )
            .unwrap();
        let e = ledger.printer_effective_clearance(&pid).unwrap().unwrap();
        assert_eq!(
            e,
            EffectiveClearance {
                radius: 57.0,
                height_to_rod: 28.0,
                dist_to_rod: None,
                height_to_lid: Some(90.0)
            }
        );
        assert!(ledger
            .printer_effective_clearance("prn-nope")
            .unwrap()
            .is_none());
        // The pure helper, with a junk plate entry.
        let p = ledger
            .snapshot()
            .unwrap()
            .printers
            .into_iter()
            .find(|p| p.id == pid)
            .unwrap();
        let junk = json!({ "clearance_radius_mm": "wide", "clearance_height_mm": -4 });
        let e = effective_extruder_clearance(&p, Some(&junk));
        assert_eq!((e.radius, e.height_to_rod), (57.0, 30.0));
    }

    /// A v0.9.32 database: no clearance columns, plate view clearance in `printer_plate`.
    #[test]
    fn upgrade_copies_changed_plate_clearance_once() {
        let (mut ledger, ids) = ledger_and_printers();
        assert!(ids.len() >= 3);
        let mut s = ledger.get_settings().unwrap();
        let plate = |r: f64, h: f64| json!({ "spacing_mm": 5, "sequence": "by_object", "clearance_radius_mm": r, "clearance_height_mm": h });
        s.printer_plate.insert(ids[0].clone(), plate(40.0, 30.0)); // radius changed only
        s.printer_plate.insert(ids[1].clone(), plate(35.0, 50.0)); // height changed only
        s.printer_plate.insert(ids[2].clone(), plate(35.0, 30.0)); // defaults: nothing copied
        s.printer_plate.insert("prn-gone".into(), plate(60.0, 60.0)); // no such printer
        ledger.save_settings(s).unwrap();
        let plates_before = ledger.get_settings().unwrap().printer_plate;
        let printers_before = ledger.snapshot().unwrap().printers.len();
        ledger
            .conn
            .execute_batch(&format!(
                "DELETE FROM shop_settings WHERE key = '{COPIED_KEY}';
                 ALTER TABLE printers DROP COLUMN extruder_clearance_radius;
                 ALTER TABLE printers DROP COLUMN extruder_clearance_dist_to_rod;
                 ALTER TABLE printers DROP COLUMN extruder_clearance_height_to_rod;
                 ALTER TABLE printers DROP COLUMN extruder_clearance_height_to_lid;"
            ))
            .unwrap();

        seed::init_schema(&ledger.conn).unwrap();
        let e = |r: Option<f64>, h: Option<f64>| ExtruderClearance {
            extruder_clearance_radius: r,
            extruder_clearance_height_to_rod: h,
            ..Default::default()
        };
        assert_eq!(fields(&ledger, &ids[0]), e(Some(40.0), None));
        assert_eq!(fields(&ledger, &ids[1]), e(None, Some(50.0)));
        assert_eq!(fields(&ledger, &ids[2]), e(None, None));
        assert_eq!(
            ledger.get_settings().unwrap().printer_plate,
            plates_before,
            "printer_plate is kept"
        );
        assert_eq!(ledger.snapshot().unwrap().printers.len(), printers_before);

        // Only once: a field the user clears later is not filled again.
        ledger
            .set_printer_extruder_clearance(&ids[0], ExtruderClearance::default())
            .unwrap();
        seed::init_schema(&ledger.conn).unwrap();
        assert_eq!(fields(&ledger, &ids[0]), ExtruderClearance::default());
    }

    #[test]
    fn upgrade_never_overwrites_a_field_already_set() {
        let (mut ledger, ids) = ledger_and_printers();
        ledger
            .set_printer_extruder_clearance(
                &ids[0],
                ExtruderClearance {
                    extruder_clearance_radius: Some(20.0),
                    ..Default::default()
                },
            )
            .unwrap();
        let mut s = ledger.get_settings().unwrap();
        s.printer_plate.insert(
            ids[0].clone(),
            json!({ "clearance_radius_mm": 45, "clearance_height_mm": 33 }),
        );
        ledger.save_settings(s).unwrap();
        ledger
            .conn
            .execute(
                "DELETE FROM shop_settings WHERE key = ?1",
                params![COPIED_KEY],
            )
            .unwrap();
        seed::init_schema(&ledger.conn).unwrap();
        let f = fields(&ledger, &ids[0]);
        assert_eq!(f.extruder_clearance_radius, Some(20.0));
        assert_eq!(f.extruder_clearance_height_to_rod, Some(33.0));
    }
}
