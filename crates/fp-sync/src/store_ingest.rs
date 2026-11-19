//! Website order ingest: `store_orders` (Supabase) -> local FarmPrint ledger.
//!
//! Reads `store_orders` rows and their `lines[]` (including the customer view angle and
//! thumbnail-only parts, which are shown but never printed). Behavior reference: the Swift app's `WebsiteOrderIngest.swift`,
//! `OrderStore+Store.swift` (`importWebsiteOrders`) and `SupabaseClient.swift` (`markImported`).
//!
//! - The network sits behind [`StoreOrderSource`] (swappable; tests use a fake). The real one
//!   is `supabase::SupabaseStoreOrderReader` (feature `supabase`), signed-in owner token only.
//! - Atomic claim, when
//!   `ShopSettings::store_ingest_claim_on` (default ON): each mappable row is claimed on the
//!   shop BEFORE the local insert with a conditional PATCH (`imported_at=is.null`). Only a
//!   claim that returns the row makes the order ours; an empty result means another device
//!   claimed it (skip); a request error leaves it for the next run. Claimed but not saved
//!   locally is reported loudly (`notSaved`). No status write-back.
//!   Setting off: read-only fetch + local dedupe only.
//! - The local `imported_store_orders` map stays the second safety net: it keeps every
//!   imported id, even after the local order is deleted, so re-running ingest never
//!   duplicates or resurrects orders.
//! - `configuration_id` picks that configuration's parts using the published catalog
//!   snapshot (`products[].configurations[].part_ids`), the same part lists the shop sold.
//! - Product-agnostic: products/parts/filaments are matched by id and catalog flags only.
//! - An order is all-or-nothing: if any line is unreadable, names an unknown product, or has a
//!   `configuration_id` that cannot be resolved against the published catalog, the whole
//!   order is left on the shop (not claimed, not imported) with a warning naming its shop
//!   order number, and is offered again on the next import. Only quantity-0 lines are
//!   dropped on their own (nothing to make).

use crate::contracts::{spools_match, FilamentSpoolIdentity, StoreOrderLine, StoreOrderRow};
use fp_core::{
    CatalogPart, FilamentSwatch, Product, ShopLedger, WebsiteImportOutcome, WebsiteLineImport,
    WebsiteOrderImport,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

/// Where pending website orders come from.
pub trait StoreOrderSource {
    /// Raw `store_orders` rows (JSON objects), pending import, oldest first. Read-only.
    fn fetch_pending_orders(&self) -> Result<Vec<Value>, String>;
    /// Published `store_catalog.snapshot` (for `configurations`). Read-only. None = unknown.
    fn fetch_catalog_snapshot(&self) -> Result<Option<Value>, String> {
        Ok(None)
    }
    /// Conditional claim of one row (`imported_at is null`): `Ok(true)` = the update returned
    /// the row (ours), `Ok(false)` = no row (already claimed elsewhere), `Err` = request failed.
    fn claim_order(
        &self,
        _row_id: &str,
        _imported_at: &str,
        _claimed_by: &str,
    ) -> Result<bool, String> {
        Err("claiming is not supported by this source".into())
    }
}

/// Why `import_store_orders` did nothing (shown to the user as-is).
pub const NOT_CONNECTED_MESSAGE: &str =
    "No shop connected. Add the shop's Supabase URL and anon key in Settings › Store.";
pub const NOT_SIGNED_IN_MESSAGE: &str = "Sign in to the shop to import orders";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportGate {
    /// Go ahead with this owner session token.
    Ready(String),
    NotConnected,
    NotSignedIn,
}

/// Pure pre-check: shop configured, and a signed-in owner session token (never the anon key).
pub fn import_gate(supabase_url: &str, anon_key: &str, owner_token: Option<&str>) -> ImportGate {
    if supabase_url.trim().is_empty() || anon_key.trim().is_empty() {
        return ImportGate::NotConnected;
    }
    match owner_token
        .map(str::trim)
        .filter(|t| !t.is_empty() && *t != anon_key.trim())
    {
        Some(t) => ImportGate::Ready(t.to_string()),
        None => ImportGate::NotSignedIn,
    }
}

/// `{connected, signed_in, imported: 0, message}` for a gate that stopped the import.
pub fn gate_result(g: &ImportGate) -> Option<Value> {
    match g {
        ImportGate::Ready(_) => None,
        ImportGate::NotConnected => Some(
            serde_json::json!({"connected": false, "signed_in": false, "imported": 0, "message": NOT_CONNECTED_MESSAGE}),
        ),
        ImportGate::NotSignedIn => Some(
            serde_json::json!({"connected": true, "signed_in": false, "imported": 0, "message": NOT_SIGNED_IN_MESSAGE}),
        ),
    }
}

/// One published configuration: its parts, and its price when listed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PublishedConfiguration {
    pub id: String,
    pub part_ids: Vec<String>,
    pub price_cents: Option<i64>,
}

/// product id -> configurations, from `store_catalog.snapshot.products[].configurations[]`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CatalogConfigurations {
    pub by_product: std::collections::HashMap<String, Vec<PublishedConfiguration>>,
    /// False when no snapshot was available (configuration_id then cannot be honored).
    pub known: bool,
}

