//! Wire-compatible types for the shop's Supabase data (schema version 3), shared with the
//! shop website and the Swift app. Field names and JSON shapes must stay byte-compatible:
//! - `store_catalog.snapshot` (`Snapshot`, `PublishedShipping`, `checkout_shipping_decision`)
//! - `store_orders` (`StoreOrderRow`, `StoreOrderLine`, `StoreOrderLinePart`, quota & thumbnail-only rules)
//! - `POST /api/orders/status` & `store_status_outbox.json` (`PublicOrderStatus`, `StoreStatusPushPayload`, `map_public_order_status`)
//! - `shop_documents` (`ShopDocumentRow`, last-write-wins conflict resolution)
//! - `catalog/_staging/<printer_id>.json` & `catalog/_staging/beds.json` (`StagedPrinterTray`, `StagedTrayPart`, `resolve_staged_tray_conflict`)
//! - Filament identity (`FilamentSpoolIdentity`, `spools_match`)

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Wire schema version shared by FarmPrint, the shop website and the Swift app.
pub const CONTRACTS_SCHEMA_VERSION: u32 = 3;

/// `CHAR_ASPECT` 0.62 must match between `Store/lib/inscription.ts` and `Domain/InscriptionLayout.swift`.
pub const INSCRIPTION_CHAR_ASPECT: f64 = 0.62;

// ============================================================================
// 1. Catalog Snapshot (`store_catalog.snapshot`) & Checkout Flat-Rate Shipping
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractQuota {
    pub max_units: u32,
    pub window_days: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractFilament {
    pub id: String,
    pub name: String,
    pub hex: String,
    pub material: String,
    /// Relative path in public `store` bucket (`swatches/<id>.jpg?v=<hash8>`). Omitted when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub photo_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractCatalogPart {
    pub id: String,
    pub display_name: String,
    pub image_stem: String,
    pub image_path: String,
    /// Non-empty `display_hex` marks a thumbnail-only part (e.g., decorative picture-only parts).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_hex: Option<String>,
}

impl ContractCatalogPart {
    pub fn is_thumbnail_only(&self) -> bool {
        self.display_hex
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PublishedShippingProduct {
    /// A non-bool value decodes as `None` (ships), per "an unknown value does not fail the document".
    #[serde(
        default,
        deserialize_with = "lenient_opt_bool",
        skip_serializing_if = "Option::is_none"
    )]
    pub ignore: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packed_weight_oz: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_box_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PublishedShippingBox {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub empty_weight_oz: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_cents: Option<i64>,
}

/// Checkout flat-rate shipping settings (`snapshot.shipping.checkout` in the published catalog).
/// - Missing `cents` defaults to `795` ($7.95).
/// - Missing `free_over_cents` defaults to `Some(4000)` ($40.00).
/// - Explicit `"free_over_cents": null` means no free-shipping threshold (`None`).
///
/// Serializes `free_over_cents: None` as explicit `null` (never omitted), since omitting means $40.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublishedShippingCheckout {
    pub cents: i64,
    pub free_over_cents: Option<i64>,
}

impl<'de> Deserialize<'de> for PublishedShippingCheckout {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde_json::Value;
        let v = Value::deserialize(d)?;
        let def = Self::default();
        let Value::Object(map) = v else {
            return Ok(def);
        };
        let finite_int = |v: &Value| -> Option<i64> {
            match v {
                Value::Number(n) => n.as_i64().or_else(|| {
                    n.as_f64()
                        .filter(|f| f.is_finite())
                        .map(|f| f.round() as i64)
                }),
                _ => None,
            }
        };
        let cents = map.get("cents").and_then(finite_int).unwrap_or(def.cents);
        let free_over_cents = match map.get("free_over_cents") {
            Some(Value::Null) => None,
            Some(v) => Some(finite_int(v).unwrap_or(4000)),
            None => def.free_over_cents,
        };
        Ok(Self {
            cents,
            free_over_cents,
        })
    }
}

fn lenient_opt_bool<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
    Ok(serde_json::Value::deserialize(d)?.as_bool())
}

/// `shipping.boxes` that is not an array (old object of interiors) is ignored; bad entries are dropped.
fn lenient_boxes<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<PublishedShippingBox>, D::Error> {
    match serde_json::Value::deserialize(d)? {
        serde_json::Value::Array(items) => Ok(items
            .into_iter()
            .filter_map(|v| serde_json::from_value(v).ok())
            .collect()),
        _ => Ok(Vec::new()),
    }
}

/// Product entries that fail to decode are dropped rather than failing the snapshot.
fn lenient_products<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<BTreeMap<String, PublishedShippingProduct>, D::Error> {
    match serde_json::Value::deserialize(d)? {
        serde_json::Value::Object(m) => Ok(m
            .into_iter()
            .filter_map(|(k, v)| serde_json::from_value(v).ok().map(|p| (k, p)))
            .collect()),
        _ => Ok(BTreeMap::new()),
    }
}

