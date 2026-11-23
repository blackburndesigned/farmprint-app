//! Catalog publish (`store_catalog`, row `id = current`, column `snapshot`). The JSON shape is
//! the shop's catalog snapshot (its `Snapshot` type) and must stay field-compatible with it.
//!
//! Built from fp-core data, product-agnostic. Fields fp-core does not own yet (part images, views,
//! layers, configurations, quota, custom_text, manual_url, letter_filaments, 3D keys...) are carried
//! over from the previously published snapshot, matched by id, so a publish never wipes them.
//! Shipping publishes only what the live shop prices from: `shipping.checkout` (flat rate + free-over),
//! plus `products[id].ignore` and packing-only fields. No box-class postage.
//!
//! No network here. Upload goes through [`CatalogUploader`]; tests use fakes / a local file.

use crate::catalog::preserve_3d_fields;
use fp_core::models::{FilamentSwatch, Product, ShippingTier, ShopSettings};
use serde_json::{json, Map, Value};

pub const SNAPSHOT_VERSION: u32 = 3;
pub const CATALOG_ROW_ID: &str = "current";
pub const DEFAULT_CHECKOUT_CENTS: i64 = fp_core::models::DEFAULT_CHECKOUT_FLAT_CENTS;
pub const DEFAULT_FREE_OVER_CENTS: i64 = 4000;

/// Product keys fp-core does not produce; copied from the previous snapshot's product when absent.
/// (`price_cents` is not here: fp-core always sets it, so a carried value could never apply.)
const CARRIED_PRODUCT_KEYS: [&str; 11] = [
    "blurb",
    "description",
    "quota",
    "configurations",
    "layers",
    "views",
    "images",
    "exclusive_groups",
    "allow_upscale",
    "custom_text",
    "manual_url",
];
/// Part keys carried from the previous snapshot's part (same product, same part id).
const CARRIED_PART_KEYS: [&str; 2] = ["image_stem", "image_path"];

#[derive(Debug)]
pub enum PublishError {
    Uploader(String),
    Invalid(String),
}
impl std::fmt::Display for PublishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Uploader(e) => write!(f, "upload failed: {e}"),
            Self::Invalid(e) => write!(f, "invalid snapshot: {e}"),
        }
    }
}
impl std::error::Error for PublishError {}

/// Row written to `store_catalog`. The shop reads `snapshot.access_token || row.access_token`.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogRow {
    pub id: String,
    pub published_at: String,
    pub access_token: String,
    pub snapshot: Value,
}

/// Injectable storage. The real one (Supabase REST upsert into `store_catalog`) lives in src-tauri.
pub trait CatalogUploader {
    /// The currently published snapshot JSON, if any.
    fn fetch_current(&self) -> Result<Option<Value>, PublishError>;
    fn upload(&mut self, row: &CatalogRow) -> Result<(), PublishError>;
}

/// Writes the row to a local JSON file. For dry runs against a copy; never touches the network.
pub struct LocalFileUploader {
    pub path: std::path::PathBuf,
}
impl CatalogUploader for LocalFileUploader {
    fn fetch_current(&self) -> Result<Option<Value>, PublishError> {
        match std::fs::read_to_string(&self.path) {
            Ok(s) => {
                let row: Value =
                    serde_json::from_str(&s).map_err(|e| PublishError::Uploader(e.to_string()))?;
                Ok(row.get("snapshot").cloned())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(PublishError::Uploader(e.to_string())),
        }
    }
    fn upload(&mut self, row: &CatalogRow) -> Result<(), PublishError> {
        let v = json!({"id": row.id, "published_at": row.published_at,
                       "access_token": row.access_token, "snapshot": row.snapshot});
        let s =
            serde_json::to_string_pretty(&v).map_err(|e| PublishError::Uploader(e.to_string()))?;
        std::fs::write(&self.path, s).map_err(|e| PublishError::Uploader(e.to_string()))
    }
}

pub struct PublishInput<'a> {
    pub filaments: &'a [FilamentSwatch],
    pub products: &'a [Product],
    pub settings: &'a ShopSettings,
    /// ISO 8601, supplied by the caller (keeps this crate clock-free and testable).
    pub published_at: String,
    /// New token, or `None` to keep the previous snapshot's token.
    pub access_token: Option<String>,
    /// Store-wide 3D switch from Settings, or `None` to keep the previous value.
    pub product_page_3d: Option<bool>,
}

