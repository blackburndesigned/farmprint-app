//! Editing an existing order from the Edit Order window (the New Order window filled in
//! with the order). The window sends the whole order as it should be; this works out what
//! changed and applies it without touching work that already happened:
//!
//! - A line that is still there with the same product keeps its part units and their
//!   states. A different product on a line is a removed line plus a new one.
//! - More quantity adds new Queued copies (one unit per tracked part). Less quantity drops
//!   copies that haven't started first (newest first); dropping a copy with a part that is
//!   staged, printing, printed or later needs `confirm_started`.
//! - A new color for a part changes only that part's Queued units; started units keep
//!   theirs and are reported (`started_color_kept`).
//! - Removing a line with started parts needs `confirm_started`.
//!
//! Every change is logged in Flow (`OrderEdited`, and `LineRemoved` for removed lines).
//! `source` and `remote_id` (website orders) are never changed.

use crate::models::{CoreError, CoreResult, ShopSnapshot};
use crate::ShopLedger;
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use uuid::Uuid;

/// Flow event kind for order edits (added line, quantity, color, inscription changes).
pub const ORDER_EDITED_KIND: &str = "OrderEdited";
const SOURCE_SURFACE: &str = "Orders · Edit Order";

/// One line as the Edit Order window wants it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderEditLine {
    /// The existing line this is (None = a new line).
    #[serde(default)]
    pub line_id: Option<String>,
    pub product_id: String,
    pub quantity: i64,
    #[serde(default)]
    pub custom_text: Option<String>,
    /// Part id -> filament id, only for parts whose color the user changed (or every part
    /// of a new line). Parts not listed keep the colors they have.
    #[serde(default)]
    pub part_filaments: HashMap<String, String>,
}

/// The whole order as the Edit Order window wants it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderEditInput {
    pub order_id: String,
    pub customer_name: String,
    #[serde(default)]
    pub customer_email: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub is_rush: bool,
    #[serde(default)]
    pub is_on_hold: bool,
    /// None keeps the current shipping charge.
    #[serde(default)]
    pub shipping_charged_cents: Option<i64>,
    /// Ship-by date `YYYY-MM-DD`. None keeps the current one; "" clears it.
    #[serde(default)]
    pub ship_by: Option<String>,
    pub lines: Vec<OrderEditLine>,
    /// The user agreed to remove parts that are staged, printing, printed or later.
    #[serde(default)]
    pub confirm_started: bool,
    #[serde(default)]
    pub actor_device: Option<String>,
}

/// Product id -> its tracked parts `(part id, default filament id)`, in order.
pub type TrackedParts = HashMap<String, Vec<(String, String)>>;

/// A part unit as it is now.
#[derive(Debug, Clone, PartialEq)]
pub struct CurrentUnit {
    pub id: String,
    pub part_id: String,
    pub unit_index: i64,
    pub state: String,
    pub filament_id: String,
}

/// An order line as it is now.
#[derive(Debug, Clone, PartialEq)]
pub struct CurrentLine {
    pub id: String,
    pub product_id: String,
    pub item_label: String,
    pub quantity: i64,
    pub custom_text: Option<String>,
    pub units: Vec<CurrentUnit>,
}