impl Default for PublishedShippingCheckout {
    fn default() -> Self {
        Self {
            cents: 795,
            free_over_cents: Some(4000),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct PublishedShipping {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkout: Option<PublishedShippingCheckout>,
    #[serde(
        default,
        deserialize_with = "lenient_products",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub products: BTreeMap<String, PublishedShippingProduct>,
    #[serde(
        default,
        deserialize_with = "lenient_boxes",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub boxes: Vec<PublishedShippingBox>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckoutShippingDecision {
    pub shipping_cents: i64,
    pub stripe_label: String,
    pub notes_line: String,
}

/// Computes the checkout shipping decision exactly as the shop's checkout does:
/// 1. If every item in the cart is Don't ship (`shipping.products[id].ignore == Some(true)`), shipping is $0.
/// 2. Else if `free_over_cents` is `Some(threshold)` and `merchandise_subtotal_cents >= threshold`, shipping is $0.
/// 3. Else shipping is `cents`.
pub fn checkout_shipping_decision(
    shipping: Option<&PublishedShipping>,
    cart_product_ids: &[String],
    merchandise_subtotal_cents: i64,
) -> CheckoutShippingDecision {
    let checkout_cfg = shipping
        .and_then(|s| s.checkout.clone())
        .unwrap_or_default();

    let all_dont_ship = !cart_product_ids.is_empty()
        && cart_product_ids.iter().all(|pid| {
            shipping
                .and_then(|s| s.products.get(pid))
                .and_then(|p| p.ignore)
                .unwrap_or(false)
        });

    let shipping_cents = if cart_product_ids.is_empty() || all_dont_ship {
        0
    } else if let Some(threshold) = checkout_cfg.free_over_cents {
        if merchandise_subtotal_cents >= threshold {
            0
        } else {
            checkout_cfg.cents
        }
    } else {
        checkout_cfg.cents
    };

    let (stripe_label, notes_line) = if shipping_cents == 0 {
        ("Free shipping".to_string(), "Ship: free".to_string())
    } else {
        let dollars = shipping_cents as f64 / 100.0;
        (
            "Standard shipping".to_string(),
            format!("Ship: ${:.2}", dollars),
        )
    };

    CheckoutShippingDecision {
        shipping_cents,
        stripe_label,
        notes_line,
    }
}

// ============================================================================
// 2. Website Orders (`store_orders`)
// ============================================================================

/// Every field defaults to an empty string when missing or null.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct StoreOrderLinePart {
    #[serde(deserialize_with = "null_as_empty_string")]
    pub part_id: String,
    #[serde(deserialize_with = "null_as_empty_string")]
    pub swatch_id: String,
    #[serde(deserialize_with = "null_as_empty_string")]
    pub hex: String,
    #[serde(deserialize_with = "null_as_empty_string")]
    pub name: String,
    #[serde(deserialize_with = "null_as_empty_string")]
    pub material: String,
}

impl StoreOrderLinePart {
    /// Without a snapshot, the `display-` swatch prefix marks a thumbnail-only part (shown, never printed).
    pub fn is_thumbnail_only_fallback(&self) -> bool {
        self.swatch_id.starts_with("display-")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoreOrderLine {
    pub product_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration_id: Option<String>,
    pub quantity: u32,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letter_swatch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letter_hex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letter_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_price_cents: Option<i64>,
    #[serde(default)]
    pub parts: Vec<StoreOrderLinePart>,
    /// Optional customer view angle (2026-11-18, "Customer view angle"): shop viewer space
    /// as-is (Z-up, mm). Missing or malformed reads as `None` (product default angle).
    #[serde(
        default,
        deserialize_with = "lenient_view_camera",
        skip_serializing_if = "Option::is_none"
    )]
    pub view_camera: Option<fp_core::ViewCamera>,
}

fn lenient_view_camera<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<fp_core::ViewCamera>, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value::<fp_core::ViewCamera>(v)
        .ok()
        .filter(fp_core::ViewCamera::is_valid))
}

impl StoreOrderLine {
    /// Formats the customer-facing description (`Text: … · Part: Color · Letter color: …`),
    /// stripping any thumbnail-only parts (`display_hex` or `display-` swatch prefix) and cutting to 500 chars.
    pub fn customer_facing_description(
        &self,
        catalog_parts: Option<&[ContractCatalogPart]>,
    ) -> String {
        let mut segments: Vec<String> = Vec::new();
        if let Some(text) = &self.custom_text {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                segments.push(format!("Text: {}", trimmed));
            }
        }
        for part in &self.parts {
            if part.is_thumbnail_only_fallback() {
                continue;
            }
            if let Some(cat_parts) = catalog_parts {
                if let Some(cp) = cat_parts.iter().find(|p| p.id == part.part_id) {
                    if cp.is_thumbnail_only() {
                        continue;
                    }
                    if !part.name.trim().is_empty() {
                        segments.push(format!("{}: {}", cp.display_name, part.name.trim()));
                    }
                    continue;
                }
            }
            if !part.name.trim().is_empty() {
                segments.push(format!("Color: {}", part.name.trim()));
            }
        }
        if self
            .custom_text
            .as_ref()
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false)
        {
            if let Some(letter_name) = &self.letter_name {
                if !letter_name.trim().is_empty() {
                    segments.push(format!("Letter color: {}", letter_name.trim()));
                }
            }
        }
        let joined = segments.join(" · ");
        if joined.chars().count() > 500 {
            let truncated: String = joined.chars().take(499).collect();
            format!("{}…", truncated)
        } else {
            joined
        }
    }
}

