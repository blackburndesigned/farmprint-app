use crate::models::CoreResult;
use rusqlite::{params, Connection};

/// Additive column migration (schema version unchanged): adds nullable columns
/// that older databases lack. Safe to run on every open.
fn add_missing_columns(conn: &Connection, table: &str, cols: &[(&str, &str)]) -> CoreResult<()> {
    let existing: Vec<String> = {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let names = stmt
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        names
    };
    for (name, decl) in cols {
        if !existing.iter().any(|c| c == name) {
            conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {name} {decl}"), [])?;
        }
    }
    Ok(())
}

pub const ORDER_SHIP_COLUMNS: [(&str, &str); 5] = [
    ("ship_status", "TEXT"),
    ("packed_at", "TEXT"),
    ("shipped_at", "TEXT"),
    ("tracking_number", "TEXT"),
    ("box_preset_id", "TEXT"),
];

/// Website order ingest (2026-11-18): nullable, additive. Schema version unchanged (3).
pub const ORDER_REMOTE_COLUMNS: [(&str, &str); 1] = [("remote_id", "TEXT")];
pub const ORDER_LINE_VIEW_COLUMNS: [(&str, &str); 1] = [("view_camera_json", "TEXT")];
/// Batch undo (2026-11-18): nullable, additive. Schema version unchanged (3).
/// `prev_*` hold the unit's values before the event, so Undo restores them exactly.
pub const FLOW_UNDO_COLUMNS: [(&str, &str); 6] = [
    ("batch_id", "TEXT"),
    ("undone_at", "TEXT"),
    ("prev_printer_id", "TEXT"),
    ("prev_filament_id", "TEXT"),
    ("prev_reprint_count", "INTEGER"),
    ("prev_plate_job_id", "TEXT"),
];

/// Printer bed size in mm (2026-11-18) and build height (2026-11-22): nullable,
/// additive. NULL = not set (plate building still uses only width and depth,
/// and keeps its 220 mm default when those are unset). Schema version unchanged (3).
pub const PRINTER_BED_COLUMNS: [(&str, &str); 3] = [
    ("bed_x_mm", "REAL"),
    ("bed_y_mm", "REAL"),
    ("bed_z_mm", "REAL"),
];

/// Filament vendor/source (2026-11-22): nullable, additive. Schema version unchanged (3).
/// Existing rows stay NULL and show as unspecified in the library.
pub const FILAMENT_VENDOR_COLUMNS: [(&str, &str); 1] = [("vendor", "TEXT")];

/// By-object extruder clearance per printer (2026-11-22), slicer parameter names, mm:
/// nullable, additive, empty by default. Schema version unchanged (3).
pub const PRINTER_CLEARANCE_COLUMNS: [(&str, &str); 4] = [
    ("extruder_clearance_radius", "REAL"),
    ("extruder_clearance_dist_to_rod", "REAL"),
    ("extruder_clearance_height_to_rod", "REAL"),
    ("extruder_clearance_height_to_lid", "REAL"),
];

/// Feeder nozzle for print areas (2026-11-22): nullable, additive. Schema version unchanged (3).
pub const FEEDER_NOZZLE_COLUMNS: [(&str, &str); 1] = [("nozzle", "TEXT")];

/// Optional ship-by date on orders (`YYYY-MM-DD`, 2026-11-25): nullable, additive.
/// Schema version unchanged (3).
pub const ORDER_SHIP_BY_COLUMNS: [(&str, &str); 1] = [("ship_by", "TEXT")];

/// `shop_settings` key holding when Insights tracking began (`InsightsTracking`).
pub const INSIGHTS_TRACKING_KEY: &str = "insights_tracking";