/// True once a unit has left the queue (staged, printing, printed, post-processing, ...).
pub fn unit_started(state: &str) -> bool {
    state != "Queued"
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct RemovedLine {
    pub line_id: String,
    pub item_label: String,
    pub units: usize,
    pub started_units: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct LineEdit {
    pub line_id: String,
    /// Index of the line in the input.
    pub input_index: usize,
    pub item_label: String,
    pub old_quantity: i64,
    pub new_quantity: i64,
    pub removed_unit_ids: Vec<String>,
    /// Removed units that had started (need confirmation).
    pub removed_started: usize,
    /// New copies to add (their unit_index).
    pub add_copies: Vec<i64>,
    /// (unit id, new unit_index) for kept copies, so indexes stay 1..=quantity.
    pub renumber: Vec<(String, i64)>,
    /// (unit id, filament id) color changes on Queued units.
    pub filament_updates: Vec<(String, String)>,
    /// Started units of a recolored part that keep their old color.
    pub started_color_kept: usize,
    pub new_custom_text: Option<String>,
    pub text_changed: bool,
    /// The inscription changed but some of the line's parts already started.
    pub text_changed_started: bool,
    /// Part id -> filament for the new copies.
    pub new_copy_filaments: HashMap<String, String>,
}

impl LineEdit {
    pub fn is_noop(&self) -> bool {
        self.removed_unit_ids.is_empty()
            && self.add_copies.is_empty()
            && self.filament_updates.is_empty()
            && !self.text_changed
            && self.renumber.is_empty()
            && self.old_quantity == self.new_quantity
    }
}

/// What saving the Edit Order window will do. `needs_confirm` = it removes started parts.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct OrderEditPlan {
    pub removed_lines: Vec<RemovedLine>,
    /// Indexes into the input lines that become new lines.
    pub added_lines: Vec<usize>,
    pub line_edits: Vec<LineEdit>,
    pub started_units_removed: usize,
    pub started_color_kept: usize,
    pub needs_confirm: bool,
    /// Plain-language notes for the user (removed started parts, kept colors, inscriptions).
    pub warnings: Vec<String>,
}

fn clean_text(t: &Option<String>) -> Option<String> {
    t.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Works out the edit. `parts` maps a product id to its tracked parts `(part id, default
/// filament id)` in order (the parts that get units).
pub fn plan_order_edit(
    current: &[CurrentLine],
    desired: &[OrderEditLine],
    parts: &HashMap<String, Vec<(String, String)>>,
) -> OrderEditPlan {
    let mut plan = OrderEditPlan::default();
    let by_id: HashMap<&str, &CurrentLine> = current.iter().map(|l| (l.id.as_str(), l)).collect();
    let mut kept: HashSet<&str> = HashSet::new();

    for (i, want) in desired.iter().enumerate() {
        let cur = want
            .line_id
            .as_deref()
            .and_then(|id| by_id.get(id).copied())
            .filter(|c| c.product_id == want.product_id && !kept.contains(c.id.as_str()));
        let Some(cur) = cur else {
            plan.added_lines.push(i);
            continue;
        };
        kept.insert(cur.id.as_str());
        plan.line_edits.push(edit_line(cur, want, i, parts));
    }

    for cur in current {
        if kept.contains(cur.id.as_str()) {
            continue;
        }
        let started = cur.units.iter().filter(|u| unit_started(&u.state)).count();
        plan.removed_lines.push(RemovedLine {
            line_id: cur.id.clone(),
            item_label: cur.item_label.clone(),
            units: cur.units.len(),
            started_units: started,
        });
    }

    plan.started_units_removed = plan
        .removed_lines
        .iter()
        .map(|r| r.started_units)
        .sum::<usize>()
        + plan
            .line_edits
            .iter()
            .map(|e| e.removed_started)
            .sum::<usize>();
    plan.started_color_kept = plan.line_edits.iter().map(|e| e.started_color_kept).sum();
    plan.needs_confirm = plan.started_units_removed > 0;

    for r in plan.removed_lines.iter().filter(|r| r.started_units > 0) {
        plan.warnings.push(format!(
            "Removing {} also removes {} already staged, printing or done.",
            r.item_label,
            plural(r.started_units, "part", "parts")
        ));
    }
    for e in &plan.line_edits {
        if e.removed_started > 0 {
            plan.warnings.push(format!(
                "Lowering {} from {} to {} removes {} already staged, printing or done.",
                e.item_label,
                e.old_quantity,
                e.new_quantity,
                plural(e.removed_started, "part", "parts")
            ));
        }
        if e.started_color_kept > 0 {
            plan.warnings.push(format!(
                "{}: {} already started keep their old color; the new color applies to queued parts only.",
                e.item_label,
                plural(e.started_color_kept, "part", "parts")
            ));
        }
        if e.text_changed_started {
            plan.warnings.push(format!(
                "{}: the inscription changed, but some of its parts already started with the old text.",
                e.item_label
            ));
        }
    }
    plan
}

fn edit_line(
    cur: &CurrentLine,
    want: &OrderEditLine,
    input_index: usize,
    parts: &HashMap<String, Vec<(String, String)>>,
) -> LineEdit {
    let new_qty = want.quantity.max(1);
    let mut e = LineEdit {
        line_id: cur.id.clone(),
        input_index,
        item_label: cur.item_label.clone(),
        old_quantity: cur.quantity,
        new_quantity: new_qty,
        ..Default::default()
    };

    // Copies of the product: units grouped by unit_index, in index order.
    let mut copies: BTreeMap<i64, Vec<&CurrentUnit>> = BTreeMap::new();
    for u in &cur.units {
        copies.entry(u.unit_index).or_default().push(u);
    }
    let started_in = |c: &Vec<&CurrentUnit>| c.iter().filter(|u| unit_started(&u.state)).count();
    let mut order: Vec<(i64, usize)> = copies.iter().map(|(k, c)| (*k, started_in(c))).collect();
    let have = order.len() as i64;
    let mut removed: HashSet<i64> = HashSet::new();
    if have > new_qty {
        // Fewest started parts first, then the newest copy.
        order.sort_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)));
        for (idx, started) in order.iter().take((have - new_qty) as usize) {
            removed.insert(*idx);
            e.removed_started += started;
            e.removed_unit_ids
                .extend(copies[idx].iter().map(|u| u.id.clone()));
        }
    }

    // Kept copies are renumbered 1..=n in their old order; new copies follow.
    let mut next = 0i64;
    for (idx, units) in &copies {
        if removed.contains(idx) {
            continue;
        }
        next += 1;
        if *idx != next {
            e.renumber
                .extend(units.iter().map(|u| (u.id.clone(), next)));
        }
    }
    e.add_copies = ((next + 1)..=new_qty).collect();

    // Colors: only parts the window says changed; started units keep theirs.
    for (idx, units) in &copies {
        if removed.contains(idx) {
            continue;
        }
        for u in units {
            if let Some(f) = want.part_filaments.get(&u.part_id) {
                if *f != u.filament_id {
                    if unit_started(&u.state) {
                        e.started_color_kept += 1;
                    } else {
                        e.filament_updates.push((u.id.clone(), f.clone()));
                    }
                }
            }
        }
    }

    // New copies: the chosen color, else the part's current color on this line (a queued
    // unit first), else the catalog default.
    if !e.add_copies.is_empty() {
        for (part_id, default_fil) in parts
            .get(&cur.product_id)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
        {
            let existing = cur
                .units
                .iter()
                .filter(|u| &u.part_id == part_id)
                .max_by_key(|u| (!unit_started(&u.state), u.unit_index))
                .map(|u| u.filament_id.clone());
            let fil = want
                .part_filaments
                .get(part_id)
                .cloned()
                .or(existing)
                .unwrap_or_else(|| default_fil.clone());
            e.new_copy_filaments.insert(part_id.clone(), fil);
        }
    }

    let new_text = clean_text(&want.custom_text);
    e.text_changed = new_text != clean_text(&cur.custom_text);
    e.text_changed_started = e.text_changed && cur.units.iter().any(|u| unit_started(&u.state));
    e.new_custom_text = new_text;
    e
}