/// Complete `store_orders` row as stored in Supabase (schema version 3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoreOrderRow {
    pub id: String,
    pub source: String,
    pub customer_name: Option<String>,
    pub customer_email: Option<String>,
    pub notes: Option<String>,
    pub lines: Vec<StoreOrderLine>,
    pub payment_status: String,
    #[serde(default)]
    pub needs_review: bool,
    pub created_at: String,
    pub imported_at: Option<String>,
    #[serde(default)]
    pub amount_total_cents: Option<i64>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub claimed_by: Option<String>,
    #[serde(default)]
    pub dismissed_at: Option<String>,
    #[serde(default)]
    pub dismiss_reason: Option<String>,
    #[serde(default)]
    pub dismissed_by: Option<String>,
    #[serde(default)]
    pub ship_name: Option<String>,
    #[serde(default)]
    pub ship_line1: Option<String>,
    #[serde(default)]
    pub ship_line2: Option<String>,
    #[serde(default)]
    pub ship_city: Option<String>,
    #[serde(default)]
    pub ship_state: Option<String>,
    #[serde(default)]
    pub ship_postal_code: Option<String>,
    #[serde(default)]
    pub ship_country: Option<String>,
    #[serde(default)]
    pub ship_phone: Option<String>,
    #[serde(default)]
    pub shipping_cents: Option<i64>,
    /// `null` or missing reads as 0 (older rows have no tax column value).
    #[serde(default, deserialize_with = "null_as_zero_i64")]
    pub tax_cents: i64,
    #[serde(default)]
    pub stripe_payment_intent: Option<String>,
    /// Any word other than the four statuses (or `refunded`) reads as `received`.
    #[serde(default)]
    pub public_status: Option<StorePublicStatus>,
    #[serde(default)]
    pub status_updated_at: Option<String>,
    #[serde(default)]
    pub shipped_at: Option<String>,
    #[serde(default)]
    pub tracking_number: Option<String>,
    #[serde(default, deserialize_with = "lenient_carrier")]
    pub tracking_carrier: Option<TrackingCarrier>,
    #[serde(default)]
    pub order_number: Option<String>,
    #[serde(default)]
    pub confirmation_sent_at: Option<String>,
    #[serde(default)]
    pub shipped_email_sent_at: Option<String>,
    #[serde(default)]
    pub review_email_sent_at: Option<String>,
    #[serde(default)]
    pub refunded_at: Option<String>,
    #[serde(default)]
    pub refunded_cents: Option<i64>,
}

impl StoreOrderRow {
    /// Pending website order predicate (`where imported_at is null and payment_status = 'paid' and dismissed_at is null`).
    pub fn is_pending_import(&self) -> bool {
        self.imported_at.is_none() && self.payment_status == "paid" && self.dismissed_at.is_none()
    }

    /// Every paid row counts toward `quota`, except rows with `dismiss_reason = 'refunded'`.
    pub fn counts_toward_quota(&self) -> bool {
        self.payment_status == "paid" && self.dismiss_reason.as_deref() != Some("refunded")
    }
}

fn null_as_empty_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) => s,
        _ => String::new(),
    })
}

fn null_as_zero_i64<'de, D: serde::Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::Number(n) => n
            .as_i64()
            .or_else(|| {
                n.as_f64()
                    .filter(|f| f.is_finite())
                    .map(|f| f.round() as i64)
            })
            .unwrap_or(0),
        _ => 0,
    })
}

fn lenient_opt_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) if !s.is_empty() => Some(s),
        _ => None,
    })
}

/// `store_orders.tracking_carrier`: `usps`, `ups`, `fedex`, or null.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackingCarrier {
    Usps,
    Ups,
    Fedex,
}

/// Unknown or non-string carrier reads as `None`.
fn lenient_carrier<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<TrackingCarrier>, D::Error> {
    Ok(serde_json::from_value(serde_json::Value::deserialize(d)?).ok())
}

/// `store_orders.public_status` as stored. `Refunded` is reserved (FarmPrint never writes it).
/// Any other non-empty word reads as `Received` (same rule the shop server applies).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StorePublicStatus {
    Received,
    Printing,
    Ready,
    Shipped,
    Refunded,
}

