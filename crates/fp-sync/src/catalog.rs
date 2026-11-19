use crate::shipping::{ProductShippingSpec, ShareBoxRule, ShippingRatesCents};
use serde::{Deserialize, Serialize};

/// Part entry in a store product assembly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CatalogPart {
    pub part_id: String,
    pub name: String,
    pub default_color_name: String,
    pub default_color_hex: String,
    /// Standing rule: parts flagged `thumbnail_only` (e.g., decorative picture-only parts)
    /// are rendered in 2D/3D product previews for context, but must NEVER appear in
    /// customer-facing order descriptions, status pages, or emails.
    #[serde(default)]
    pub thumbnail_only: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CatalogProduct {
    pub product_id: String,
    pub slug: String,
    pub title: String,
    pub price_cents: i64,
    pub active: bool,
    pub product_page_3d: bool,
    pub preview_3d_glb_url: Option<String>,
    pub parts: Vec<CatalogPart>,
    pub shipping: ProductShippingSpec,
}

impl CatalogProduct {
    /// Returns only customer-facing customizable/shipped parts, stripping `thumbnail_only` context parts.
    pub fn customer_visible_parts(&self) -> Vec<&CatalogPart> {
        self.parts.iter().filter(|p| !p.thumbnail_only).collect()
    }
}

/// Complete store catalog snapshot contract (`store_catalog` payload).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoreCatalogSnapshot {
    pub schema_version: u32,
    pub published_at: String,
    pub shipping_rates: ShippingRatesCents,
    pub share_rules: Vec<ShareBoxRule>,
    pub products: Vec<CatalogProduct>,
}

impl StoreCatalogSnapshot {
    /// Sanitizes an order line's part color selections so `thumbnail_only` assembly parts
    /// are never included in customer-facing text, emails, or order status payloads.
    pub fn filter_customer_facing_selections(
        &self,
        product_id: &str,
        selections: &[(String, String, String)], // (part_id, part_name, color_name)
    ) -> Vec<(String, String, String)> {
        let Some(product) = self.products.iter().find(|p| p.product_id == product_id) else {
            return selections.to_vec();
        };
        selections
            .iter()
            .filter(|(part_id, _, _)| {
                product
                    .parts
                    .iter()
                    .find(|p| &p.part_id == part_id)
                    .map(|p| !p.thumbnail_only)
                    .unwrap_or(true)
            })
            .cloned()
            .collect()
    }
}

/// Per-product 3D keys carried over from the previous snapshot (used by the shop's 3D product page).
pub const PRESERVED_PRODUCT_3D_KEYS: [&str; 3] = ["preview_3d", "inscription_3d", "store_3d"];