impl ShopLedger {
    fn order_edit_state(&self, order_id: &str) -> CoreResult<(Vec<CurrentLine>, TrackedParts)> {
        let exists: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM orders WHERE id = ?1",
                params![order_id],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(CoreError::NotFound(format!("order {order_id}")));
        }
        let mut stmt = self.conn.prepare(
            "SELECT id, product_id, item_label, quantity, custom_text FROM order_lines WHERE order_id = ?1 ORDER BY id",
        )?;
        let mut lines: Vec<CurrentLine> = stmt
            .query_map(params![order_id], |r| {
                Ok(CurrentLine {
                    id: r.get(0)?,
                    product_id: r.get(1)?,
                    item_label: r.get(2)?,
                    quantity: r.get(3)?,
                    custom_text: r.get(4)?,
                    units: Vec::new(),
                })
            })?
            .collect::<Result<_, _>>()?;
        let mut stmt = self.conn.prepare(
            "SELECT id, line_id, part_id, unit_index, state, filament_id FROM part_units WHERE order_id = ?1 ORDER BY unit_index, id",
        )?;
        let units = stmt
            .query_map(params![order_id], |r| {
                Ok((
                    r.get::<_, String>(1)?,
                    CurrentUnit {
                        id: r.get(0)?,
                        part_id: r.get(2)?,
                        unit_index: r.get(3)?,
                        state: r.get(4)?,
                        filament_id: r.get(5)?,
                    },
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (line_id, u) in units {
            if let Some(l) = lines.iter_mut().find(|l| l.id == line_id) {
                l.units.push(u);
            }
        }
        let parts = self.tracked_parts_by_product()?;
        Ok((lines, parts))
    }

    fn tracked_parts_by_product(&self) -> CoreResult<TrackedParts> {
        let mut stmt = self.conn.prepare(
            "SELECT product_id, id, default_filament_id FROM catalog_parts WHERE is_tracked = 1 AND is_color_only = 0 ORDER BY product_id, sort_order",
        )?;
        let mut out: HashMap<String, Vec<(String, String)>> = HashMap::new();
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (p, id, fil) = row?;
            out.entry(p).or_default().push((id, fil));
        }
        Ok(out)
    }

    /// What saving the Edit Order window would do (nothing is written).
    pub fn plan_order_edit(&self, input: &OrderEditInput) -> CoreResult<OrderEditPlan> {
        let (current, parts) = self.order_edit_state(&input.order_id)?;
        Ok(plan_order_edit(&current, &input.lines, &parts))
    }

    /// Saves the Edit Order window. Fails without writing anything when it would remove
    /// started parts and `confirm_started` is false. Returns the snapshot and the ids of the
    /// removed lines (their saved pictures can go).
    pub fn apply_order_edit(
        &mut self,
        input: &OrderEditInput,
    ) -> CoreResult<(ShopSnapshot, Vec<String>)> {
        if input.customer_name.trim().is_empty() {
            return Err(CoreError::Validation("Customer name is required".into()));
        }
        if input.lines.is_empty() {
            return Err(CoreError::Validation(
                "An order needs at least one product".into(),
            ));
        }
        if let Some(c) = input.shipping_charged_cents {
            if c < 0 {
                return Err(CoreError::Validation("Shipping can't be negative".into()));
            }
        }
        let (current, parts) = self.order_edit_state(&input.order_id)?;
        let plan = plan_order_edit(&current, &input.lines, &parts);
        if plan.needs_confirm && !input.confirm_started {
            return Err(CoreError::Validation(format!(
                "This edit removes {} that already started. Confirm to continue.",
                plural(plan.started_units_removed, "part", "parts")
            )));
        }
        for i in &plan.added_lines {
            let pid = &input.lines[*i].product_id;
            let known: Option<String> = self
                .conn
                .query_row("SELECT id FROM products WHERE id = ?1", params![pid], |r| {
                    r.get(0)
                })
                .optional()?;
            if known.is_none() {
                return Err(CoreError::NotFound(format!("product {pid}")));
            }
        }

        let now = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let actor = input
            .actor_device
            .clone()
            .unwrap_or_else(|| "FarmPrint".to_string());
        let tx = self.conn.transaction()?;
        let (order_code, old_name): (String, String) = tx.query_row(
            "SELECT order_code, customer_name FROM orders WHERE id = ?1",
            params![input.order_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let name = input.customer_name.trim().to_string();
        tx.execute(
            "UPDATE orders SET customer_name = ?1, customer_email = ?2, notes = ?3, is_rush = ?4, is_on_hold = ?5,
                shipping_charged_cents = COALESCE(?6, shipping_charged_cents), updated_at = ?7 WHERE id = ?8",
            params![
                name,
                input.customer_email.trim(),
                input.notes.trim(),
                input.is_rush as i64,
                input.is_on_hold as i64,
                input.shipping_charged_cents,
                now,
                input.order_id
            ],
        )?;
        if let Some(sb) = &input.ship_by {
            tx.execute(
                "UPDATE orders SET ship_by = ?1 WHERE id = ?2",
                params![crate::normalize_ship_by(sb)?, input.order_id],
            )?;
        }
        let ev = EventCtx {
            tx: &tx,
            now: &now,
            order_id: &input.order_id,
            order_code: &order_code,
            customer: &name,
            actor: &actor,
        };
        if old_name != name {
            ev.log(
                ORDER_EDITED_KIND,
                None,
                None,
                None,
                format!("Customer changed from {old_name} to {name}"),
                None,
            )?;
        }

        // Removed lines.
        for r in &plan.removed_lines {
            let cur = current
                .iter()
                .find(|l| l.id == r.line_id)
                .expect("planned from current");
            ev.log(
                "LineRemoved",
                Some(&r.line_id),
                Some(&r.item_label),
                Some(&cur.product_id),
                format!("Removed line {}", r.item_label),
                Some(format!(
                    "units={}; started_or_later={}",
                    r.units, r.started_units
                )),
            )?;
            tx.execute(
                "DELETE FROM part_units WHERE line_id = ?1",
                params![r.line_id],
            )?;
            tx.execute("DELETE FROM order_lines WHERE id = ?1", params![r.line_id])?;
        }

        // Kept lines.
        for e in &plan.line_edits {
            let cur = current
                .iter()
                .find(|l| l.id == e.line_id)
                .expect("planned from current");
            for id in &e.removed_unit_ids {
                tx.execute("DELETE FROM part_units WHERE id = ?1", params![id])?;
            }
            for (id, idx) in &e.renumber {
                tx.execute(
                    "UPDATE part_units SET unit_index = ?1 WHERE id = ?2",
                    params![idx, id],
                )?;
            }
            for (id, fil) in &e.filament_updates {
                tx.execute(
                    "UPDATE part_units SET filament_id = ?1, updated_at = ?2 WHERE id = ?3 AND state = 'Queued'",
                    params![fil, now, id],
                )?;
            }
            for idx in &e.add_copies {
                for (part_id, _) in parts
                    .get(&cur.product_id)
                    .map(|v| v.as_slice())
                    .unwrap_or(&[])
                {
                    let fil = e
                        .new_copy_filaments
                        .get(part_id)
                        .cloned()
                        .unwrap_or_default();
                    insert_unit(
                        &tx,
                        &input.order_id,
                        &cur.id,
                        &cur.product_id,
                        part_id,
                        *idx,
                        &fil,
                        &now,
                    )?;
                }
            }
            tx.execute(
                "UPDATE order_lines SET quantity = ?1, custom_text = ?2 WHERE id = ?3",
                params![e.new_quantity, e.new_custom_text, e.line_id],
            )?;
            let mut what: Vec<String> = Vec::new();
            if e.old_quantity != e.new_quantity {
                what.push(format!("quantity {} → {}", e.old_quantity, e.new_quantity));
            }
            if !e.filament_updates.is_empty() {
                what.push(format!(
                    "new color on {}",
                    plural(e.filament_updates.len(), "queued part", "queued parts")
                ));
            }
            if e.text_changed {
                what.push("inscription changed".to_string());
            }
            if !what.is_empty() {
                let mut note: Vec<String> = Vec::new();
                if !e.removed_unit_ids.is_empty() {
                    note.push(format!(
                        "removed_units={}; started_or_later={}",
                        e.removed_unit_ids.len(),
                        e.removed_started
                    ));
                }
                if !e.add_copies.is_empty() {
                    note.push(format!(
                        "added_units={}",
                        e.add_copies.len() * parts.get(&cur.product_id).map_or(0, |v| v.len())
                    ));
                }
                if e.started_color_kept > 0 {
                    note.push(format!("started_kept_color={}", e.started_color_kept));
                }
                if e.text_changed {
                    note.push(format!(
                        "inscription: {:?} → {:?}",
                        clean_text(&cur.custom_text).unwrap_or_default(),
                        e.new_custom_text.clone().unwrap_or_default()
                    ));
                }
                ev.log(
                    ORDER_EDITED_KIND,
                    Some(&e.line_id),
                    Some(&e.item_label),
                    Some(&cur.product_id),
                    format!("Edited {}: {}", e.item_label, what.join(", ")),
                    if note.is_empty() {
                        None
                    } else {
                        Some(note.join("; "))
                    },
                )?;
            }
        }

        // New lines.
        for i in &plan.added_lines {
            let want = &input.lines[*i];
            let qty = want.quantity.max(1);
            let (prod_name, price): (String, i64) = tx.query_row(
                "SELECT name, price_cents FROM products WHERE id = ?1",
                params![want.product_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let line_id = format!("line-{}", Uuid::new_v4().simple());
            tx.execute(
                "INSERT INTO order_lines (id, order_id, product_id, item_label, quantity, unit_price_cents, custom_text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![line_id, input.order_id, want.product_id, prod_name, qty, price, clean_text(&want.custom_text)],
            )?;
            for idx in 1..=qty {
                for (part_id, default_fil) in parts
                    .get(&want.product_id)
                    .map(|v| v.as_slice())
                    .unwrap_or(&[])
                {
                    let fil = want
                        .part_filaments
                        .get(part_id)
                        .cloned()
                        .unwrap_or_else(|| default_fil.clone());
                    insert_unit(
                        &tx,
                        &input.order_id,
                        &line_id,
                        &want.product_id,
                        part_id,
                        idx,
                        &fil,
                        &now,
                    )?;
                }
            }
            ev.log(
                ORDER_EDITED_KIND,
                Some(&line_id),
                Some(&prod_name),
                Some(&want.product_id),
                format!("Added {qty}× {prod_name}"),
                None,
            )?;
        }
        tx.commit()?;
        let removed = plan
            .removed_lines
            .iter()
            .map(|r| r.line_id.clone())
            .collect();
        Ok((self.snapshot()?, removed))
    }
}

#[allow(clippy::too_many_arguments)]
fn insert_unit(
    tx: &Transaction,
    order_id: &str,
    line_id: &str,
    product_id: &str,
    part_id: &str,
    idx: i64,
    filament_id: &str,
    now: &str,
) -> CoreResult<()> {
    let uid = format!("unit-{}-{}", Uuid::new_v4().simple(), idx);
    tx.execute(
        "INSERT INTO part_units (id, order_id, line_id, product_id, part_id, unit_index, filament_id, state, printer_id, plate_job_id, reprint_count, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'Queued', NULL, NULL, 0, ?8)",
        params![uid, order_id, line_id, product_id, part_id, idx, filament_id, now],
    )?;
    Ok(())
}

struct EventCtx<'a> {
    tx: &'a Transaction<'a>,
    now: &'a str,
    order_id: &'a str,
    order_code: &'a str,
    customer: &'a str,
    actor: &'a str,
}

impl EventCtx<'_> {
    fn log(
        &self,
        kind: &str,
        line_id: Option<&str>,
        item_label: Option<&str>,
        product_id: Option<&str>,
        label: String,
        note: Option<String>,
    ) -> CoreResult<()> {
        let product_name: Option<String> = match product_id {
            Some(p) => self
                .tx
                .query_row("SELECT name FROM products WHERE id = ?1", params![p], |r| {
                    r.get(0)
                })
                .optional()?,
            None => None,
        };
        let to_state = if kind == "LineRemoved" {
            "Removed"
        } else {
            "Edited"
        };
        self.tx.execute(
            "INSERT INTO flow_events (
                id, created_at, kind, order_id, order_code, customer_name, line_id, item_label,
                product_id, product_name, filament_name, filament_hex, from_state, to_state,
                actor_device, source_surface, action_label, failure_note, cost_impact_cents, can_undo
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '', '', NULL, ?11, ?12, ?13, ?14, ?15, 0, 0)",
            params![
                Uuid::new_v4().to_string(),
                self.now,
                kind,
                self.order_id,
                self.order_code,
                self.customer,
                line_id,
                item_label,
                product_id,
                product_name,
                to_state,
                self.actor,
                SOURCE_SURFACE,
                label,
                note
            ],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::PartUnit;

    fn ledger() -> ShopLedger {
        ShopLedger::open_in_memory().unwrap()
    }

    fn line_units(l: &ShopLedger, line_id: &str) -> Vec<PartUnit> {
        let mut v: Vec<PartUnit> = l
            .snapshot()
            .unwrap()
            .orders
            .into_iter()
            .flat_map(|o| o.lines)
            .filter(|ln| ln.id == line_id)
            .flat_map(|ln| ln.units)
            .collect();
        v.sort_by_key(|u| (u.unit_index, u.part_id.clone()));
        v
    }

    fn sig(units: &[PartUnit]) -> Vec<(String, i64, String, String)> {
        units
            .iter()
            .map(|u| {
                (
                    u.id.clone(),
                    u.unit_index,
                    u.state.clone(),
                    u.filament_id.clone(),
                )
            })
            .collect()
    }

    fn set_state(l: &ShopLedger, unit_id: &str, state: &str) {
        l.conn
            .execute(
                "UPDATE part_units SET state = ?1 WHERE id = ?2",
                params![state, unit_id],
            )
            .unwrap();
    }

    /// The demo order 1 as the window would send it, with line 1 changed by `f`.
    fn input(f: impl FnOnce(&mut OrderEditLine)) -> OrderEditInput {
        let mut line = OrderEditLine {
            line_id: Some("line-demo-1".into()),
            product_id: "prod-demo-widget".into(),
            quantity: 1,
            custom_text: None,
            part_filaments: HashMap::new(),
        };
        f(&mut line);
        OrderEditInput {
            order_id: "ord-demo-1".into(),
            customer_name: "Sam Example".into(),
            customer_email: "customer1@example.com".into(),
            notes: String::new(),
            is_rush: false,
            is_on_hold: false,
            shipping_charged_cents: None,
            ship_by: None,
            lines: vec![line],
            confirm_started: false,
            actor_device: Some("Test".into()),
        }
    }

    fn events(l: &ShopLedger, kind: &str) -> Vec<crate::models::FlowEvent> {
        l.snapshot()
            .unwrap()
            .flow_events
            .into_iter()
            .filter(|e| e.kind == kind)
            .collect()
    }

    #[test]
    fn unchanged_order_changes_nothing() {
        let mut l = ledger();
        let plan = l.plan_order_edit(&input(|_| {})).unwrap();
        assert!(plan.added_lines.is_empty() && plan.removed_lines.is_empty());
        assert!(plan.line_edits.iter().all(|e| e.is_noop()));
        let before = line_units(&l, "line-demo-1");
        l.apply_order_edit(&input(|_| {})).unwrap();
        assert_eq!(sig(&line_units(&l, "line-demo-1")), sig(&before));
        assert!(events(&l, ORDER_EDITED_KIND).is_empty());
    }

    #[test]
    fn more_quantity_adds_queued_copies_and_keeps_printed_units() {
        let mut l = ledger();
        set_state(&l, "unit-demo-1-base", "Printed");
        l.apply_order_edit(&input(|ln| ln.quantity = 3)).unwrap();
        let units = line_units(&l, "line-demo-1");
        assert_eq!(units.len(), 6, "2 parts × 3");
        let base = units.iter().find(|u| u.id == "unit-demo-1-base").unwrap();
        assert_eq!(
            (base.state.as_str(), base.unit_index),
            ("Printed", 1),
            "printed unit kept as is"
        );
        assert!(units
            .iter()
            .any(|u| u.id == "unit-demo-1-lid" && u.unit_index == 1));
        let new: Vec<_> = units.iter().filter(|u| u.unit_index > 1).collect();
        assert_eq!(new.len(), 4);
        assert!(new.iter().all(|u| u.state == "Queued"));
        // New copies take the line's current colors.
        assert!(new
            .iter()
            .filter(|u| u.part_id == "part-demo-base")
            .all(|u| u.filament_id == "fil-demo-red"));
        assert!(new
            .iter()
            .filter(|u| u.part_id == "part-demo-lid")
            .all(|u| u.filament_id == "fil-demo-blue"));
        let ev = events(&l, ORDER_EDITED_KIND);
        assert_eq!(ev.len(), 1);
        assert!(
            ev[0].action_label.contains("quantity 1 → 3"),
            "{}",
            ev[0].action_label
        );
        assert_eq!(ev[0].source_surface, "Orders · Edit Order");
        let qty = l
            .snapshot()
            .unwrap()
            .orders
            .into_iter()
            .find(|o| o.id == "ord-demo-1")
            .unwrap()
            .lines[0]
            .quantity;
        assert_eq!(qty, 3);
    }

    #[test]
    fn less_quantity_drops_unstarted_copies_first() {
        let mut l = ledger();
        l.apply_order_edit(&input(|ln| ln.quantity = 3)).unwrap();
        // Copy 1 printed, copy 3 staged, copy 2 untouched.
        set_state(&l, "unit-demo-1-base", "Printed");
        let staged = line_units(&l, "line-demo-1")
            .into_iter()
            .find(|u| u.unit_index == 3)
            .unwrap();
        set_state(&l, &staged.id, "Staged");
        let plan = l.plan_order_edit(&input(|ln| ln.quantity = 2)).unwrap();
        assert!(
            !plan.needs_confirm,
            "copy 2 hasn't started, so nothing started is removed"
        );
        l.apply_order_edit(&input(|ln| ln.quantity = 2)).unwrap();
        let units = line_units(&l, "line-demo-1");
        assert_eq!(units.len(), 4);
        assert!(units
            .iter()
            .any(|u| u.id == "unit-demo-1-base" && u.state == "Printed" && u.unit_index == 1));
        let s = units.iter().find(|u| u.id == staged.id).unwrap();
        assert_eq!(
            (s.state.as_str(), s.unit_index),
            ("Staged", 2),
            "staged copy kept and renumbered"
        );
    }

    #[test]
    fn removing_started_units_needs_confirmation_and_is_logged() {
        let mut l = ledger();
        l.apply_order_edit(&input(|ln| ln.quantity = 2)).unwrap();
        set_state(&l, "unit-demo-1-base", "Printed");
        let staged = line_units(&l, "line-demo-1")
            .into_iter()
            .find(|u| u.unit_index == 2)
            .unwrap();
        set_state(&l, &staged.id, "Printing");
        let plan = l.plan_order_edit(&input(|ln| ln.quantity = 1)).unwrap();
        assert!(plan.needs_confirm);
        assert_eq!(
            plan.started_units_removed, 1,
            "drops the copy with fewer started parts"
        );
        assert!(plan.warnings.iter().any(|w| w.contains("from 2 to 1")));
        let before = line_units(&l, "line-demo-1");
        assert!(l.apply_order_edit(&input(|ln| ln.quantity = 1)).is_err());
        assert_eq!(
            sig(&line_units(&l, "line-demo-1")),
            sig(&before),
            "nothing written without confirmation"
        );
        let mut ok = input(|ln| ln.quantity = 1);
        ok.confirm_started = true;
        l.apply_order_edit(&ok).unwrap();
        let units = line_units(&l, "line-demo-1");
        assert_eq!(units.len(), 2);
        assert!(units
            .iter()
            .any(|u| u.id == "unit-demo-1-base" && u.state == "Printed"));
        let ev = events(&l, ORDER_EDITED_KIND);
        assert!(ev.iter().any(|e| e
            .failure_note
            .as_deref()
            .unwrap_or("")
            .contains("started_or_later=1")));
    }

    #[test]
    fn new_color_changes_only_queued_units() {
        let mut l = ledger();
        l.apply_order_edit(&input(|ln| ln.quantity = 2)).unwrap();
        set_state(&l, "unit-demo-1-base", "Printed");
        let change = |ln: &mut OrderEditLine| {
            ln.quantity = 2;
            ln.part_filaments
                .insert("part-demo-base".into(), "fil-demo-white".into());
        };
        let plan = l.plan_order_edit(&input(change)).unwrap();
        assert_eq!(plan.started_color_kept, 1);
        assert!(
            !plan.needs_confirm,
            "a kept color is a warning, not a confirmation"
        );
        assert!(plan
            .warnings
            .iter()
            .any(|w| w.contains("keep their old color")));
        l.apply_order_edit(&input(change)).unwrap();
        let units = line_units(&l, "line-demo-1");
        let base1 = units.iter().find(|u| u.id == "unit-demo-1-base").unwrap();
        assert_eq!(
            base1.filament_id, "fil-demo-red",
            "printed part keeps its color"
        );
        let base2 = units
            .iter()
            .find(|u| u.part_id == "part-demo-base" && u.unit_index == 2)
            .unwrap();
        assert_eq!(base2.filament_id, "fil-demo-white");
        assert!(
            units
                .iter()
                .filter(|u| u.part_id == "part-demo-lid")
                .all(|u| u.filament_id == "fil-demo-blue"),
            "unlisted parts keep their colors"
        );
    }

    #[test]
    fn removing_a_line_with_printed_parts_needs_confirmation() {
        let mut l = ledger();
        set_state(&l, "unit-demo-1-lid", "Ready");
        let mut inp = input(|_| {});
        inp.lines = vec![OrderEditLine {
            line_id: None,
            product_id: "prod-demo-widget".into(),
            quantity: 2,
            custom_text: Some("  Hi  ".into()),
            part_filaments: HashMap::from([(
                "part-demo-lid".to_string(),
                "fil-demo-white".to_string(),
            )]),
        }];
        let plan = l.plan_order_edit(&inp).unwrap();
        assert_eq!(plan.removed_lines.len(), 1);
        assert_eq!(plan.added_lines, vec![0]);
        assert!(plan.needs_confirm);
        assert!(l.apply_order_edit(&inp).is_err());
        inp.confirm_started = true;
        l.apply_order_edit(&inp).unwrap();
        let order = l
            .snapshot()
            .unwrap()
            .orders
            .into_iter()
            .find(|o| o.id == "ord-demo-1")
            .unwrap();
        assert_eq!(order.lines.len(), 1);
        let ln = &order.lines[0];
        assert_ne!(ln.id, "line-demo-1");
        assert_eq!((ln.quantity, ln.custom_text.as_deref()), (2, Some("Hi")));
        assert_eq!(ln.units.len(), 4);
        assert!(ln
            .units
            .iter()
            .filter(|u| u.part_id == "part-demo-lid")
            .all(|u| u.filament_id == "fil-demo-white"));
        assert!(
            ln.units
                .iter()
                .filter(|u| u.part_id == "part-demo-base")
                .all(|u| u.filament_id == "fil-demo-red"),
            "catalog default"
        );
        assert_eq!(events(&l, "LineRemoved").len(), 1);
        assert!(events(&l, ORDER_EDITED_KIND)
            .iter()
            .any(|e| e.action_label.starts_with("Added 2×")));
    }

    #[test]
    fn details_and_inscription_save_and_website_ids_stay() {
        let mut l = ledger();
        l.conn
            .execute("UPDATE orders SET source = 'website', remote_id = 'store-1' WHERE id = 'ord-demo-1'", [])
            .unwrap();
        set_state(&l, "unit-demo-1-base", "Printed");
        let mut inp = input(|ln| ln.custom_text = Some("Ada".into()));
        inp.customer_name = "Sam Q. Example".into();
        inp.notes = "Gift wrap".into();
        inp.is_rush = true;
        inp.shipping_charged_cents = Some(599);
        inp.ship_by = Some("2026-12-01".into());
        let plan = l.plan_order_edit(&inp).unwrap();
        assert!(plan
            .warnings
            .iter()
            .any(|w| w.contains("inscription changed")));
        l.apply_order_edit(&inp).unwrap();
        let o = l
            .snapshot()
            .unwrap()
            .orders
            .into_iter()
            .find(|o| o.id == "ord-demo-1")
            .unwrap();
        assert_eq!(o.customer_name, "Sam Q. Example");
        assert_eq!(o.notes, "Gift wrap");
        assert!(o.is_rush);
        assert_eq!(o.shipping_charged_cents, 599);
        assert_eq!(o.ship_by.as_deref(), Some("2026-12-01"));
        assert_eq!(o.lines[0].custom_text.as_deref(), Some("Ada"));
        let (source, remote): (String, Option<String>) = l
            .conn
            .query_row(
                "SELECT source, remote_id FROM orders WHERE id = 'ord-demo-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (source.as_str(), remote.as_deref()),
            ("website", Some("store-1"))
        );
        assert!(line_units(&l, "line-demo-1")
            .iter()
            .any(|u| u.id == "unit-demo-1-base" && u.state == "Printed"));
    }

    #[test]
    fn rejects_bad_input() {
        let mut l = ledger();
        let mut inp = input(|_| {});
        inp.customer_name = "  ".into();
        assert!(l.apply_order_edit(&inp).is_err());
        let mut inp = input(|_| {});
        inp.lines.clear();
        assert!(l.apply_order_edit(&inp).is_err());
        let mut inp = input(|_| {});
        inp.order_id = "nope".into();
        assert!(l.apply_order_edit(&inp).is_err());
        let mut inp = input(|_| {});
        inp.lines.push(OrderEditLine {
            line_id: None,
            product_id: "nope".into(),
            quantity: 1,
            custom_text: None,
            part_filaments: HashMap::new(),
        });
        assert!(l.apply_order_edit(&inp).is_err());
    }
}