pub fn init_schema(conn: &Connection) -> CoreResult<()> {
    init_tables(conn)?;
    add_missing_columns(conn, "orders", &ORDER_SHIP_COLUMNS)?;
    add_missing_columns(conn, "orders", &ORDER_REMOTE_COLUMNS)?;
    add_missing_columns(conn, "order_lines", &ORDER_LINE_VIEW_COLUMNS)?;
    add_missing_columns(conn, "flow_events", &FLOW_UNDO_COLUMNS)?;
    add_missing_columns(conn, "printers", &PRINTER_BED_COLUMNS)?;
    add_missing_columns(conn, "printers", &PRINTER_CLEARANCE_COLUMNS)?;
    add_missing_columns(conn, "filaments", &FILAMENT_VENDOR_COLUMNS)?;
    add_missing_columns(conn, "orders", &ORDER_SHIP_BY_COLUMNS)?;
    // Printer status history (2026-11-25): one row per status change, for Insights
    // utilization. Additive, local only. Schema version unchanged (3).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS printer_status_log (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            printer_id TEXT NOT NULL,
            status TEXT NOT NULL,
            changed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_printer_status_log_printer ON printer_status_log(printer_id, seq);",
    )?;
    // When ship-by dates and printer history started being kept ("Collecting since").
    conn.execute(
        "INSERT OR IGNORE INTO shop_settings (key, value_json) VALUES (?1, ?2)",
        rusqlite::params![
            INSIGHTS_TRACKING_KEY,
            serde_json::json!({ "since": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string() }).to_string()
        ],
    )?;
    // Lookup indexes (additive, schema version unchanged). Safe to run on every open.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);
         CREATE INDEX IF NOT EXISTS idx_part_units_order_line ON part_units(order_id, line_id);
         CREATE INDEX IF NOT EXISTS idx_part_units_line ON part_units(line_id);
         CREATE INDEX IF NOT EXISTS idx_catalog_parts_product ON catalog_parts(product_id);
         CREATE INDEX IF NOT EXISTS idx_flow_events_order_unit ON flow_events(order_id, unit_id);
         CREATE INDEX IF NOT EXISTS idx_flow_events_unit ON flow_events(unit_id);
         CREATE INDEX IF NOT EXISTS idx_flow_events_batch ON flow_events(batch_id);
         CREATE INDEX IF NOT EXISTS idx_overstock_product_part_filament ON overstock(product_id, part_id, filament_id);",
    )?;
    // Printer feeders (2026-11-22): additive, local only. Schema version unchanged (3).
    // A printer with no rows here reads as one default feeder holding its current slots,
    // so old databases need no data migration. Dry box spools live in
    // `printer_feeder_spools` and never take a printer slot number.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS printer_feeders (
            id TEXT PRIMARY KEY,
            printer_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
            slot_count INTEGER NOT NULL,
            is_dry_box INTEGER NOT NULL DEFAULT 0,
            note TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_printer_feeders_printer ON printer_feeders(printer_id, position);
        CREATE TABLE IF NOT EXISTS printer_feeder_spools (
            feeder_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            filament_id TEXT NOT NULL,
            PRIMARY KEY (feeder_id, position)
        );",
    )?;
    // Dual-nozzle print areas (2026-11-22): additive, local only. Schema version unchanged (3).
    // A feeder's `nozzle` is "left", "right" or NULL (not set); a printer with no
    // `printer_print_areas` rows uses its whole bed, exactly as before.
    add_missing_columns(conn, "printer_feeders", &FEEDER_NOZZLE_COLUMNS)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS printer_print_areas (
            id TEXT PRIMARY KEY,
            printer_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
            nozzle TEXT NOT NULL DEFAULT 'both',
            width_mm REAL NOT NULL,
            depth_mm REAL NOT NULL,
            height_mm REAL NOT NULL,
            x_mm REAL NOT NULL DEFAULT 0,
            y_mm REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_printer_print_areas_printer ON printer_print_areas(printer_id, position);",
    )?;
    // Local dedupe map for website ingest. Kept when the local order is deleted, so a
    // deleted website order is never re-imported (FarmPrint never writes back to the shop).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS imported_store_orders (
            remote_id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL,
            imported_at TEXT NOT NULL
        );",
    )?;
    // Plate view clearance -> printer fields, once (see `clearance::copy_plate_clearance_once`).
    crate::clearance::copy_plate_clearance_once(conn)?;
    Ok(())
}