impl<'de> Deserialize<'de> for StorePublicStatus {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        Ok(match v.as_str() {
            Some("printing") => Self::Printing,
            Some("ready") => Self::Ready,
            Some("shipped") => Self::Shipped,
            Some("refunded") => Self::Refunded,
            _ => Self::Received,
        })
    }
}

// ----------------------------------------------------------------------------
// Order ship fields (shop sync payload, schema 3) & shop prefs shipping switch
// ----------------------------------------------------------------------------

/// `ship_status`: `ready`, `packed`, or `shipped`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShipStatus {
    Ready,
    Packed,
    Shipped,
}

fn lenient_ship_status<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<ShipStatus>, D::Error> {
    Ok(serde_json::from_value(serde_json::Value::deserialize(d)?).ok())
}

/// Optional ship fields on each order (flattened into the order payload).
/// Omitted from JSON when nil or empty; a bad value decodes as `None` and never fails the order.
/// Reopening an order (status leaves Closed) clears all five: see [`OrderShipFields::clear`].
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct OrderShipFields {
    #[serde(
        deserialize_with = "lenient_ship_status",
        skip_serializing_if = "Option::is_none"
    )]
    pub ship_status: Option<ShipStatus>,
    #[serde(
        deserialize_with = "lenient_opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub packed_at: Option<String>,
    #[serde(
        deserialize_with = "lenient_opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub shipped_at: Option<String>,
    #[serde(
        deserialize_with = "lenient_opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub tracking_number: Option<String>,
    /// `None` means use the suggested box (`shipping.products[id].default_box_id`).
    #[serde(
        deserialize_with = "lenient_opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub box_preset_id: Option<String>,
}

impl OrderShipFields {
    pub fn clear(&mut self) {
        *self = Self::default();
    }
    pub fn is_shipped(&self) -> bool {
        self.ship_status == Some(ShipStatus::Shipped) || self.shipped_at.is_some()
    }
}

/// `UIPrefs.shipping` in shop prefs (not in the catalog snapshot). `enabled` defaults to false.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ShopShippingPrefs {
    #[serde(deserialize_with = "lenient_bool_false")]
    pub enabled: bool,
    #[serde(
        deserialize_with = "lenient_opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub enabled_at: Option<String>,
}

fn lenient_bool_false<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(serde_json::Value::deserialize(d)?
        .as_bool()
        .unwrap_or(false))
}

impl ShopShippingPrefs {
    /// Turns the switch on or off. `enabled_at` is set the first time it turns on and kept afterward.
    pub fn set_enabled(&mut self, on: bool, now_iso8601: &str) {
        if on && self.enabled_at.is_none() {
            self.enabled_at = Some(now_iso8601.to_string());
        }
        self.enabled = on;
    }
}

// --- fp-core mirrors (fp-core cannot depend on fp-sync) ---

impl From<ShipStatus> for fp_core::ShipStatus {
    fn from(s: ShipStatus) -> Self {
        match s {
            ShipStatus::Ready => fp_core::ShipStatus::Ready,
            ShipStatus::Packed => fp_core::ShipStatus::Packed,
            ShipStatus::Shipped => fp_core::ShipStatus::Shipped,
        }
    }
}

impl From<fp_core::ShipStatus> for ShipStatus {
    fn from(s: fp_core::ShipStatus) -> Self {
        match s {
            fp_core::ShipStatus::Ready => ShipStatus::Ready,
            fp_core::ShipStatus::Packed => ShipStatus::Packed,
            fp_core::ShipStatus::Shipped => ShipStatus::Shipped,
        }
    }
}

impl From<OrderShipFields> for fp_core::OrderShipFields {
    fn from(f: OrderShipFields) -> Self {
        fp_core::OrderShipFields {
            ship_status: f.ship_status.map(Into::into),
            packed_at: f.packed_at,
            shipped_at: f.shipped_at,
            tracking_number: f.tracking_number,
            box_preset_id: f.box_preset_id,
        }
    }
}

impl From<fp_core::OrderShipFields> for OrderShipFields {
    fn from(f: fp_core::OrderShipFields) -> Self {
        OrderShipFields {
            ship_status: f.ship_status.map(Into::into),
            packed_at: f.packed_at,
            shipped_at: f.shipped_at,
            tracking_number: f.tracking_number,
            box_preset_id: f.box_preset_id,
        }
    }
}

impl ShopShippingPrefs {
    /// Reads the switch from fp-core settings.
    pub fn from_settings(s: &fp_core::ShopSettings) -> Self {
        Self {
            enabled: s.shipping_enabled,
            enabled_at: s.shipping_enabled_at.clone(),
        }
    }
    /// Writes the switch back into fp-core settings.
    pub fn apply_to_settings(&self, s: &mut fp_core::ShopSettings) {
        s.shipping_enabled = self.enabled;
        s.shipping_enabled_at = self.enabled_at.clone();
    }
}

