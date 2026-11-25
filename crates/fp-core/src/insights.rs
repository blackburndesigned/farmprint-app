//! Insights: shop metrics over a date range, each compared with the previous period of the
//! same length, with drill-down lists and CSV export. Everything is computed here from
//! what the ledger already stores (orders, lines, part units, Flow events, filaments) plus
//! two additive records: the optional order ship-by date and the printer status log.
//!
//! Rules:
//! - Undone Flow events are left out.
//! - A metric with no data says so (`None` / empty lists); nothing is made up.
//! - Metrics built on assumptions are marked `estimate` with a note saying what they use.
//! - Ranges are `[start, end)`; dates for days/weeks and ship-by use the UI's time zone
//!   offset.

use crate::models::{CoreResult, Printer};
use crate::seed::INSIGHTS_TRACKING_KEY;
use crate::ShopLedger;
use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

// ---------------------------------------------------------------------------------------
// Printer status log
// ---------------------------------------------------------------------------------------

/// Records each printer's status when it differs from its last recorded one. Called with
/// every snapshot (which follows every change), so each change is stamped when it happens.
pub fn record_printer_statuses(conn: &Connection, printers: &[Printer]) -> CoreResult<()> {
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    for p in printers {
        let last: Option<String> = conn
            .query_row(
                "SELECT status FROM printer_status_log WHERE printer_id = ?1 ORDER BY seq DESC LIMIT 1",
                params![p.id],
                |r| r.get(0),
            )
            .optional()?;
        if last.as_deref() != Some(p.status.as_str()) {
            conn.execute(
                "INSERT INTO printer_status_log (printer_id, status, changed_at) VALUES (?1, ?2, ?3)",
                params![p.id, p.status, now],
            )?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Input data (loaded once, then every metric is a pure function of it)
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct UnitRow {
    pub id: String,
    pub part_id: String,
    pub part_name: String,
    pub state: String,
    pub filament_id: String,
    pub printer_id: Option<String>,
    pub unit_cost_cents: i64,
    pub grams: f64,
    pub print_minutes: i64,
    pub reprint_count: i64,
}

#[derive(Debug, Clone, Default)]
pub struct LineRow {
    pub product_id: String,
    pub product_name: String,
    pub quantity: i64,
    pub unit_price_cents: i64,
    pub units: Vec<UnitRow>,
}

#[derive(Debug, Clone)]
pub struct OrderRow {
    pub id: String,
    pub code: String,
    pub customer_name: String,
    pub customer_email: String,
    pub source: String,
    pub created: DateTime<Utc>,
    /// When it shipped (the ship date, else its last Shipped event); None if not shipped.
    pub shipped: Option<DateTime<Utc>>,
    /// Every part is shipped or closed (an order can be done without a ship time).
    pub done: bool,
    pub ship_by: Option<NaiveDate>,
    pub on_hold: bool,
    pub shipping_charged_cents: i64,
    pub lines: Vec<LineRow>,
}

impl OrderRow {
    pub fn merch_cents(&self) -> i64 {
        self.lines
            .iter()
            .map(|l| l.unit_price_cents * l.quantity)
            .sum()
    }
    pub fn revenue_cents(&self) -> i64 {
        self.merch_cents() + self.shipping_charged_cents
    }
    pub fn is_open(&self) -> bool {
        self.shipped.is_none() && !self.done
    }
    /// Customer key: email if there is one, else the name (case and spaces ignored).
    pub fn customer_key(&self) -> String {
        let e = self.customer_email.trim().to_lowercase();
        if !e.is_empty() {
            return e;
        }
        format!("name:{}", self.customer_name.trim().to_lowercase())
    }
}

#[derive(Debug, Clone, Default)]
pub struct EventRow {
    pub at: Option<DateTime<Utc>>,
    pub kind: String,
    pub order_id: Option<String>,
    pub order_code: Option<String>,
    pub unit_id: Option<String>,
    pub part_id: Option<String>,
    pub part_name: Option<String>,
    pub product_name: Option<String>,
    pub filament_name: String,
    pub printer_id: Option<String>,
    pub printer_name: Option<String>,
    pub failure_reason: Option<String>,
    pub cost_impact_cents: i64,
}

#[derive(Debug, Clone, Default)]
pub struct FilamentRow {
    pub id: String,
    pub name: String,
    pub material: String,
    pub hex: String,
    pub cost_per_kg: f64,
}

#[derive(Debug, Clone, Default)]
pub struct PartInfo {
    pub name: String,
    pub grams: f64,
    pub unit_cost_cents: i64,
    pub print_minutes: i64,
}

#[derive(Debug, Clone)]
pub struct StatusRow {
    pub printer_id: String,
    pub status: String,
    pub at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default)]
pub struct InsightsData {
    pub orders: Vec<OrderRow>,
    /// Not undone, oldest first.
    pub events: Vec<EventRow>,
    pub filaments: Vec<FilamentRow>,
    pub parts: HashMap<String, PartInfo>,
    pub printers: Vec<(String, String)>,
    pub status_log: Vec<StatusRow>,
    pub packaging_cost_cents: Option<i64>,
    pub default_target_days: Option<u32>,
    /// When ship-by dates and the printer status log began.
    pub tracking_since: Option<DateTime<Utc>>,
}

pub fn parse_ts(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|n| n.and_utc())
        })
        .or_else(|| {
            NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
                .ok()
                .map(|n| n.and_utc())
        })
        .or_else(|| {
            NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map(|n| n.and_utc())
        })
}

impl ShopLedger {
    /// Loads everything Insights needs.
    pub fn insights_data(&self) -> CoreResult<InsightsData> {
        let settings = self.get_settings()?;
        let conn = &self.conn;
        let mut parts: HashMap<String, PartInfo> = HashMap::new();
        {
            let mut st = conn
                .prepare("SELECT id, name, grams, unit_cost, print_minutes FROM catalog_parts")?;
            let rows = st.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, f64>(2)?,
                    r.get::<_, f64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })?;
            for r in rows {
                let (id, name, grams, cost, mins) = r?;
                parts.insert(
                    id,
                    PartInfo {
                        name,
                        grams,
                        unit_cost_cents: (cost * 100.0).round() as i64,
                        print_minutes: mins,
                    },
                );
            }
        }
        let mut filaments = Vec::new();
        {
            let mut st =
                conn.prepare("SELECT id, name, material, hex, cost_per_kg FROM filaments")?;
            let rows = st.query_map([], |r| {
                Ok(FilamentRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    material: r.get(2)?,
                    hex: r.get(3)?,
                    cost_per_kg: r.get(4)?,
                })
            })?;
            for r in rows {
                filaments.push(r?);
            }
        }
        let mut printers = Vec::new();
        {
            let mut st = conn.prepare("SELECT id, name FROM printers ORDER BY id")?;
            let rows =
                st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for r in rows {
                printers.push(r?);
            }
        }
        let mut events = Vec::new();
        {
            let mut st = conn.prepare(
                "SELECT created_at, kind, order_id, order_code, unit_id, part_id, part_name, product_name, filament_name,
                        printer_id, printer_name, failure_reason, cost_impact_cents
                 FROM flow_events WHERE undone_at IS NULL ORDER BY seq",
            )?;
            let rows = st.query_map([], |r| {
                Ok(EventRow {
                    at: parse_ts(&r.get::<_, String>(0)?),
                    kind: r.get(1)?,
                    order_id: r.get(2)?,
                    order_code: r.get(3)?,
                    unit_id: r.get(4)?,
                    part_id: r.get(5)?,
                    part_name: r.get(6)?,
                    product_name: r.get(7)?,
                    filament_name: r.get(8)?,
                    printer_id: r.get(9)?,
                    printer_name: r.get(10)?,
                    failure_reason: r.get(11)?,
                    cost_impact_cents: r.get(12)?,
                })
            })?;
            for r in rows {
                events.push(r?);
            }
        }
        let mut units_by_line: HashMap<String, Vec<UnitRow>> = HashMap::new();
        {
            let mut st = conn.prepare(
                "SELECT id, line_id, part_id, state, filament_id, printer_id, reprint_count FROM part_units ORDER BY unit_index, id",
            )?;
            let rows = st.query_map([], |r| {
                Ok((
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            })?;
            for r in rows {
                let (line, id, part_id, state, filament_id, printer_id, reprint_count) = r?;
                let info = parts.get(&part_id).cloned().unwrap_or_default();
                units_by_line.entry(line).or_default().push(UnitRow {
                    id,
                    part_name: info.name.clone(),
                    part_id,
                    state,
                    filament_id,
                    printer_id,
                    unit_cost_cents: info.unit_cost_cents,
                    grams: info.grams,
                    print_minutes: info.print_minutes,
                    reprint_count,
                });
            }
        }
        let mut lines_by_order: HashMap<String, Vec<LineRow>> = HashMap::new();
        {
            let mut st = conn.prepare(
                "SELECT l.id, l.order_id, l.product_id, COALESCE(p.name, l.item_label), l.quantity, l.unit_price_cents
                 FROM order_lines l LEFT JOIN products p ON p.id = l.product_id ORDER BY l.id",
            )?;
            let rows = st.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            })?;
            for r in rows {
                let (id, order, product_id, product_name, quantity, unit_price_cents) = r?;
                lines_by_order.entry(order).or_default().push(LineRow {
                    product_id,
                    product_name,
                    quantity,
                    unit_price_cents,
                    units: units_by_line.remove(&id).unwrap_or_default(),
                });
            }
        }
        let mut last_shipped_event: HashMap<String, DateTime<Utc>> = HashMap::new();
        for e in &events {
            if e.kind == "Shipped" {
                if let (Some(o), Some(at)) = (&e.order_id, e.at) {
                    last_shipped_event.insert(o.clone(), at);
                }
            }
        }
        let mut orders = Vec::new();
        {
            let mut st = conn.prepare(
                "SELECT id, order_code, customer_name, customer_email, source, created_at, shipped_at, ship_by, is_on_hold,
                        shipping_charged_cents, ship_status
                 FROM orders ORDER BY created_at",
            )?;
            let rows = st.query_map([], |r| {
                Ok((
                    (
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ),
                    (
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, Option<String>>(6)?,
                        r.get::<_, Option<String>>(7)?,
                    ),
                    (
                        r.get::<_, i64>(8)?,
                        r.get::<_, i64>(9)?,
                        r.get::<_, Option<String>>(10)?,
                    ),
                ))
            })?;
            for r in rows {
                let (
                    (id, code, name, email),
                    (source, created, shipped_at, ship_by),
                    (hold, ship_charged, ship_status),
                ) = r?;
                let Some(created) = parse_ts(&created) else {
                    continue;
                };
                let lines = lines_by_order.remove(&id).unwrap_or_default();
                let all_done = {
                    let mut units = lines.iter().flat_map(|l| l.units.iter()).peekable();
                    units.peek().is_some()
                        && units.all(|u| u.state == "Shipped" || u.state == "Closed")
                };
                let marked_shipped = ship_status.as_deref() == Some("shipped");
                let shipped = shipped_at.as_deref().and_then(parse_ts).or_else(|| {
                    if all_done || marked_shipped {
                        last_shipped_event.get(&id).copied()
                    } else {
                        None
                    }
                });
                orders.push(OrderRow {
                    id,
                    code,
                    customer_name: name,
                    customer_email: email,
                    source,
                    created,
                    shipped,
                    done: all_done || marked_shipped,
                    ship_by: ship_by
                        .as_deref()
                        .and_then(|s| NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok()),
                    on_hold: hold != 0,
                    shipping_charged_cents: ship_charged,
                    lines,
                });
            }
        }
        let mut status_log = Vec::new();
        {
            let mut st = conn.prepare(
                "SELECT printer_id, status, changed_at FROM printer_status_log ORDER BY seq",
            )?;
            let rows = st.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?;
            for r in rows {
                let (printer_id, status, at) = r?;
                if let Some(at) = parse_ts(&at) {
                    status_log.push(StatusRow {
                        printer_id,
                        status,
                        at,
                    });
                }
            }
        }
        let tracking_since = conn
            .query_row(
                "SELECT value_json FROM shop_settings WHERE key = ?1",
                params![INSIGHTS_TRACKING_KEY],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
            .and_then(|v| v.get("since").and_then(|s| s.as_str()).and_then(parse_ts));
        Ok(InsightsData {
            orders,
            events,
            filaments,
            parts,
            printers,
            status_log,
            packaging_cost_cents: settings.packaging_cost_cents,
            default_target_days: settings.default_target_days,
            tracking_since,
        })
    }

    pub fn insights(&self, q: &InsightsQuery) -> CoreResult<Insights> {
        Ok(compute_insights(&self.insights_data()?, q, Utc::now()))
    }

    pub fn insights_drilldown(
        &self,
        q: &InsightsQuery,
        metric: &str,
        key: Option<&str>,
    ) -> CoreResult<Table> {
        Ok(drilldown(
            &self.insights_data()?,
            q,
            Utc::now(),
            metric,
            key,
        ))
    }

    pub fn insights_csv(&self, q: &InsightsQuery, metric: Option<&str>) -> CoreResult<String> {
        Ok(insights_csv(&self.insights_data()?, q, Utc::now(), metric))
    }
}