fn hex(h: &str) -> String {
    let t = h.trim();
    let body = t.strip_prefix('#').unwrap_or(t);
    if body.is_empty() {
        return String::new();
    }
    // Contract colors are 6-digit #RRGGBB; drop the alpha byte of app-side #RRGGBBAA (case kept as stored).
    let body = if body.len() == 8 && body.chars().all(|c| c.is_ascii_hexdigit()) {
        &body[..6]
    } else {
        body
    };
    format!("#{body}")
}

/// Picture-only for the shop (gets a fixed `display_hex`): untracked AND not color-only.
/// Color-only parts are customer-colorable (e.g. the inscription text part), so no display_hex.
pub fn is_picture_only(part: &fp_core::models::CatalogPart) -> bool {
    !part.is_tracked && !part.is_color_only
}

fn prev_products(previous: Option<&Value>) -> Vec<&Map<String, Value>> {
    previous
        .and_then(|p| p.get("products"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default()
}

fn build_shipping(settings: &ShopSettings, products: &[Product]) -> Value {
    // As entered when flat_shipping_cents_set (so $0 publishes); else 0 = "not entered" -> default.
    let cents = settings.checkout_flat_cents();
    // free_shipping_threshold_enabled: Some(false) = no threshold (explicit null on the wire);
    // Some(true) = as entered; None = legacy (entered value if > 0, else the $40 default).
    let free_over: Value = match settings.free_shipping_threshold_enabled {
        Some(false) => Value::Null,
        Some(true) => json!(settings.free_shipping_threshold_cents.max(0)),
        None => json!(if settings.free_shipping_threshold_cents > 0 {
            settings.free_shipping_threshold_cents
        } else {
            DEFAULT_FREE_OVER_CENTS
        }),
    };
    let mut per_product = Map::new();
    for p in products {
        let mut e = Map::new();
        let ignore = settings
            .product_shipping
            .iter()
            .any(|s| s.product_id == p.id && s.box_class == ShippingTier::Ignore);
        if ignore {
            e.insert("ignore".into(), json!(true));
        }
        if p.packed_weight_oz > 0.0 {
            e.insert("packed_weight_oz".into(), json!(p.packed_weight_oz));
        }
        if let Some(b) = settings.box_presets.iter().find(|b| {
            !p.default_box_name.is_empty()
                && (b.name == p.default_box_name || b.id == p.default_box_name)
        }) {
            e.insert("default_box_id".into(), json!(b.id));
        }
        if !e.is_empty() {
            per_product.insert(p.id.clone(), Value::Object(e));
        }
    }
    let boxes: Vec<Value> = settings.box_presets.iter().map(|b| json!({
        "id": b.id, "name": b.name, "length": b.length_in, "width": b.width_in,
        "height": b.height_in, "empty_weight_oz": b.box_weight_oz, "cost_cents": b.cost_cents,
    })).collect();
    let mut s = Map::new();
    s.insert(
        "checkout".into(),
        json!({"cents": cents, "free_over_cents": free_over}),
    );
    if !per_product.is_empty() {
        s.insert("products".into(), Value::Object(per_product));
    }
    if !boxes.is_empty() {
        s.insert("boxes".into(), Value::Array(boxes));
    }
    Value::Object(s)
}

/// Builds the wire snapshot. `previous` is the currently published snapshot (for carry-over).
pub fn build_snapshot(
    input: &PublishInput,
    previous: Option<&Value>,
) -> Result<Value, PublishError> {
    let access_token = input
        .access_token
        .clone()
        .or_else(|| {
            previous
                .and_then(|p| p.get("access_token"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| {
            PublishError::Invalid("access_token is required (none given, none published)".into())
        })?;
    let filament_hex = |id: &str| {
        input
            .filaments
            .iter()
            .find(|f| f.id == id)
            .map(|f| hex(&f.hex))
    };
    let prevs = prev_products(previous);

    let products: Vec<Value> = input
        .products
        .iter()
        .map(|p| {
            let prev = prevs
                .iter()
                .find(|q| q.get("id").and_then(Value::as_str) == Some(p.id.as_str()));
            let prev_parts: Vec<&Map<String, Value>> = prev
                .and_then(|q| q.get("parts"))
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_object).collect())
                .unwrap_or_default();
            let mut parts: Vec<_> = p.parts.iter().collect();
            parts.sort_by_key(|pt| pt.sort_order);
            let parts: Vec<Value> = parts
                .into_iter()
                .map(|pt| {
                    let mut o = Map::new();
                    o.insert("id".into(), json!(pt.id));
                    o.insert("display_name".into(), json!(pt.name));
                    let pp = prev_parts
                        .iter()
                        .find(|q| q.get("id").and_then(Value::as_str) == Some(pt.id.as_str()));
                    for k in CARRIED_PART_KEYS {
                        o.insert(
                            k.into(),
                            pp.and_then(|q| q.get(k)).cloned().unwrap_or(json!("")),
                        );
                    }
                    if is_picture_only(pt) {
                        if let Some(h) =
                            filament_hex(&pt.default_filament_id).filter(|h| !h.is_empty())
                        {
                            o.insert("display_hex".into(), json!(h));
                        }
                    }
                    Value::Object(o)
                })
                .collect();
            let mut o = Map::new();
            o.insert("id".into(), json!(p.id));
            o.insert("name".into(), json!(p.name));
            o.insert("price_cents".into(), json!(p.price_cents));
            o.insert("parts".into(), Value::Array(parts));
            if let Some(prev) = prev {
                for k in CARRIED_PRODUCT_KEYS {
                    if !o.contains_key(k) {
                        if let Some(v) = prev.get(k) {
                            o.insert(k.into(), v.clone());
                        }
                    }
                }
            }
            if !o.contains_key("configurations") {
                o.insert("configurations".into(), json!([]));
            }
            if p.supports_custom_text && !o.contains_key("custom_text") {
                o.insert(
                    "custom_text".into(),
                    json!({"label": "Custom text", "max_length": 16}),
                );
            }
            Value::Object(o)
        })
        .collect();

    let filaments: Vec<Value> = input
        .filaments
        .iter()
        .map(|f| {
            let mut o =
                json!({"id": f.id, "name": f.name, "hex": hex(&f.hex), "material": f.material});
            // Keep a published swatch photo; fp-core has no photo field yet.
            if let Some(ph) = previous
                .and_then(|p| p.get("filaments"))
                .and_then(Value::as_array)
                .and_then(|a| {
                    a.iter()
                        .find(|x| x.get("id").and_then(Value::as_str) == Some(f.id.as_str()))
                })
                .and_then(|x| x.get("photo_url"))
                .filter(|v| v.is_string())
            {
                o["photo_url"] = ph.clone();
            }
            o
        })
        .collect();

    let currency = match input.settings.currency.trim() {
        "" => "usd".to_string(),
        c => c.to_lowercase(),
    };
    let mut snap = json!({
        "version": SNAPSHOT_VERSION,
        "published_at": input.published_at,
        "access_token": access_token,
        "currency": currency,
        "filaments": filaments,
        "letter_filaments": previous.and_then(|p| p.get("letter_filaments")).cloned().unwrap_or(json!([])),
        "products": products,
        "shipping": build_shipping(input.settings, input.products),
    });
    if let Some(b) = input.product_page_3d {
        snap["product_page_3d"] = json!(b);
    }
    if let Some(prev) = previous {
        preserve_3d_fields(&mut snap, prev);
    }
    // Tri-state: None carries the live value (above); no live value either = off.
    if snap.get("product_page_3d").is_none_or(Value::is_null) {
        snap["product_page_3d"] = json!(false);
    }
    Ok(snap)
}

/// Fetch previous, build, preserve 3D, upload. Returns the uploaded row.
pub fn publish_catalog(
    input: &PublishInput,
    uploader: &mut dyn CatalogUploader,
) -> Result<CatalogRow, PublishError> {
    let previous = uploader.fetch_current()?;
    let snapshot = build_snapshot(input, previous.as_ref())?;
    let row = CatalogRow {
        id: CATALOG_ROW_ID.into(),
        published_at: input.published_at.clone(),
        access_token: snapshot["access_token"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        snapshot,
    };
    uploader.upload(&row)?;
    Ok(row)
}

/// Dry-run comparison of the published snapshot vs the one about to be published.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct CatalogDiff {
    pub has_current: bool,
    pub products_added: Vec<String>,
    pub products_removed: Vec<String>,
    pub products_changed: Vec<String>,
    /// Human-readable lines, e.g. "checkout.cents: 795 -> 599".
    pub shipping_changes: Vec<String>,
    pub other_changes: Vec<String>,
}

fn products_by_id(s: Option<&Value>) -> Vec<(String, &Value)> {
    s.and_then(|v| v.get("products"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    p.get("id")
                        .and_then(Value::as_str)
                        .map(|id| (id.to_string(), p))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn diff_values(prefix: &str, a: Option<&Value>, b: Option<&Value>, out: &mut Vec<String>) {
    match (a, b) {
        (Some(Value::Object(x)), Some(Value::Object(y))) => {
            let mut keys: Vec<&String> = x.keys().chain(y.keys()).collect();
            keys.sort();
            keys.dedup();
            for k in keys {
                diff_values(
                    &format!("{prefix}{}{k}", if prefix.is_empty() { "" } else { "." }),
                    x.get(k),
                    y.get(k),
                    out,
                );
            }
        }
        (a, b) if a != b => {
            let f = |v: Option<&Value>| v.map(|v| v.to_string()).unwrap_or_else(|| "(none)".into());
            out.push(format!("{prefix}: {} -> {}", f(a), f(b)));
        }
        _ => {}
    }
}

/// Pure diff; `current` is the published snapshot (None on first publish). Never includes access_token values.
pub fn diff_snapshots(current: Option<&Value>, next: &Value) -> CatalogDiff {
    let cur = products_by_id(current);
    let nxt = products_by_id(Some(next));
    let mut d = CatalogDiff {
        has_current: current.is_some(),
        ..Default::default()
    };
    for (id, p) in &nxt {
        match cur.iter().find(|(c, _)| c == id) {
            None => d.products_added.push(id.clone()),
            Some((_, q)) if q != p => d.products_changed.push(id.clone()),
            _ => {}
        }
    }
    for (id, _) in &cur {
        if !nxt.iter().any(|(n, _)| n == id) {
            d.products_removed.push(id.clone());
        }
    }
    diff_values(
        "",
        current.and_then(|c| c.get("shipping")),
        next.get("shipping"),
        &mut d.shipping_changes,
    );
    for k in [
        "currency",
        "product_page_3d",
        "filaments",
        "letter_filaments",
        "version",
    ] {
        let (a, b) = (current.and_then(|c| c.get(k)), next.get(k));
        if a != b {
            d.other_changes.push(if k.ends_with("filaments") {
                format!("{k} changed")
            } else {
                format!(
                    "{k}: {} -> {}",
                    a.map(|v| v.to_string()).unwrap_or("(none)".into()),
                    b.map(|v| v.to_string()).unwrap_or("(none)".into())
                )
            });
        }
    }
    if current.and_then(|c| c.get("access_token")) != next.get("access_token") {
        d.other_changes.push("access_token changed".into());
    }
    d
}

#[cfg(test)]
mod tests {
    #[test]
    fn hex_normalizes_to_rrggbb() {
        assert_eq!(super::hex("#1E40AF66"), "#1E40AF");
        assert_eq!(super::hex("1e40af66"), "#1e40af");
        assert_eq!(super::hex("#1E40AF"), "#1E40AF");
        assert_eq!(super::hex(" 9ca3af "), "#9ca3af");
        assert_eq!(super::hex(""), "");
    }

    use super::*;
    use fp_core::models::{CatalogPart, ProductShippingSetting, ShippingBoxPreset};

    struct Fake {
        current: Option<Value>,
        uploaded: Vec<CatalogRow>,
    }
    impl CatalogUploader for Fake {
        fn fetch_current(&self) -> Result<Option<Value>, PublishError> {
            Ok(self.current.clone())
        }
        fn upload(&mut self, row: &CatalogRow) -> Result<(), PublishError> {
            self.uploaded.push(row.clone());
            Ok(())
        }
    }

    fn part(id: &str, tracked: bool, color_only: bool, fil: &str, order: i64) -> CatalogPart {
        CatalogPart {
            id: id.into(),
            product_id: "prod-a".into(),
            name: format!("Part {id}"),
            is_tracked: tracked,
            is_color_only: color_only,
            default_filament_id: fil.into(),
            grams: 1.0,
            print_minutes: 1,
            unit_cost: 0.0,
            mesh_file: String::new(),
            sort_order: order,
        }
    }
    fn fixtures() -> (Vec<FilamentSwatch>, Vec<Product>, ShopSettings) {
        let f = |id: &str, h: &str| FilamentSwatch {
            id: id.into(),
            name: format!("Color {id}"),
            brand: "Brand".into(),
            material: "PLA".into(),
            hex: h.into(),
            cost_per_kg: 20.0,
            grams_remaining: 1000.0,
            vendor: None,
        };
        let p = Product {
            id: "prod-a".into(),
            name: "Widget".into(),
            sku: "W".into(),
            price_cents: 1500,
            packed_weight_oz: 3.5,
            default_box_name: "Mailer".into(),
            box_cost_cents: 50,
            supports_custom_text: true,
            parts: vec![
                part("body", true, false, "f1", 0),
                part("deco", false, false, "f2", 1),
                part("trim", true, true, "f2", 2),
            ],
        };
        let q = Product {
            id: "prod-b".into(),
            name: "Gift card".into(),
            sku: "G".into(),
            price_cents: 2500,
            packed_weight_oz: 0.0,
            default_box_name: String::new(),
            box_cost_cents: 0,
            supports_custom_text: false,
            parts: vec![],
        };
        let s = ShopSettings {
            box_presets: vec![ShippingBoxPreset {
                id: "box-1".into(),
                name: "Mailer".into(),
                length_in: 6.0,
                width_in: 4.0,
                height_in: 2.0,
                box_weight_oz: 1.0,
                cost_cents: 40,
            }],
            product_shipping: vec![ProductShippingSetting {
                product_id: "prod-b".into(),
                box_class: ShippingTier::Ignore,
                per_box: 0,
            }],
            ..Default::default()
        };
        (vec![f("f1", "112233"), f("f2", "#AABBCC")], vec![p, q], s)
    }
    fn input<'a>(
        f: &'a [FilamentSwatch],
        p: &'a [Product],
        s: &'a ShopSettings,
        tok: Option<&str>,
    ) -> PublishInput<'a> {
        PublishInput {
            filaments: f,
            products: p,
            settings: s,
            published_at: "2026-11-01T12:00:00Z".into(),
            access_token: tok.map(Into::into),
            product_page_3d: None,
        }
    }

    #[test]
    fn builds_contract_shape_with_flat_shipping_and_picture_only_parts() {
        let (f, p, s) = fixtures();
        let snap = build_snapshot(&input(&f, &p, &s, Some("tok")), None).unwrap();
        for k in [
            "version",
            "published_at",
            "access_token",
            "currency",
            "filaments",
            "letter_filaments",
            "products",
            "shipping",
        ] {
            assert!(snap.get(k).is_some(), "missing {k}");
        }
        assert_eq!(snap["version"], json!(3));
        assert_eq!(snap["currency"], json!("usd"));
        assert_eq!(snap["filaments"][0]["hex"], json!("#112233"));
        let parts = snap["products"][0]["parts"].as_array().unwrap();
        assert!(parts[0].get("display_hex").is_none());
        assert_eq!(parts[1]["display_hex"], json!("#AABBCC"));
        // trim is tracked+color-only: customer-colorable, never a fixed display_hex.
        assert!(parts[2].get("display_hex").is_none());
        assert_eq!(snap["products"][0]["custom_text"]["max_length"], json!(16));
        assert!(snap["products"][1].get("custom_text").is_none());
        assert_eq!(
            snap["shipping"]["checkout"],
            json!({"cents": 795, "free_over_cents": 4000})
        );
        assert_eq!(
            snap["shipping"]["products"]["prod-b"]["ignore"],
            json!(true)
        );
        assert_eq!(
            snap["shipping"]["products"]["prod-a"]["default_box_id"],
            json!("box-1")
        );
        // No box-class pricing keys.
        let sh = snap["shipping"].as_object().unwrap();
        assert!(
            !sh.contains_key("rates") && !sh.contains_key("share") && !sh.contains_key("per_box")
        );
        // Typed decode by the existing contract model succeeds.
        let ship: crate::contracts::PublishedShipping =
            serde_json::from_value(snap["shipping"].clone()).unwrap();
        assert_eq!(ship.checkout.unwrap().cents, 795);
    }

    #[test]
    fn settings_override_checkout_rate() {
        let (f, p, mut s) = fixtures();
        s.flat_shipping_cents = 599;
        s.free_shipping_threshold_cents = 5000;
        let snap = build_snapshot(&input(&f, &p, &s, Some("t")), None).unwrap();
        assert_eq!(
            snap["shipping"]["checkout"],
            json!({"cents": 599, "free_over_cents": 5000})
        );
    }

    #[test]
    fn publish_carries_previous_fields_and_preserves_3d() {
        let (f, p, s) = fixtures();
        let previous = json!({
            "version": 3, "access_token": "old-tok", "product_page_3d": true,
            "letter_filaments": [{"id": "l1", "name": "L", "hex": "#000000", "material": "PLA"}],
            "filaments": [{"id": "f1", "photo_url": "swatches/f1.jpg?v=1"}],
            "products": [{"id": "prod-a", "quota": {"max_units": 5, "window_days": 7},
                "configurations": [{"id": "c1", "name": "C", "price_cents": 1500, "part_ids": ["body"]}],
                "custom_text": {"label": "Name", "max_length": 10}, "manual_url": "https://example.com/m.pdf",
                "preview_3d": {"mesh_path": "a.glb"}, "inscription_3d": {"part_id": "body"}, "store_3d": "on",
                "parts": [{"id": "body", "image_stem": "body", "image_path": "img/body.png"}]}]
        });
        let mut up = Fake {
            current: Some(previous),
            uploaded: vec![],
        };
        let row = publish_catalog(&input(&f, &p, &s, None), &mut up).unwrap();
        assert_eq!(up.uploaded.len(), 1);
        assert_eq!(row.id, "current");
        assert_eq!(row.access_token, "old-tok");
        let a = &row.snapshot["products"][0];
        assert_eq!(a["quota"]["max_units"], json!(5));
        assert_eq!(a["configurations"][0]["id"], json!("c1"));
        assert_eq!(a["custom_text"]["label"], json!("Name"));
        assert_eq!(a["manual_url"], json!("https://example.com/m.pdf"));
        assert_eq!(a["preview_3d"]["mesh_path"], json!("a.glb"));
        assert_eq!(a["inscription_3d"]["part_id"], json!("body"));
        assert_eq!(a["store_3d"], json!("on"));
        assert_eq!(a["parts"][0]["image_path"], json!("img/body.png"));
        assert_eq!(row.snapshot["product_page_3d"], json!(true));
        assert_eq!(row.snapshot["letter_filaments"][0]["id"], json!("l1"));
        assert_eq!(
            row.snapshot["filaments"][0]["photo_url"],
            json!("swatches/f1.jpg?v=1")
        );
    }

    #[test]
    fn color_only_parts_get_no_display_hex() {
        let (f, mut p, s) = fixtures();
        p[0].parts = vec![
            part("text", false, true, "f2", 0),
            part("pic", false, false, "f2", 1),
        ];
        let snap = build_snapshot(&input(&f, &p, &s, Some("t")), None).unwrap();
        let parts = snap["products"][0]["parts"].as_array().unwrap();
        assert!(parts[0].get("display_hex").is_none());
        assert_eq!(parts[1]["display_hex"], json!("#AABBCC"));
    }

    #[test]
    fn free_shipping_threshold_toggle_and_3d_from_settings() {
        let (f, p, mut s) = fixtures();
        s.free_shipping_threshold_enabled = Some(false);
        s.free_shipping_threshold_cents = 5000;
        let snap = build_snapshot(&input(&f, &p, &s, Some("t")), None).unwrap();
        assert!(snap["shipping"]["checkout"]["free_over_cents"].is_null());
        let ship: crate::contracts::PublishedShipping =
            serde_json::from_value(snap["shipping"].clone()).unwrap();
        assert_eq!(ship.checkout.unwrap().free_over_cents, None);
        s.free_shipping_threshold_enabled = Some(true);
        let mut i = input(&f, &p, &s, Some("t"));
        i.product_page_3d = Some(s.product_page_3d);
        let snap = build_snapshot(&i, None).unwrap();
        assert_eq!(snap["shipping"]["checkout"]["free_over_cents"], json!(5000));
        assert_eq!(snap["product_page_3d"], json!(false));
    }

    #[test]
    fn diff_reports_products_and_shipping() {
        let (f, p, mut s) = fixtures();
        let a = build_snapshot(&input(&f, &p, &s, Some("t")), None).unwrap();
        s.flat_shipping_cents = 599;
        let mut p2 = p.clone();
        p2.remove(1);
        p2[0].price_cents = 1600;
        let mut extra = p[1].clone();
        extra.id = "prod-c".into();
        p2.push(extra);
        let b = build_snapshot(&input(&f, &p2, &s, Some("t")), Some(&a)).unwrap();
        let d = diff_snapshots(Some(&a), &b);
        assert_eq!(d.products_added, vec!["prod-c"]);
        assert_eq!(d.products_removed, vec!["prod-b"]);
        assert_eq!(d.products_changed, vec!["prod-a"]);
        assert!(d
            .shipping_changes
            .iter()
            .any(|l| l == "checkout.cents: 795 -> 599"));
        assert!(!diff_snapshots(None, &b).has_current);
    }

    #[test]
    fn zero_flat_rate_publishes_only_when_entered() {
        let (f, p, mut s) = fixtures();
        s.flat_shipping_cents = 0;
        let snap = build_snapshot(&input(&f, &p, &s, Some("t")), None).unwrap();
        assert_eq!(
            snap["shipping"]["checkout"]["cents"],
            json!(795),
            "not entered -> default"
        );
        s.flat_shipping_cents_set = Some(true);
        let snap = build_snapshot(&input(&f, &p, &s, Some("t")), None).unwrap();
        assert_eq!(snap["shipping"]["checkout"]["cents"], json!(0));
        let ship: crate::contracts::PublishedShipping =
            serde_json::from_value(snap["shipping"].clone()).unwrap();
        assert_eq!(ship.checkout.unwrap().cents, 0);
    }

    #[test]
    fn product_page_3d_tri_state() {
        let (f, p, s) = fixtures();
        let on = json!({"access_token": "t", "product_page_3d": true, "products": []});
        let mut i = input(&f, &p, &s, Some("t"));
        i.product_page_3d = None;
        assert_eq!(
            build_snapshot(&i, Some(&on)).unwrap()["product_page_3d"],
            json!(true)
        );
        assert_eq!(
            build_snapshot(&i, None).unwrap()["product_page_3d"],
            json!(false)
        );
        i.product_page_3d = Some(false);
        assert_eq!(
            build_snapshot(&i, Some(&on)).unwrap()["product_page_3d"],
            json!(false)
        );
        i.product_page_3d = Some(true);
        assert_eq!(
            build_snapshot(&i, None).unwrap()["product_page_3d"],
            json!(true)
        );
        // Settings mapping used by src-tauri: unset flag => None.
        let mut st = ShopSettings::default();
        assert_eq!(st.product_page_3d_set.then_some(st.product_page_3d), None);
        st.product_page_3d_set = true;
        assert_eq!(
            st.product_page_3d_set.then_some(st.product_page_3d),
            Some(false)
        );
        let legacy: ShopSettings = serde_json::from_str(r#"{"product_page_3d":true}"#).unwrap();
        assert!(!legacy.product_page_3d_set);
    }

    #[test]
    fn refuses_without_token_and_uploads_nothing() {
        let (f, p, s) = fixtures();
        let mut up = Fake {
            current: None,
            uploaded: vec![],
        };
        assert!(publish_catalog(&input(&f, &p, &s, None), &mut up).is_err());
        assert!(up.uploaded.is_empty());
    }

    #[test]
    fn local_file_round_trip() {
        let (f, p, s) = fixtures();
        let path =
            std::env::temp_dir().join(format!("fp-publish-test-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut up = LocalFileUploader { path: path.clone() };
        publish_catalog(&input(&f, &p, &s, Some("tok")), &mut up).unwrap();
        let again = publish_catalog(&input(&f, &p, &s, None), &mut up).unwrap();
        assert_eq!(again.access_token, "tok");
        let _ = std::fs::remove_file(&path);
    }
}