// ============================================================================
// 3. Shop Order Status (`POST /api/orders/status`) & `store_status_outbox.json`
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PublicOrderStatus {
    Received,
    Printing,
    Ready,
    Shipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreStatusPushPayload {
    pub id: String,
    pub public_status: PublicOrderStatus,
    pub shipped_at: Option<String>,
    pub tracking_number: Option<String>,
    /// FarmPrint sends null.
    pub tracking_carrier: Option<TrackingCarrier>,
}

/// Maps local order state to `public_status`; mirrors the Swift app's `StorePublicStatus` mapping.
pub fn map_public_order_status(
    ship_status_is_shipped: bool,
    shipped_at: Option<&str>,
    last_pushed: Option<PublicOrderStatus>,
    is_closed: bool,
    all_items_dont_ship: bool,
    any_part_past_first_step: bool,
) -> Option<PublicOrderStatus> {
    if ship_status_is_shipped || shipped_at.is_some() {
        return Some(PublicOrderStatus::Shipped);
    }
    if matches!(
        last_pushed,
        Some(PublicOrderStatus::Ready | PublicOrderStatus::Shipped)
    ) && !is_closed
    {
        return Some(PublicOrderStatus::Printing);
    }
    if all_items_dont_ship && !is_closed {
        return None;
    }
    if is_closed {
        return Some(PublicOrderStatus::Ready);
    }
    if any_part_past_first_step {
        return Some(PublicOrderStatus::Printing);
    }
    Some(PublicOrderStatus::Received)
}

// ============================================================================
// 4. Shop Sync (`shop_documents`) & Staged Print Jobs (`catalog/_staging/`)
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShopDocumentRow {
    pub kind: String,
    pub id: String,
    pub revision: i64,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub device_id: String,
    pub payload: serde_json::Value,
}

/// Compares two `updated_at` stamps as RFC3339 instants; falls back to string compare
/// when either does not parse. Returns true when `a` is strictly later than `b`.
pub fn updated_at_is_later(a: &str, b: &str) -> bool {
    use chrono::DateTime;
    match (
        DateTime::parse_from_rfc3339(a.trim()),
        DateTime::parse_from_rfc3339(b.trim()),
    ) {
        (Ok(x), Ok(y)) => x > y,
        _ => a > b,
    }
}

/// Last-write-wins resolution for `shop_documents` records (`revision` first, then `updated_at`).
pub fn resolve_shop_document_conflict<'a>(
    local: &'a ShopDocumentRow,
    remote: &'a ShopDocumentRow,
) -> &'a ShopDocumentRow {
    if remote.revision > local.revision {
        remote
    } else if local.revision > remote.revision {
        local
    } else if updated_at_is_later(&remote.updated_at, &local.updated_at) {
        remote
    } else {
        local
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagedTrayPart {
    pub order_id: String,
    pub item_id: String,
    pub part_id: String,
    #[serde(rename = "spoolMatchKey")]
    pub spool_match_key: String,
}

/// Synced file per printer: `catalog/_staging/<printer id>.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagedPrinterTray {
    pub printer_id: String,
    pub parts: Vec<StagedTrayPart>,
    pub loaded_filaments: Vec<String>,
    pub staged_from: String,
    pub updated_at: String,
    pub revision: i64,
}

/// Whole-tray conflict resolution: higher `revision` wins; tie goes to later `updated_at`.
pub fn resolve_staged_tray_conflict<'a>(
    local: &'a StagedPrinterTray,
    remote: &'a StagedPrinterTray,
) -> &'a StagedPrinterTray {
    if remote.revision > local.revision {
        remote
    } else if local.revision > remote.revision {
        local
    } else if updated_at_is_later(&remote.updated_at, &local.updated_at) {
        remote
    } else {
        local
    }
}

// ============================================================================
// 5. Filament Identity
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilamentSpoolIdentity {
    pub brand: Option<String>,
    pub material_line: String,
    pub color_name: String,
    pub hex: String,
}