impl CatalogConfigurations {
    pub fn from_snapshot(snapshot: Option<&Value>) -> Self {
        let Some(snap) = snapshot else {
            return Self::default();
        };
        let mut by_product = std::collections::HashMap::new();
        for p in snap
            .get("products")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(pid) = p.get("id").and_then(Value::as_str) else {
                continue;
            };
            let cfgs: Vec<PublishedConfiguration> = p
                .get("configurations")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|c| {
                    let id = c.get("id").and_then(Value::as_str)?.trim().to_string();
                    if id.is_empty() {
                        return None;
                    }
                    let part_ids = c
                        .get("part_ids")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect();
                    let price_cents = c
                        .get("price_cents")
                        .and_then(Value::as_i64)
                        .filter(|v| *v >= 0);
                    Some(PublishedConfiguration {
                        id,
                        part_ids,
                        price_cents,
                    })
                })
                .collect();
            if !cfgs.is_empty() {
                by_product.insert(pid.to_string(), cfgs);
            }
        }
        Self {
            by_product,
            known: true,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct IngestReport {
    pub fetched: usize,
    pub imported: usize,
    pub duplicates: usize,
    pub skipped_orders: usize,
    pub skipped_lines: usize,
    pub imported_order_ids: Vec<String>,
    /// Claim setting was on for this run.
    pub claim_enabled: bool,
    /// Rows this device claimed on the shop (then imported, or listed in `claimed_not_saved`).
    pub claimed: usize,
    /// Rows whose claim came back empty: another device claimed them. Not imported.
    pub claimed_elsewhere: usize,
    /// Rows whose claim request failed (network/HTTP). Not imported; retried next run.
    pub claim_errors: usize,
    /// Already-local rows still pending on the shop that this run marked claimed.
    pub claimed_existing: usize,
    /// CLAIMED ON THE SHOP BUT NOT SAVED LOCALLY (`notSaved`): shop order numbers (shop row id
    /// when a row has none). Needs a look.
    pub claimed_not_saved: Vec<String>,
    /// Human-readable, no secrets and no customer details (order id / number only).
    pub warnings: Vec<String>,
}

/// Result of mapping one row: the import (if any line survived) plus warnings.
#[derive(Debug, Clone, PartialEq)]
pub struct MappedOrder {
    pub import: Option<WebsiteOrderImport>,
    pub skipped_lines: usize,
    pub warnings: Vec<String>,
}

/// Picture-only (thumbnail-only) parts: untracked and not color-only (same rule as publish).
fn is_picture_only(p: &CatalogPart) -> bool {
    !p.is_tracked && !p.is_color_only
}

/// Parts that become part units (same filter as `ShopLedger::create_order`).
fn makes_units(p: &CatalogPart) -> bool {
    p.is_tracked && !p.is_color_only
}

fn trimmed(s: Option<&str>) -> Option<String> {
    s.map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

/// `lines` arrives as a JSON array; older rows may carry it as a JSON-encoded string.
fn raw_lines(raw: &Value) -> Vec<Value> {
    match raw.get("lines") {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(s)) => serde_json::from_str::<Vec<Value>>(s).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Parses a raw row. Lines are parsed one by one so one bad line cannot sink the order.
pub fn parse_store_order(
    raw: &Value,
) -> Result<(StoreOrderRow, Vec<Result<StoreOrderLine, String>>), String> {
    let mut head = raw.clone();
    let obj = head
        .as_object_mut()
        .ok_or_else(|| "row is not an object".to_string())?;
    obj.insert("lines".into(), Value::Array(vec![]));
    let row: StoreOrderRow =
        serde_json::from_value(head).map_err(|e| format!("unreadable row ({e})"))?;
    let lines = raw_lines(raw)
        .into_iter()
        .map(|l| serde_json::from_value::<StoreOrderLine>(l).map_err(|e| e.to_string()))
        .collect();
    Ok((row, lines))
}

fn resolve_filament(
    part: &crate::contracts::StoreOrderLinePart,
    filaments: &[FilamentSwatch],
) -> Option<String> {
    let sid = part.swatch_id.trim();
    if !sid.is_empty() {
        if let Some(f) = filaments.iter().find(|f| f.id == sid) {
            return Some(f.id.clone());
        }
    }
    // Filament identity: name + material line, brand
    // missing = wildcard. Hex is never used to decide a match.
    if part.name.trim().is_empty() {
        return None;
    }
    let want = FilamentSpoolIdentity {
        brand: None,
        material_line: part.material.clone(),
        color_name: part.name.clone(),
        hex: String::new(),
    };
    filaments
        .iter()
        .find(|f| {
            let have = FilamentSpoolIdentity {
                brand: trimmed(Some(&f.brand)),
                material_line: f.material.clone(),
                color_name: f.name.clone(),
                hex: String::new(),
            };
            spools_match(&want, &have)
        })
        .map(|f| f.id.clone())
}

/// Maps one raw `store_orders` row to a local import. Pure: no ledger, no network.
pub fn map_store_order(
    raw: &Value,
    products: &[Product],
    filaments: &[FilamentSwatch],
    configs: &CatalogConfigurations,
) -> MappedOrder {
    let mut warnings = Vec::new();
    let (row, lines) = match parse_store_order(raw) {
        Ok(v) => v,
        Err(e) => {
            let id = raw.get("id").and_then(Value::as_str).unwrap_or("?");
            return MappedOrder {
                import: None,
                skipped_lines: 0,
                warnings: vec![format!("store order {id}: skipped, {e}")],
            };
        }
    };
    let label = row
        .order_number
        .clone()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| row.id.clone());
    if row.id.trim().is_empty() {
        return MappedOrder {
            import: None,
            skipped_lines: 0,
            warnings: vec!["store order without id: skipped".into()],
        };
    }
    if row.payment_status.trim() != "paid" || row.dismissed_at.is_some() {
        return MappedOrder {
            import: None,
            skipped_lines: 0,
            warnings: vec![format!(
                "store order {label}: not a pending paid order, skipped"
            )],
        };
    }

    let mut skipped_lines = 0;
    // Reasons this order cannot be imported whole. Any blocker leaves it on the shop.
    let mut blockers: Vec<String> = Vec::new();
    let mut out_lines = Vec::new();
    for (i, parsed) in lines.into_iter().enumerate() {
        let n = i + 1;
        let line = match parsed {
            Ok(l) => l,
            Err(e) => {
                skipped_lines += 1;
                blockers.push(format!("line {n} is unreadable ({e})"));
                continue;
            }
        };
        if line.quantity == 0 {
            skipped_lines += 1;
            warnings.push(format!("store order {label} line {n}: quantity 0, skipped"));
            continue;
        }
        let Some(product) = products.iter().find(|p| p.id == line.product_id) else {
            skipped_lines += 1;
            blockers.push(format!(
                "line {n} is for product '{}', which is not in FarmPrint",
                line.product_id
            ));
            continue;
        };
        // configuration_id -> that configuration's parts (Swift `ProductOptions.configuration`
        // + `resolvedPartIds`): only those parts get units on this line.
        let mut only_part_ids: Option<Vec<String>> = None;
        let mut config_price: Option<i64> = None;
        if let Some(cfg_id) = trimmed(line.configuration_id.as_deref()) {
            let hit = configs
                .by_product
                .get(&product.id)
                .and_then(|v| v.iter().find(|c| c.id == cfg_id));
            match hit {
                Some(c) => {
                    let ids: Vec<String> = product
                        .parts
                        .iter()
                        .filter(|p| c.part_ids.contains(&p.id))
                        .map(|p| p.id.clone())
                        .collect();
                    if ids.is_empty() {
                        blockers.push(format!(
                            "line {n}: option '{cfg_id}' lists no parts that exist in FarmPrint"
                        ));
                        continue;
                    }
                    only_part_ids = Some(ids);
                    config_price = c.price_cents;
                }
                None if !configs.known => {
                    blockers.push(format!("line {n}: option '{cfg_id}' could not be checked (published catalog unavailable)"));
                    continue;
                }
                None => {
                    blockers.push(format!(
                        "line {n}: option '{cfg_id}' is not in the published catalog"
                    ));
                    continue;
                }
            }
        }
        let mut part_filaments = BTreeMap::new();
        for lp in &line.parts {
            if lp.is_thumbnail_only_fallback() {
                continue;
            }
            let Some(cp) = product.parts.iter().find(|p| p.id == lp.part_id) else {
                warnings.push(format!(
                    "store order {label} line {n}: unknown part id '{}', ignored",
                    lp.part_id
                ));
                continue;
            };
            if is_picture_only(cp) || !makes_units(cp) {
                continue;
            }
            if only_part_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&cp.id))
            {
                continue;
            }
            match resolve_filament(lp, filaments) {
                Some(fid) => { part_filaments.insert(cp.id.clone(), fid); }
                None => warnings.push(format!(
                    "store order {label} line {n}: no local filament for part '{}' (swatch '{}'), using the part's default",
                    cp.id, lp.swatch_id
                )),
            }
        }
        let view_camera = line.view_camera.filter(fp_core::ViewCamera::is_valid);
        out_lines.push(WebsiteLineImport {
            product_id: product.id.clone(),
            title: trimmed(Some(&line.title)).unwrap_or_else(|| product.name.clone()),
            quantity: line.quantity as i64,
            unit_price_cents: line
                .unit_price_cents
                .filter(|c| *c >= 0)
                .or(config_price)
                .unwrap_or(product.price_cents),
            custom_text: trimmed(line.custom_text.as_deref()),
            view_camera,
            part_filaments,
            only_part_ids,
        });
    }
    if !blockers.is_empty() {
        warnings.push(format!(
            "Website order {label} was left on the shop and not imported: {}. Fix the product in FarmPrint or republish the catalog, then import again.",
            blockers.join("; ")
        ));
        return MappedOrder {
            import: None,
            skipped_lines,
            warnings,
        };
    }
    if out_lines.is_empty() {
        warnings.push(format!(
            "store order {label}: no usable lines, skipped (will retry next import)"
        ));
        return MappedOrder {
            import: None,
            skipped_lines,
            warnings,
        };
    }

    let customer_name = trimmed(row.customer_name.as_deref())
        .or_else(|| trimmed(row.ship_name.as_deref()))
        .unwrap_or_else(|| {
            warnings.push(format!(
                "store order {label}: no customer name, using 'Website customer'"
            ));
            "Website customer".to_string()
        });
    let source = match row.source.trim() {
        "" | "manual" => "website".to_string(),
        s => s.to_string(),
    };
    let import = WebsiteOrderImport {
        remote_id: row.id.trim().to_string(),
        source,
        order_code: trimmed(row.order_number.as_deref()),
        customer_name,
        customer_email: trimmed(row.customer_email.as_deref()).unwrap_or_default(),
        notes: row.notes.clone().unwrap_or_default(),
        // store_orders has no rush field; website orders import as normal priority.
        is_rush: false,
        // needs_review rows are imported but held for a look.
        is_on_hold: row.needs_review,
        shipping_charged_cents: row.shipping_cents.unwrap_or(0).max(0),
        created_at: row.created_at.clone(),
        lines: out_lines,
    };
    MappedOrder {
        import: Some(import),
        skipped_lines,
        warnings,
    }
}