// ---------------------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------------------

/// The date range the UI picked. `start` None = all time (no previous period).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InsightsQuery {
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    /// Minutes east of UTC (New York in winter = -300).
    #[serde(default)]
    pub tz_offset_minutes: i32,
}

#[derive(Debug, Clone, Copy)]
pub struct Range {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub prev: Option<(DateTime<Utc>, DateTime<Utc>)>,
    pub tz: i32,
    pub weekly: bool,
}

impl Range {
    pub fn contains(&self, t: DateTime<Utc>) -> bool {
        t >= self.start && t < self.end
    }
    pub fn in_prev(&self, t: DateTime<Utc>) -> bool {
        self.prev.is_some_and(|(s, e)| t >= s && t < e)
    }
    pub fn local_date(&self, t: DateTime<Utc>) -> NaiveDate {
        (t + Duration::minutes(self.tz as i64)).date_naive()
    }
    /// Day, or Monday of the week for long ranges.
    pub fn bucket(&self, t: DateTime<Utc>) -> NaiveDate {
        let d = self.local_date(t);
        if self.weekly {
            d - Duration::days(d.weekday().num_days_from_monday() as i64)
        } else {
            d
        }
    }
    pub fn buckets(&self) -> Vec<NaiveDate> {
        let mut out = Vec::new();
        let last = self.bucket(self.end - Duration::seconds(1));
        let mut d = self.bucket(self.start);
        while d <= last && out.len() < 2000 {
            out.push(d);
            d += Duration::days(if self.weekly { 7 } else { 1 });
        }
        out
    }
}

pub fn resolve_range(data: &InsightsData, q: &InsightsQuery, now: DateTime<Utc>) -> Range {
    let end = q.end.as_deref().and_then(parse_ts).unwrap_or(now);
    let explicit = q.start.as_deref().and_then(parse_ts);
    let start = explicit.unwrap_or_else(|| {
        data.orders
            .iter()
            .map(|o| o.created)
            .chain(data.events.iter().filter_map(|e| e.at))
            .min()
            .unwrap_or(end - Duration::days(30))
            .min(end)
    });
    let len = end - start;
    let prev = explicit.map(|s| (s - len, s));
    Range {
        start,
        end,
        prev,
        tz: q.tz_offset_minutes,
        weekly: len > Duration::days(62),
    }
}

// ---------------------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------------------

pub fn median(v: &[f64]) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let n = s.len();
    Some(if n % 2 == 1 {
        s[n / 2]
    } else {
        (s[n / 2 - 1] + s[n / 2]) / 2.0
    })
}

/// 90th percentile, nearest rank (the value 90 % of items are at or below).
pub fn p90(v: &[f64]) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let rank = ((0.9 * s.len() as f64).ceil() as usize).clamp(1, s.len());
    Some(s[rank - 1])
}

fn ratio(n: usize, d: usize) -> Option<f64> {
    (d > 0).then(|| n as f64 / d as f64)
}

fn hours(d: Duration) -> f64 {
    d.num_seconds() as f64 / 3600.0
}

/// Order age bucket for open orders: 0-1, 2-3, 4-7, 7+ days.
pub fn age_bucket(age_days: f64) -> &'static str {
    if age_days < 2.0 {
        "0-1"
    } else if age_days < 4.0 {
        "2-3"
    } else if age_days <= 7.0 {
        "4-7"
    } else {
        "7+"
    }
}
pub const AGE_BUCKETS: [&str; 4] = ["0-1", "2-3", "4-7", "7+"];

// ---------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------

