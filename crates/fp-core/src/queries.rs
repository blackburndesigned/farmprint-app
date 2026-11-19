use crate::{
    CatalogPart, CoreResult, FilamentSwatch, FlowEvent, FlowEventKind, Order, OrderStatus,
    OverstockItem, PartUnit, PartUnitState, Printer, PrinterFilamentSlot, PrinterStatus, Product,
    ShopKpis, ShopLedger, ShopSnapshot,
};
use rusqlite::params;

pub const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS filament_swatches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hex TEXT NOT NULL,
    material TEXT NOT NULL,
    brand TEXT NOT NULL,
    remaining_grams INTEGER NOT NULL,
    spool_capacity_grams INTEGER NOT NULL,
    dry_box_humidity_pct INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_products (
    id TEXT PRIMARY KEY,
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    shipping_profile TEXT NOT NULL,
    stl_folder_override TEXT NOT NULL,
    composite_thumbnail_svg TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_parts (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    name TEXT NOT NULL,
    stl_filename TEXT NOT NULL,
    default_filament_id TEXT NOT NULL,
    est_print_minutes INTEGER NOT NULL,
    grams INTEGER NOT NULL,
    plate_capacity INTEGER NOT NULL,
    supports_required INTEGER NOT NULL,
    layer_height_mm REAL NOT NULL,
    nozzle_mm REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS printers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL,
    nozzle_temp_c INTEGER NOT NULL,
    bed_temp_c INTEGER NOT NULL,
    chamber_temp_c INTEGER NOT NULL,
    active_job_label TEXT,
    progress_pct INTEGER NOT NULL,
    eta_minutes INTEGER NOT NULL,
    utilization_7d_pct INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS printer_slots (
    printer_id TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    filament_id TEXT NOT NULL,
    active INTEGER NOT NULL,
    PRIMARY KEY (printer_id, slot_index)
);
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    order_number TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    is_rush INTEGER NOT NULL,
    shipping_tier TEXT NOT NULL,
    due_at_iso TEXT NOT NULL,
    created_at_iso TEXT NOT NULL,
    custom_text TEXT,
    total_cents INTEGER NOT NULL,
    shipping_cents INTEGER NOT NULL,
    tracking_code TEXT
);
CREATE TABLE IF NOT EXISTS part_units (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    part_id TEXT NOT NULL,
    part_name TEXT NOT NULL,
    filament_id TEXT NOT NULL,
    state TEXT NOT NULL,
    printer_id TEXT,
    plate_batch_id TEXT,
    reprint_count INTEGER NOT NULL DEFAULT 0,
    updated_at_iso TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS overstock_items (
    id TEXT PRIMARY KEY,
    part_id TEXT NOT NULL,
    part_name TEXT NOT NULL,
    filament_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    bin_location TEXT NOT NULL,
    updated_at_iso TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS flow_events (
    id TEXT PRIMARY KEY,
    timestamp_iso TEXT NOT NULL,
    kind TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    order_id TEXT,
    part_id TEXT NOT NULL,
    filament_id TEXT NOT NULL,
    printer_id TEXT,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    actor_device TEXT NOT NULL,
    notes TEXT NOT NULL,
    can_undo INTEGER NOT NULL DEFAULT 1
);
"#;

impl ShopLedger {
    pub fn snapshot(&self) -> CoreResult<ShopSnapshot> {
        let filaments = self.load_filaments()?;
        let products = self.load_products()?;
        let printers = self.load_printers()?;
        let orders = self.load_orders()?;
        let overstock = self.load_overstock()?;
        let flow_events = self.load_flow_events()?;

        let (mut total_units, mut printed_units, mut printing_units, mut failed_reprints) = (0usize, 0usize, 0usize, 0u32);
        for o in &orders {
            for u in &o.units {
                total_units += 1;
                if matches!(u.state, PartUnitState::Printed | PartUnitState::Packed | PartUnitState::Shipped) {
                    printed_units += 1;
                } else if u.state == PartUnitState::Printing {
                    printing_units += 1;
                }
                failed_reprints += u.reprint_count;
            }
        }
        let active_orders = orders.iter().filter(|o| o.status != OrderStatus::Shipped).count();
        let rush_orders = orders.iter().filter(|o| o.is_rush && o.status != OrderStatus::Shipped).count();
        let overstock_total_units: u32 = overstock.iter().map(|i| i.quantity).sum();
        let fleet_utilization_pct = if printers.is_empty() { 0 } else {
            (printers.iter().map(|p| p.utilization_7d_pct as u32).sum::<u32>() / printers.len() as u32) as u8
        };

        Ok(ShopSnapshot {
            filaments, products, printers, orders, overstock, flow_events,
            kpis: ShopKpis {
                active_orders, rush_orders, total_units, printed_units, printing_units,
                failed_reprints: failed_reprints as usize, overstock_total_units, fleet_utilization_pct,
                cloud_sync_healthy: true, last_sync_iso: chrono::Utc::now().to_rfc3339(),
            },
        })
    }

    pub(crate) fn recompute_order_status_tx(tx: &rusqlite::Transaction<'_>, order_id: &str) -> CoreResult<()> {
        let mut stmt = tx.prepare("SELECT state FROM part_units WHERE order_id = ?1")?;
        let states: Vec<String> = stmt.query_map(params![order_id], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?;
        if states.is_empty() { return Ok(()); }
        let new_status = if states.iter().all(|s| s == "Shipped") { "Shipped" }
            else if states.iter().all(|s| s == "Packed" || s == "Shipped") { "Packed" }
            else if states.iter().all(|s| s == "Printed" || s == "Packed" || s == "Shipped") { "ReadyToPack" }
            else if states.iter().any(|s| s == "Staged" || s == "Printing" || s == "Printed") { "InProduction" }
            else { "Queued" };
        tx.execute("UPDATE orders SET status = ?1 WHERE id = ?2", params![new_status, order_id])?;
        Ok(())
    }

    fn load_filaments(&self) -> CoreResult<Vec<FilamentSwatch>> {
        let mut stmt = self.conn.prepare("SELECT id, name, hex, material, brand, remaining_grams, spool_capacity_grams, dry_box_humidity_pct FROM filament_swatches ORDER BY name")?;
        let rows = stmt.query_map([], |r| Ok(FilamentSwatch {
            id: r.get(0)?, name: r.get(1)?, hex: r.get(2)?, material: r.get(3)?, brand: r.get(4)?,
            remaining_grams: r.get(5)?, spool_capacity_grams: r.get(6)?, dry_box_humidity_pct: r.get(7)?,
        }))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    fn load_products(&self) -> CoreResult<Vec<Product>> {
        let mut stmt = self.conn.prepare("SELECT id, sku, name, category, price_cents, shipping_profile, stl_folder_override, composite_thumbnail_svg FROM catalog_products ORDER BY name")?;
        let prods: Vec<Product> = stmt.query_map([], |r| Ok(Product {
            id: r.get(0)?, sku: r.get(1)?, name: r.get(2)?, category: r.get(3)?, price_cents: r.get(4)?,
            shipping_profile: r.get(5)?, stl_folder_override: r.get(6)?, composite_thumbnail_svg: r.get(7)?, parts: Vec::new(),
        }))?.collect::<Result<Vec<_>, _>>()?;
        let mut part_stmt = self.conn.prepare("SELECT id, product_id, name, stl_filename, default_filament_id, est_print_minutes, grams, plate_capacity, supports_required, layer_height_mm, nozzle_mm FROM catalog_parts ORDER BY name")?;
        let all_parts: Vec<CatalogPart> = part_stmt.query_map([], |r| Ok(CatalogPart {
            id: r.get(0)?, product_id: r.get(1)?, name: r.get(2)?, stl_filename: r.get(3)?, default_filament_id: r.get(4)?,
            est_print_minutes: r.get(5)?, grams: r.get(6)?, plate_capacity: r.get(7)?, supports_required: r.get::<_, i64>(8)? != 0,
            layer_height_mm: r.get(9)?, nozzle_mm: r.get(10)?,
        }))?.collect::<Result<Vec<_>, _>>()?;
        Ok(prods.into_iter().map(|mut p| { p.parts = all_parts.iter().filter(|pt| pt.product_id == p.id).cloned().collect(); p }).collect())
    }

    fn load_printers(&self) -> CoreResult<Vec<Printer>> {
        let mut stmt = self.conn.prepare("SELECT id, name, model, status, nozzle_temp_c, bed_temp_c, chamber_temp_c, active_job_label, progress_pct, eta_minutes, utilization_7d_pct FROM printers ORDER BY id")?;
        let printers: Vec<Printer> = stmt.query_map([], |r| {
            let status = match r.get::<_, String>(3)?.as_str() {
                "Printing" => PrinterStatus::Printing, "Paused" => PrinterStatus::Paused,
                "NeedsAttention" => PrinterStatus::NeedsAttention, "Offline" => PrinterStatus::Offline, _ => PrinterStatus::Idle,
            };
            Ok(Printer {
                id: r.get(0)?, name: r.get(1)?, model: r.get(2)?, status, nozzle_temp_c: r.get(4)?, bed_temp_c: r.get(5)?,
                chamber_temp_c: r.get(6)?, active_job_label: r.get(7)?, progress_pct: r.get(8)?, eta_minutes: r.get(9)?,
                utilization_7d_pct: r.get(10)?, loaded_slots: Vec::new(),
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        let mut slot_stmt = self.conn.prepare("SELECT printer_id, slot_index, filament_id, active FROM printer_slots ORDER BY slot_index")?;
        let slots: Vec<(String, PrinterFilamentSlot)> = slot_stmt.query_map([], |r| Ok((
            r.get(0)?, PrinterFilamentSlot { slot_index: r.get(1)?, filament_id: r.get(2)?, active: r.get::<_, i64>(3)? != 0 },
        )))?.collect::<Result<Vec<_>, _>>()?;
        Ok(printers.into_iter().map(|mut pr| { pr.loaded_slots = slots.iter().filter(|(pid, _)| pid == &pr.id).map(|(_, s)| s.clone()).collect(); pr }).collect())
    }

    fn load_orders(&self) -> CoreResult<Vec<Order>> {
        let mut stmt = self.conn.prepare("SELECT id, order_number, customer_name, customer_email, channel, status, is_rush, shipping_tier, due_at_iso, created_at_iso, custom_text, total_cents, shipping_cents, tracking_code FROM orders ORDER BY is_rush DESC, due_at_iso ASC")?;
        let orders: Vec<Order> = stmt.query_map([], |r| {
            let status = match r.get::<_, String>(5)?.as_str() {
                "InProduction" => OrderStatus::InProduction, "ReadyToPack" => OrderStatus::ReadyToPack,
                "Packed" => OrderStatus::Packed, "Shipped" => OrderStatus::Shipped, "Hold" => OrderStatus::Hold, _ => OrderStatus::Queued,
            };
            Ok(Order {
                id: r.get(0)?, order_number: r.get(1)?, customer_name: r.get(2)?, customer_email: r.get(3)?, channel: r.get(4)?,
                status, is_rush: r.get::<_, i64>(6)? != 0, shipping_tier: r.get(7)?, due_at_iso: r.get(8)?, created_at_iso: r.get(9)?,
                custom_text: r.get(10)?, total_cents: r.get(11)?, shipping_cents: r.get(12)?, tracking_code: r.get(13)?, units: Vec::new(),
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        let mut unit_stmt = self.conn.prepare("SELECT id, order_id, product_id, part_id, part_name, filament_id, state, printer_id, plate_batch_id, reprint_count, updated_at_iso FROM part_units ORDER BY id")?;
        let units: Vec<PartUnit> = unit_stmt.query_map([], |r| Ok(PartUnit {
            id: r.get(0)?, order_id: r.get(1)?, product_id: r.get(2)?, part_id: r.get(3)?, part_name: r.get(4)?, filament_id: r.get(5)?,
            state: PartUnitState::from_label(&r.get::<_, String>(6)?), printer_id: r.get(7)?, plate_batch_id: r.get(8)?, reprint_count: r.get(9)?, updated_at_iso: r.get(10)?,
        }))?.collect::<Result<Vec<_>, _>>()?;
        Ok(orders.into_iter().map(|mut o| { o.units = units.iter().filter(|u| u.order_id == o.id).cloned().collect(); o }).collect())
    }

    fn load_overstock(&self) -> CoreResult<Vec<OverstockItem>> {
        let mut stmt = self.conn.prepare("SELECT id, part_id, part_name, filament_id, quantity, bin_location, updated_at_iso FROM overstock_items ORDER BY part_name")?;
        let rows = stmt.query_map([], |r| Ok(OverstockItem {
            id: r.get(0)?, part_id: r.get(1)?, part_name: r.get(2)?, filament_id: r.get(3)?, quantity: r.get(4)?, bin_location: r.get(5)?, updated_at_iso: r.get(6)?,
        }))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    fn load_flow_events(&self) -> CoreResult<Vec<FlowEvent>> {
        let mut stmt = self.conn.prepare("SELECT id, timestamp_iso, kind, unit_id, order_id, part_id, filament_id, printer_id, from_state, to_state, actor_device, notes, can_undo FROM flow_events ORDER BY timestamp_iso DESC LIMIT 100")?;
        let rows = stmt.query_map([], |r| {
            let kind = match r.get::<_, String>(2)?.as_str() {
                "StartedPrint" => FlowEventKind::StartedPrint, "CompletedPrint" => FlowEventKind::CompletedPrint,
                "FailedPrint" => FlowEventKind::FailedPrint, "Requeued" => FlowEventKind::Requeued,
                "MovedToOverstock" => FlowEventKind::MovedToOverstock, "PulledFromOverstock" => FlowEventKind::PulledFromOverstock,
                "PackedOrder" => FlowEventKind::PackedOrder, "ShippedOrder" => FlowEventKind::ShippedOrder,
                "UndidAction" => FlowEventKind::UndidAction, _ => FlowEventKind::StagedOnPlate,
            };
            Ok(FlowEvent {
                id: r.get(0)?, timestamp_iso: r.get(1)?, kind, unit_id: r.get(3)?, order_id: r.get(4)?, part_id: r.get(5)?,
                filament_id: r.get(6)?, printer_id: r.get(7)?, from_state: r.get(8)?, to_state: r.get(9)?,
                actor_device: r.get(10)?, notes: r.get(11)?, can_undo: r.get::<_, i64>(12)? != 0,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}