/// Rows mapped and deduped against the ledger, ready to claim and/or insert.
#[derive(Debug, Clone, Default)]
pub struct PreparedIngest {
    pub report: IngestReport,
    /// Mappable rows not yet local, in fetch order.
    pub candidates: Vec<WebsiteOrderImport>,
    /// Rows already local but still pending on the shop (claimed when claiming is on).
    pub local_duplicates: Vec<String>,
}

/// Step 2 (ledger, no network): dedupe locally and map every new row. Never panics.
pub fn prepare_ingest(
    rows: &[Value],
    ledger: &ShopLedger,
    configs: &CatalogConfigurations,
) -> Result<PreparedIngest, String> {
    let snap = ledger.snapshot().map_err(|e| e.to_string())?;
    let mut seen: HashSet<String> = ledger
        .imported_store_order_ids()
        .map_err(|e| e.to_string())?;
    let mut prep = PreparedIngest {
        report: IngestReport {
            fetched: rows.len(),
            ..Default::default()
        },
        ..Default::default()
    };
    for raw in rows {
        if let Some(id) = raw
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|i| !i.is_empty())
        {
            if seen.contains(id) {
                prep.report.duplicates += 1;
                if !prep.local_duplicates.iter().any(|d| d == id)
                    && !prep.candidates.iter().any(|c| c.remote_id == id)
                {
                    prep.local_duplicates.push(id.to_string());
                }
                continue;
            }
        }
        let mapped = map_store_order(raw, &snap.products, &snap.filaments, configs);
        prep.report.skipped_lines += mapped.skipped_lines;
        prep.report.warnings.extend(mapped.warnings);
        match mapped.import {
            Some(import) => {
                seen.insert(import.remote_id.clone());
                prep.candidates.push(import);
            }
            None => prep.report.skipped_orders += 1,
        }
    }
    Ok(prep)
}

/// How a candidate is named in warnings: its shop order number, else the shop row id.
fn import_label(c: &WebsiteOrderImport) -> &str {
    c.order_code
        .as_deref()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or(&c.remote_id)
}

/// Step 3 (network, no ledger lock), claim setting on: claim each candidate, one at a time.
/// Returns only the candidates this device won. Rows already local but still pending on the
/// shop are claimed too (so they stop being offered); that never imports anything.
pub fn claim_candidates(
    source: &dyn StoreOrderSource,
    prep: &mut PreparedIngest,
    device_id: &str,
    imported_at: &str,
) -> Vec<WebsiteOrderImport> {
    let rep = &mut prep.report;
    rep.claim_enabled = true;
    let mut won = Vec::new();
    for c in std::mem::take(&mut prep.candidates) {
        match source.claim_order(&c.remote_id, imported_at, device_id) {
            Ok(true) => {
                rep.claimed += 1;
                won.push(c);
            }
            Ok(false) => {
                rep.claimed_elsewhere += 1;
                rep.skipped_orders += 1;
                rep.warnings.push(format!(
                    "store order {}: already claimed by another device, skipped",
                    import_label(&c)
                ));
            }
            Err(e) => {
                rep.claim_errors += 1;
                rep.skipped_orders += 1;
                rep.warnings.push(format!(
                    "store order {}: claim failed, will retry next import ({e})",
                    import_label(&c)
                ));
            }
        }
    }
    for id in std::mem::take(&mut prep.local_duplicates) {
        match source.claim_order(&id, imported_at, device_id) {
            Ok(true) => rep.claimed_existing += 1,
            Ok(false) => {}
            Err(e) => rep.warnings.push(format!(
                "store order {id}: already local; claim failed ({e})"
            )),
        }
    }
    won
}

/// Step 4 (ledger, no network): insert. `claimed` = these rows were claimed on the shop, so
/// any failure to save is the loud `claimed_not_saved` case.
pub fn apply_imports(
    ledger: &mut ShopLedger,
    imports: &[WebsiteOrderImport],
    rep: &mut IngestReport,
    claimed: bool,
) {
    for import in imports {
        let why = match ledger.import_website_order(import) {
            Ok(WebsiteImportOutcome::Imported { order_id }) => {
                rep.imported += 1;
                rep.imported_order_ids.push(order_id);
                continue;
            }
            Ok(WebsiteImportOutcome::Duplicate) => {
                rep.duplicates += 1;
                continue;
            }
            Ok(WebsiteImportOutcome::Skipped { reason }) => reason,
            Err(e) => format!("could not save: {e}"),
        };
        rep.skipped_orders += 1;
        if claimed {
            rep.claimed_not_saved.push(import_label(import).to_string());
            rep.warnings.push(format!(
                "CLAIMED ON THE SHOP BUT NOT SAVED LOCALLY: store order {} ({why}). The shop will not offer it again; add it by hand.",
                import_label(import)
            ));
        } else {
            rep.warnings.push(format!(
                "store order {}: skipped, {why}",
                import_label(import)
            ));
        }
    }
}