fn init_tables(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS filaments (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            brand TEXT NOT NULL,
            material TEXT NOT NULL,
            hex TEXT NOT NULL,
            cost_per_kg REAL NOT NULL,
            grams_remaining REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sku TEXT NOT NULL,
            price_cents INTEGER NOT NULL,
            packed_weight_oz REAL NOT NULL,
            default_box_name TEXT NOT NULL,
            box_cost_cents INTEGER NOT NULL,
            supports_custom_text INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS catalog_parts (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            name TEXT NOT NULL,
            is_tracked INTEGER NOT NULL DEFAULT 1,
            is_color_only INTEGER NOT NULL DEFAULT 0,
            default_filament_id TEXT NOT NULL,
            grams REAL NOT NULL,
            print_minutes INTEGER NOT NULL,
            unit_cost REAL NOT NULL,
            mesh_file TEXT NOT NULL,
            sort_order INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS printers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            model TEXT NOT NULL,
            nozzle_mm REAL NOT NULL,
            status TEXT NOT NULL,
            utilization_pct REAL NOT NULL DEFAULT 0.0
        );

        CREATE TABLE IF NOT EXISTS printer_slots (
            printer_id TEXT NOT NULL,
            slot_index INTEGER NOT NULL,
            filament_id TEXT NOT NULL,
            PRIMARY KEY (printer_id, slot_index)
        );

        CREATE TABLE IF NOT EXISTS orders (
            id TEXT PRIMARY KEY,
            order_code TEXT NOT NULL,
            customer_name TEXT NOT NULL,
            customer_email TEXT NOT NULL,
            source TEXT NOT NULL,
            is_rush INTEGER NOT NULL DEFAULT 0,
            is_on_hold INTEGER NOT NULL DEFAULT 0,
            notes TEXT NOT NULL DEFAULT '',
            shipping_charged_cents INTEGER NOT NULL DEFAULT 0,
            shipping_cost_cents INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS order_lines (
            id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            item_label TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            unit_price_cents INTEGER NOT NULL,
            custom_text TEXT
        );

        CREATE TABLE IF NOT EXISTS part_units (
            id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL,
            line_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            part_id TEXT NOT NULL,
            unit_index INTEGER NOT NULL,
            filament_id TEXT NOT NULL,
            state TEXT NOT NULL,
            printer_id TEXT,
            plate_job_id TEXT,
            reprint_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS overstock (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            part_id TEXT NOT NULL,
            filament_id TEXT NOT NULL,
            quantity INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS flow_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            kind TEXT NOT NULL,
            order_id TEXT,
            order_code TEXT,
            customer_name TEXT,
            line_id TEXT,
            item_label TEXT,
            product_id TEXT,
            product_name TEXT,
            part_id TEXT,
            part_name TEXT,
            unit_id TEXT,
            filament_name TEXT NOT NULL,
            filament_hex TEXT NOT NULL,
            from_state TEXT,
            to_state TEXT NOT NULL,
            printer_id TEXT,
            printer_name TEXT,
            actor_device TEXT NOT NULL,
            source_surface TEXT NOT NULL,
            action_label TEXT NOT NULL,
            failure_reason TEXT,
            failure_note TEXT,
            cost_impact_cents INTEGER NOT NULL DEFAULT 0,
            can_undo INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS shop_settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
        );
        ",
    )?;
    Ok(())
}

/// Generic, made-up demo/test fixture. Loaded only by tests (`open_in_memory`) and
/// by dev builds with `FARMPRINT_DEMO_SEED=1`. Contains no real shop, customer or product data.
pub fn seed_if_empty(conn: &Connection) -> CoreResult<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM products", [], |r| r.get(0))?;
    if count > 0 {
        return Ok(());
    }

    let filaments = [
        (
            "fil-demo-red",
            "Red",
            "Demo Brand",
            "PLA",
            "#D9473F",
            20.0,
            900.0,
        ),
        (
            "fil-demo-blue",
            "Blue",
            "Demo Brand",
            "PLA",
            "#3F6FD9",
            20.0,
            850.0,
        ),
        (
            "fil-demo-white",
            "White",
            "Demo Brand",
            "PLA",
            "#F2F2F2",
            20.0,
            800.0,
        ),
        (
            "fil-demo-gray",
            "Gray",
            "Demo Brand",
            "PLA",
            "#808080",
            20.0,
            750.0,
        ),
    ];
    for (id, name, brand, mat, hex, cost, rem) in filaments {
        conn.execute(
            "INSERT INTO filaments (id, name, brand, material, hex, cost_per_kg, grams_remaining) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, name, brand, mat, hex, cost, rem],
        )?;
    }

    let products = [
        (
            "prod-demo-widget",
            "Widget",
            "DEMO-W",
            1000,
            2.0,
            "Small",
            100,
            0,
        ),
        (
            "prod-demo-gadget",
            "Gadget",
            "DEMO-G",
            500,
            1.0,
            "Small",
            100,
            0,
        ),
    ];
    for (id, name, sku, price, weight, box_name, box_cost, custom_txt) in products {
        conn.execute(
            "INSERT INTO products VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, name, sku, price, weight, box_name, box_cost, custom_txt],
        )?;
    }

    let parts = [
        (
            "part-demo-base",
            "prod-demo-widget",
            "Base",
            1,
            0,
            "fil-demo-red",
            10.0,
            20,
            0.2,
            "base.stl",
            0,
        ),
        (
            "part-demo-lid",
            "prod-demo-widget",
            "Lid",
            1,
            0,
            "fil-demo-blue",
            5.0,
            10,
            0.1,
            "lid.stl",
            1,
        ),
        (
            "part-demo-deco",
            "prod-demo-widget",
            "Decoration",
            0,
            1,
            "fil-demo-white",
            0.0,
            0,
            0.0,
            "deco.stl",
            2,
        ),
        (
            "part-demo-body",
            "prod-demo-gadget",
            "Body",
            1,
            0,
            "fil-demo-gray",
            8.0,
            16,
            0.15,
            "body.stl",
            0,
        ),
    ];
    for (id, pid, name, tracked, color_only, fil, g, mins, cost, mesh, ord) in parts {
        conn.execute(
            "INSERT INTO catalog_parts VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![id, pid, name, tracked, color_only, fil, g, mins, cost, mesh, ord],
        )?;
    }

    let printers = [
        (
            "prn-demo-1",
            "Printer 1",
            "Demo Printer",
            0.4,
            "Printing",
            50.0,
        ),
        ("prn-demo-2", "Printer 2", "Demo Printer", 0.4, "Idle", 0.0),
        ("prn-demo-3", "Printer 3", "Demo Printer", 0.4, "Idle", 0.0),
        ("prn-demo-4", "Printer 4", "Demo Printer", 0.4, "Idle", 0.0),
    ];
    for (id, name, model, nozzle, status, util) in printers {
        conn.execute(
            "INSERT INTO printers (id, name, model, nozzle_mm, status, utilization_pct) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, name, model, nozzle, status, util],
        )?;
    }
    for (pid, slot, fid) in [
        ("prn-demo-1", 1, "fil-demo-red"),
        ("prn-demo-1", 2, "fil-demo-blue"),
        ("prn-demo-2", 1, "fil-demo-white"),
    ] {
        conn.execute(
            "INSERT INTO printer_slots VALUES (?1, ?2, ?3)",
            params![pid, slot, fid],
        )?;
    }

    // Four made-up orders, one Widget line each. Shipping values are 0.
    let customers = ["Sam Example", "Alex Sample", "Jamie Test", "Riley Demo"];
    for (i, name) in customers.iter().enumerate() {
        let n = i + 1;
        let oid = format!("ord-demo-{n}");
        let lid = format!("line-demo-{n}");
        conn.execute(
            "INSERT INTO orders (id, order_code, customer_name, customer_email, source, is_rush, is_on_hold, notes, shipping_charged_cents, shipping_cost_cents, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'manual', 0, 0, '', 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            params![oid, format!("FP-DEMO-000{n}"), name, format!("customer{n}@example.com")],
        )?;
        conn.execute(
            "INSERT INTO order_lines (id, order_id, product_id, item_label, quantity, unit_price_cents, custom_text) VALUES (?1, ?2, 'prod-demo-widget', ?3, 1, 1000, NULL)",
            params![lid, oid, format!("Widget #{n}")],
        )?;
        for (part, fil) in [("base", "fil-demo-red"), ("lid", "fil-demo-blue")] {
            conn.execute(
                "INSERT INTO part_units VALUES (?1, ?2, ?3, 'prod-demo-widget', ?4, 1, ?5, 'Queued', NULL, NULL, 0, '2026-01-01T00:00:00Z')",
                params![format!("unit-demo-{n}-{part}"), oid, lid, format!("part-demo-{part}"), fil],
            )?;
        }
    }

    for n in 1..=5 {
        let o = ((n - 1) % 4) + 1;
        conn.execute(
            "INSERT INTO flow_events (id, created_at, kind, order_id, order_code, customer_name, line_id, item_label, product_id, product_name, part_id, part_name, unit_id, filament_name, filament_hex, from_state, to_state, printer_id, printer_name, actor_device, source_surface, action_label, failure_reason, failure_note, cost_impact_cents, can_undo)
             VALUES (?1, ?2, 'StagedToPrinter', ?3, ?4, ?5, ?6, ?7, 'prod-demo-widget', 'Widget', 'part-demo-lid', 'Lid', ?8, 'Blue', '#3F6FD9', 'Queued', 'Queued', NULL, NULL, 'Demo Device', 'Demo', 'Demo event', NULL, NULL, 0, 0)",
            params![
                format!("ev-demo-{n}"),
                format!("2026-01-01T00:0{n}:00Z"),
                format!("ord-demo-{o}"),
                format!("FP-DEMO-000{o}"),
                customers[(o - 1) as usize],
                format!("line-demo-{o}"),
                format!("Widget #{o}"),
                format!("unit-demo-{o}-lid"),
            ],
        )?;
    }
    Ok(())
}
