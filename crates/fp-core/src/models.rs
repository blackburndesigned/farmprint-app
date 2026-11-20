use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Validation error: {0}")]
    Validation(String),
}

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PartUnitState {
    Queued,
    Staged,
    Printing,
    Printed,
    PostProcessing,
    Ready,
    Shipped,
}

impl PartUnitState {
    /// Parses a stored or legacy state label; anything unknown reads as `Queued`.
    pub fn from_label(s: &str) -> Self {
        match s {
            "Staged" => Self::Staged,
            "Printing" => Self::Printing,
            "Printed" => Self::Printed,
            "Post-Processing" | "PostProcessing" | "Pre-processing" => Self::PostProcessing,
            "Ready" | "Processed" => Self::Ready,
            "Shipped" | "Closed" => Self::Shipped,
            _ => Self::Queued,
        }
    }

    pub fn progress_weight(&self) -> f64 {
        match self {
            Self::Queued => 0.0,
            Self::Staged => 0.15,
            Self::Printing => 0.45,
            Self::Printed => 0.75,
            Self::PostProcessing => 0.90,
            Self::Ready | Self::Shipped => 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilamentSwatch {
    pub id: String,
    pub name: String,
    pub brand: String,
    pub material: String,
    pub hex: String,
    pub cost_per_kg: f64,
    pub grams_remaining: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogPart {
    pub id: String,
    pub product_id: String,
    pub name: String,
    pub is_tracked: bool,
    pub is_color_only: bool,
    pub default_filament_id: String,
    pub grams: f64,
    pub print_minutes: i64,
    pub unit_cost: f64,
    pub mesh_file: String,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Product {
    pub id: String,
    pub name: String,
    pub sku: String,
    pub price_cents: i64,
    pub packed_weight_oz: f64,
    pub default_box_name: String,
    pub box_cost_cents: i64,
    pub supports_custom_text: bool,
    pub parts: Vec<CatalogPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartUnit {
    pub id: String,
    pub order_id: String,
    pub order_code: String,
    pub customer_name: String,
    pub line_id: String,
    pub line_label: String,
    pub product_id: String,
    pub product_name: String,
    pub part_id: String,
    pub part_name: String,
    pub unit_index: i64,
    pub filament_id: String,
    pub filament_name: String,
    pub filament_hex: String,
    pub filament_material: String,
    pub state: String,
    pub printer_id: Option<String>,
    pub printer_name: Option<String>,
    pub plate_job_id: Option<String>,
    pub reprint_count: i64,
    pub unit_cost: f64,
    pub print_minutes: i64,
    pub grams: f64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderLine {
    pub id: String,
    pub order_id: String,
    pub product_id: String,
    pub product_name: String,
    pub item_label: String,
    pub quantity: i64,
    pub unit_price_cents: i64,
    pub custom_text: Option<String>,
    /// Website order line's customer view angle (`store_orders.lines[].view_camera`,
    /// `{position, target, fov}`). Shop 3D viewer world space as-is (Z-up, mm, not re-centered).
    /// `None` for manual orders and 2D-only products (UI uses the product's default angle).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_camera: Option<ViewCamera>,
    pub units: Vec<PartUnit>,
}

/// `store_orders.lines[].view_camera`: `{ position: [x,y,z], target: [x,y,z], fov }`.
/// Raw three.js camera.position / controls.target in the shop 3D viewer's world space
/// (Z-up, millimetres, not re-centred); `fov` is vertical degrees. No `up` (Z-up turntable).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ViewCamera {
    pub position: [f64; 3],
    pub target: [f64; 3],
    pub fov: f64,
}

impl ViewCamera {
    /// Finite numbers, `fov` in (0, 180), and the camera not sitting on its target.
    pub fn is_valid(&self) -> bool {
        let finite = self
            .position
            .iter()
            .chain(self.target.iter())
            .all(|v| v.is_finite())
            && self.fov.is_finite();
        let d2: f64 = (0..3)
            .map(|i| (self.position[i] - self.target[i]).powi(2))
            .sum();
        finite && self.fov > 0.0 && self.fov < 180.0 && d2 > 1e-12
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub id: String,
    /// Content hash of this order as sent (see `delta::order_content_hash`). Lets the UI
    /// send what it already has so unchanged orders are not sent again.
    #[serde(default)]
    pub order_hash: String,
    pub order_code: String,
    pub customer_name: String,
    pub customer_email: String,
    pub source: String,
    /// Shop `store_orders.id` (Stripe session id) for website orders; `None` for manual ones.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_id: Option<String>,
    pub is_rush: bool,
    pub is_on_hold: bool,
    pub notes: String,
    pub shipping_charged_cents: i64,
    pub shipping_cost_cents: i64,
    pub created_at: String,
    pub updated_at: String,
    pub overall_state: String,
    pub progress_pct: f64,
    pub bottleneck_note: Option<String>,
    pub ship_by_status: String,
    pub queue_hours_ahead: f64,
    pub total_revenue_cents: i64,
    pub estimated_cost_cents: i64,
    pub reprint_loss_cents: i64,
    pub net_profit_cents: i64,
    pub margin_pct: f64,
    pub has_margin_warning: bool,
    pub margin_warning_note: Option<String>,
    /// Ship fields (`ship_status`, `tracking_number`, ...), flattened like the shop payload.
    #[serde(flatten)]
    pub ship: OrderShipFields,
    pub lines: Vec<OrderLine>,
}

/// `ship_status`: `ready`, `packed`, or `shipped`. Mirrors `fp_sync::contracts::ShipStatus`
/// (fp-sync depends on fp-core, so the conversion lives in fp-sync).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShipStatus {
    Ready,
    Packed,
    Shipped,
}

impl ShipStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ShipStatus::Ready => "ready",
            ShipStatus::Packed => "packed",
            ShipStatus::Shipped => "shipped",
        }
    }
    /// Unknown or blank words read as `None`, never an error.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "ready" => Some(ShipStatus::Ready),
            "packed" => Some(ShipStatus::Packed),
            "shipped" => Some(ShipStatus::Shipped),
            _ => None,
        }
    }
}

/// Optional ship fields on an order. Mirrors `fp_sync::contracts::OrderShipFields`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct OrderShipFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ship_status: Option<ShipStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shipped_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracking_number: Option<String>,
    /// `None` means use the product's suggested box.
    #[serde(skip_serializing_if = "Option::is_none")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrinterSlot {
    pub slot_index: i64,
    pub filament_id: String,
    pub filament_name: String,
    pub filament_hex: String,
    pub material: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Printer {
    pub id: String,
    pub name: String,
    pub model: String,
    pub nozzle_mm: f64,
    pub status: String,
    pub loaded_slots: Vec<PrinterSlot>,
    pub active_units: Vec<PartUnit>,
    pub staged_units: Vec<PartUnit>,
    pub remaining_minutes: i64,
    pub utilization_pct: f64,
    /// Bed width (X) in mm; None = unknown (use the 220 mm default).
    #[serde(default)]
    pub bed_x_mm: Option<f64>,
    /// Bed depth (Y) in mm; None = unknown (use the 220 mm default).
    #[serde(default)]
    pub bed_y_mm: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverstockItem {
    pub id: String,
    pub product_id: String,
    pub product_name: String,
    pub part_id: String,
    pub part_name: String,
    pub filament_id: String,
    pub filament_name: String,
    pub filament_hex: String,
    pub quantity: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowEvent {
    pub id: String,
    pub seq: i64,
    pub created_at: String,
    pub kind: String,
    pub order_id: Option<String>,
    pub order_code: Option<String>,
    pub customer_name: Option<String>,
    pub line_id: Option<String>,
    pub item_label: Option<String>,
    pub product_id: Option<String>,
    pub product_name: Option<String>,
    pub part_id: Option<String>,
    pub part_name: Option<String>,
    pub unit_id: Option<String>,
    pub filament_name: String,
    pub filament_hex: String,
    pub from_state: Option<String>,
    pub to_state: String,
    pub printer_id: Option<String>,
    pub printer_name: Option<String>,
    pub actor_device: String,
    pub source_surface: String,
    pub action_label: String,
    pub failure_reason: Option<String>,
    pub failure_note: Option<String>,
    pub cost_impact_cents: i64,
    /// True only for an event that can still be undone right now (not already undone,
    /// not an undo itself, and tied to a part unit).
    pub can_undo: bool,
    /// Every event written by one action (e.g. "Mark whole job done" on 12 parts)
    /// shares a batch id; Undo reverts the whole batch. `None` on older events.
    #[serde(default)]
    pub batch_id: Option<String>,
    /// Set once the event's action was undone. Undone events are left out of analytics.
    #[serde(default)]
    pub undone: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BottleneckCallout {
    pub filament_id: String,
    pub filament_name: String,
    pub filament_hex: String,
    pub material: String,
    pub blocked_units: usize,
    pub affected_orders: usize,
    pub blocked_hours: f64,
    pub recommendation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyticsSummary {
    pub total_orders: usize,
    pub active_orders: usize,
    pub ready_to_ship_orders: usize,
    pub at_risk_orders: usize,
    pub units_queued: usize,
    pub units_staged: usize,
    pub units_printing: usize,
    pub units_printed: usize,
    pub units_post_processing: usize,
    pub units_ready: usize,
    pub total_revenue_cents: i64,
    pub total_material_cost_cents: i64,
    pub total_reprint_loss_cents: i64,
    pub total_reprint_grams: f64,
    pub total_net_profit_cents: i64,
    pub average_margin_pct: f64,
    pub fleet_utilization_pct: f64,
    pub estimated_queue_hours: f64,
    pub first_pass_yield_pct: f64,
    pub failure_by_reason: Vec<(String, usize, i64)>,
    pub bottlenecks: Vec<BottleneckCallout>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ShippingBoxPreset {
    pub id: String,
    pub name: String,
    pub length_in: f64,
    pub width_in: f64,
    pub height_in: f64,
    pub box_weight_oz: f64,
    pub cost_cents: i64,
}

/// Box tier for a product: Not set / Don't ship / Small / Medium / Large.
/// Same serde names as `fp_sync::shipping::ShippingBoxClass`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShippingTier {
    #[default]
    NotSet,
    #[serde(alias = "ignore_shipping")]
    Ignore,
    Small,
    Medium,
    Large,
}

/// Postage per box tier, in cents. 0 = not entered yet.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ShippingTierRates {
    pub small: i64,
    pub medium: i64,
    pub large: i64,
}

/// Per-product tier and how many units fit in one box when shipped alone.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProductShippingSetting {
    pub product_id: String,
    pub box_class: ShippingTier,
    pub per_box: u32,
}

/// "Ships together" rule: these products may share one `box_class` box,
/// up to `limits[product_id]` units each.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ShipsTogetherRule {
    pub id: String,
    pub box_class: ShippingTier,
    pub limits: std::collections::BTreeMap<String, u32>,
}

/// One settings shape shared by the Tauri UI and fp-core. Every field defaults
/// to blank/0/false so older saved JSON (missing fields) still loads.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ShopSettings {
    // General
    pub shop_name: String,
    pub operator_name: String,
    pub app_lock_enabled: bool,
    /// "biometric" (Touch ID / Windows Hello) | "password" ("" = biometric if available, else password).
    pub app_lock_method: String,
    /// argon2 PHC hash of the app password. Never sent to the UI (blanked by the backend).
    pub app_lock_password_hash: String,
    /// First-run setup wizard finished (or the shop existed before the wizard).
    pub setup_completed: bool,
    /// Units for display: "metric" | "imperial" ("" = metric).
    pub units: String,
    /// ISO currency code ("" = USD).
    pub currency: String,
    /// "sidebar" | "bottomTabs" ("" = sidebar).
    pub navigation_chrome: String,
    /// ANDON age badge turns red after this many days (0 = 3 days).
    pub orders_late_after_days: u32,
    // Appearance
    /// 3 or 4 (0 = not chosen; UI shows 3).
    pub part_grid_preferred_columns: u8,
    pub appearance_mode: String,
    pub card_scale_pct: i64,
    pub wall_tv_auto_rotate_secs: i64,
    // Print library
    pub product_library_path: String,
    pub print_queue_folder: String,
    pub group_print_queue_as_3mf: bool,
    pub open_staged_in_slicer: bool,
    pub slicer_app_name: String,
    pub slicer_bundle_id: String,
    pub slicer_app_path: String,
    // Costs
    pub default_electricity_cost_per_hr_cents: i64,
    pub min_margin_warning_pct: f64,
    // Store
    pub store_url: String,
    pub supabase_url: String,
    pub supabase_anon_key: String,
    /// Test-mode key only (pk_test_…).
    pub stripe_publishable_key: String,
    pub supabase_sync_enabled: bool,
    // Store › Shipping
    pub shipping_enabled: bool,
    #[serde(alias = "flat_rate_shipping_cents")]
    pub flat_shipping_cents: i64,
    pub free_shipping_threshold_cents: i64,
    /// `Some(true)` = `flat_shipping_cents` was entered and applies as-is, including $0.
    /// `None`/`Some(false)` = legacy: 0 means "not entered", so the shop default ($7.95) applies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flat_shipping_cents_set: Option<bool>,
    /// `None` = not chosen (legacy: threshold applies when > 0), `Some(false)` = no
    /// free-shipping threshold, `Some(true)` = threshold applies as entered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_shipping_threshold_enabled: Option<bool>,
    /// Set the first time shipping is turned on (`ShopShippingPrefs.enabled_at`); kept afterward.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shipping_enabled_at: Option<String>,
    /// Shop shows 3D product pages (catalog `product_page_3d`). Default off.
    pub product_page_3d: bool,
    /// New Order shows the "Test bench" burst tools. Default off (old rows: serde default).
    pub test_bench_enabled: bool,
    /// Website order import marks each imported `store_orders` row (`imported_at`) with the
    /// signed-in owner's session. Local only, never published.
    /// `None` = never chosen = ON (the default); `Some(false)` turns it off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_ingest_claim_enabled: Option<bool>,
    /// True once the user explicitly set `product_page_3d` (UI sends it with the toggle).
    /// False = never chosen: publish carries over the live shop's value instead of forcing off.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub product_page_3d_set: bool,
    pub shipping_origin_zip: String,
    pub shipping_rates_cents: ShippingTierRates,
    pub product_shipping: Vec<ProductShippingSetting>,
    pub ships_together: Vec<ShipsTogetherRule>,
    #[serde(alias = "boxes")]
    pub box_presets: Vec<ShippingBoxPreset>,
    // Process (empty = built-in steps)
    pub process_steps: Vec<ProcessStepSetting>,
    // Printers: printer_id -> accent hex
    pub printer_accents: std::collections::BTreeMap<String, String>,
    // Printers: printer_id -> has a multi-spool switcher (AMS or similar)
    pub printer_multi_spool: std::collections::BTreeMap<String, bool>,
    /// Printers board grouping: "job" (each send/Print! batch as it was sent) | "order".
    /// "" = "job".
    pub printers_board_view: String,
    /// Suggested Groups shows a small hint naming a printer that has the group's filament
    /// loaded. Default off: FarmPrint doesn't pick a printer for you.
    pub suggest_printer: bool,
    // Branding
    pub logo_path: String,
    // Appearance Studio
    pub appearance_studio: AppearanceStudio,
    // Updates (advanced): https URL of a Tauri latest.json feed. Empty = default from tauri.conf.json.
    pub update_feed_url: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProcessStepSetting {
    pub id: String,
    pub name: String,
    pub color_hex: String,
    /// UI-only: hide this step from ANDON lanes and status pickers. Units keep
    /// their real state (e.g. Print! still stages units); hidden "Staged" units
    /// are shown in the In Queue lane.
    pub hidden: bool,
}

/// Surface backgrounds are "" (system), "#RRGGBB", or a gradient token
/// "gradient:<axis>:<angle>:#AAAAAA,#BBBBBB".
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppearanceStudio {
    pub window_bg_light: String,
    pub window_bg_dark: String,
    pub card_bg_light: String,
    pub card_bg_dark: String,
    pub tile_bg_light: String,
    pub tile_bg_dark: String,
    pub window_bg_blur: f64,
    pub card_bg_blur: f64,
    pub tile_bg_blur: f64,
    pub tile_outline_enabled: bool,
    pub tile_outline_follows_status: bool,
    pub tile_outline_strokes: Vec<OutlineStroke>,
    pub card_header_frost_enabled: bool,
    /// "none" | "light" | "dark" | "custom"
    pub card_header_frost_tint: String,
    pub card_header_frost_custom_hex: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct OutlineStroke {
    /// "#RRGGBB" or a gradient token (see AppearanceStudio).
    pub color: String,
    pub weight: f64,
    pub opacity: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShopSnapshot {
    pub filaments: Vec<FilamentSwatch>,
    pub products: Vec<Product>,
    pub printers: Vec<Printer>,
    pub orders: Vec<Order>,
    pub overstock: Vec<OverstockItem>,
    pub flow_events: Vec<FlowEvent>,
    pub analytics: AnalyticsSummary,
}

/// What still uses a filament swatch (see `ShopLedger::filament_usage`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilamentUsage {
    pub open_units: i64,
    pub part_defaults: i64,
    pub overstock_rows: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransitionRequest {
    pub unit_ids: Vec<String>,
    pub to_state: String,
    pub printer_id: Option<String>,
    pub actor_device: String,
    pub source_surface: String,
    pub action_label: String,
    pub failure_reason: Option<String>,
    pub failure_note: Option<String>,
    #[serde(default)]
    pub filament_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateProductInput {
    pub name: String,
    pub sku: String,
    pub price_cents: i64,
    pub packed_weight_oz: f64,
    pub default_box_name: String,
    pub box_cost_cents: i64,
    pub supports_custom_text: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCatalogPartInput {
    pub product_id: String,
    pub name: String,
    pub default_filament_id: String,
    pub grams: f64,
    pub print_minutes: i64,
    pub unit_cost: f64,
    pub mesh_file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateOrderInput {
    pub customer_name: String,
    pub customer_email: String,
    pub product_id: String,
    pub quantity: i64,
    pub is_rush: bool,
    pub custom_text: Option<String>,
}

/// One already-mapped website order (built by `fp_sync::store_ingest`). Product ids and
/// filament ids must exist locally; the ledger re-checks and skips anything that does not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebsiteOrderImport {
    /// `store_orders.id`; the local dedupe key (`imported_store_orders.remote_id`).
    pub remote_id: String,
    /// `store_orders.source` (never `manual`).
    pub source: String,
    /// Shop `order_number` (`BD-…`) when present, else the ledger makes an `FP-` code.
    pub order_code: Option<String>,
    pub customer_name: String,
    pub customer_email: String,
    pub notes: String,
    pub is_rush: bool,
    pub is_on_hold: bool,
    pub shipping_charged_cents: i64,
    pub created_at: String,
    pub lines: Vec<WebsiteLineImport>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebsiteLineImport {
    pub product_id: String,
    pub title: String,
    pub quantity: i64,
    pub unit_price_cents: i64,
    pub custom_text: Option<String>,
    pub view_camera: Option<ViewCamera>,
    /// Tracked part id -> local filament id (customer's color). Parts not listed use the
    /// catalog default filament.
    pub part_filaments: std::collections::BTreeMap<String, String>,
    /// The line's configuration parts (`configuration_id`); `None` = all of the product's parts.
    #[serde(default)]
    pub only_part_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum WebsiteImportOutcome {
    Imported {
        order_id: String,
    },
    /// This `remote_id` was imported before (even if that local order was later deleted).
    Duplicate,
    /// Nothing usable to import (no valid lines).
    Skipped {
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertPrinterInput {
    pub id: Option<String>,
    pub name: String,
    pub model: String,
    #[serde(default = "default_nozzle")]
    pub nozzle_mm: f64,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub loaded_filament_ids: Option<Vec<String>>,
}

fn default_nozzle() -> f64 {
    0.4
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertFilamentInput {
    pub id: Option<String>,
    pub name: String,
    pub brand: String,
    pub material: String,
    pub hex: String,
    #[serde(default = "default_cost_per_kg")]
    pub cost_per_kg: f64,
    #[serde(default = "default_grams_rem")]
    pub grams_remaining: f64,
}

fn default_cost_per_kg() -> f64 {
    22.99
}

fn default_grams_rem() -> f64 {
    1000.0
}

impl ShopSettings {
    /// Same rule as `fp_sync::contracts::ShopShippingPrefs::set_enabled`.
    pub fn set_shipping_enabled(&mut self, on: bool, now_iso8601: &str) {
        if on && self.shipping_enabled_at.is_none() {
            self.shipping_enabled_at = Some(now_iso8601.to_string());
        }
        self.shipping_enabled = on;
    }

    /// Whether the free-shipping threshold is in effect.
    /// Website import marks rows imported unless explicitly turned off (default ON).
    pub fn store_ingest_claim_on(&self) -> bool {
        self.store_ingest_claim_enabled.unwrap_or(true)
    }

    /// Flat rate the shop charges (published as `shipping.checkout.cents`):
    /// as entered when `flat_shipping_cents_set` (so $0 is possible), else the entered value
    /// when > 0, else the contract default.
    pub fn checkout_flat_cents(&self) -> i64 {
        if self.flat_shipping_cents_set == Some(true) || self.flat_shipping_cents > 0 {
            self.flat_shipping_cents.max(0)
        } else {
            DEFAULT_CHECKOUT_FLAT_CENTS
        }
    }

    pub fn free_shipping_threshold_active(&self) -> bool {
        match self.free_shipping_threshold_enabled {
            Some(on) => on && self.free_shipping_threshold_cents >= 0,
            None => self.free_shipping_threshold_cents > 0,
        }
    }
}

/// Contract default for `shipping.checkout.cents` when no flat rate was entered ($7.95).
pub const DEFAULT_CHECKOUT_FLAT_CENTS: i64 = 795;

#[cfg(test)]
mod shop_settings_tests {
    use super::*;

    #[test]
    fn ship_types_and_new_settings() {
        let mut f = OrderShipFields {
            ship_status: ShipStatus::parse("Shipped"),
            ..Default::default()
        };
        assert!(f.is_shipped());
        assert_eq!(ShipStatus::parse("lost"), None);
        f.clear();
        assert_eq!(f, OrderShipFields::default());
        assert_eq!(serde_json::to_string(&f).unwrap(), "{}");
        let mut s = ShopSettings::default();
        assert!(!s.product_page_3d && s.free_shipping_threshold_enabled.is_none());
        s.set_shipping_enabled(true, "t1");
        s.set_shipping_enabled(false, "t2");
        s.set_shipping_enabled(true, "t3");
        assert!(s.shipping_enabled);
        assert_eq!(s.shipping_enabled_at.as_deref(), Some("t1"));
        let s2: ShopSettings = serde_json::from_str(
            r#"{"product_page_3d":true,"free_shipping_threshold_enabled":false}"#,
        )
        .unwrap();
        assert!(s2.product_page_3d);
        assert_eq!(s2.free_shipping_threshold_enabled, Some(false));
    }

    #[test]
    fn default_settings_have_no_made_up_values() {
        let s = ShopSettings::default();
        assert_eq!(s.flat_shipping_cents, 0);
        assert!(s.flat_shipping_cents_set.is_none());
        assert_eq!(s.min_margin_warning_pct, 0.0);
        assert!(s.slicer_app_name.is_empty());
        assert!(s.box_presets.is_empty());
        assert_eq!(s.shipping_rates_cents, ShippingTierRates::default());
    }

    #[test]
    fn old_saved_settings_still_load() {
        let old = r#"{"shop_name":"X","flat_shipping_cents":795,"box_presets":[{"id":"b","name":"B","length_in":1.0,"width_in":1.0,"height_in":1.0,"box_weight_oz":1.0,"cost_cents":5}]}"#;
        let s: ShopSettings = serde_json::from_str(old).unwrap();
        assert_eq!(s.shop_name, "X");
        assert_eq!(s.flat_shipping_cents, 795);
        assert_eq!(s.box_presets.len(), 1);
        let ui = r#"{"flat_rate_shipping_cents":100,"boxes":[],"app_lock_enabled":true,
            "product_shipping":[{"product_id":"p","box_class":"ignore","per_box":2}]}"#;
        let s: ShopSettings = serde_json::from_str(ui).unwrap();
        assert_eq!(s.flat_shipping_cents, 100);
        assert!(s.app_lock_enabled);
        assert_eq!(s.product_shipping[0].box_class, ShippingTier::Ignore);
    }
}

/// Filament rows that look like the same swatch (`ShopLedger::find_duplicate_filaments`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DuplicateFilamentGroup {
    pub canonical_id: String,
    pub duplicate_ids: Vec<String>,
}