/// Claim setting off: read-only, local dedupe only (prepare + insert).
pub fn ingest_rows(
    rows: &[Value],
    ledger: &mut ShopLedger,
    configs: &CatalogConfigurations,
) -> Result<IngestReport, String> {
    let mut prep = prepare_ingest(rows, ledger, configs)?;
    let candidates = std::mem::take(&mut prep.candidates);
    apply_imports(ledger, &candidates, &mut prep.report, false);
    Ok(prep.report)
}

/// Step 1 (network, no ledger lock): pending rows + the published catalog's configurations.
/// A catalog read failure is not fatal; orders with a configuration id are then left on the shop.
pub fn fetch_for_ingest(
    source: &dyn StoreOrderSource,
) -> Result<(Vec<Value>, CatalogConfigurations, Option<String>), String> {
    let rows = source.fetch_pending_orders()?;
    if rows.is_empty() {
        return Ok((rows, CatalogConfigurations::default(), None));
    }
    match source.fetch_catalog_snapshot() {
        Ok(snap) => Ok((
            rows,
            CatalogConfigurations::from_snapshot(snap.as_ref()),
            None,
        )),
        Err(e) => Ok((
            rows,
            CatalogConfigurations::default(),
            Some(format!(
                "published catalog unavailable ({e}); orders with options were left on the shop"
            )),
        )),
    }
}