/// One number at the top: this period and the previous one.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Headline {
    pub id: String,
    pub label: String,
    pub value: Option<f64>,
    pub previous: Option<f64>,
    /// "hours" | "pct" (0..1) | "cents" | "count"
    pub unit: String,
    /// "up" = higher is better, "down" = lower is better.
    pub better: String,
    pub estimate: bool,
    pub note: Option<String>,
    pub collecting_since: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct LeadTime {
    pub shipped: usize,
    pub median_hours: Option<f64>,
    pub p90_hours: Option<f64>,
    pub prev_median_hours: Option<f64>,
    pub prev_p90_hours: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct OnTime {
    pub with_target: usize,
    pub on_time: usize,
    pub rate: Option<f64>,
    pub prev_rate: Option<f64>,
    pub default_target_days: Option<u32>,
    pub collecting_since: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct WaitWork {
    pub orders: usize,
    pub waiting_hours: Option<f64>,
    pub printing_hours: Option<f64>,
    pub after_print_hours: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct CountRow {
    pub key: String,
    pub count: usize,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct SeriesPoint {
    pub date: String,
    pub parts_printed: usize,
    pub orders_shipped: usize,
    pub revenue_cents: i64,
    pub orders_placed: usize,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Throughput {
    pub bucket: String,
    pub parts_printed: usize,
    pub orders_shipped: usize,
    pub prev_parts_printed: Option<usize>,
    pub prev_orders_shipped: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct QueueRow {
    pub key: String,
    pub parts: usize,
    pub minutes: i64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Bottleneck {
    pub by_printer: Vec<QueueRow>,
    pub by_material: Vec<QueueRow>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct YieldRow {
    pub key: String,
    pub passed: usize,
    pub total: usize,
    pub rate: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Yield {
    pub overall: YieldRow,
    pub prev_rate: Option<f64>,
    pub by_product: Vec<YieldRow>,
    pub by_printer: Vec<YieldRow>,
    pub by_material: Vec<YieldRow>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ReasonRow {
    pub reason: String,
    pub count: usize,
    pub cost_cents: i64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Money {
    pub revenue_cents: i64,
    pub orders: usize,
    pub aov_cents: Option<f64>,
    pub prev_revenue_cents: Option<i64>,
    pub prev_orders: Option<usize>,
    pub prev_aov_cents: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ProductRow {
    pub product: String,
    pub units_sold: i64,
    pub revenue_cents: i64,
    pub cost_cents: i64,
    pub margin_pct: Option<f64>,
    pub printer_minutes: i64,
    pub revenue_share: Option<f64>,
    pub minutes_share: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ChannelRow {
    pub source: String,
    pub orders: usize,
    pub revenue_cents: i64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct CustomerRow {
    pub key: String,
    pub name: String,
    pub orders: usize,
    pub revenue_cents: i64,
    pub last_order: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Customers {
    pub customers: usize,
    pub repeat_customers: usize,
    pub repeat_rate: Option<f64>,
    pub prev_repeat_rate: Option<f64>,
    pub median_days_between_orders: Option<f64>,
    pub top: Vec<CustomerRow>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct FilamentUse {
    pub key: String,
    pub hex: Option<String>,
    pub grams: f64,
    pub cost_cents: i64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Filament {
    pub grams: f64,
    pub cost_cents: i64,
    pub by_material: Vec<FilamentUse>,
    pub by_color: Vec<FilamentUse>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct PrinterUse {
    pub printer_id: String,
    pub name: String,
    pub printing_hours: f64,
    pub observed_hours: f64,
    pub rate: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Utilization {
    pub rate: Option<f64>,
    pub prev_rate: Option<f64>,
    pub by_printer: Vec<PrinterUse>,
    pub collecting_since: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct RangeOut {
    pub start: String,
    pub end: String,
    pub prev_start: Option<String>,
    pub prev_end: Option<String>,
    pub bucket: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Insights {
    pub range: RangeOut,
    pub headline: Vec<Headline>,
    pub lead_time: LeadTime,
    pub on_time: OnTime,
    pub wait_work: WaitWork,
    pub aging: Vec<CountRow>,
    pub throughput: Throughput,
    pub series: Vec<SeriesPoint>,
    pub bottleneck: Bottleneck,
    #[serde(rename = "yield")]
    pub yield_: Yield,
    pub failures: Vec<ReasonRow>,
    pub scrap_cost_cents: i64,
    pub prev_scrap_cost_cents: Option<i64>,
    pub money: Money,
    pub products: Vec<ProductRow>,
    pub packaging_cost_set: bool,
    pub channels: Vec<ChannelRow>,
    pub customers: Customers,
    pub filament: Filament,
    pub utilization: Utilization,
}

// Notes for estimates (shown under the metric in the UI and in CSV).
pub const NOTE_WAIT_WORK: &str = "Estimate from Flow times: waiting = placed to first print start; printing = first print start to last part printed; after print = last part printed to shipped. Post-processing and packing aren't timed separately.";
pub const NOTE_SCRAP: &str = "Estimate: catalog part cost of failed prints only (no machine time, labor or filament weight).";
pub const NOTE_MARGIN: &str = "Estimate: line price minus catalog part cost, reprints and packaging (spread by line price). Shipping, machine time and labor aren't included.";
pub const NOTE_CUSTOMERS: &str =
    "Estimate: customers are matched by email, or by name when there's no email.";
pub const NOTE_FILAMENT: &str = "Estimate: catalog grams per part for each printed or failed print, priced at the filament's cost per kg. Actual use (purges, supports) isn't measured.";
pub const NOTE_PACKAGING_UNSET: &str = "Packaging cost not set (counted as 0).";

// ---------------------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------------------

struct Ctx<'a> {
    data: &'a InsightsData,
    r: Range,
    now: DateTime<Utc>,
    unit_filament: HashMap<&'a str, &'a str>,
    filament_by_id: HashMap<&'a str, &'a FilamentRow>,
    filament_by_name: HashMap<&'a str, &'a FilamentRow>,
    printer_name: HashMap<&'a str, &'a str>,
}

impl<'a> Ctx<'a> {
    fn new(data: &'a InsightsData, q: &InsightsQuery, now: DateTime<Utc>) -> Self {
        let mut unit_filament = HashMap::new();
        for o in &data.orders {
            for l in &o.lines {
                for u in &l.units {
                    unit_filament.insert(u.id.as_str(), u.filament_id.as_str());
                }
            }
        }
        Ctx {
            data,
            r: resolve_range(data, q, now),
            now,
            unit_filament,
            filament_by_id: data.filaments.iter().map(|f| (f.id.as_str(), f)).collect(),
            filament_by_name: data
                .filaments
                .iter()
                .map(|f| (f.name.as_str(), f))
                .collect(),
            printer_name: data
                .printers
                .iter()
                .map(|(i, n)| (i.as_str(), n.as_str()))
                .collect(),
        }
    }
    fn filament_of_unit(&self, unit_id: &str) -> Option<&'a FilamentRow> {
        self.unit_filament
            .get(unit_id)
            .and_then(|f| self.filament_by_id.get(f).copied())
    }
    fn filament_of_event(&self, e: &EventRow) -> Option<&'a FilamentRow> {
        e.unit_id
            .as_deref()
            .and_then(|u| self.filament_of_unit(u))
            .or_else(|| self.filament_by_name.get(e.filament_name.as_str()).copied())
    }
    fn material_of_event(&self, e: &EventRow) -> String {
        self.filament_of_event(e)
            .map(|f| f.material.clone())
            .unwrap_or_else(|| "Unknown".into())
    }
    fn printer_of_event(&self, e: &EventRow) -> String {
        e.printer_name
            .clone()
            .or_else(|| {
                e.printer_id
                    .as_deref()
                    .and_then(|p| self.printer_name.get(p))
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| "No printer".into())
    }
    fn events_in(&self, kinds: &[&str], prev: bool) -> Vec<&'a EventRow> {
        self.data
            .events
            .iter()
            .filter(|e| kinds.contains(&e.kind.as_str()))
            .filter(|e| {
                e.at.is_some_and(|t| {
                    if prev {
                        self.r.in_prev(t)
                    } else {
                        self.r.contains(t)
                    }
                })
            })
            .collect()
    }
    fn in_period(&self, t: DateTime<Utc>, prev: bool) -> bool {
        if prev {
            self.r.in_prev(t)
        } else {
            self.r.contains(t)
        }
    }
    fn shipped_orders(&self, prev: bool) -> Vec<&'a OrderRow> {
        self.data
            .orders
            .iter()
            .filter(|o| o.shipped.is_some_and(|t| self.in_period(t, prev)))
            .collect()
    }
    fn placed_orders(&self, prev: bool) -> Vec<&'a OrderRow> {
        self.data
            .orders
            .iter()
            .filter(|o| self.in_period(o.created, prev))
            .collect()
    }
    fn open_orders(&self) -> Vec<&'a OrderRow> {
        self.data
            .orders
            .iter()
            .filter(|o| o.is_open() && o.created < self.r.end && o.created >= self.r.start)
            .collect()
    }
    /// Ship-by date, else placed date + the shop's default target days; None = no target.
    fn target(&self, o: &OrderRow) -> Option<NaiveDate> {
        o.ship_by.or_else(|| {
            self.data
                .default_target_days
                .map(|d| self.r.local_date(o.created) + Duration::days(d as i64))
        })
    }
    fn on_time(&self, o: &OrderRow) -> Option<bool> {
        let t = self.target(o)?;
        Some(self.r.local_date(o.shipped?) <= t)
    }
    /// (first print start, last part printed) for an order.
    fn print_span(&self, order_id: &str) -> (Option<DateTime<Utc>>, Option<DateTime<Utc>>) {
        let mut first = None;
        let mut last = None;
        for e in &self.data.events {
            if e.order_id.as_deref() != Some(order_id) {
                continue;
            }
            let Some(t) = e.at else { continue };
            if e.kind == "StartedPrint" && first.is_none_or(|f| t < f) {
                first = Some(t);
            }
            if e.kind == "PrintedDone" && last.is_none_or(|l| t > l) {
                last = Some(t);
            }
        }
        (first, last)
    }
    fn wait_work_of(&self, o: &OrderRow) -> Option<(f64, f64, f64)> {
        let shipped = o.shipped?;
        let (first, last) = self.print_span(&o.id);
        let (first, last) = (first?, last?);
        let w = hours(first - o.created).max(0.0);
        let p = hours(last - first).max(0.0);
        let a = hours(shipped - last).max(0.0);
        Some((w, p, a))
    }
    /// First outcome (printed or failed) per part unit within the period, in time order.
    fn first_outcomes(&self, prev: bool) -> Vec<&'a EventRow> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for e in self.events_in(&["PrintedDone", "FailedPrint"], prev) {
            let key = e
                .unit_id
                .clone()
                .unwrap_or_else(|| format!("{:?}{:?}", e.at, e.part_id));
            if seen.insert(key) {
                out.push(e);
            }
        }
        out
    }
    fn packaging(&self) -> i64 {
        self.data.packaging_cost_cents.unwrap_or(0)
    }
    /// Estimated cost of one line: catalog part cost x (1 + reprints) + its share of packaging.
    fn line_cost(&self, o: &OrderRow, l: &LineRow) -> i64 {
        let parts: i64 = l
            .units
            .iter()
            .map(|u| u.unit_cost_cents * (1 + u.reprint_count))
            .sum();
        let merch = o.merch_cents();
        let line_rev = l.unit_price_cents * l.quantity;
        let pack = if merch > 0 {
            (self.packaging() as f64 * line_rev as f64 / merch as f64).round() as i64
        } else if o.lines.is_empty() {
            0
        } else {
            self.packaging() / o.lines.len() as i64
        };
        parts + pack
    }
    fn line_minutes(l: &LineRow) -> i64 {
        l.units
            .iter()
            .map(|u| u.print_minutes * (1 + u.reprint_count))
            .sum()
    }
    fn grams_of_event(&self, e: &EventRow) -> f64 {
        e.part_id
            .as_deref()
            .and_then(|p| self.data.parts.get(p))
            .map(|p| p.grams)
            .unwrap_or(0.0)
    }
    fn fmt_ts(&self, t: DateTime<Utc>) -> String {
        (t + Duration::minutes(self.r.tz as i64))
            .format("%Y-%m-%d %H:%M")
            .to_string()
    }
    fn fmt_date(&self, t: DateTime<Utc>) -> String {
        self.r.local_date(t).format("%Y-%m-%d").to_string()
    }
    fn collecting(&self, first: Option<DateTime<Utc>>) -> Option<String> {
        let since = first.or(self.data.tracking_since)?;
        (since > self.r.start).then(|| self.fmt_date(since))
    }
}

fn channel_label(source: &str) -> String {
    match source {
        "website" => "Website".into(),
        "manual" | "" => "Manual".into(),
        other => {
            let mut c = other.chars();
            c.next()
                .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                .unwrap_or_default()
        }
    }
}

fn yield_rows<F: Fn(&EventRow) -> String>(events: &[&EventRow], key: F) -> Vec<YieldRow> {
    let mut m: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for e in events {
        let s = m.entry(key(e)).or_default();
        s.1 += 1;
        if e.kind == "PrintedDone" {
            s.0 += 1;
        }
    }
    let mut v: Vec<YieldRow> = m
        .into_iter()
        .map(|(key, (passed, total))| YieldRow {
            key,
            passed,
            total,
            rate: ratio(passed, total),
        })
        .collect();
    v.sort_by(|a, b| {
        a.rate
            .unwrap_or(0.0)
            .total_cmp(&b.rate.unwrap_or(0.0))
            .then(b.total.cmp(&a.total))
    });
    v
}

fn yield_overall(events: &[&EventRow]) -> YieldRow {
    let passed = events.iter().filter(|e| e.kind == "PrintedDone").count();
    YieldRow {
        key: "All".into(),
        passed,
        total: events.len(),
        rate: ratio(passed, events.len()),
    }
}

fn failure_reason(e: &EventRow) -> String {
    e.failure_reason
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "No reason given".into())
}

// ---------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------

fn lead_hours(c: &Ctx, prev: bool) -> Vec<f64> {
    c.shipped_orders(prev)
        .iter()
        .filter_map(|o| o.shipped.map(|s| hours(s - o.created).max(0.0)))
        .collect()
}

fn on_time_counts(c: &Ctx, prev: bool) -> (usize, usize) {
    let mut with = 0;
    let mut ok = 0;
    for o in c.shipped_orders(prev) {
        if let Some(v) = c.on_time(o) {
            with += 1;
            if v {
                ok += 1;
            }
        }
    }
    (with, ok)
}

fn utilization(c: &Ctx, prev: bool) -> (Option<f64>, Vec<PrinterUse>) {
    let (start, end) = if prev {
        match c.r.prev {
            Some(p) => p,
            None => return (None, Vec::new()),
        }
    } else {
        (c.r.start, c.r.end)
    };
    let end = end.min(c.now);
    let mut rows = Vec::new();
    let (mut tp, mut to) = (0.0, 0.0);
    for (pid, name) in &c.data.printers {
        let log: Vec<&StatusRow> = c
            .data
            .status_log
            .iter()
            .filter(|s| &s.printer_id == pid)
            .collect();
        let (mut printing, mut observed) = (0.0, 0.0);
        for (i, s) in log.iter().enumerate() {
            let next = log.get(i + 1).map(|n| n.at).unwrap_or(c.now);
            let a = s.at.max(start);
            let b = next.min(end);
            if b > a {
                let h = hours(b - a);
                observed += h;
                if s.status == "Printing" {
                    printing += h;
                }
            }
        }
        tp += printing;
        to += observed;
        rows.push(PrinterUse {
            printer_id: pid.clone(),
            name: name.clone(),
            printing_hours: printing,
            observed_hours: observed,
            rate: (observed > 0.0).then(|| printing / observed),
        });
    }
    ((to > 0.0).then(|| tp / to), rows)
}

fn repeat_stats(c: &Ctx, prev: bool) -> (usize, usize) {
    let (start, end) = if prev {
        match c.r.prev {
            Some(p) => p,
            None => return (0, 0),
        }
    } else {
        (c.r.start, c.r.end)
    };
    let mut in_range: HashSet<String> = HashSet::new();
    let mut total: HashMap<String, usize> = HashMap::new();
    for o in &c.data.orders {
        if o.created < end {
            *total.entry(o.customer_key()).or_default() += 1;
            if o.created >= start {
                in_range.insert(o.customer_key());
            }
        }
    }
    let repeat = in_range
        .iter()
        .filter(|k| total.get(*k).copied().unwrap_or(0) >= 2)
        .count();
    (in_range.len(), repeat)
}

pub fn compute_insights(data: &InsightsData, q: &InsightsQuery, now: DateTime<Utc>) -> Insights {
    let c = Ctx::new(data, q, now);
    let r = c.r;
    let has_prev = r.prev.is_some();
    let prev_opt = |v: Option<f64>| if has_prev { v } else { None };

    // Speed
    let lh = lead_hours(&c, false);
    let lhp = lead_hours(&c, true);
    let lead_time = LeadTime {
        shipped: lh.len(),
        median_hours: median(&lh),
        p90_hours: p90(&lh),
        prev_median_hours: prev_opt(median(&lhp)),
        prev_p90_hours: prev_opt(p90(&lhp)),
    };
    let (with, ok) = on_time_counts(&c, false);
    let (pwith, pok) = on_time_counts(&c, true);
    let on_time = OnTime {
        with_target: with,
        on_time: ok,
        rate: ratio(ok, with),
        prev_rate: prev_opt(ratio(pok, pwith)),
        default_target_days: data.default_target_days,
        collecting_since: if data.default_target_days.is_none() {
            c.collecting(None)
        } else {
            None
        },
    };
    let ww: Vec<(f64, f64, f64)> = c
        .shipped_orders(false)
        .iter()
        .filter_map(|o| c.wait_work_of(o))
        .collect();
    let wait_work = WaitWork {
        orders: ww.len(),
        waiting_hours: median(&ww.iter().map(|x| x.0).collect::<Vec<_>>()),
        printing_hours: median(&ww.iter().map(|x| x.1).collect::<Vec<_>>()),
        after_print_hours: median(&ww.iter().map(|x| x.2).collect::<Vec<_>>()),
    };
    let mut aging_counts: BTreeMap<&str, usize> = AGE_BUCKETS.iter().map(|b| (*b, 0)).collect();
    for o in c.open_orders() {
        *aging_counts
            .entry(age_bucket(hours(now - o.created) / 24.0))
            .or_default() += 1;
    }
    let aging = AGE_BUCKETS
        .iter()
        .map(|b| CountRow {
            key: b.to_string(),
            count: aging_counts[b],
        })
        .collect();

    let printed = c.events_in(&["PrintedDone"], false);
    let printed_prev = c.events_in(&["PrintedDone"], true);
    let shipped = c.shipped_orders(false);
    let throughput = Throughput {
        bucket: if r.weekly {
            "week".into()
        } else {
            "day".into()
        },
        parts_printed: printed.len(),
        orders_shipped: shipped.len(),
        prev_parts_printed: has_prev.then_some(printed_prev.len()),
        prev_orders_shipped: has_prev.then(|| c.shipped_orders(true).len()),
    };
    let placed = c.placed_orders(false);
    let mut series_map: BTreeMap<NaiveDate, SeriesPoint> = r
        .buckets()
        .into_iter()
        .map(|d| {
            (
                d,
                SeriesPoint {
                    date: d.format("%Y-%m-%d").to_string(),
                    ..Default::default()
                },
            )
        })
        .collect();
    for e in &printed {
        if let Some(p) = e.at.and_then(|t| series_map.get_mut(&r.bucket(t))) {
            p.parts_printed += 1;
        }
    }
    for o in &shipped {
        if let Some(p) = o.shipped.and_then(|t| series_map.get_mut(&r.bucket(t))) {
            p.orders_shipped += 1;
        }
    }
    for o in &placed {
        if let Some(p) = series_map.get_mut(&r.bucket(o.created)) {
            p.orders_placed += 1;
            p.revenue_cents += o.revenue_cents();
        }
    }
    let series = series_map.into_values().collect();

    // Live bottleneck: parts waiting or on a printer, for open orders not on hold.
    let mut by_printer: BTreeMap<String, QueueRow> = BTreeMap::new();
    let mut by_material: BTreeMap<String, QueueRow> = BTreeMap::new();
    for o in data.orders.iter().filter(|o| o.is_open() && !o.on_hold) {
        for u in o.lines.iter().flat_map(|l| l.units.iter()) {
            let waiting = matches!(u.state.as_str(), "Queued" | "Staged");
            let on_printer = matches!(u.state.as_str(), "Staged" | "Printing");
            if on_printer {
                if let Some(pid) = &u.printer_id {
                    let name = c
                        .printer_name
                        .get(pid.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| pid.clone());
                    let q = by_printer.entry(name.clone()).or_insert_with(|| QueueRow {
                        key: name,
                        ..Default::default()
                    });
                    q.parts += 1;
                    q.minutes += u.print_minutes;
                }
            }
            if waiting {
                let mat = c
                    .filament_by_id
                    .get(u.filament_id.as_str())
                    .map(|f| f.material.clone())
                    .unwrap_or_else(|| "Unknown".into());
                let q = by_material.entry(mat.clone()).or_insert_with(|| QueueRow {
                    key: mat,
                    ..Default::default()
                });
                q.parts += 1;
                q.minutes += u.print_minutes;
            }
        }
    }
    let sort_q = |m: BTreeMap<String, QueueRow>| {
        let mut v: Vec<QueueRow> = m.into_values().collect();
        v.sort_by(|a, b| b.minutes.cmp(&a.minutes).then(b.parts.cmp(&a.parts)));
        v
    };
    let bottleneck = Bottleneck {
        by_printer: sort_q(by_printer),
        by_material: sort_q(by_material),
    };

    // Quality
    let fo = c.first_outcomes(false);
    let fo_prev = c.first_outcomes(true);
    let yield_ = Yield {
        overall: yield_overall(&fo),
        prev_rate: prev_opt(yield_overall(&fo_prev).rate),
        by_product: yield_rows(&fo, |e| {
            e.product_name.clone().unwrap_or_else(|| "Unknown".into())
        }),
        by_printer: yield_rows(&fo, |e| c.printer_of_event(e)),
        by_material: yield_rows(&fo, |e| c.material_of_event(e)),
    };
    let failed = c.events_in(&["FailedPrint"], false);
    let mut reasons: BTreeMap<String, ReasonRow> = BTreeMap::new();
    for e in &failed {
        let k = failure_reason(e);
        let row = reasons.entry(k.clone()).or_insert_with(|| ReasonRow {
            reason: k,
            ..Default::default()
        });
        row.count += 1;
        row.cost_cents += e.cost_impact_cents;
    }
    let mut failures: Vec<ReasonRow> = reasons.into_values().collect();
    failures.sort_by(|a, b| b.count.cmp(&a.count).then(b.cost_cents.cmp(&a.cost_cents)));
    let scrap_cost_cents: i64 = failed.iter().map(|e| e.cost_impact_cents).sum();
    let prev_scrap_cost_cents = has_prev.then(|| {
        c.events_in(&["FailedPrint"], true)
            .iter()
            .map(|e| e.cost_impact_cents)
            .sum()
    });

    // Money
    let placed_prev = c.placed_orders(true);
    let rev: i64 = placed.iter().map(|o| o.revenue_cents()).sum();
    let rev_prev: i64 = placed_prev.iter().map(|o| o.revenue_cents()).sum();
    let money = Money {
        revenue_cents: rev,
        orders: placed.len(),
        aov_cents: (!placed.is_empty()).then(|| rev as f64 / placed.len() as f64),
        prev_revenue_cents: has_prev.then_some(rev_prev),
        prev_orders: has_prev.then_some(placed_prev.len()),
        prev_aov_cents: if has_prev && !placed_prev.is_empty() {
            Some(rev_prev as f64 / placed_prev.len() as f64)
        } else {
            None
        },
    };
    let mut prod: BTreeMap<String, ProductRow> = BTreeMap::new();
    for o in &placed {
        for l in &o.lines {
            let row = prod
                .entry(l.product_name.clone())
                .or_insert_with(|| ProductRow {
                    product: l.product_name.clone(),
                    ..Default::default()
                });
            row.units_sold += l.quantity;
            row.revenue_cents += l.unit_price_cents * l.quantity;
            row.cost_cents += c.line_cost(o, l);
            row.printer_minutes += Ctx::line_minutes(l);
        }
    }
    let total_rev: i64 = prod.values().map(|p| p.revenue_cents).sum();
    let total_min: i64 = prod.values().map(|p| p.printer_minutes).sum();
    let mut products: Vec<ProductRow> = prod
        .into_values()
        .map(|mut p| {
            p.margin_pct = (p.revenue_cents > 0)
                .then(|| (p.revenue_cents - p.cost_cents) as f64 / p.revenue_cents as f64);
            p.revenue_share = (total_rev > 0).then(|| p.revenue_cents as f64 / total_rev as f64);
            p.minutes_share = (total_min > 0).then(|| p.printer_minutes as f64 / total_min as f64);
            p
        })
        .collect();
    products.sort_by(|a, b| {
        b.revenue_cents
            .cmp(&a.revenue_cents)
            .then(a.product.cmp(&b.product))
    });
    let mut ch: BTreeMap<String, ChannelRow> = BTreeMap::new();
    for o in &placed {
        let k = channel_label(&o.source);
        let row = ch.entry(k.clone()).or_insert_with(|| ChannelRow {
            source: k,
            ..Default::default()
        });
        row.orders += 1;
        row.revenue_cents += o.revenue_cents();
    }
    let mut channels: Vec<ChannelRow> = ch.into_values().collect();
    channels.sort_by_key(|c| std::cmp::Reverse(c.revenue_cents));

    // Customers
    let (cust, rep) = repeat_stats(&c, false);
    let (pcust, prep) = repeat_stats(&c, true);
    let mut by_cust: HashMap<String, Vec<&OrderRow>> = HashMap::new();
    for o in data.orders.iter().filter(|o| o.created < r.end) {
        by_cust.entry(o.customer_key()).or_default().push(o);
    }
    let mut gaps = Vec::new();
    for list in by_cust.values() {
        let mut ts: Vec<DateTime<Utc>> = list.iter().map(|o| o.created).collect();
        ts.sort();
        for w in ts.windows(2) {
            if r.contains(w[1]) {
                gaps.push(hours(w[1] - w[0]) / 24.0);
            }
        }
    }
    let mut top: HashMap<String, CustomerRow> = HashMap::new();
    for o in &placed {
        let k = o.customer_key();
        let row = top.entry(k.clone()).or_insert_with(|| CustomerRow {
            key: k,
            ..Default::default()
        });
        if row.name.is_empty() {
            row.name = if o.customer_name.trim().is_empty() {
                o.customer_email.clone()
            } else {
                o.customer_name.clone()
            };
        }
        row.orders += 1;
        row.revenue_cents += o.revenue_cents();
        let d = c.fmt_date(o.created);
        if d > row.last_order {
            row.last_order = d;
        }
    }
    let mut top: Vec<CustomerRow> = top.into_values().collect();
    top.sort_by(|a, b| {
        b.revenue_cents
            .cmp(&a.revenue_cents)
            .then(b.orders.cmp(&a.orders))
            .then(a.name.cmp(&b.name))
    });
    top.truncate(10);
    let customers = Customers {
        customers: cust,
        repeat_customers: rep,
        repeat_rate: ratio(rep, cust),
        prev_repeat_rate: prev_opt(ratio(prep, pcust)),
        median_days_between_orders: median(&gaps),
        top,
    };

    // Materials
    let mut fil_mat: BTreeMap<String, FilamentUse> = BTreeMap::new();
    let mut fil_col: BTreeMap<String, FilamentUse> = BTreeMap::new();
    let (mut grams, mut fcost) = (0.0, 0.0);
    for e in c.events_in(&["PrintedDone", "FailedPrint"], false) {
        let g = c.grams_of_event(e);
        let f = c.filament_of_event(e);
        let cost = f.map(|f| g / 1000.0 * f.cost_per_kg * 100.0).unwrap_or(0.0);
        grams += g;
        fcost += cost;
        let mat = f
            .map(|f| f.material.clone())
            .unwrap_or_else(|| "Unknown".into());
        let col = f
            .map(|f| f.name.clone())
            .unwrap_or_else(|| e.filament_name.clone());
        let m = fil_mat.entry(mat.clone()).or_insert_with(|| FilamentUse {
            key: mat,
            ..Default::default()
        });
        m.grams += g;
        m.cost_cents += cost.round() as i64;
        let k = fil_col.entry(col.clone()).or_insert_with(|| FilamentUse {
            key: col,
            hex: f.map(|f| f.hex.clone()),
            ..Default::default()
        });
        k.grams += g;
        k.cost_cents += cost.round() as i64;
    }
    let sort_f = |m: BTreeMap<String, FilamentUse>| {
        let mut v: Vec<FilamentUse> = m.into_values().collect();
        v.sort_by(|a, b| b.grams.total_cmp(&a.grams));
        v
    };
    let filament = Filament {
        grams,
        cost_cents: fcost.round() as i64,
        by_material: sort_f(fil_mat),
        by_color: sort_f(fil_col),
    };

    // Utilization
    let (urate, by_printer_use) = utilization(&c, false);
    let (uprev, _) = utilization(&c, true);
    let first_log = data.status_log.iter().map(|s| s.at).min();
    let utilization = Utilization {
        rate: urate,
        prev_rate: prev_opt(uprev),
        by_printer: by_printer_use,
        collecting_since: c.collecting(first_log),
    };

    let packaging_cost_set = data.packaging_cost_cents.is_some();
    let h = |id: &str,
             label: &str,
             value: Option<f64>,
             previous: Option<f64>,
             unit: &str,
             better: &str| Headline {
        id: id.into(),
        label: label.into(),
        value,
        previous,
        unit: unit.into(),
        better: better.into(),
        estimate: false,
        note: None,
        collecting_since: None,
    };
    let mut headline = vec![
        h(
            "lead_time",
            "Lead time (median)",
            lead_time.median_hours,
            lead_time.prev_median_hours,
            "hours",
            "down",
        ),
        Headline {
            collecting_since: on_time.collecting_since.clone(),
            ..h(
                "on_time",
                "On time",
                on_time.rate,
                on_time.prev_rate,
                "pct",
                "up",
            )
        },
        h(
            "throughput",
            "Parts printed",
            Some(throughput.parts_printed as f64),
            throughput.prev_parts_printed.map(|v| v as f64),
            "count",
            "up",
        ),
        h(
            "yield",
            "First-pass yield",
            yield_.overall.rate,
            yield_.prev_rate,
            "pct",
            "up",
        ),
        h(
            "revenue",
            "Revenue",
            Some(money.revenue_cents as f64),
            money.prev_revenue_cents.map(|v| v as f64),
            "cents",
            "up",
        ),
        h(
            "orders",
            "Orders",
            Some(money.orders as f64),
            money.prev_orders.map(|v| v as f64),
            "count",
            "up",
        ),
        h(
            "aov",
            "Avg order value",
            money.aov_cents,
            money.prev_aov_cents,
            "cents",
            "up",
        ),
        Headline {
            collecting_since: utilization.collecting_since.clone(),
            ..h(
                "utilization",
                "Printer utilization",
                utilization.rate,
                utilization.prev_rate,
                "pct",
                "up",
            )
        },
        Headline {
            estimate: true,
            note: Some(NOTE_CUSTOMERS.into()),
            ..h(
                "repeat_rate",
                "Repeat customers",
                customers.repeat_rate,
                customers.prev_repeat_rate,
                "pct",
                "up",
            )
        },
        Headline {
            estimate: true,
            note: Some(NOTE_SCRAP.into()),
            ..h(
                "scrap",
                "Scrap cost",
                Some(scrap_cost_cents as f64),
                prev_scrap_cost_cents.map(|v| v as f64),
                "cents",
                "down",
            )
        },
    ];
    // A zero count with nothing in the range is still a real number; only rates/medians go blank.
    for x in &mut headline {
        if x.previous.is_some() && !has_prev {
            x.previous = None;
        }
    }

    Insights {
        range: RangeOut {
            start: r.start.to_rfc3339(),
            end: r.end.to_rfc3339(),
            prev_start: r.prev.map(|p| p.0.to_rfc3339()),
            prev_end: r.prev.map(|p| p.1.to_rfc3339()),
            bucket: throughput.bucket.clone(),
        },
        headline,
        lead_time,
        on_time,
        wait_work,
        aging,
        throughput,
        series,
        bottleneck,
        yield_,
        failures,
        scrap_cost_cents,
        prev_scrap_cost_cents,
        money,
        products,
        packaging_cost_set,
        channels,
        customers,
        filament,
        utilization,
    }
}

// ---------------------------------------------------------------------------------------
// Drill-down tables and CSV
// ---------------------------------------------------------------------------------------

/// Rows behind a number. `order_ids[i]` lets the UI open the order for row `i`.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Table {
    pub title: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub order_ids: Vec<Option<String>>,
}

impl Table {
    fn new(title: &str, cols: &[&str]) -> Self {
        Table {
            title: title.into(),
            columns: cols.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }
    fn push(&mut self, order: Option<&str>, row: Vec<String>) {
        self.rows.push(row);
        self.order_ids.push(order.map(|s| s.to_string()));
    }
}

fn money(c: i64) -> String {
    let sign = if c < 0 { "-" } else { "" };
    format!("{sign}{}.{:02}", c.abs() / 100, c.abs() % 100)
}
fn money_f(c: Option<f64>) -> String {
    c.map(|v| money(v.round() as i64)).unwrap_or_default()
}
fn num1(v: Option<f64>) -> String {
    v.map(|v| format!("{v:.1}")).unwrap_or_default()
}
fn pct(v: Option<f64>) -> String {
    v.map(|v| format!("{:.1}%", v * 100.0)).unwrap_or_default()
}

/// The CSV metrics, in export order.
pub const CSV_METRICS: [&str; 16] = [
    "lead_time",
    "on_time",
    "wait_work",
    "aging",
    "throughput",
    "bottleneck",
    "yield",
    "failures",
    "revenue",
    "channel",
    "products",
    "customers",
    "repeat_rate",
    "filament",
    "utilization",
    "scrap",
];

pub fn drilldown(
    data: &InsightsData,
    q: &InsightsQuery,
    now: DateTime<Utc>,
    metric: &str,
    key: Option<&str>,
) -> Table {
    let c = Ctx::new(data, q, now);
    let key = key.filter(|k| !k.is_empty());
    match metric {
        "lead_time" | "on_time" | "wait_work" | "orders_shipped" => {
            let mut t = Table::new(
                "Orders shipped",
                &[
                    "Order",
                    "Customer",
                    "Placed",
                    "Shipped",
                    "Lead time (h)",
                    "Target",
                    "On time",
                    "Waiting (h)",
                    "Printing (h)",
                    "After print (h)",
                ],
            );
            for o in c.shipped_orders(false) {
                let ot = c.on_time(o);
                if metric == "on_time" {
                    match key {
                        Some("late") if ot != Some(false) => continue,
                        Some("on_time") if ot != Some(true) => continue,
                        _ => {}
                    }
                }
                let ww = c.wait_work_of(o);
                t.push(
                    Some(&o.id),
                    vec![
                        o.code.clone(),
                        o.customer_name.clone(),
                        c.fmt_ts(o.created),
                        o.shipped.map(|s| c.fmt_ts(s)).unwrap_or_default(),
                        num1(o.shipped.map(|s| hours(s - o.created))),
                        c.target(o)
                            .map(|d| d.format("%Y-%m-%d").to_string())
                            .unwrap_or_default(),
                        match ot {
                            Some(true) => "Yes".into(),
                            Some(false) => "No".into(),
                            None => String::new(),
                        },
                        num1(ww.map(|x| x.0)),
                        num1(ww.map(|x| x.1)),
                        num1(ww.map(|x| x.2)),
                    ],
                );
            }
            t
        }
        "aging" => {
            let mut t = Table::new(
                "Open orders by age",
                &[
                    "Order",
                    "Customer",
                    "Placed",
                    "Age (days)",
                    "Bucket",
                    "Parts left",
                    "Ship by",
                ],
            );
            for o in c.open_orders() {
                let age = hours(now - o.created) / 24.0;
                let b = age_bucket(age);
                if key.is_some_and(|k| k != b) {
                    continue;
                }
                let left = o
                    .lines
                    .iter()
                    .flat_map(|l| l.units.iter())
                    .filter(|u| !matches!(u.state.as_str(), "Shipped" | "Closed"))
                    .count();
                t.push(
                    Some(&o.id),
                    vec![
                        o.code.clone(),
                        o.customer_name.clone(),
                        c.fmt_ts(o.created),
                        format!("{age:.1}"),
                        b.into(),
                        left.to_string(),
                        c.target(o)
                            .map(|d| d.format("%Y-%m-%d").to_string())
                            .unwrap_or_default(),
                    ],
                );
            }
            t
        }
        "throughput" | "yield" | "failures" | "scrap" | "filament" => {
            let (title, events): (&str, Vec<&EventRow>) = match metric {
                "throughput" => ("Parts printed", c.events_in(&["PrintedDone"], false)),
                "yield" => ("First print outcome per part", c.first_outcomes(false)),
                "failures" | "scrap" => ("Failed prints", c.events_in(&["FailedPrint"], false)),
                _ => (
                    "Prints (filament estimate)",
                    c.events_in(&["PrintedDone", "FailedPrint"], false),
                ),
            };
            let mut t = Table::new(
                title,
                &[
                    "When",
                    "Result",
                    "Order",
                    "Product",
                    "Part",
                    "Printer",
                    "Material",
                    "Color",
                    "Reason",
                    "Part cost",
                    "Grams (est.)",
                ],
            );
            for e in events {
                let product = e.product_name.clone().unwrap_or_default();
                let printer = c.printer_of_event(e);
                let material = c.material_of_event(e);
                let color = c
                    .filament_of_event(e)
                    .map(|f| f.name.clone())
                    .unwrap_or_else(|| e.filament_name.clone());
                let reason = if e.kind == "FailedPrint" {
                    failure_reason(e)
                } else {
                    String::new()
                };
                if let Some(k) = key {
                    let keep = match k.split_once(':') {
                        Some(("product", v)) => product == v,
                        Some(("printer", v)) => printer == v,
                        Some(("material", v)) => material == v,
                        Some(("color", v)) => color == v,
                        Some(("date", v)) => {
                            e.at.is_some_and(|t| c.r.bucket(t).format("%Y-%m-%d").to_string() == v)
                        }
                        _ => reason == k,
                    };
                    if !keep {
                        continue;
                    }
                }
                let cost = if e.kind == "FailedPrint" {
                    e.cost_impact_cents
                } else {
                    e.part_id
                        .as_deref()
                        .and_then(|p| data.parts.get(p))
                        .map(|p| p.unit_cost_cents)
                        .unwrap_or(0)
                };
                t.push(
                    e.order_id.as_deref(),
                    vec![
                        e.at.map(|t| c.fmt_ts(t)).unwrap_or_default(),
                        if e.kind == "FailedPrint" {
                            "Failed".into()
                        } else {
                            "Printed".into()
                        },
                        e.order_code.clone().unwrap_or_default(),
                        product,
                        e.part_name.clone().unwrap_or_default(),
                        printer,
                        material,
                        color,
                        reason,
                        money(cost),
                        format!("{:.0}", c.grams_of_event(e)),
                    ],
                );
            }
            t
        }
        "bottleneck" => {
            let mut t = Table::new(
                "Parts waiting now",
                &[
                    "Order",
                    "Product",
                    "Part",
                    "State",
                    "Printer",
                    "Material",
                    "Print minutes",
                ],
            );
            for o in data.orders.iter().filter(|o| o.is_open() && !o.on_hold) {
                for l in &o.lines {
                    for u in &l.units {
                        if !matches!(u.state.as_str(), "Queued" | "Staged" | "Printing") {
                            continue;
                        }
                        let printer = u
                            .printer_id
                            .as_deref()
                            .map(|p| {
                                c.printer_name
                                    .get(p)
                                    .map(|s| s.to_string())
                                    .unwrap_or_else(|| p.to_string())
                            })
                            .unwrap_or_default();
                        let material = c
                            .filament_by_id
                            .get(u.filament_id.as_str())
                            .map(|f| f.material.clone())
                            .unwrap_or_else(|| "Unknown".into());
                        let keep = match key.and_then(|k| k.split_once(':')) {
                            Some(("printer", v)) => {
                                printer == v && matches!(u.state.as_str(), "Staged" | "Printing")
                            }
                            Some(("material", v)) => {
                                material == v && matches!(u.state.as_str(), "Queued" | "Staged")
                            }
                            _ => true,
                        };
                        if keep {
                            t.push(
                                Some(&o.id),
                                vec![
                                    o.code.clone(),
                                    l.product_name.clone(),
                                    u.part_name.clone(),
                                    u.state.clone(),
                                    printer,
                                    material,
                                    u.print_minutes.to_string(),
                                ],
                            );
                        }
                    }
                }
            }
            t
        }
        "revenue" | "orders" | "aov" | "channel" | "customers" | "repeat_rate" => {
            let mut t = Table::new(
                "Orders placed",
                &[
                    "Order", "Placed", "Customer", "Email", "Channel", "Items", "Revenue", "Status",
                ],
            );
            for o in c.placed_orders(false) {
                if let Some(k) = key {
                    let keep = match metric {
                        "channel" => channel_label(&o.source) == k,
                        "customers" | "repeat_rate" => o.customer_key() == k,
                        _ => c.r.bucket(o.created).format("%Y-%m-%d").to_string() == k,
                    };
                    if !keep {
                        continue;
                    }
                }
                let items: i64 = o.lines.iter().map(|l| l.quantity).sum();
                let status = if o.shipped.is_some() || o.done {
                    "Shipped"
                } else if o.on_hold {
                    "On hold"
                } else {
                    "Open"
                };
                t.push(
                    Some(&o.id),
                    vec![
                        o.code.clone(),
                        c.fmt_ts(o.created),
                        o.customer_name.clone(),
                        o.customer_email.clone(),
                        channel_label(&o.source),
                        items.to_string(),
                        money(o.revenue_cents()),
                        status.into(),
                    ],
                );
            }
            t
        }
        "products" | "margin" | "mix" => {
            let mut t = Table::new(
                "Order lines",
                &[
                    "Order",
                    "Placed",
                    "Product",
                    "Qty",
                    "Revenue",
                    "Est. cost",
                    "Est. margin",
                    "Printer minutes",
                ],
            );
            for o in c.placed_orders(false) {
                for l in &o.lines {
                    if key.is_some_and(|k| k != l.product_name) {
                        continue;
                    }
                    let rev = l.unit_price_cents * l.quantity;
                    let cost = c.line_cost(o, l);
                    t.push(
                        Some(&o.id),
                        vec![
                            o.code.clone(),
                            c.fmt_ts(o.created),
                            l.product_name.clone(),
                            l.quantity.to_string(),
                            money(rev),
                            money(cost),
                            pct((rev > 0).then(|| (rev - cost) as f64 / rev as f64)),
                            Ctx::line_minutes(l).to_string(),
                        ],
                    );
                }
            }
            t
        }
        "utilization" => {
            let mut t = Table::new(
                "Printer status history",
                &["Printer", "Status", "From", "To", "Hours in range"],
            );
            let end = c.r.end.min(now);
            for (pid, name) in &data.printers {
                if key.is_some_and(|k| k != pid) {
                    continue;
                }
                let log: Vec<&StatusRow> = data
                    .status_log
                    .iter()
                    .filter(|s| &s.printer_id == pid)
                    .collect();
                for (i, s) in log.iter().enumerate() {
                    let next = log.get(i + 1).map(|n| n.at);
                    let a = s.at.max(c.r.start);
                    let b = next.unwrap_or(now).min(end);
                    if b <= a {
                        continue;
                    }
                    t.push(
                        None,
                        vec![
                            name.clone(),
                            s.status.clone(),
                            c.fmt_ts(s.at),
                            next.map(|n| c.fmt_ts(n)).unwrap_or_else(|| "now".into()),
                            num1(Some(hours(b - a))),
                        ],
                    );
                }
            }
            t
        }
        _ => Table::new("Not enough data", &[]),
    }
}

/// The summary rows for one metric (what the chart shows).
pub fn summary(ins: &Insights, metric: &str) -> Table {
    match metric {
        "lead_time" => {
            let mut t = Table::new(
                "Lead time (placed to shipped)",
                &["Measure", "This period", "Previous period"],
            );
            let l = &ins.lead_time;
            t.push(
                None,
                vec![
                    "Orders shipped".into(),
                    l.shipped.to_string(),
                    String::new(),
                ],
            );
            t.push(
                None,
                vec![
                    "Median (h)".into(),
                    num1(l.median_hours),
                    num1(l.prev_median_hours),
                ],
            );
            t.push(
                None,
                vec!["P90 (h)".into(), num1(l.p90_hours), num1(l.prev_p90_hours)],
            );
            t
        }
        "on_time" => {
            let mut t = Table::new("On time", &["Measure", "This period", "Previous period"]);
            let o = &ins.on_time;
            t.push(
                None,
                vec![
                    "Shipped with a target".into(),
                    o.with_target.to_string(),
                    String::new(),
                ],
            );
            t.push(
                None,
                vec!["On time".into(), o.on_time.to_string(), String::new()],
            );
            t.push(
                None,
                vec!["On-time rate".into(), pct(o.rate), pct(o.prev_rate)],
            );
            t
        }
        "wait_work" => {
            let mut t = Table::new("Wait vs work (estimate, median hours)", &["Stage", "Hours"]);
            let w = &ins.wait_work;
            t.push(None, vec!["Waiting to start".into(), num1(w.waiting_hours)]);
            t.push(None, vec!["Printing".into(), num1(w.printing_hours)]);
            t.push(
                None,
                vec!["After printing".into(), num1(w.after_print_hours)],
            );
            t
        }
        "aging" => {
            let mut t = Table::new("Open orders by age (days)", &["Age", "Orders"]);
            for r in &ins.aging {
                t.push(None, vec![r.key.clone(), r.count.to_string()]);
            }
            t
        }
        "throughput" | "revenue" | "orders" | "aov" => {
            let mut t = Table::new(
                &format!("By {}", ins.throughput.bucket),
                &[
                    "Date",
                    "Parts printed",
                    "Orders shipped",
                    "Orders placed",
                    "Revenue",
                ],
            );
            for p in &ins.series {
                t.push(
                    None,
                    vec![
                        p.date.clone(),
                        p.parts_printed.to_string(),
                        p.orders_shipped.to_string(),
                        p.orders_placed.to_string(),
                        money(p.revenue_cents),
                    ],
                );
            }
            t
        }
        "bottleneck" => {
            let mut t = Table::new(
                "Queue right now",
                &["Group", "Name", "Parts", "Print minutes"],
            );
            for r in &ins.bottleneck.by_printer {
                t.push(
                    None,
                    vec![
                        "Printer".into(),
                        r.key.clone(),
                        r.parts.to_string(),
                        r.minutes.to_string(),
                    ],
                );
            }
            for r in &ins.bottleneck.by_material {
                t.push(
                    None,
                    vec![
                        "Material".into(),
                        r.key.clone(),
                        r.parts.to_string(),
                        r.minutes.to_string(),
                    ],
                );
            }
            t
        }
        "yield" => {
            let mut t = Table::new(
                "First-pass yield",
                &["Group", "Name", "Passed", "Total", "Yield"],
            );
            let y = &ins.yield_;
            t.push(
                None,
                vec![
                    "All".into(),
                    "All".into(),
                    y.overall.passed.to_string(),
                    y.overall.total.to_string(),
                    pct(y.overall.rate),
                ],
            );
            for (g, rows) in [
                ("Product", &y.by_product),
                ("Printer", &y.by_printer),
                ("Material", &y.by_material),
            ] {
                for r in rows {
                    t.push(
                        None,
                        vec![
                            g.into(),
                            r.key.clone(),
                            r.passed.to_string(),
                            r.total.to_string(),
                            pct(r.rate),
                        ],
                    );
                }
            }
            t
        }
        "failures" | "scrap" => {
            let mut t = Table::new(
                "Failure reasons",
                &["Reason", "Failed prints", "Scrap cost (estimate)"],
            );
            for r in &ins.failures {
                t.push(
                    None,
                    vec![r.reason.clone(), r.count.to_string(), money(r.cost_cents)],
                );
            }
            t
        }
        "channel" => {
            let mut t = Table::new("Sales channels", &["Channel", "Orders", "Revenue"]);
            for r in &ins.channels {
                t.push(
                    None,
                    vec![
                        r.source.clone(),
                        r.orders.to_string(),
                        money(r.revenue_cents),
                    ],
                );
            }
            t
        }
        "products" | "margin" | "mix" => {
            let mut t = Table::new(
                "Products (margin is an estimate)",
                &[
                    "Product",
                    "Units sold",
                    "Revenue",
                    "Est. cost",
                    "Est. margin",
                    "Printer minutes",
                    "Revenue share",
                    "Printer time share",
                ],
            );
            for p in &ins.products {
                t.push(
                    None,
                    vec![
                        p.product.clone(),
                        p.units_sold.to_string(),
                        money(p.revenue_cents),
                        money(p.cost_cents),
                        pct(p.margin_pct),
                        p.printer_minutes.to_string(),
                        pct(p.revenue_share),
                        pct(p.minutes_share),
                    ],
                );
            }
            t
        }
        "customers" | "repeat_rate" => {
            let mut t = Table::new(
                "Top customers (estimate)",
                &["Customer", "Orders", "Revenue", "Last order"],
            );
            for r in &ins.customers.top {
                t.push(
                    None,
                    vec![
                        r.name.clone(),
                        r.orders.to_string(),
                        money(r.revenue_cents),
                        r.last_order.clone(),
                    ],
                );
            }
            t
        }
        "filament" => {
            let mut t = Table::new(
                "Filament used (estimate)",
                &["Group", "Name", "Grams", "Cost"],
            );
            for r in &ins.filament.by_material {
                t.push(
                    None,
                    vec![
                        "Material".into(),
                        r.key.clone(),
                        format!("{:.0}", r.grams),
                        money(r.cost_cents),
                    ],
                );
            }
            for r in &ins.filament.by_color {
                t.push(
                    None,
                    vec![
                        "Color".into(),
                        r.key.clone(),
                        format!("{:.0}", r.grams),
                        money(r.cost_cents),
                    ],
                );
            }
            t
        }
        "utilization" => {
            let mut t = Table::new(
                "Printer utilization",
                &["Printer", "Printing (h)", "Observed (h)", "Utilization"],
            );
            for r in &ins.utilization.by_printer {
                t.push(
                    None,
                    vec![
                        r.name.clone(),
                        num1(Some(r.printing_hours)),
                        num1(Some(r.observed_hours)),
                        pct(r.rate),
                    ],
                );
            }
            t
        }
        _ => Table::new("Not enough data", &[]),
    }
}

fn csv_cell(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn write_table(out: &mut String, t: &Table) {
    out.push_str(&csv_cell(&format!("# {}", t.title)));
    out.push_str("\r\n");
    if !t.columns.is_empty() {
        out.push_str(
            &t.columns
                .iter()
                .map(|c| csv_cell(c))
                .collect::<Vec<_>>()
                .join(","),
        );
        out.push_str("\r\n");
    }
    if t.rows.is_empty() {
        out.push_str("Not enough data\r\n");
    }
    for r in &t.rows {
        out.push_str(&r.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(","));
        out.push_str("\r\n");
    }
    out.push_str("\r\n");
}

/// CSV for one metric (summary + the rows behind it) or, with `None`, every metric plus
/// the list of orders placed in the range.
pub fn insights_csv(
    data: &InsightsData,
    q: &InsightsQuery,
    now: DateTime<Utc>,
    metric: Option<&str>,
) -> String {
    let ins = compute_insights(data, q, now);
    let mut out = String::new();
    out.push_str(&format!(
        "# FarmPrint Insights,{},{}\r\n",
        csv_cell(&ins.range.start),
        csv_cell(&ins.range.end)
    ));
    let mut head = Table::new(
        "Headline",
        &[
            "Metric",
            "This period",
            "Previous period",
            "Unit",
            "Estimate",
            "Note",
        ],
    );
    for h in &ins.headline {
        let fmt = |v: Option<f64>| match h.unit.as_str() {
            "pct" => pct(v),
            "cents" => money_f(v),
            "count" => v.map(|v| format!("{v:.0}")).unwrap_or_default(),
            _ => num1(v),
        };
        let unit = match h.unit.as_str() {
            "cents" => "money",
            "pct" => "percent",
            u => u,
        };
        let mut note = h.note.clone().unwrap_or_default();
        if let Some(s) = &h.collecting_since {
            note = format!("Collecting since {s}. {note}").trim().to_string();
        }
        t_push_head(
            &mut head,
            &h.label,
            fmt(h.value),
            fmt(h.previous),
            unit,
            h.estimate,
            note,
        );
    }
    match metric {
        Some(m) => {
            if let Some(h) = ins.headline.iter().find(|h| h.id == m) {
                let mut one = Table::new(
                    "Headline",
                    &head.columns.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
                );
                let i = ins.headline.iter().position(|x| x.id == h.id).unwrap_or(0);
                one.push(None, head.rows[i].clone());
                write_table(&mut out, &one);
            }
            write_table(&mut out, &summary(&ins, m));
            write_table(&mut out, &drilldown(data, q, now, m, None));
        }
        None => {
            write_table(&mut out, &head);
            for m in CSV_METRICS {
                if matches!(m, "repeat_rate" | "scrap") {
                    continue;
                }
                write_table(&mut out, &summary(&ins, m));
            }
            write_table(&mut out, &drilldown(data, q, now, "revenue", None));
        }
    }
    if !ins.packaging_cost_set {
        out.push_str(&csv_cell(&format!("# Note: {NOTE_PACKAGING_UNSET}")));
        out.push_str("\r\n");
    }
    out
}

fn t_push_head(
    t: &mut Table,
    label: &str,
    v: String,
    p: String,
    unit: &str,
    est: bool,
    note: String,
) {
    t.push(
        None,
        vec![
            label.into(),
            v,
            p,
            unit.into(),
            if est {
                "Estimate".into()
            } else {
                String::new()
            },
            note,
        ],
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(s: &str) -> DateTime<Utc> {
        parse_ts(s).unwrap()
    }
    fn unit(id: &str, state: &str, cost: i64) -> UnitRow {
        UnitRow {
            id: id.into(),
            part_id: "p1".into(),
            part_name: "Part".into(),
            state: state.into(),
            filament_id: "f1".into(),
            printer_id: None,
            unit_cost_cents: cost,
            grams: 50.0,
            print_minutes: 60,
            reprint_count: 0,
        }
    }
    fn order(
        id: &str,
        created: &str,
        shipped: Option<&str>,
        price: i64,
        units: Vec<UnitRow>,
    ) -> OrderRow {
        OrderRow {
            id: id.into(),
            code: id.to_uppercase(),
            customer_name: format!("Customer {id}"),
            customer_email: String::new(),
            source: "manual".into(),
            created: ts(created),
            shipped: shipped.map(ts),
            done: shipped.is_some(),
            ship_by: None,
            on_hold: false,
            shipping_charged_cents: 0,
            lines: vec![LineRow {
                product_id: "prod".into(),
                product_name: "Product A".into(),
                quantity: 1,
                unit_price_cents: price,
                units,
            }],
        }
    }
    fn ev(kind: &str, at: &str, order: &str, unit: &str) -> EventRow {
        EventRow {
            at: Some(ts(at)),
            kind: kind.into(),
            order_id: Some(order.into()),
            order_code: Some(order.to_uppercase()),
            unit_id: Some(unit.into()),
            part_id: Some("p1".into()),
            part_name: Some("Part".into()),
            product_name: Some("Product A".into()),
            filament_name: "Color One".into(),
            printer_id: Some("pr1".into()),
            printer_name: Some("Printer 1".into()),
            failure_reason: None,
            cost_impact_cents: if kind == "FailedPrint" { 120 } else { 0 },
        }
    }
    fn base() -> InsightsData {
        InsightsData {
            filaments: vec![FilamentRow {
                id: "f1".into(),
                name: "Color One".into(),
                material: "MAT".into(),
                hex: "#112233".into(),
                cost_per_kg: 20.0,
            }],
            parts: [(
                "p1".to_string(),
                PartInfo {
                    name: "Part".into(),
                    grams: 50.0,
                    unit_cost_cents: 120,
                    print_minutes: 60,
                },
            )]
            .into(),
            printers: vec![("pr1".into(), "Printer 1".into())],
            ..Default::default()
        }
    }
    fn q(start: &str, end: &str) -> InsightsQuery {
        InsightsQuery {
            start: Some(start.into()),
            end: Some(end.into()),
            tz_offset_minutes: 0,
        }
    }
    fn now() -> DateTime<Utc> {
        ts("2026-11-20T12:00:00Z")
    }

    #[test]
    fn median_and_p90() {
        assert_eq!(median(&[]), None);
        assert_eq!(median(&[5.0]), Some(5.0));
        assert_eq!(median(&[3.0, 1.0, 2.0]), Some(2.0));
        assert_eq!(median(&[4.0, 1.0, 2.0, 3.0]), Some(2.5));
        let v: Vec<f64> = (1..=10).map(|x| x as f64).collect();
        assert_eq!(p90(&v), Some(9.0));
        assert_eq!(p90(&[7.0]), Some(7.0));
        assert_eq!(p90(&[]), None);
        let v: Vec<f64> = (1..=20).map(|x| x as f64).collect();
        assert_eq!(p90(&v), Some(18.0));
    }

    #[test]
    fn age_buckets_edges() {
        assert_eq!(age_bucket(0.0), "0-1");
        assert_eq!(age_bucket(1.99), "0-1");
        assert_eq!(age_bucket(2.0), "2-3");
        assert_eq!(age_bucket(3.9), "2-3");
        assert_eq!(age_bucket(4.0), "4-7");
        assert_eq!(age_bucket(7.0), "4-7");
        assert_eq!(age_bucket(7.5), "7+");
    }

    #[test]
    fn no_data_is_empty_not_zero_rates() {
        let ins = compute_insights(
            &base(),
            &q("2026-11-01T00:00:00Z", "2026-11-15T00:00:00Z"),
            now(),
        );
        assert_eq!(ins.lead_time.shipped, 0);
        assert_eq!(ins.lead_time.median_hours, None);
        assert_eq!(ins.lead_time.p90_hours, None);
        assert_eq!(ins.on_time.rate, None);
        assert_eq!(ins.yield_.overall.rate, None);
        assert_eq!(ins.money.aov_cents, None);
        assert_eq!(ins.customers.repeat_rate, None);
        assert_eq!(ins.utilization.rate, None);
        assert!(ins.aging.iter().all(|a| a.count == 0));
        let lead = ins.headline.iter().find(|h| h.id == "lead_time").unwrap();
        assert_eq!(lead.value, None);
        assert_eq!(lead.previous, None);
        // CSV still renders, saying so.
        let csv = insights_csv(
            &base(),
            &q("2026-11-01T00:00:00Z", "2026-11-15T00:00:00Z"),
            now(),
            Some("lead_time"),
        );
        assert!(csv.contains("Not enough data"));
    }

    #[test]
    fn lead_time_and_period_compare() {
        let mut d = base();
        // This period: 10 Nov - 20 Nov. Previous: 31 Oct - 10 Nov.
        d.orders.push(order(
            "a",
            "2026-11-11T00:00:00Z",
            Some("2026-11-12T00:00:00Z"),
            1000,
            vec![unit("ua", "Shipped", 100)],
        ));
        d.orders.push(order(
            "b",
            "2026-11-12T00:00:00Z",
            Some("2026-11-14T00:00:00Z"),
            2000,
            vec![unit("ub", "Shipped", 100)],
        ));
        d.orders.push(order(
            "c",
            "2026-11-13T00:00:00Z",
            Some("2026-11-17T00:00:00Z"),
            3000,
            vec![unit("uc", "Shipped", 100)],
        ));
        d.orders.push(order(
            "p",
            "2026-11-01T00:00:00Z",
            Some("2026-11-02T12:00:00Z"),
            500,
            vec![unit("up", "Shipped", 100)],
        ));
        let ins = compute_insights(
            &d,
            &q("2026-11-10T00:00:00Z", "2026-11-20T00:00:00Z"),
            now(),
        );
        assert_eq!(ins.lead_time.shipped, 3);
        assert_eq!(ins.lead_time.median_hours, Some(48.0));
        assert_eq!(ins.lead_time.p90_hours, Some(96.0));
        assert_eq!(ins.lead_time.prev_median_hours, Some(36.0));
        assert_eq!(ins.money.orders, 3);
        assert_eq!(ins.money.revenue_cents, 6000);
        assert_eq!(ins.money.aov_cents, Some(2000.0));
        assert_eq!(ins.money.prev_revenue_cents, Some(500));
        assert_eq!(ins.money.prev_orders, Some(1));
        let rev = ins.headline.iter().find(|h| h.id == "revenue").unwrap();
        assert_eq!((rev.value, rev.previous), (Some(6000.0), Some(500.0)));
        // All time has no previous period.
        let all = compute_insights(&d, &InsightsQuery::default(), now());
        assert_eq!(all.lead_time.shipped, 4);
        assert!(all.headline.iter().all(|h| h.previous.is_none()));
        // Drill-down lists the shipped orders behind the number.
        let t = drilldown(
            &d,
            &q("2026-11-10T00:00:00Z", "2026-11-20T00:00:00Z"),
            now(),
            "lead_time",
            None,
        );
        assert_eq!(t.rows.len(), 3);
        assert_eq!(t.order_ids[0].as_deref(), Some("a"));
    }

    #[test]
    fn on_time_uses_ship_by_else_default_days() {
        let mut d = base();
        let mut a = order(
            "a",
            "2026-11-11T10:00:00Z",
            Some("2026-11-13T10:00:00Z"),
            1000,
            vec![],
        );
        a.ship_by = NaiveDate::from_ymd_opt(2026, 11, 12); // late
        let b = order(
            "b",
            "2026-11-11T10:00:00Z",
            Some("2026-11-13T10:00:00Z"),
            1000,
            vec![],
        );
        d.orders = vec![a, b];
        let rq = q("2026-11-10T00:00:00Z", "2026-11-20T00:00:00Z");
        // No default target: only the order with a ship-by date counts.
        let ins = compute_insights(&d, &rq, now());
        assert_eq!((ins.on_time.with_target, ins.on_time.on_time), (1, 0));
        assert_eq!(ins.on_time.rate, Some(0.0));
        // Default 2 days: b's target is 13 Nov, shipped 13 Nov => on time.
        d.default_target_days = Some(2);
        let ins = compute_insights(&d, &rq, now());
        assert_eq!((ins.on_time.with_target, ins.on_time.on_time), (2, 1));
        assert_eq!(ins.on_time.rate, Some(0.5));
        let late = drilldown(&d, &rq, now(), "on_time", Some("late"));
        assert_eq!(late.order_ids, vec![Some("a".to_string())]);
    }

    #[test]
    fn on_time_collecting_since_when_no_default() {
        let mut d = base();
        d.tracking_since = Some(ts("2026-11-15T00:00:00Z"));
        let ins = compute_insights(
            &d,
            &q("2026-11-10T00:00:00Z", "2026-11-20T00:00:00Z"),
            now(),
        );
        assert_eq!(ins.on_time.collecting_since.as_deref(), Some("2026-11-15"));
        d.default_target_days = Some(3);
        let ins = compute_insights(
            &d,
            &q("2026-11-10T00:00:00Z", "2026-11-20T00:00:00Z"),
            now(),
        );
        assert_eq!(ins.on_time.collecting_since, None);
    }

    #[test]
    fn first_pass_yield_counts_first_outcome_only() {
        let mut d = base();
        d.events = vec![
            ev("FailedPrint", "2026-11-11T00:00:00Z", "a", "u1"),
            ev("PrintedDone", "2026-11-11T05:00:00Z", "a", "u1"), // reprint pass; not first
            ev("PrintedDone", "2026-11-12T00:00:00Z", "a", "u2"),
            ev("PrintedDone", "2026-11-12T00:00:00Z", "a", "u3"),
            ev("PrintedDone", "2026-11-01T00:00:00Z", "z", "u9"), // previous period
        ];
        let rq = q("2026-11-10T00:00:00Z", "2026-11-20T00:00:00Z");
        let ins = compute_insights(&d, &rq, now());
        assert_eq!(
            (ins.yield_.overall.passed, ins.yield_.overall.total),
            (2, 3)
        );
        assert!((ins.yield_.overall.rate.unwrap() - 2.0 / 3.0).abs() < 1e-9);
        assert_eq!(ins.yield_.prev_rate, Some(1.0));
        assert_eq!(ins.yield_.by_material[0].key, "MAT");
        assert_eq!(ins.yield_.by_printer[0].key, "Printer 1");
        assert_eq!(ins.throughput.parts_printed, 3);
        assert_eq!(ins.failures.len(), 1);
        assert_eq!(ins.failures[0].reason, "No reason given");
        assert_eq!(ins.scrap_cost_cents, 120);
        // Filament: 4 prints x 50 g at 20/kg = 200 g, 4.00.
        assert_eq!(ins.filament.grams, 200.0);
        assert_eq!(ins.filament.cost_cents, 400);
        let t = drilldown(&d, &rq, now(), "yield", Some("material:MAT"));
        assert_eq!(t.rows.len(), 3);
    }

    #[test]
    fn undone_events_never_load() {
        let l = ShopLedger::open_in_memory().unwrap();
        let snap = l.snapshot().unwrap();
        let before = l.insights_data().unwrap().events.len();
        l.conn
            .execute(
                "INSERT INTO flow_events (id, created_at, kind, filament_name, filament_hex, to_state, actor_device, source_surface, action_label, undone_at)
                 VALUES ('x-undone', ?1, 'PrintedDone', 'F', '#000', 'Printed', 'test', 'test', 'Printed', ?1)",
                params![Utc::now().to_rfc3339()],
            )
            .unwrap();
        let data = l.insights_data().unwrap();
        assert_eq!(data.events.len(), before);
        // Snapshot records each printer's current status once, and not again unchanged.
        assert_eq!(data.status_log.len(), snap.printers.len());
        l.snapshot().unwrap();
        assert_eq!(
            l.insights_data().unwrap().status_log.len(),
            snap.printers.len()
        );
        assert!(data.tracking_since.is_some());
        // Insights over the seed runs end to end.
        let ins = l.insights(&InsightsQuery::default()).unwrap();
        assert_eq!(ins.headline.len(), 10);
    }

    #[test]
    fn aging_counts_open_orders_in_range() {
        let mut d = base();
        d.orders = vec![
            order(
                "a",
                "2026-11-20T00:00:00Z",
                None,
                100,
                vec![unit("u1", "Queued", 1)],
            ),
            order(
                "b",
                "2026-11-17T12:00:00Z",
                None,
                100,
                vec![unit("u2", "Queued", 1)],
            ),
            order(
                "c",
                "2026-11-14T00:00:00Z",
                None,
                100,
                vec![unit("u3", "Printing", 1)],
            ),
            order(
                "d",
                "2026-11-11T00:00:00Z",
                None,
                100,
                vec![unit("u4", "Queued", 1)],
            ),
            order(
                "e",
                "2026-11-11T00:00:00Z",
                Some("2026-11-12T00:00:00Z"),
                100,
                vec![unit("u5", "Shipped", 1)],
            ),
            order(
                "f",
                "2026-10-01T00:00:00Z",
                None,
                100,
                vec![unit("u6", "Queued", 1)],
            ), // before range
        ];
        let rq = q("2026-11-10T00:00:00Z", "2026-11-21T00:00:00Z");
        let ins = compute_insights(&d, &rq, now());
        let counts: Vec<usize> = ins.aging.iter().map(|a| a.count).collect();
        assert_eq!(counts, vec![1, 1, 1, 1]);
        let t = drilldown(&d, &rq, now(), "aging", Some("7+"));
        assert_eq!(t.order_ids, vec![Some("d".to_string())]);
        // Live bottleneck: 3 waiting parts of material MAT (Printing ones aren't waiting).
        let all = compute_insights(&d, &InsightsQuery::default(), now());
        assert_eq!(all.bottleneck.by_material[0].parts, 4);
    }

    #[test]
    fn utilization_from_status_log_and_collecting_since() {
        let mut d = base();
        d.status_log = vec![
            StatusRow {
                printer_id: "pr1".into(),
                status: "Idle".into(),
                at: ts("2026-11-15T00:00:00Z"),
            },
            StatusRow {
                printer_id: "pr1".into(),
                status: "Printing".into(),
                at: ts("2026-11-16T00:00:00Z"),
            },
            StatusRow {
                printer_id: "pr1".into(),
                status: "Idle".into(),
                at: ts("2026-11-17T00:00:00Z"),
            },
        ];
        let ins = compute_insights(
            &d,
            &q("2026-11-10T00:00:00Z", "2026-11-18T00:00:00Z"),
            now(),
        );
        // Observed 15th-18th = 72 h, printing 24 h.
        assert!((ins.utilization.rate.unwrap() - 24.0 / 72.0).abs() < 1e-9);
        assert_eq!(
            ins.utilization.collecting_since.as_deref(),
            Some("2026-11-15")
        );
        assert_eq!(ins.utilization.prev_rate, None);
        let ins = compute_insights(
            &d,
            &q("2026-11-16T00:00:00Z", "2026-11-17T00:00:00Z"),
            now(),
        );
        assert_eq!(ins.utilization.rate, Some(1.0));
        assert_eq!(ins.utilization.collecting_since, None);
    }

    #[test]
    fn margin_counts_packaging_only_when_set() {
        let mut d = base();
        let mut u = unit("u1", "Shipped", 300);
        u.reprint_count = 1;
        d.orders = vec![order(
            "a",
            "2026-11-11T00:00:00Z",
            Some("2026-11-12T00:00:00Z"),
            1000,
            vec![u],
        )];
        let rq = q("2026-11-10T00:00:00Z", "2026-11-20T00:00:00Z");
        let ins = compute_insights(&d, &rq, now());
        assert!(!ins.packaging_cost_set);
        assert_eq!(ins.products[0].cost_cents, 600); // part + one reprint, no packaging
        assert_eq!(ins.products[0].margin_pct, Some(0.4));
        assert!(insights_csv(&d, &rq, now(), None).contains(NOTE_PACKAGING_UNSET));
        d.packaging_cost_cents = Some(100);
        let ins = compute_insights(&d, &rq, now());
        assert!(ins.packaging_cost_set);
        assert_eq!(ins.products[0].cost_cents, 700);
    }

    #[test]
    fn customers_repeat_and_channels() {
        let mut d = base();
        let mut a1 = order("a1", "2026-11-01T00:00:00Z", None, 1000, vec![]);
        a1.customer_email = "Same@Example.test".into();
        let mut a2 = order("a2", "2026-11-11T00:00:00Z", None, 2000, vec![]);
        a2.customer_email = "same@example.test ".into();
        a2.source = "website".into();
        let b = order("b", "2026-11-12T00:00:00Z", None, 500, vec![]);
        d.orders = vec![a1, a2, b];
        let ins = compute_insights(
            &d,
            &q("2026-11-10T00:00:00Z", "2026-11-20T00:00:00Z"),
            now(),
        );
        assert_eq!(
            (ins.customers.customers, ins.customers.repeat_customers),
            (2, 1)
        );
        assert_eq!(ins.customers.repeat_rate, Some(0.5));
        assert_eq!(ins.customers.median_days_between_orders, Some(10.0));
        assert_eq!(ins.customers.top[0].orders, 1);
        assert_eq!(ins.customers.top[0].revenue_cents, 2000);
        let ch: Vec<(&str, usize)> = ins
            .channels
            .iter()
            .map(|c| (c.source.as_str(), c.orders))
            .collect();
        assert_eq!(ch, vec![("Website", 1), ("Manual", 1)]);
    }

    #[test]
    fn wait_work_split() {
        let mut d = base();
        d.orders = vec![order(
            "a",
            "2026-11-11T00:00:00Z",
            Some("2026-11-12T00:00:00Z"),
            1000,
            vec![unit("u1", "Shipped", 1)],
        )];
        d.events = vec![
            ev("StartedPrint", "2026-11-11T04:00:00Z", "a", "u1"),
            ev("PrintedDone", "2026-11-11T10:00:00Z", "a", "u1"),
        ];
        let ins = compute_insights(
            &d,
            &q("2026-11-10T00:00:00Z", "2026-11-20T00:00:00Z"),
            now(),
        );
        assert_eq!(ins.wait_work.orders, 1);
        assert_eq!(ins.wait_work.waiting_hours, Some(4.0));
        assert_eq!(ins.wait_work.printing_hours, Some(6.0));
        assert_eq!(ins.wait_work.after_print_hours, Some(14.0));
    }

    #[test]
    fn range_buckets_daily_and_weekly() {
        let d = base();
        let r = resolve_range(
            &d,
            &q("2026-11-10T00:00:00Z", "2026-11-17T00:00:00Z"),
            now(),
        );
        assert!(!r.weekly);
        assert_eq!(r.buckets().len(), 7);
        assert!(r.prev.is_some());
        let r = resolve_range(
            &d,
            &q("2026-08-01T00:00:00Z", "2026-11-17T00:00:00Z"),
            now(),
        );
        assert!(r.weekly);
        assert!(r
            .buckets()
            .iter()
            .all(|b| b.weekday() == chrono::Weekday::Mon));
        // Time zone shifts the local day.
        let r = Range { tz: -300, ..r };
        assert_eq!(
            r.local_date(ts("2026-11-11T03:00:00Z")),
            NaiveDate::from_ymd_opt(2026, 11, 10).unwrap()
        );
    }

    #[test]
    fn csv_quotes_and_lists_all_sections() {
        let mut d = base();
        let mut a = order("a", "2026-11-11T00:00:00Z", None, 1000, vec![]);
        a.customer_name = "Last, First \"Q\"".into();
        d.orders = vec![a];
        let csv = insights_csv(
            &d,
            &q("2026-11-10T00:00:00Z", "2026-11-20T00:00:00Z"),
            now(),
            None,
        );
        assert!(csv.contains("\"Last, First \"\"Q\"\"\""));
        assert!(csv.contains("# Headline"));
        assert!(csv.contains("# Orders placed"));
        assert!(csv.contains("\r\n"));
    }
}
