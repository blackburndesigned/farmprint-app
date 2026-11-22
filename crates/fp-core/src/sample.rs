//! "Load sample shop": a made-up demo shop that lets a new user explore FarmPrint before
//! adding their own products. Everything here is generic and fictional (no real people,
//! products or shops), and every row it writes has an id starting with [`SAMPLE_ID_PREFIX`],
//! so "Clear sample data" removes exactly these rows and nothing the user made.
//!
//! Loading is refused once the shop has any order or product, so it can never mix into or
//! overwrite real data. Schema unchanged (3); plain inserts plus normal unit transitions,
//! so the Flow history looks like real use.

use crate::models::{CoreError, CoreResult, ShopSnapshot, TransitionRequest};
use crate::{backup_database, ShopLedger, RESET_BACKUPS_KEPT};
use chrono::{Duration, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// Id prefix of every sample row (filaments, products, parts, printers, orders, lines, units).
pub const SAMPLE_ID_PREFIX: &str = "sample-";

/// Sample product ids. The desktop app ships a generic picture set for each of these.
pub const SAMPLE_PRODUCT_IDS: [&str; 6] = [
    "sample-flexi-dragon",
    "sample-planter",
    "sample-cable-organizer",
    "sample-headphone-stand",
    "sample-desk-tray",
    "sample-keychain",
];

const ACTOR: &str = "FarmPrint";
const SURFACE: &str = "Sample shop";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SampleShopStatus {
    /// The shop has no orders and no products, so a sample shop can be loaded.
    pub can_load: bool,
    /// Sample rows are present (offer "Clear sample data").
    pub has_sample: bool,
    /// Orders the user created themselves (not sample orders).
    pub own_orders: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SampleClearOutcome {
    pub removed_orders: i64,
    /// Sample products kept because one of the user's own orders still uses them.
    pub kept_products: Vec<String>,
}

// (id, name, brand, material, hex, cost_per_kg, grams_remaining)
const FILAMENTS: [(&str, &str, &str, &str, &str, f64, f64); 7] = [
    (
        "sample-fil-black",
        "Matte Black",
        "Sample Filament Co.",
        "PLA",
        "#2B2B2E",
        20.0,
        820.0,
    ),
    (
        "sample-fil-white",
        "Ivory White",
        "Sample Filament Co.",
        "PLA",
        "#F1EDE4",
        20.0,
        640.0,
    ),
    (
        "sample-fil-blue",
        "Ocean Blue",
        "Sample Filament Co.",
        "PLA",
        "#2F6DB5",
        22.0,
        910.0,
    ),
    (
        "sample-fil-green",
        "Forest Green",
        "Sample Filament Co.",
        "PLA",
        "#3E8E5A",
        22.0,
        455.0,
    ),
    (
        "sample-fil-orange",
        "Sunset Orange",
        "Sample Filament Co.",
        "PLA",
        "#F08A24",
        22.0,
        730.0,
    ),
    (
        "sample-fil-red",
        "Signal Red",
        "Sample Filament Co.",
        "PETG",
        "#D2403A",
        24.0,
        980.0,
    ),
    (
        "sample-fil-lavender",
        "Lavender",
        "Sample Filament Co.",
        "PLA",
        "#A78BDA",
        24.0,
        300.0,
    ),
];

// (id, name, sku, price_cents, packed_weight_oz, box, box_cost_cents)
const PRODUCTS: [(&str, &str, &str, i64, f64, &str, i64); 6] = [
    (
        "sample-flexi-dragon",
        "Flexi Dragon",
        "SAMPLE-DRAGON",
        1800,
        4.0,
        "Small",
        80,
    ),
    (
        "sample-planter",
        "Planter with Drip Tray",
        "SAMPLE-PLANTER",
        2200,
        9.0,
        "Medium",
        120,
    ),
    (
        "sample-cable-organizer",
        "Cable Organizer",
        "SAMPLE-CABLE",
        900,
        2.0,
        "Small",
        60,
    ),
    (
        "sample-headphone-stand",
        "Headphone Stand",
        "SAMPLE-HPSTAND",
        2600,
        12.0,
        "Medium",
        120,
    ),
    (
        "sample-desk-tray",
        "Desk Tray",
        "SAMPLE-TRAY",
        2000,
        10.0,
        "Medium",
        120,
    ),
    (
        "sample-keychain",
        "Mountain Keychain",
        "SAMPLE-KEY",
        600,
        0.5,
        "Small",
        40,
    ),
];

/// (id, product_id, name, default_filament, grams, print_minutes, sort_order, picture/mesh stem)
type SamplePart = (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    f64,
    i64,
    i64,
    &'static str,
);

const PARTS: [SamplePart; 15] = [
    (
        "sample-part-dragon-body",
        "sample-flexi-dragon",
        "Body",
        "sample-fil-green",
        38.0,
        150,
        1,
        "body",
    ),
    (
        "sample-part-dragon-wings",
        "sample-flexi-dragon",
        "Wings",
        "sample-fil-lavender",
        12.0,
        45,
        2,
        "wings",
    ),
    (
        "sample-part-dragon-head",
        "sample-flexi-dragon",
        "Head",
        "sample-fil-orange",
        9.0,
        35,
        3,
        "head",
    ),
    (
        "sample-part-planter-tray",
        "sample-planter",
        "Drip Tray",
        "sample-fil-white",
        30.0,
        70,
        1,
        "drip_tray",
    ),
    (
        "sample-part-planter-pot",
        "sample-planter",
        "Pot",
        "sample-fil-green",
        85.0,
        210,
        2,
        "pot",
    ),
    (
        "sample-part-cable-pad",
        "sample-cable-organizer",
        "Grip Pad",
        "sample-fil-black",
        3.0,
        10,
        1,
        "grip_pad",
    ),
    (
        "sample-part-cable-base",
        "sample-cable-organizer",
        "Base",
        "sample-fil-blue",
        32.0,
        85,
        2,
        "base",
    ),
    (
        "sample-part-hp-base",
        "sample-headphone-stand",
        "Base",
        "sample-fil-black",
        70.0,
        160,
        1,
        "base",
    ),
    (
        "sample-part-hp-post",
        "sample-headphone-stand",
        "Post",
        "sample-fil-white",
        40.0,
        95,
        2,
        "post",
    ),
    (
        "sample-part-hp-hanger",
        "sample-headphone-stand",
        "Hanger",
        "sample-fil-red",
        35.0,
        90,
        3,
        "hanger",
    ),
    (
        "sample-part-desk-tray",
        "sample-desk-tray",
        "Tray",
        "sample-fil-white",
        95.0,
        220,
        1,
        "tray",
    ),
    (
        "sample-part-desk-dividers",
        "sample-desk-tray",
        "Dividers",
        "sample-fil-orange",
        18.0,
        45,
        2,
        "dividers",
    ),
    (
        "sample-part-key-tag",
        "sample-keychain",
        "Tag",
        "sample-fil-blue",
        6.0,
        18,
        1,
        "tag",
    ),
    (
        "sample-part-key-inlay",
        "sample-keychain",
        "Inlay",
        "sample-fil-white",
        1.0,
        6,
        2,
        "inlay",
    ),
    (
        "sample-part-key-ring",
        "sample-keychain",
        "Split Ring",
        "sample-fil-black",
        1.0,
        5,
        3,
        "ring",
    ),
];

// (id, name, model, loaded filaments)
const PRINTERS: [(&str, &str, &str, &[&str]); 4] = [
    (
        "sample-prn-1",
        "Printer 1",
        "Generic FDM 256",
        &["sample-fil-black", "sample-fil-white"],
    ),
    (
        "sample-prn-2",
        "Printer 2",
        "Generic FDM 256",
        &["sample-fil-green"],
    ),
    (
        "sample-prn-3",
        "Printer 3",
        "Generic FDM 256",
        &[
            "sample-fil-blue",
            "sample-fil-orange",
            "sample-fil-red",
            "sample-fil-white",
        ],
    ),
    ("sample-prn-4", "Printer 4", "Generic FDM 256", &[]),
];

/// Where a sample unit ends up. Units start Queued and are moved with normal transitions.
#[derive(Clone, Copy)]
enum Goal {
    Queued,
    Staged(&'static str),
    Printing(&'static str),
    Printed,
    PostProcessing,
    Ready,
    Shipped,
    /// Printed once, failed, and back in the queue (shows a reprint and a failure in Flow).
    FailedOnce(&'static str),
}

struct SampleLine {
    product: &'static str,
    /// (part name, filament id override, goal); parts not listed use the default color and `rest`.
    parts: &'static [(&'static str, Option<&'static str>, Goal)],
    rest: Goal,
}

struct SampleOrder {
    n: u32,
    customer: &'static str,
    days_ago: i64,
    rush: bool,
    hold: bool,
    notes: &'static str,
    tracking: Option<&'static str>,
    lines: &'static [SampleLine],
}

const fn line(product: &'static str, rest: Goal) -> SampleLine {
    SampleLine {
        product,
        parts: &[],
        rest,
    }
}

const ORDERS: &[SampleOrder] = &[
    SampleOrder {
        n: 1001,
        customer: "Maya R.",
        days_ago: 0,
        rush: true,
        hold: false,
        notes: "",
        tracking: None,
        lines: &[
            line("sample-flexi-dragon", Goal::Queued),
            SampleLine {
                product: "sample-keychain",
                parts: &[("Tag", Some("sample-fil-green"), Goal::Queued)],
                rest: Goal::Queued,
            },
        ],
    },
    SampleOrder {
        n: 1002,
        customer: "Daniel K.",
        days_ago: 1,
        rush: false,
        hold: false,
        notes: "",
        tracking: None,
        lines: &[
            SampleLine {
                product: "sample-keychain",
                parts: &[("Tag", None, Goal::Printing("sample-prn-3"))],
                rest: Goal::Staged("sample-prn-1"),
            },
            SampleLine {
                product: "sample-keychain",
                parts: &[(
                    "Tag",
                    Some("sample-fil-orange"),
                    Goal::Printing("sample-prn-3"),
                )],
                rest: Goal::Staged("sample-prn-1"),
            },
            SampleLine {
                product: "sample-keychain",
                parts: &[(
                    "Tag",
                    Some("sample-fil-red"),
                    Goal::Printing("sample-prn-3"),
                )],
                rest: Goal::Staged("sample-prn-1"),
            },
        ],
    },
    SampleOrder {
        n: 1003,
        customer: "Priya S.",
        days_ago: 1,
        rush: false,
        hold: false,
        notes: "",
        tracking: None,
        lines: &[SampleLine {
            product: "sample-planter",
            parts: &[
                ("Pot", None, Goal::Printing("sample-prn-2")),
                ("Drip Tray", None, Goal::Printed),
            ],
            rest: Goal::Queued,
        }],
    },
    SampleOrder {
        n: 1004,
        customer: "Marcus T.",
        days_ago: 2,
        rush: false,
        hold: false,
        notes: "",
        tracking: None,
        lines: &[SampleLine {
            product: "sample-headphone-stand",
            parts: &[
                ("Base", None, Goal::Printed),
                ("Post", None, Goal::Printed),
                ("Hanger", None, Goal::FailedOnce("sample-prn-3")),
            ],
            rest: Goal::Queued,
        }],
    },
    SampleOrder {
        n: 1005,
        customer: "Elena V.",
        days_ago: 3,
        rush: false,
        hold: false,
        notes: "",
        tracking: None,
        lines: &[SampleLine {
            product: "sample-flexi-dragon",
            parts: &[
                ("Body", Some("sample-fil-lavender"), Goal::PostProcessing),
                ("Wings", Some("sample-fil-blue"), Goal::PostProcessing),
                ("Head", Some("sample-fil-lavender"), Goal::PostProcessing),
            ],
            rest: Goal::PostProcessing,
        }],
    },
    SampleOrder {
        n: 1006,
        customer: "Owen B.",
        days_ago: 4,
        rush: false,
        hold: false,
        notes: "",
        tracking: None,
        lines: &[
            SampleLine {
                product: "sample-desk-tray",
                parts: &[("Tray", Some("sample-fil-black"), Goal::Ready)],
                rest: Goal::Ready,
            },
            line("sample-cable-organizer", Goal::Ready),
        ],
    },
    SampleOrder {
        n: 1007,
        customer: "Sofia M.",
        days_ago: 5,
        rush: false,
        hold: true,
        notes: "Waiting on the customer's pot color.",
        tracking: None,
        lines: &[line("sample-planter", Goal::Queued)],
    },
    SampleOrder {
        n: 1008,
        customer: "Jamal W.",
        days_ago: 9,
        rush: false,
        hold: false,
        notes: "",
        tracking: Some("SAMPLE-TRACKING-1008"),
        lines: &[
            line("sample-headphone-stand", Goal::Shipped),
            line("sample-keychain", Goal::Shipped),
        ],
    },
];

fn count(conn: &rusqlite::Connection, sql: &str) -> CoreResult<i64> {
    Ok(conn.query_row(sql, [], |r| r.get(0))?)
}

impl ShopLedger {
    /// Whether "Load sample shop" / "Clear sample data" apply right now.
    pub fn sample_shop_status(&self) -> CoreResult<SampleShopStatus> {
        let orders = count(&self.conn, "SELECT COUNT(*) FROM orders")?;
        let products = count(&self.conn, "SELECT COUNT(*) FROM products")?;
        let own_orders = count(
            &self.conn,
            "SELECT COUNT(*) FROM orders WHERE id NOT GLOB 'sample-*'",
        )?;
        let sample_rows = count(
            &self.conn,
            "SELECT (SELECT COUNT(*) FROM orders WHERE id GLOB 'sample-*')
                  + (SELECT COUNT(*) FROM products WHERE id GLOB 'sample-*')
                  + (SELECT COUNT(*) FROM printers WHERE id GLOB 'sample-*')
                  + (SELECT COUNT(*) FROM filaments WHERE id GLOB 'sample-*')",
        )?;
        Ok(SampleShopStatus {
            can_load: orders == 0 && products == 0,
            has_sample: sample_rows > 0,
            own_orders,
        })
    }

    /// Fills an empty shop with the generic sample shop. Refuses when the shop already has
    /// any order or product. Backs up an on-disk database first.
    pub fn load_sample_shop(&mut self) -> CoreResult<ShopSnapshot> {
        if !self.sample_shop_status()?.can_load {
            return Err(CoreError::Validation(
                "The sample shop can only be loaded into an empty shop (no orders or products)."
                    .into(),
            ));
        }
        if let Some(path) = self.db_path.clone() {
            backup_database(&self.conn, &path, "reset-", RESET_BACKUPS_KEPT).map_err(|e| {
                CoreError::Validation(format!("Sample shop not loaded, backup failed: {e}"))
            })?;
        }
        let now = Utc::now();
        let ts = |days: i64, mins: i64| {
            (now - Duration::days(days) - Duration::minutes(mins))
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string()
        };
        let mut work: Vec<(String, Goal)> = Vec::new();
        {
            let tx = self.conn.transaction()?;
            for (id, name, brand, mat, hex, cost, grams) in FILAMENTS {
                tx.execute(
                    "INSERT INTO filaments (id, name, brand, material, hex, cost_per_kg, grams_remaining) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![id, name, brand, mat, hex, cost, grams],
                )?;
            }
            for (id, name, sku, price, oz, box_name, box_cost) in PRODUCTS {
                tx.execute(
                    "INSERT INTO products (id, name, sku, price_cents, packed_weight_oz, default_box_name, box_cost_cents, supports_custom_text) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
                    params![id, name, sku, price, oz, box_name, box_cost],
                )?;
            }
            for (id, pid, name, fil, grams, mins, sort, stem) in PARTS {
                let cost_per_kg = FILAMENTS
                    .iter()
                    .find(|f| f.0 == fil)
                    .map(|f| f.5)
                    .unwrap_or(20.0);
                let unit_cost = (grams * cost_per_kg / 1000.0 * 100.0).round() / 100.0;
                tx.execute(
                    "INSERT INTO catalog_parts (id, product_id, name, is_tracked, is_color_only, default_filament_id, grams, print_minutes, unit_cost, mesh_file, sort_order) VALUES (?1, ?2, ?3, 1, 0, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![id, pid, name, fil, grams, mins, unit_cost, format!("{stem}.png"), sort],
                )?;
            }
            for (id, name, model, slots) in PRINTERS {
                tx.execute(
                    "INSERT INTO printers (id, name, model, nozzle_mm, status, utilization_pct, bed_x_mm, bed_y_mm) VALUES (?1, ?2, ?3, 0.4, 'Idle', 0.0, 256.0, 256.0)",
                    params![id, name, model],
                )?;
                for (i, fil) in slots.iter().enumerate() {
                    tx.execute(
                        "INSERT INTO printer_slots (printer_id, slot_index, filament_id) VALUES (?1, ?2, ?3)",
                        params![id, i as i64 + 1, fil],
                    )?;
                }
            }
            for o in ORDERS {
                let oid = format!("sample-ord-{}", o.n);
                let created = ts(o.days_ago, (o.n % 7) as i64 * 37);
                tx.execute(
                    "INSERT INTO orders (id, order_code, customer_name, customer_email, source, is_rush, is_on_hold, notes, shipping_charged_cents, shipping_cost_cents, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'manual', ?5, ?6, ?7, 0, 0, ?8, ?8)",
                    params![
                        oid,
                        format!("SAMPLE-{}", o.n),
                        o.customer,
                        format!("{}@example.com", o.customer.to_ascii_lowercase().replace('.', "").replace(' ', ".")),
                        o.rush as i64,
                        o.hold as i64,
                        o.notes,
                        created
                    ],
                )?;
                let mut copies: std::collections::HashMap<&str, i64> =
                    std::collections::HashMap::new();
                for (li, l) in o.lines.iter().enumerate() {
                    let (_, pname, _, price, ..) = PRODUCTS
                        .iter()
                        .find(|p| p.0 == l.product)
                        .copied()
                        .expect("sample product");
                    let copy = copies.entry(l.product).or_insert(0);
                    *copy += 1;
                    let lid = format!("sample-line-{}-{}", o.n, li + 1);
                    tx.execute(
                        "INSERT INTO order_lines (id, order_id, product_id, item_label, quantity, unit_price_cents, custom_text) VALUES (?1, ?2, ?3, ?4, 1, ?5, NULL)",
                        params![lid, oid, l.product, format!("{pname} #{copy}"), price],
                    )?;
                    for (part_id, _, part_name, default_fil, ..) in
                        PARTS.iter().filter(|p| p.1 == l.product)
                    {
                        let hit = l.parts.iter().find(|(n, ..)| n == part_name);
                        let fil = hit.and_then(|h| h.1).unwrap_or(default_fil);
                        let goal = hit.map(|h| h.2).unwrap_or(l.rest);
                        let uid = format!(
                            "sample-unit-{}-{}-{}",
                            o.n,
                            li + 1,
                            part_id.trim_start_matches("sample-part-")
                        );
                        tx.execute(
                            "INSERT INTO part_units (id, order_id, line_id, product_id, part_id, unit_index, filament_id, state, printer_id, plate_job_id, reprint_count, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 'Queued', NULL, NULL, 0, ?7)",
                            params![uid, oid, lid, l.product, part_id, fil, created],
                        )?;
                        work.push((uid, goal));
                    }
                }
            }
            tx.commit()?;
        }

        // Move units the way the floor would, so Flow and the boards show real history.
        let step = |ledger: &mut ShopLedger,
                    ids: Vec<String>,
                    to: &str,
                    printer: Option<&str>,
                    fail: Option<&str>|
         -> CoreResult<()> {
            if ids.is_empty() {
                return Ok(());
            }
            ledger.transition_units(TransitionRequest {
                unit_ids: ids,
                to_state: to.to_string(),
                printer_id: printer.map(str::to_string),
                actor_device: ACTOR.to_string(),
                source_surface: SURFACE.to_string(),
                action_label: match fail {
                    Some(_) => "Sample: print failed, back in queue".to_string(),
                    None => format!("Sample: moved to {to}"),
                },
                failure_reason: fail.map(str::to_string),
                failure_note: None,
                filament_id: None,
            })?;
            Ok(())
        };
        let pick = |f: &dyn Fn(Goal) -> bool| -> Vec<String> {
            work.iter()
                .filter(|(_, g)| f(*g))
                .map(|(id, _)| id.clone())
                .collect()
        };
        for (pid, ..) in PRINTERS {
            let staged = pick(&|g| matches!(g, Goal::Staged(p) if p == pid));
            step(self, staged, "Staged", Some(pid), None)?;
            let printing = pick(&|g| {
                matches!(g, Goal::Printing(p) | Goal::FailedOnce(p) if p == pid)
                    || matches!(g, Goal::Printed | Goal::PostProcessing | Goal::Ready | Goal::Shipped if pid == "sample-prn-1")
            });
            step(self, printing, "Printing", Some(pid), None)?;
        }
        let failed = pick(&|g| matches!(g, Goal::FailedOnce(_)));
        step(
            self,
            failed,
            "Queued",
            None,
            Some("Spaghetti / detached from bed"),
        )?;
        let printed = pick(&|g| {
            matches!(
                g,
                Goal::Printed | Goal::PostProcessing | Goal::Ready | Goal::Shipped
            )
        });
        step(self, printed, "Printed", None, None)?;
        let post = pick(&|g| matches!(g, Goal::PostProcessing | Goal::Ready | Goal::Shipped));
        step(self, post, "Post-Processing", None, None)?;
        let ready = pick(&|g| matches!(g, Goal::Ready | Goal::Shipped));
        step(self, ready, "Ready", None, None)?;
        for o in ORDERS.iter().filter(|o| o.tracking.is_some()) {
            let oid = format!("sample-ord-{}", o.n);
            self.conn.execute(
                "UPDATE orders SET tracking_number = ?1 WHERE id = ?2",
                params![o.tracking, oid],
            )?;
            let prefix = format!("sample-unit-{}-", o.n);
            let ids = pick(&|g| matches!(g, Goal::Shipped))
                .into_iter()
                .filter(|id| id.starts_with(&prefix))
                .collect();
            step(self, ids, "Shipped", None, None)?;
        }
        // Spread the history over the orders' ages and keep each order's own date.
        for o in ORDERS {
            let oid = format!("sample-ord-{}", o.n);
            let created = ts(o.days_ago, (o.n % 7) as i64 * 37);
            let updated = ts(o.days_ago.saturating_sub(1), 5);
            self.conn.execute(
                "UPDATE orders SET created_at = ?1, updated_at = ?2 WHERE id = ?3",
                params![created, updated, oid],
            )?;
            self.conn.execute(
                "UPDATE flow_events SET created_at = ?1 WHERE order_id = ?2",
                params![updated, oid],
            )?;
        }
        self.snapshot()
    }

    /// Removes the sample shop: every sample order with its lines, units and history, and
    /// the sample catalog, filaments and printers. Sample products, filaments or printers
    /// still used by the user's own orders are kept (and reported). Never touches rows
    /// the user created. Backs up an on-disk database first.
    pub fn clear_sample_data(&mut self) -> CoreResult<(ShopSnapshot, SampleClearOutcome)> {
        if let Some(path) = self.db_path.clone() {
            backup_database(&self.conn, &path, "reset-", RESET_BACKUPS_KEPT).map_err(|e| {
                CoreError::Validation(format!("Sample data not cleared, backup failed: {e}"))
            })?;
        }
        let tx = self.conn.transaction()?;
        let removed_orders: i64 = tx.query_row(
            "SELECT COUNT(*) FROM orders WHERE id GLOB 'sample-*'",
            [],
            |r| r.get(0),
        )?;
        tx.execute_batch(
            "
            DELETE FROM flow_events WHERE order_id GLOB 'sample-*';
            DELETE FROM part_units WHERE order_id GLOB 'sample-*';
            DELETE FROM order_lines WHERE order_id GLOB 'sample-*';
            DELETE FROM orders WHERE id GLOB 'sample-*';
            DELETE FROM overstock WHERE id GLOB 'sample-*';
            ",
        )?;
        // Products still used by the user's own order lines or overstock stay.
        let kept_products: Vec<String> = {
            let mut st = tx.prepare(
                "SELECT name FROM products p WHERE p.id GLOB 'sample-*' AND (
                    EXISTS (SELECT 1 FROM order_lines l WHERE l.product_id = p.id)
                    OR EXISTS (SELECT 1 FROM part_units u WHERE u.product_id = p.id)
                    OR EXISTS (SELECT 1 FROM overstock s WHERE s.product_id = p.id))
                 ORDER BY name",
            )?;
            let rows = st
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        tx.execute_batch(
            "
            DELETE FROM catalog_parts WHERE id GLOB 'sample-*' AND product_id GLOB 'sample-*'
              AND product_id NOT IN (SELECT product_id FROM order_lines)
              AND product_id NOT IN (SELECT product_id FROM part_units)
              AND product_id NOT IN (SELECT product_id FROM overstock);
            DELETE FROM products WHERE id GLOB 'sample-*'
              AND id NOT IN (SELECT product_id FROM order_lines)
              AND id NOT IN (SELECT product_id FROM part_units)
              AND id NOT IN (SELECT product_id FROM overstock);
            DELETE FROM printer_slots WHERE printer_id GLOB 'sample-*'
              AND printer_id NOT IN (SELECT printer_id FROM part_units WHERE printer_id IS NOT NULL);
            DELETE FROM printers WHERE id GLOB 'sample-*'
              AND id NOT IN (SELECT printer_id FROM part_units WHERE printer_id IS NOT NULL);
            DELETE FROM filaments WHERE id GLOB 'sample-*'
              AND id NOT IN (SELECT filament_id FROM part_units)
              AND id NOT IN (SELECT default_filament_id FROM catalog_parts)
              AND id NOT IN (SELECT filament_id FROM printer_slots)
              AND id NOT IN (SELECT filament_id FROM overstock);
            ",
        )?;
        tx.commit()?;
        Ok((
            self.snapshot()?,
            SampleClearOutcome {
                removed_orders,
                kept_products,
            },
        ))
    }

    /// Sample product ids that no longer exist (their picture folders can be removed).
    pub fn removed_sample_product_ids(&self) -> CoreResult<Vec<&'static str>> {
        let mut out = Vec::new();
        for id in SAMPLE_PRODUCT_IDS {
            let n: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM products WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )?;
            if n == 0 {
                out.push(id);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An empty in-memory ledger (no demo seed), like a fresh install.
    fn empty() -> ShopLedger {
        let mut l = ShopLedger::open_in_memory().unwrap();
        l.conn
            .execute_batch(
                "DELETE FROM flow_events; DELETE FROM part_units; DELETE FROM order_lines; DELETE FROM orders;
                 DELETE FROM printer_slots; DELETE FROM printers; DELETE FROM catalog_parts; DELETE FROM products;
                 DELETE FROM filaments;",
            )
            .unwrap();
        assert!(l.sample_shop_status().unwrap().can_load);
        let _ = &mut l;
        l
    }

    #[test]
    fn loads_orders_in_every_stage() {
        let mut l = empty();
        let snap = l.load_sample_shop().unwrap();
        assert_eq!(snap.orders.len(), ORDERS.len());
        assert_eq!(snap.products.len(), PRODUCTS.len());
        assert_eq!(snap.printers.len(), 4);
        let units: Vec<_> = snap
            .orders
            .iter()
            .flat_map(|o| o.lines.iter().flat_map(|l| l.units.iter()))
            .collect();
        let states: std::collections::HashSet<&str> =
            units.iter().map(|u| u.state.as_str()).collect();
        for s in [
            "Queued",
            "Staged",
            "Printing",
            "Printed",
            "Post-Processing",
            "Ready",
            "Shipped",
        ] {
            assert!(states.contains(s), "missing state {s}: {states:?}");
        }
        assert!(
            units.iter().any(|u| u.reprint_count == 1),
            "one failed print"
        );
        assert!(snap.orders.iter().any(|o| o.is_rush) && snap.orders.iter().any(|o| o.is_on_hold));
        // Printing/staged units sit on a printer.
        let busy: Vec<_> = units
            .iter()
            .filter(|u| u.state == "Printing" || u.state == "Staged")
            .collect();
        assert!(busy.len() >= 4);
        assert!(busy.iter().all(|u| u
            .printer_id
            .as_deref()
            .is_some_and(|p| p.starts_with(SAMPLE_ID_PREFIX))));
        let shipped = snap
            .orders
            .iter()
            .find(|o| o.id == "sample-ord-1008")
            .unwrap();
        assert_eq!(shipped.overall_state, "Shipped");
        let st = l.sample_shop_status().unwrap();
        assert!(!st.can_load && st.has_sample && st.own_orders == 0);
    }

    #[test]
    fn sample_data_is_generic() {
        let mut l = empty();
        let snap = l.load_sample_shop().unwrap();
        // Made-up customers: a first name and an initial, at example.com. Products are the
        // generic sample set.
        for o in &snap.orders {
            let (first, initial) = o
                .customer_name
                .split_once(' ')
                .expect("first name and initial");
            assert!(
                !first.is_empty() && initial.len() == 2 && initial.ends_with('.'),
                "{}",
                o.customer_name
            );
        }
        let mut names: Vec<&str> = snap.products.iter().map(|p| p.name.as_str()).collect();
        names.sort();
        assert_eq!(
            names,
            [
                "Cable Organizer",
                "Desk Tray",
                "Flexi Dragon",
                "Headphone Stand",
                "Mountain Keychain",
                "Planter with Drip Tray"
            ]
        );
        // Every part points at its shipped picture (and the STL beside it) so Print! works.
        for p in snap.products.iter().flat_map(|p| &p.parts) {
            assert!(p.mesh_file.ends_with(".png"), "{}", p.name);
        }
        assert!(snap
            .filaments
            .iter()
            .all(|f| f.brand == "Sample Filament Co."));
        for o in &snap.orders {
            assert!(o.customer_email.ends_with("@example.com"));
        }
    }

    #[test]
    fn refuses_to_load_into_a_shop_with_data() {
        let mut l = ShopLedger::open_in_memory().unwrap(); // generic test seed has products and orders
        let before = l.snapshot().unwrap().orders.len();
        assert!(!l.sample_shop_status().unwrap().can_load);
        assert!(l.load_sample_shop().is_err());
        assert_eq!(l.snapshot().unwrap().orders.len(), before);
    }

    #[test]
    fn clear_removes_only_sample_rows() {
        let mut l = empty();
        l.load_sample_shop().unwrap();
        // The user adds their own filament and printer while exploring.
        l.conn
            .execute(
                "INSERT INTO filaments (id, name, brand, material, hex, cost_per_kg, grams_remaining) VALUES ('fil-own', 'Mine', 'B', 'PLA', '#123456', 20, 1000)",
                [],
            )
            .unwrap();
        let (snap, out) = l.clear_sample_data().unwrap();
        assert_eq!(out.removed_orders, ORDERS.len() as i64);
        assert!(out.kept_products.is_empty());
        assert!(snap.orders.is_empty() && snap.products.is_empty() && snap.printers.is_empty());
        assert_eq!(
            snap.filaments
                .iter()
                .map(|f| f.id.as_str())
                .collect::<Vec<_>>(),
            vec!["fil-own"]
        );
        let st = l.sample_shop_status().unwrap();
        assert!(st.can_load && !st.has_sample);
        assert_eq!(
            l.removed_sample_product_ids().unwrap().len(),
            PRODUCTS.len()
        );
    }

    #[test]
    fn clear_keeps_sample_products_used_by_own_orders() {
        let mut l = empty();
        l.load_sample_shop().unwrap();
        l.create_order(crate::CreateOrderInput {
            customer_name: "Own Order".into(),
            customer_email: "own@example.com".into(),
            product_id: "sample-cable-organizer".into(),
            quantity: 1,
            is_rush: false,
            custom_text: None,
        })
        .unwrap();
        assert_eq!(l.sample_shop_status().unwrap().own_orders, 1);
        let (snap, out) = l.clear_sample_data().unwrap();
        assert_eq!(out.kept_products, vec!["Cable Organizer".to_string()]);
        assert_eq!(snap.orders.len(), 1);
        assert_eq!(snap.orders[0].customer_name, "Own Order");
        assert_eq!(snap.products.len(), 1);
        assert!(!snap.orders[0].lines[0].units.is_empty());
    }
}