/// ISO 8601 UTC with milliseconds (`2026-11-18T12:00:00.000Z`).
pub fn iso_utc_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// All steps in one call (tests, or callers without a shared lock).
/// `claim_device_id`: `Some(device id)` = claim setting on; `None` = read-only.
pub fn ingest_store_orders(
    source: &dyn StoreOrderSource,
    ledger: &mut ShopLedger,
    claim_device_id: Option<&str>,
) -> Result<IngestReport, String> {
    let (rows, configs, warn) = fetch_for_ingest(source)?;
    let mut rep = match claim_device_id {
        None => ingest_rows(&rows, ledger, &configs)?,
        Some(dev) => {
            let mut prep = prepare_ingest(&rows, ledger, &configs)?;
            let won = claim_candidates(source, &mut prep, dev, &iso_utc_now());
            apply_imports(ledger, &won, &mut prep.report, true);
            prep.report
        }
    };
    rep.warnings.extend(warn);
    Ok(rep)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;

    struct FakeSource {
        rows: Vec<Value>,
        calls: Cell<usize>,
    }
    impl StoreOrderSource for FakeSource {
        fn fetch_pending_orders(&self) -> Result<Vec<Value>, String> {
            self.calls.set(self.calls.get() + 1);
            Ok(self.rows.clone())
        }
    }

    #[derive(Clone, Copy, PartialEq, Debug)]
    enum ClaimMode {
        Win,
        Lost,
        Error,
    }

    /// Fake shop: published catalog + per-row claim outcome (default Win). Records every
    /// claim call (never a real request). A won claim drops the row from later fetches,
    /// like the server's `imported_at is null` filter.
    struct ClaimFake {
        rows: Vec<Value>,
        snapshot: Option<Value>,
        modes: std::cell::RefCell<std::collections::HashMap<String, ClaimMode>>,
        calls: std::cell::RefCell<Vec<(String, String, String)>>,
        won: std::cell::RefCell<HashSet<String>>,
    }
    impl StoreOrderSource for ClaimFake {
        fn fetch_pending_orders(&self) -> Result<Vec<Value>, String> {
            let won = self.won.borrow();
            Ok(self
                .rows
                .iter()
                .filter(|r| !won.contains(r["id"].as_str().unwrap_or("")))
                .cloned()
                .collect())
        }
        fn fetch_catalog_snapshot(&self) -> Result<Option<Value>, String> {
            Ok(self.snapshot.clone())
        }
        fn claim_order(&self, id: &str, at: &str, by: &str) -> Result<bool, String> {
            self.calls
                .borrow_mut()
                .push((id.into(), at.into(), by.into()));
            match self
                .modes
                .borrow()
                .get(id)
                .copied()
                .unwrap_or(ClaimMode::Win)
            {
                ClaimMode::Win => {
                    self.won.borrow_mut().insert(id.into());
                    Ok(true)
                }
                ClaimMode::Lost => Ok(false),
                ClaimMode::Error => Err("Supabase 503".into()),
            }
        }
    }

    fn claim_fake(rows: Vec<Value>, snapshot: Option<Value>) -> ClaimFake {
        ClaimFake {
            rows,
            snapshot,
            modes: Default::default(),
            calls: Default::default(),
            won: Default::default(),
        }
    }

    /// Fixture with a second tracked part so a configuration can pick a subset.
    fn ledger_with_configs() -> (ShopLedger, String) {
        let (mut l, pid) = ledger();
        let mut p = l
            .snapshot()
            .unwrap()
            .products
            .into_iter()
            .find(|p| p.id == pid)
            .unwrap();
        let mut grate = p.parts[0].clone();
        grate.id = "p-grate".into();
        grate.name = "Grate".into();
        grate.sort_order = 4;
        p.parts.push(grate);
        l.upsert_product(p).unwrap();
        (l, pid)
    }

    fn snapshot_with_configs(pid: &str) -> Value {
        json!({"version": 3, "products": [{"id": pid, "configurations": [
            {"id": "cfg-dish", "name": "Dish", "price_cents": 900, "part_ids": ["p-body", "p-badge"]},
            {"id": "cfg-full", "name": "Dish + Grate", "price_cents": 1400, "part_ids": ["p-body", "p-grate", "p-badge"]}
        ]}]})
    }

    fn unit_parts(l: &ShopLedger, remote: &str) -> Vec<Vec<String>> {
        let snap = l.snapshot().unwrap();
        let o = snap
            .orders
            .iter()
            .find(|o| o.remote_id.as_deref() == Some(remote))
            .unwrap();
        o.lines
            .iter()
            .map(|ln| ln.units.iter().map(|u| u.part_id.clone()).collect())
            .collect()
    }

    #[test]
    fn configuration_id_picks_only_that_configurations_parts() {
        let (mut l, pid) = ledger_with_configs();
        let rows = vec![
            row(
                "cs_cfg_dish",
                json!([{"product_id": pid, "configuration_id": "cfg-dish", "quantity": 1, "title": "Dish", "parts": []}]),
            ),
            row(
                "cs_cfg_full",
                json!([{"product_id": pid, "configuration_id": "cfg-full", "quantity": 1, "title": "Full", "unit_price_cents": 1500, "parts": []}]),
            ),
            row(
                "cs_cfg_none",
                json!([{"product_id": pid, "quantity": 1, "title": "Plain", "parts": []}]),
            ),
            row(
                "cs_cfg_ghost",
                json!([{"product_id": pid, "configuration_id": "cfg-gone", "quantity": 1, "title": "Ghost", "parts": []}]),
            ),
        ];
        let src = claim_fake(rows, Some(snapshot_with_configs(&pid)));
        let rep = ingest_store_orders(&src, &mut l, None).unwrap();
        assert_eq!(
            (rep.imported, rep.skipped_orders),
            (3, 1),
            "{:?}",
            rep.warnings
        );
        assert_eq!(
            unit_parts(&l, "cs_cfg_dish"),
            vec![vec!["p-body".to_string()]]
        );
        assert_eq!(
            unit_parts(&l, "cs_cfg_full"),
            vec![vec!["p-body".to_string(), "p-grate".to_string()]]
        );
        assert_eq!(
            unit_parts(&l, "cs_cfg_none"),
            vec![vec!["p-body".to_string(), "p-grate".to_string()]]
        );
        // Unknown configuration: never gets every part; the order stays on the shop.
        assert_eq!(local_count(&l, "cs_cfg_ghost"), 0);
        assert!(!l
            .imported_store_order_ids()
            .unwrap()
            .contains("cs_cfg_ghost"));
        assert!(
            rep.warnings.iter().any(|w| w.contains("FP-TEST23")
                && w.contains("left on the shop")
                && w.contains("'cfg-gone' is not in the published catalog")),
            "{:?}",
            rep.warnings
        );
        // Price: line price wins, then the configuration's published price.
        let snap = l.snapshot().unwrap();
        let price = |r: &str| {
            snap.orders
                .iter()
                .find(|o| o.remote_id.as_deref() == Some(r))
                .unwrap()
                .lines[0]
                .unit_price_cents
        };
        assert_eq!(price("cs_cfg_dish"), 900);
        assert_eq!(price("cs_cfg_full"), 1500);
        assert_eq!(price("cs_cfg_none"), 1200);
        // Claim off: nothing claimed.
        assert!(src.calls.borrow().is_empty());
        assert!(!rep.claim_enabled);
    }

    #[test]
    fn configuration_without_published_catalog_leaves_order_on_shop_unclaimed() {
        let (mut l, pid) = ledger_with_configs();
        let src = claim_fake(
            vec![row(
                "cs_cfg_x",
                json!([{"product_id": pid, "configuration_id": "cfg-dish", "quantity": 1, "title": "Dish", "parts": []}]),
            )],
            None,
        );
        // Claim ON: a blocked order must never be claimed.
        let rep = ingest_store_orders(&src, &mut l, Some("fprust-dev-1")).unwrap();
        assert_eq!(
            (rep.imported, rep.claimed, rep.skipped_orders),
            (0, 0, 1),
            "{:?}",
            rep.warnings
        );
        assert!(src.calls.borrow().is_empty(), "blocked order was claimed");
        assert!(
            rep.warnings
                .iter()
                .any(|w| w.contains("FP-TEST23") && w.contains("could not be checked")),
            "{:?}",
            rep.warnings
        );
        assert_eq!(local_count(&l, "cs_cfg_x"), 0);
        // Once the catalog is readable the same row imports with only that configuration's parts.
        let src2 = claim_fake(
            vec![row(
                "cs_cfg_x",
                json!([{"product_id": pid, "configuration_id": "cfg-dish", "quantity": 1, "title": "Dish", "parts": []}]),
            )],
            Some(snapshot_with_configs(&pid)),
        );
        let r2 = ingest_store_orders(&src2, &mut l, Some("fprust-dev-1")).unwrap();
        assert_eq!((r2.imported, r2.claimed), (1, 1), "{:?}", r2.warnings);
        assert_eq!(unit_parts(&l, "cs_cfg_x"), vec![vec!["p-body".to_string()]]);
    }

    #[test]
    fn configuration_listing_no_local_parts_blocks_the_order() {
        let (mut l, pid) = ledger_with_configs();
        let snap = json!({"version": 3, "products": [{"id": pid, "configurations": [
            {"id": "cfg-alien", "part_ids": ["not-here"]}
        ]}]});
        let src = claim_fake(
            vec![row(
                "cs_alien",
                json!([{"product_id": pid, "configuration_id": "cfg-alien", "quantity": 1, "title": "A", "parts": []}]),
            )],
            Some(snap),
        );
        let rep = ingest_store_orders(&src, &mut l, Some("dev")).unwrap();
        assert_eq!((rep.imported, rep.claimed), (0, 0));
        assert!(src.calls.borrow().is_empty());
        assert!(rep
            .warnings
            .iter()
            .any(|w| w.contains("FP-TEST23") && w.contains("lists no parts")));
    }

    #[test]
    fn unknown_product_line_blocks_whole_order_and_claim() {
        let (mut l, pid) = ledger();
        let src = claim_fake(
            vec![row(
                "cs_half",
                json!([
                    {"product_id": pid, "quantity": 1, "title": "Good", "parts": []},
                    {"product_id": "no-such-product", "quantity": 1, "title": "Ghost", "parts": []}
                ]),
            )],
            None,
        );
        let rep = ingest_store_orders(&src, &mut l, Some("dev")).unwrap();
        assert_eq!(
            (rep.imported, rep.claimed, rep.skipped_orders),
            (0, 0, 1),
            "{:?}",
            rep.warnings
        );
        assert!(src.calls.borrow().is_empty(), "never claim a partial order");
        assert_eq!(local_count(&l, "cs_half"), 0);
        assert!(
            !l.imported_store_order_ids().unwrap().contains("cs_half"),
            "retried next import"
        );
        let w = rep
            .warnings
            .iter()
            .find(|w| w.contains("left on the shop"))
            .expect("warning");
        assert!(
            w.starts_with("Website order FP-TEST23")
                && w.contains("line 2")
                && w.contains("no-such-product"),
            "{w}"
        );
        assert!(
            !w.contains("cs_half"),
            "uses the order number, not the Stripe id: {w}"
        );
    }

    fn local_count(l: &ShopLedger, remote: &str) -> usize {
        l.snapshot()
            .unwrap()
            .orders
            .iter()
            .filter(|o| o.remote_id.as_deref() == Some(remote))
            .count()
    }

    #[test]
    fn claim_wins_then_imports_with_device_id_and_timestamp() {
        let (mut l, pid) = ledger();
        let line = json!([{"product_id": pid, "quantity": 1, "title": "W", "parts": []}]);
        let src = claim_fake(vec![row("cs_win", line)], None);
        let rep = ingest_store_orders(&src, &mut l, Some("fprust-dev-1")).unwrap();
        assert_eq!(
            (rep.claim_enabled, rep.claimed, rep.imported),
            (true, 1, 1),
            "{:?}",
            rep.warnings
        );
        assert!(rep.claimed_not_saved.is_empty());
        assert_eq!(local_count(&l, "cs_win"), 1);
        let calls = src.calls.borrow().clone();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            (calls[0].0.as_str(), calls[0].2.as_str()),
            ("cs_win", "fprust-dev-1")
        );
        assert!(
            calls[0].1.ends_with('Z') && calls[0].1.contains('.'),
            "ISO UTC ms: {}",
            calls[0].1
        );
        // Won rows are no longer pending: nothing to do next time.
        let r2 = ingest_store_orders(&src, &mut l, Some("fprust-dev-1")).unwrap();
        assert_eq!((r2.fetched, r2.imported), (0, 0));
    }

    #[test]
    fn claim_empty_means_another_device_has_it_skip() {
        let (mut l, pid) = ledger();
        let src = claim_fake(
            vec![row(
                "cs_lost",
                json!([{"product_id": pid, "quantity": 1, "title": "W", "parts": []}]),
            )],
            None,
        );
        src.modes
            .borrow_mut()
            .insert("cs_lost".into(), ClaimMode::Lost);
        let rep = ingest_store_orders(&src, &mut l, Some("dev")).unwrap();
        assert_eq!(
            (
                rep.claimed,
                rep.claimed_elsewhere,
                rep.imported,
                rep.skipped_orders
            ),
            (0, 1, 0, 1)
        );
        assert_eq!(local_count(&l, "cs_lost"), 0);
        assert!(
            rep.warnings
                .iter()
                .any(|w| w.contains("store order FP-TEST23: already claimed")),
            "{:?}",
            rep.warnings
        );
        assert!(!l.imported_store_order_ids().unwrap().contains("cs_lost"));
    }

    #[test]
    fn claim_error_skips_and_retries_next_time() {
        let (mut l, pid) = ledger();
        let src = claim_fake(
            vec![row(
                "cs_err",
                json!([{"product_id": pid, "quantity": 1, "title": "W", "parts": []}]),
            )],
            None,
        );
        src.modes
            .borrow_mut()
            .insert("cs_err".into(), ClaimMode::Error);
        let r1 = ingest_store_orders(&src, &mut l, Some("dev")).unwrap();
        assert_eq!((r1.claim_errors, r1.imported), (1, 0));
        assert!(r1.warnings.iter().any(|w| w.contains("will retry")));
        assert_eq!(local_count(&l, "cs_err"), 0);
        // Network back: the same row is claimed and imported on the next run.
        src.modes.borrow_mut().remove("cs_err");
        let r2 = ingest_store_orders(&src, &mut l, Some("dev")).unwrap();
        assert_eq!((r2.claimed, r2.imported), (1, 1));
        assert_eq!(local_count(&l, "cs_err"), 1);
        assert_eq!(src.calls.borrow().len(), 2);
    }

    #[test]
    fn local_insert_failure_after_claim_is_reported_loudly() {
        let (mut l, pid) = ledger();
        let src = claim_fake(
            vec![row(
                "cs_lost_local",
                json!([{"product_id": pid, "quantity": 1, "title": "W", "parts": []}]),
            )],
            None,
        );
        // Split steps like the app: prepare (ledger), claim (network), insert (ledger).
        let (rows, configs, _) = fetch_for_ingest(&src).unwrap();
        let mut prep = prepare_ingest(&rows, &l, &configs).unwrap();
        let won = claim_candidates(&src, &mut prep, "dev", "2026-11-18T12:00:00.000Z");
        assert_eq!(won.len(), 1);
        // The product disappears between claim and insert, so the local save fails.
        l.delete_product(&pid).unwrap();
        apply_imports(&mut l, &won, &mut prep.report, true);
        let rep = prep.report;
        assert_eq!((rep.claimed, rep.imported), (1, 0));
        assert_eq!(rep.claimed_not_saved, vec!["FP-TEST23".to_string()]);
        assert!(rep
            .warnings
            .iter()
            .any(|w| w
                .starts_with("CLAIMED ON THE SHOP BUT NOT SAVED LOCALLY: store order FP-TEST23")));
        assert_eq!(local_count(&l, "cs_lost_local"), 0);
    }

    #[test]
    fn setting_off_never_claims_and_already_local_rows_are_tidied_when_on() {
        let (mut l, pid) = ledger();
        let line = json!([{"product_id": pid, "quantity": 1, "title": "W", "parts": []}]);
        let src = claim_fake(
            vec![
                row("cs_ro", line.clone()),
                row(
                    "cs_bad",
                    json!([{"product_id": "gone", "quantity": 1, "title": "G", "parts": []}]),
                ),
            ],
            None,
        );
        let r0 = ingest_store_orders(&src, &mut l, None).unwrap();
        assert_eq!((r0.imported, r0.claimed, r0.claim_enabled), (1, 0, false));
        assert!(
            src.calls.borrow().is_empty(),
            "setting off: no claim request at all"
        );
        // Turned on later: the already-local row is claimed (tidy, no re-import); the
        // unmappable row is never claimed, so another device or a later run can take it.
        let r1 = ingest_store_orders(&src, &mut l, Some("dev")).unwrap();
        assert_eq!((r1.imported, r1.duplicates, r1.claimed_existing), (0, 1, 1));
        let ids: Vec<String> = src.calls.borrow().iter().map(|c| c.0.clone()).collect();
        assert_eq!(ids, vec!["cs_ro".to_string()]);
        assert_eq!(local_count(&l, "cs_ro"), 1);
    }

    #[test]
    fn not_signed_in_or_not_connected_stops_before_any_request() {
        assert_eq!(
            import_gate("", "anon", Some("jwt")),
            ImportGate::NotConnected
        );
        assert_eq!(
            import_gate("https://x.supabase.co", "", Some("jwt")),
            ImportGate::NotConnected
        );
        assert_eq!(
            import_gate("https://x.supabase.co", "anon", None),
            ImportGate::NotSignedIn
        );
        assert_eq!(
            import_gate("https://x.supabase.co", "anon", Some("  ")),
            ImportGate::NotSignedIn
        );
        // The anon key is never accepted as the owner's token.
        assert_eq!(
            import_gate("https://x.supabase.co", "anon", Some("anon")),
            ImportGate::NotSignedIn
        );
        assert_eq!(
            import_gate("https://x.supabase.co", "anon", Some("jwt")),
            ImportGate::Ready("jwt".into())
        );
        let v = gate_result(&ImportGate::NotSignedIn).unwrap();
        assert_eq!(v["message"], json!("Sign in to the shop to import orders"));
        assert_eq!(
            (
                v["connected"].clone(),
                v["signed_in"].clone(),
                v["imported"].clone()
            ),
            (json!(true), json!(false), json!(0))
        );
        assert_eq!(
            gate_result(&ImportGate::NotConnected).unwrap()["connected"],
            json!(false)
        );
        assert!(gate_result(&ImportGate::Ready("jwt".into())).is_none());
    }

    #[test]
    fn claim_setting_defaults_on_and_can_be_turned_off() {
        let s = fp_core::ShopSettings::default();
        assert!(s.store_ingest_claim_on());
        let old: fp_core::ShopSettings = serde_json::from_value(json!({"shop_name": "x"})).unwrap();
        assert!(old.store_ingest_claim_on(), "older saved settings: ON");
        let off: fp_core::ShopSettings =
            serde_json::from_value(json!({"store_ingest_claim_enabled": false})).unwrap();
        assert!(!off.store_ingest_claim_on());
        assert_eq!(
            serde_json::to_value(&off).unwrap()["store_ingest_claim_enabled"],
            json!(false)
        );
    }
    struct OfflineSource;
    impl StoreOrderSource for OfflineSource {
        fn fetch_pending_orders(&self) -> Result<Vec<Value>, String> {
            Err("offline".into())
        }
    }

    /// Generic fixture: one product with a tracked part, a color-only part and a
    /// picture-only part, plus two filaments. No real shop data.
    fn ledger() -> (ShopLedger, String) {
        let mut l = ShopLedger::open_in_memory().unwrap();
        let s = l
            .add_filament_swatch(
                "Ingest Red".into(),
                "Acme".into(),
                "PLA Basic".into(),
                "#FF0000".into(),
                20.0,
                1000.0,
            )
            .unwrap();
        let red = s
            .filaments
            .iter()
            .find(|f| f.name == "Ingest Red")
            .unwrap()
            .id
            .clone();
        l.add_filament_swatch(
            "Ingest Blue".into(),
            "Acme".into(),
            "PLA Basic".into(),
            "#0000FF".into(),
            20.0,
            1000.0,
        )
        .unwrap();
        let pid = "prod-ingest-test".to_string();
        let part =
            |id: &str, name: &str, tracked: bool, color_only: bool, order: i64| CatalogPart {
                id: id.into(),
                product_id: pid.clone(),
                name: name.into(),
                is_tracked: tracked,
                is_color_only: color_only,
                default_filament_id: red.clone(),
                grams: 5.0,
                print_minutes: 10,
                unit_cost: 0.1,
                mesh_file: String::new(),
                sort_order: order,
            };
        l.upsert_product(Product {
            id: pid.clone(),
            name: "Test Widget".into(),
            sku: "TW".into(),
            price_cents: 1200,
            packed_weight_oz: 1.0,
            default_box_name: String::new(),
            box_cost_cents: 0,
            supports_custom_text: true,
            parts: vec![
                part("p-body", "Body", true, false, 1),
                part("p-trim", "Trim", true, true, 2),
                part("p-badge", "Badge", false, false, 3),
            ],
        })
        .unwrap();
        (l, pid)
    }

    fn part_ids(_l: &ShopLedger, _pid: &str) -> (String, String, String) {
        ("p-body".into(), "p-trim".into(), "p-badge".into())
    }

    fn blue_id(l: &ShopLedger) -> String {
        l.snapshot()
            .unwrap()
            .filaments
            .iter()
            .find(|f| f.name == "Ingest Blue")
            .unwrap()
            .id
            .clone()
    }

    fn row(id: &str, lines: Value) -> Value {
        json!({
            "id": id, "source": "website", "customer_name": "Pat Example", "customer_email": "pat@example.com",
            "notes": "Ship to: 1 Test St", "lines": lines, "payment_status": "paid", "needs_review": false,
            "created_at": "2026-11-18T12:00:00Z", "imported_at": null, "order_number": "FP-TEST23",
            "shipping_cents": 795
        })
    }

    #[test]
    fn maps_lines_colors_custom_text_and_view_camera() {
        let (mut l, pid) = ledger();
        let (body, trim, badge) = part_ids(&l, &pid);
        let blue = blue_id(&l);
        let cam = json!({"position": [120.1235, -150.5, 98.25], "target": [0, 0, 12.5], "fov": 32});
        let src = FakeSource {
            calls: Cell::new(0),
            rows: vec![row(
                "cs_test_a",
                json!([{
                    "product_id": pid, "quantity": 2, "title": "Test Widget", "custom_text": " ANN ",
                    "unit_price_cents": 1500, "view_camera": cam,
                    "parts": [
                        {"part_id": body, "swatch_id": blue, "hex": "#0000FF", "name": "Blue", "material": "PLA Basic"},
                        {"part_id": trim, "swatch_id": blue, "hex": "#0000FF", "name": "Blue", "material": "PLA Basic"},
                        {"part_id": badge, "swatch_id": format!("display-{badge}"), "hex": "#999999", "name": "Silver", "material": ""}
                    ]
                }]),
            )],
        };
        let rep = ingest_store_orders(&src, &mut l, None).unwrap();
        assert_eq!(
            (
                rep.fetched,
                rep.imported,
                rep.duplicates,
                rep.skipped_orders,
                rep.skipped_lines
            ),
            (1, 1, 0, 0, 0),
            "{:?}",
            rep.warnings
        );

        let snap = l.snapshot().unwrap();
        let o = snap
            .orders
            .iter()
            .find(|o| o.remote_id.as_deref() == Some("cs_test_a"))
            .unwrap();
        assert_eq!(o.source, "website");
        assert_eq!(o.order_code, "FP-TEST23");
        assert_eq!(o.customer_name, "Pat Example");
        assert_eq!(o.customer_email, "pat@example.com");
        assert_eq!(o.notes, "Ship to: 1 Test St");
        assert_eq!(o.shipping_charged_cents, 795);
        assert!(!o.is_rush && !o.is_on_hold);
        // quantity 2 -> two local lines, each with its own copy of the customer's angle.
        assert_eq!(o.lines.len(), 2);
        for line in &o.lines {
            assert_eq!(line.custom_text.as_deref(), Some("ANN"));
            assert_eq!(line.unit_price_cents, 1500);
            let vc = line.view_camera.expect("view_camera passed through");
            assert_eq!(vc.position, [120.1235, -150.5, 98.25]);
            assert_eq!(vc.target, [0.0, 0.0, 12.5]);
            assert_eq!(vc.fov, 32.0);
            // Only the tracked, non-color-only part becomes a unit; picture-only never does.
            assert_eq!(line.units.len(), 1);
            assert_eq!(line.units[0].part_id, body);
            assert_eq!(line.units[0].filament_id, blue);
            assert!(!line.item_label.contains("Silver"));
        }
        // Serialized for the UI as the shop shape.
        let j = serde_json::to_value(&o.lines[0]).unwrap();
        assert_eq!(
            j["view_camera"],
            json!({"position": [120.1235, -150.5, 98.25], "target": [0.0, 0.0, 12.5], "fov": 32.0})
        );
    }

    #[test]
    fn dedupes_on_reimport_and_after_local_delete() {
        let (mut l, pid) = ledger();
        let src = FakeSource {
            calls: Cell::new(0),
            rows: vec![
                row(
                    "cs_dup",
                    json!([{"product_id": pid, "quantity": 1, "title": "W", "parts": []}]),
                ),
                // Same id twice in one fetch.
                row(
                    "cs_dup",
                    json!([{"product_id": pid, "quantity": 1, "title": "W", "parts": []}]),
                ),
            ],
        };
        let r1 = ingest_store_orders(&src, &mut l, None).unwrap();
        assert_eq!((r1.imported, r1.duplicates), (1, 1));
        let r2 = ingest_store_orders(&src, &mut l, None).unwrap();
        assert_eq!((r2.imported, r2.duplicates), (0, 2));
        let count = |l: &ShopLedger| {
            l.snapshot()
                .unwrap()
                .orders
                .iter()
                .filter(|o| o.remote_id.as_deref() == Some("cs_dup"))
                .count()
        };
        assert_eq!(count(&l), 1);
        // Deleting the local order must not bring it back on the next import.
        let oid = r1.imported_order_ids[0].clone();
        l.delete_order(&oid).unwrap();
        let r3 = ingest_store_orders(&src, &mut l, None).unwrap();
        assert_eq!((r3.imported, r3.duplicates), (0, 2));
        assert_eq!(count(&l), 0);
        assert_eq!(src.calls.get(), 3);
    }

    #[test]
    fn unreadable_line_blocks_order_but_quantity_zero_line_is_dropped() {
        let (mut l, pid) = ledger();
        let blocked = FakeSource {
            calls: Cell::new(0),
            rows: vec![row(
                "cs_bad",
                json!([
                    {"quantity": "lots"},
                    {"product_id": pid, "quantity": 1, "title": "Good", "parts": []}
                ]),
            )],
        };
        let rb = ingest_store_orders(&blocked, &mut l, None).unwrap();
        assert_eq!((rb.imported, rb.skipped_orders), (0, 1));
        assert!(rb
            .warnings
            .iter()
            .any(|w| w.contains("FP-TEST23") && w.contains("line 1 is unreadable")));
        let src = FakeSource {
            calls: Cell::new(0),
            rows: vec![row(
                "cs_mixed",
                json!([
                    {"product_id": pid, "quantity": 0, "title": "Zero", "parts": []},
                    {"product_id": pid, "quantity": 1, "title": "Good", "view_camera": {"position": [1, 2], "target": "x"}, "parts": [
                        {"part_id": "not-a-part", "swatch_id": "sw", "hex": "#000000", "name": "Black", "material": "PLA"}
                    ]}
                ]),
            )],
        };
        let rep = ingest_store_orders(&src, &mut l, None).unwrap();
        assert_eq!(
            (rep.imported, rep.skipped_lines),
            (1, 1),
            "{:?}",
            rep.warnings
        );
        let snap = l.snapshot().unwrap();
        let o = snap
            .orders
            .iter()
            .find(|o| o.remote_id.as_deref() == Some("cs_mixed"))
            .unwrap();
        assert_eq!(o.lines.len(), 1);
        assert!(
            o.lines[0].view_camera.is_none(),
            "malformed view_camera reads as missing"
        );
        assert!(o.lines[0].item_label.starts_with("Good"));
    }

    #[test]
    fn order_with_no_usable_lines_is_skipped_and_retried() {
        let (mut l, _pid) = ledger();
        let src = FakeSource {
            calls: Cell::new(0),
            rows: vec![
                row(
                    "cs_none",
                    json!([{"product_id": "gone", "quantity": 1, "title": "Gone", "parts": []}]),
                ),
                json!({"id": "cs_broken"}),
                json!("not an object"),
            ],
        };
        let rep = ingest_store_orders(&src, &mut l, None).unwrap();
        assert_eq!((rep.imported, rep.skipped_orders), (0, 3));
        assert!(
            !l.imported_store_order_ids().unwrap().contains("cs_none"),
            "not marked seen, so it retries"
        );
    }

    #[test]
    fn needs_review_holds_and_name_fallback_and_identity_match() {
        let (mut l, pid) = ledger();
        let (body, _, _) = part_ids(&l, &pid);
        let blue = blue_id(&l);
        let mut r = row(
            "cs_review",
            json!([{"product_id": pid, "quantity": 1, "title": "",
            "parts": [{"part_id": body, "swatch_id": "shop-only-swatch", "hex": "#123456", "name": "ingest  blue", "material": "PLA Basic"}]}]),
        );
        r["needs_review"] = json!(true);
        r["customer_name"] = Value::Null;
        r["ship_name"] = json!("Sam Shipto");
        r["order_number"] = Value::Null;
        r["source"] = json!("manual");
        let rep = ingest_rows(&[r], &mut l, &CatalogConfigurations::default()).unwrap();
        assert_eq!(rep.imported, 1, "{:?}", rep.warnings);
        let snap = l.snapshot().unwrap();
        let o = snap
            .orders
            .iter()
            .find(|o| o.remote_id.as_deref() == Some("cs_review"))
            .unwrap();
        assert!(o.is_on_hold);
        assert_eq!(o.customer_name, "Sam Shipto");
        assert_eq!(o.source, "website", "a store row is never a manual order");
        assert!(o.order_code.starts_with("FP-"));
        assert!(
            o.lines[0].item_label.starts_with("Test Widget"),
            "empty title falls back to product name"
        );
        assert_eq!(
            o.lines[0].units[0].filament_id, blue,
            "name+material identity match, hex ignored"
        );
    }

    #[test]
    fn unpaid_or_dismissed_rows_are_not_imported() {
        let (mut l, pid) = ledger();
        let line = json!([{"product_id": pid, "quantity": 1, "title": "W", "parts": []}]);
        let mut a = row("cs_unpaid", line.clone());
        a["payment_status"] = json!("unpaid");
        let mut b = row("cs_dismissed", line);
        b["dismissed_at"] = json!("2026-11-01T00:00:00Z");
        let rep = ingest_rows(&[a, b], &mut l, &CatalogConfigurations::default()).unwrap();
        assert_eq!((rep.imported, rep.skipped_orders), (0, 2));
    }

    #[test]
    fn offline_source_errors_without_touching_the_ledger() {
        let (mut l, _) = ledger();
        let before = l.snapshot().unwrap().orders.len();
        assert!(ingest_store_orders(&OfflineSource, &mut l, Some("dev-test")).is_err());
        assert_eq!(l.snapshot().unwrap().orders.len(), before);
    }

    #[test]
    fn manual_orders_have_no_view_camera_or_remote_id() {
        let (mut l, pid) = ledger();
        let snap = l
            .create_order(fp_core::CreateOrderInput {
                customer_name: "Walk In".into(),
                customer_email: String::new(),
                product_id: pid,
                quantity: 1,
                is_rush: false,
                custom_text: None,
            })
            .unwrap();
        let o = snap
            .orders
            .iter()
            .find(|o| o.customer_name == "Walk In")
            .unwrap();
        assert!(o.remote_id.is_none() && o.lines[0].view_camera.is_none());
        let j = serde_json::to_value(o).unwrap();
        assert!(j.get("remote_id").is_none() && j["lines"][0].get("view_camera").is_none());
    }
}