/// The new app has no GLB exporter yet, so a publish must not drop or null the 3D fields an older
/// publish (or the local catalog) already had. Works on the wire JSON (`store_catalog.snapshot`) so it
/// keeps nested fields (`config_meshes`, cameras, `field`) exactly as published.
///
/// - Top-level `product_page_3d`: copied from `previous` when missing or null in `next`.
/// - Per product, matched by `id`: each key in `PRESERVED_PRODUCT_3D_KEYS` is copied when it is
///   missing or null in `next`. A non-null value already in `next` always wins.
/// - Products not in `previous` are left as is. Nothing is product-specific.
pub fn preserve_3d_fields(next: &mut serde_json::Value, previous: &serde_json::Value) {
    use serde_json::Value;
    let missing = |o: &serde_json::Map<String, Value>, k: &str| o.get(k).is_none_or(Value::is_null);

    let Some(next_obj) = next.as_object_mut() else {
        return;
    };
    if missing(next_obj, "product_page_3d") {
        if let Some(v) = previous.get("product_page_3d").filter(|v| !v.is_null()) {
            next_obj.insert("product_page_3d".into(), v.clone());
        }
    }

    let prev_products: Vec<&serde_json::Map<String, Value>> = previous
        .get("products")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default();
    let Some(products) = next_obj.get_mut("products").and_then(Value::as_array_mut) else {
        return;
    };
    for product in products.iter_mut().filter_map(Value::as_object_mut) {
        let Some(id) = product.get("id").and_then(Value::as_str).map(str::to_owned) else {
            continue;
        };
        let Some(prev) = prev_products
            .iter()
            .find(|p| p.get("id").and_then(Value::as_str) == Some(id.as_str()))
        else {
            continue;
        };
        for key in PRESERVED_PRODUCT_3D_KEYS {
            if missing(product, key) {
                if let Some(v) = prev.get(key).filter(|v| !v.is_null()) {
                    product.insert(key.into(), v.clone());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shipping::ShippingBoxClass;

    #[test]
    fn strips_thumbnail_only_parts_from_customer_facing_output() {
        let product = CatalogProduct {
            product_id: "prod-test-widget".to_string(),
            slug: "widget".to_string(),
            title: "Widget".to_string(),
            price_cents: 1500,
            active: true,
            product_page_3d: true,
            preview_3d_glb_url: Some("https://example.com/widget.glb".to_string()),
            parts: vec![
                CatalogPart {
                    part_id: "part-body".to_string(),
                    name: "Body".to_string(),
                    default_color_name: "Blue".to_string(),
                    default_color_hex: "#1E40AF".to_string(),
                    thumbnail_only: false,
                },
                CatalogPart {
                    part_id: "part-lock".to_string(),
                    name: "Lock".to_string(),
                    default_color_name: "Silver".to_string(),
                    default_color_hex: "#9CA3AF".to_string(),
                    thumbnail_only: true,
                },
                CatalogPart {
                    part_id: "part-shackle".to_string(),
                    name: "Shackle".to_string(),
                    default_color_name: "Chrome".to_string(),
                    default_color_hex: "#D1D5DB".to_string(),
                    thumbnail_only: true,
                },
            ],
            shipping: ProductShippingSpec {
                product_id: "prod-test-widget".to_string(),
                box_class: ShippingBoxClass::Small,
                per_box: 5,
            },
        };

        let visible = product.customer_visible_parts();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].name, "Body");

        let snapshot = StoreCatalogSnapshot {
            schema_version: 3,
            published_at: "2026-10-25T12:00:00Z".to_string(),
            shipping_rates: ShippingRatesCents::default(),
            share_rules: vec![],
            products: vec![product],
        };

        let filtered = snapshot.filter_customer_facing_selections(
            "prod-test-widget",
            &[
                (
                    "part-body".to_string(),
                    "Body".to_string(),
                    "Blue".to_string(),
                ),
                (
                    "part-lock".to_string(),
                    "Lock".to_string(),
                    "Silver".to_string(),
                ),
                (
                    "part-shackle".to_string(),
                    "Shackle".to_string(),
                    "Chrome".to_string(),
                ),
            ],
        );
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].1, "Body");
    }

    #[test]
    fn publish_preserves_previous_3d_fields() {
        use serde_json::json;
        let previous = json!({
            "version": 3,
            "product_page_3d": true,
            "products": [
                {"id": "prod-a", "preview_3d": {"mesh_path": "a.glb", "config_meshes": {"c1": "a-c1.glb"}, "field": {"w": 1}},
                 "inscription_3d": {"part_id": "p1"}, "store_3d": "on"},
                {"id": "prod-b", "preview_3d": {"mesh_path": "b-old.glb"}}
            ]
        });
        let mut next = json!({
            "version": 3,
            "products": [
                {"id": "prod-a", "preview_3d": null},
                {"id": "prod-b", "preview_3d": {"mesh_path": "b-new.glb"}},
                {"id": "prod-new"}
            ]
        });
        preserve_3d_fields(&mut next, &previous);
        assert_eq!(next["product_page_3d"], json!(true));
        assert_eq!(
            next["products"][0]["preview_3d"],
            previous["products"][0]["preview_3d"]
        );
        assert_eq!(
            next["products"][0]["inscription_3d"],
            json!({"part_id": "p1"})
        );
        assert_eq!(next["products"][0]["store_3d"], json!("on"));
        // A value already present in the new publish wins.
        assert_eq!(
            next["products"][1]["preview_3d"]["mesh_path"],
            json!("b-new.glb")
        );
        // Products with no previous entry get nothing invented.
        assert!(next["products"][2].get("preview_3d").is_none());
        // Explicit false is kept, not overwritten.
        let mut off = json!({"product_page_3d": false, "products": []});
        preserve_3d_fields(&mut off, &previous);
        assert_eq!(off["product_page_3d"], json!(false));
    }
}