fn normalize_brand(brand: &str) -> String {
    brand
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn normalize_token(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Two spools are the same filament when brand (ignoring case and whitespace only),
/// material line (bare base material matches any line of that material), and color name match.
/// Hex is never used to decide a match (hex values vary between brands and scans).
pub fn spools_match(a: &FilamentSpoolIdentity, b: &FilamentSpoolIdentity) -> bool {
    // 1. Color name must match (case/whitespace insensitive)
    if normalize_token(&a.color_name) != normalize_token(&b.color_name) {
        return false;
    }

    // 2. Brand: missing brand acts as a wildcard
    if let (Some(ba), Some(bb)) = (&a.brand, &b.brand) {
        let nba = normalize_brand(ba);
        let nbb = normalize_brand(bb);
        if !nba.is_empty() && !nbb.is_empty() && nba != nbb {
            return false;
        }
    }

    // 3. Material line: bare base material (single word like "PETG" or "PLA") matches any line of that base material
    let ma = normalize_token(&a.material_line);
    let mb = normalize_token(&b.material_line);
    if ma == mb {
        return true;
    }
    let ma_words: Vec<&str> = ma.split(' ').collect();
    let mb_words: Vec<&str> = mb.split(' ').collect();
    if ma_words.len() == 1 && mb_words.first() == ma_words.first() {
        return true;
    }
    if mb_words.len() == 1 && ma_words.first() == mb_words.first() {
        return true;
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkout_shipping_decision_follows_contract_rules() {
        let mut products = BTreeMap::new();
        products.insert(
            "digital-addon".to_string(),
            PublishedShippingProduct {
                ignore: Some(true),
                packed_weight_oz: None,
                default_box_id: None,
            },
        );
        products.insert(
            "widget".to_string(),
            PublishedShippingProduct {
                ignore: Some(false),
                packed_weight_oz: Some(2.4),
                default_box_id: Some("small-box".to_string()),
            },
        );
        let shipping = PublishedShipping {
            checkout: Some(PublishedShippingCheckout::default()), // 795 cents, free over 4000
            products,
            boxes: vec![],
        };

        // 1. Don't-ship only -> $0
        let d1 = checkout_shipping_decision(Some(&shipping), &["digital-addon".to_string()], 1500);
        assert_eq!(d1.shipping_cents, 0);
        assert_eq!(d1.notes_line, "Ship: free");

        // 2. Physical item under $40 -> $7.95
        let d2 = checkout_shipping_decision(Some(&shipping), &["widget".to_string()], 3999);
        assert_eq!(d2.shipping_cents, 795);
        assert_eq!(d2.notes_line, "Ship: $7.95");

        // 3. Physical item at or over $40 -> $0
        let d3 = checkout_shipping_decision(Some(&shipping), &["widget".to_string()], 4000);
        assert_eq!(d3.shipping_cents, 0);
        assert_eq!(d3.notes_line, "Ship: free");
    }

    #[test]
    fn shipping_checkout_decodes_per_contract_defaults() {
        let parse = |j: &str| serde_json::from_str::<PublishedShipping>(j).unwrap();
        let c = |j: &str| parse(j).checkout.unwrap();
        // Missing fields use defaults; missing free_over_cents is $40, not "no threshold".
        assert_eq!(
            c(r#"{"checkout":{}}"#),
            PublishedShippingCheckout::default()
        );
        // Explicit null free_over_cents = no threshold.
        assert_eq!(
            c(r#"{"checkout":{"cents":500,"free_over_cents":null}}"#).free_over_cents,
            None
        );
        // Null / string values fall back to defaults instead of failing.
        let bad = c(r#"{"checkout":{"cents":"7.95","free_over_cents":"40"}}"#);
        assert_eq!((bad.cents, bad.free_over_cents), (795, Some(4000)));
        assert_eq!(c(r#"{"checkout":{"cents":null}}"#).cents, 795);
        // Explicit null round-trips as null, not omitted.
        let out = serde_json::to_string(&PublishedShippingCheckout {
            cents: 500,
            free_over_cents: None,
        })
        .unwrap();
        assert!(out.contains(r#""free_over_cents":null"#));
        // Old object-shaped `boxes` and old per-product keys are ignored; bad `ignore` ships.
        let s = parse(
            r#"{"boxes":{"small":{"l":1}},"products":{"a":{"ignore":"yes","size_weight":3,"unranked":true},"b":{"ignore":true}}}"#,
        );
        assert!(s.boxes.is_empty());
        assert_eq!(s.products["a"].ignore, None);
        assert_eq!(s.products["b"].ignore, Some(true));
        let s2 = parse(r#"{"boxes":[{"id":"bx","length":6},{"id":5}]}"#);
        assert_eq!(s2.boxes.len(), 1);
    }

    #[test]
    fn staged_tray_conflict_prefers_higher_revision_then_updated_at() {
        let t1 = StagedPrinterTray {
            printer_id: "p1".to_string(),
            parts: vec![],
            loaded_filaments: vec![],
            staged_from: "go".to_string(),
            updated_at: "2026-10-25T10:00:00Z".to_string(),
            revision: 3,
        };
        let t2 = StagedPrinterTray {
            printer_id: "p1".to_string(),
            parts: vec![],
            loaded_filaments: vec![],
            staged_from: "mac".to_string(),
            updated_at: "2026-10-25T09:00:00Z".to_string(),
            revision: 4,
        };
        assert_eq!(resolve_staged_tray_conflict(&t1, &t2).revision, 4);
    }

    #[test]
    fn filament_identity_ignores_hex_case_and_whitespace_and_bare_material() {
        let s1 = FilamentSpoolIdentity {
            brand: Some("Poly Maker".to_string()),
            material_line: "PETG HF".to_string(),
            color_name: "Blue".to_string(),
            hex: "#1E40AF".to_string(),
        };
        let s2 = FilamentSpoolIdentity {
            brand: Some("polymaker".to_string()),
            material_line: "PETG".to_string(),
            color_name: "blue".to_string(),
            hex: "#0000FF".to_string(),
        };
        assert!(spools_match(&s1, &s2));
        // Brand matching does not apply singular/plural or other brand-specific rewrites.
        let s3 = FilamentSpoolIdentity {
            brand: Some("Acme Lab".to_string()),
            material_line: "PLA".to_string(),
            color_name: "Red".to_string(),
            hex: "#FF0000".to_string(),
        };
        let s4 = FilamentSpoolIdentity {
            brand: Some("acmelabs".to_string()),
            material_line: "PLA".to_string(),
            color_name: "red".to_string(),
            hex: "#AA0000".to_string(),
        };
        assert!(!spools_match(&s3, &s4));
    }

    #[test]
    fn store_order_line_strips_thumbnail_only_parts_from_description() {
        let catalog_parts = vec![
            ContractCatalogPart {
                id: "body".to_string(),
                display_name: "Body".to_string(),
                image_stem: "body".to_string(),
                image_path: "parts/body.png".to_string(),
                display_hex: None,
            },
            ContractCatalogPart {
                id: "lock".to_string(),
                display_name: "Lock".to_string(),
                image_stem: "lock".to_string(),
                image_path: "parts/lock.png".to_string(),
                display_hex: Some("#9CA3AF".to_string()),
            },
        ];
        let line = StoreOrderLine {
            product_id: "prod-test-widget".to_string(),
            configuration_id: None,
            quantity: 1,
            title: "Widget".to_string(),
            custom_text: Some("HELLO".to_string()),
            letter_swatch_id: Some("sw-white".to_string()),
            letter_hex: Some("#FFFFFF".to_string()),
            letter_name: Some("White".to_string()),
            unit_price_cents: Some(1500),
            parts: vec![
                StoreOrderLinePart {
                    part_id: "body".to_string(),
                    swatch_id: "sw-blue".to_string(),
                    hex: "#1E40AF".to_string(),
                    name: "Blue".to_string(),
                    material: "PETG".to_string(),
                },
                StoreOrderLinePart {
                    part_id: "lock".to_string(),
                    swatch_id: "display-lock".to_string(),
                    hex: "#9CA3AF".to_string(),
                    name: "Silver".to_string(),
                    material: "Metal".to_string(),
                },
            ],
            view_camera: None,
        };
        let desc = line.customer_facing_description(Some(&catalog_parts));
        assert_eq!(desc, "Text: HELLO · Body: Blue · Letter color: White");
        assert!(!desc.contains("Lock"));
    }

    fn order_json(extra: serde_json::Value) -> serde_json::Value {
        let mut base = serde_json::json!({
            "id": "cs_test_1", "source": "website", "customer_name": null,
            "customer_email": null, "notes": null, "lines": [],
            "payment_status": "paid", "created_at": "2026-01-01T00:00:00Z", "imported_at": null
        });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    }

    #[test]
    fn order_ship_fields_decode_and_bad_values_become_none() {
        let f: OrderShipFields = serde_json::from_value(serde_json::json!({
            "ship_status": "packed", "packed_at": "2026-01-02T00:00:00Z",
            "tracking_number": "TRK1", "box_preset_id": "box-a"
        }))
        .unwrap();
        assert_eq!(f.ship_status, Some(ShipStatus::Packed));
        assert_eq!(f.box_preset_id.as_deref(), Some("box-a"));
        assert!(f.shipped_at.is_none());
        let bad: OrderShipFields = serde_json::from_value(serde_json::json!({
            "ship_status": "lost", "packed_at": 5, "shipped_at": true, "box_preset_id": ""
        }))
        .unwrap();
        assert_eq!(bad, OrderShipFields::default());
        let n: OrderShipFields =
            serde_json::from_value(serde_json::json!({"ship_status": 3})).unwrap();
        assert!(n.ship_status.is_none());
        assert_eq!(
            serde_json::to_string(&OrderShipFields::default()).unwrap(),
            "{}"
        );
        let mut c = f.clone();
        c.clear();
        assert_eq!(c, OrderShipFields::default());
    }

    #[test]
    fn ship_types_convert_to_and_from_fp_core() {
        let f = OrderShipFields {
            ship_status: Some(ShipStatus::Shipped),
            packed_at: Some("a".into()),
            shipped_at: Some("b".into()),
            tracking_number: Some("T".into()),
            box_preset_id: None,
        };
        let core: fp_core::OrderShipFields = f.clone().into();
        assert!(core.is_shipped());
        assert_eq!(OrderShipFields::from(core.clone()), f);
        assert_eq!(
            serde_json::to_value(&core).unwrap(),
            serde_json::to_value(&f).unwrap()
        );
        let mut st = fp_core::ShopSettings::default();
        let mut p = ShopShippingPrefs::from_settings(&st);
        p.set_enabled(true, "t1");
        p.apply_to_settings(&mut st);
        assert!(st.shipping_enabled);
        assert_eq!(st.shipping_enabled_at.as_deref(), Some("t1"));
        assert_eq!(ShopShippingPrefs::from_settings(&st), p);
    }

    #[test]
    fn shop_shipping_prefs_default_off_and_keep_enabled_at() {
        let p: ShopShippingPrefs = serde_json::from_str("{}").unwrap();
        assert!(!p.enabled && p.enabled_at.is_none());
        let p2: ShopShippingPrefs = serde_json::from_str(r#"{"enabled":"yes"}"#).unwrap();
        assert!(!p2.enabled);
        let mut p = p;
        p.set_enabled(true, "2026-01-01T00:00:00Z");
        p.set_enabled(false, "2026-02-01T00:00:00Z");
        p.set_enabled(true, "2026-03-01T00:00:00Z");
        assert!(p.enabled);
        assert_eq!(p.enabled_at.as_deref(), Some("2026-01-01T00:00:00Z"));
    }

    #[test]
    fn store_order_row_lifecycle_columns_and_tax_default() {
        let r: StoreOrderRow = serde_json::from_value(order_json(serde_json::json!({
            "tax_cents": null, "confirmation_sent_at": "2026-01-01T00:00:01Z",
            "refunded_cents": 250
        })))
        .unwrap();
        assert_eq!(r.tax_cents, 0);
        assert_eq!(
            r.confirmation_sent_at.as_deref(),
            Some("2026-01-01T00:00:01Z")
        );
        assert_eq!(r.refunded_cents, Some(250));
        assert!(
            r.shipped_email_sent_at.is_none()
                && r.review_email_sent_at.is_none()
                && r.refunded_at.is_none()
        );
        let r2: StoreOrderRow = serde_json::from_value(order_json(serde_json::json!({}))).unwrap();
        assert_eq!(r2.tax_cents, 0);
        let r3: StoreOrderRow =
            serde_json::from_value(order_json(serde_json::json!({"tax_cents": 81}))).unwrap();
        assert_eq!(r3.tax_cents, 81);
    }

    #[test]
    fn line_part_missing_fields_default_empty() {
        let p: StoreOrderLinePart =
            serde_json::from_value(serde_json::json!({"part_id": "p1", "hex": null})).unwrap();
        assert_eq!(p.part_id, "p1");
        assert_eq!(p.hex, "");
        assert_eq!(p.swatch_id, "");
        assert_eq!(p.material, "");
    }

    #[test]
    fn public_status_unknown_word_is_received_and_carrier_restricted() {
        let r: StoreOrderRow = serde_json::from_value(order_json(serde_json::json!({
            "public_status": "boxed", "tracking_carrier": "dhl"
        })))
        .unwrap();
        assert_eq!(r.public_status, Some(StorePublicStatus::Received));
        assert!(r.tracking_carrier.is_none());
        let r: StoreOrderRow = serde_json::from_value(order_json(serde_json::json!({
            "public_status": "refunded", "tracking_carrier": "ups"
        })))
        .unwrap();
        assert_eq!(r.public_status, Some(StorePublicStatus::Refunded));
        assert_eq!(r.tracking_carrier, Some(TrackingCarrier::Ups));
        let r: StoreOrderRow =
            serde_json::from_value(order_json(serde_json::json!({"public_status": null}))).unwrap();
        assert!(r.public_status.is_none());
        let payload = StoreStatusPushPayload {
            id: "cs_1".into(),
            public_status: PublicOrderStatus::Shipped,
            shipped_at: None,
            tracking_number: None,
            tracking_carrier: Some(TrackingCarrier::Fedex),
        };
        assert_eq!(
            serde_json::to_value(&payload).unwrap()["tracking_carrier"],
            "fedex"
        );
    }

    #[test]
    fn shop_document_tie_break_uses_rfc3339_instants() {
        let doc = |u: &str| ShopDocumentRow {
            kind: "order".into(),
            id: "o1".into(),
            revision: 2,
            updated_at: u.into(),
            deleted_at: None,
            device_id: "d".into(),
            payload: serde_json::Value::Null,
        };
        // Same instant-ordering differs from string ordering across offsets.
        let local = doc("2026-01-01T10:00:00Z");
        let remote = doc("2026-01-01T09:30:00-01:00"); // 10:30Z, later
        assert_eq!(
            resolve_shop_document_conflict(&local, &remote).updated_at,
            remote.updated_at
        );
        let local = doc("2026-01-01T10:00:00.5Z");
        let remote = doc("2026-01-01T10:00:00Z");
        assert_eq!(
            resolve_shop_document_conflict(&local, &remote).updated_at,
            local.updated_at
        );
        // Unparseable falls back to string compare.
        assert!(updated_at_is_later("b", "a"));
        assert!(!updated_at_is_later("a", "2026-01-01T00:00:00Z") || "a" > "2026-01-01T00:00:00Z");
    }
}
