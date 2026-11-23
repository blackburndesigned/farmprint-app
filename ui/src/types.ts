export type PartUnitState =
  | "Queued"
  | "Staged"
  | "Printing"
  | "Printed"
  | "Post-Processing"
  | "Ready"
  | "Shipped";

export interface FilamentSwatch {
  id: string;
  name: string;
  brand: string;
  material: string;
  hex: string;
  cost_per_kg: number;
  grams_remaining: number;
  /** Where the spool was bought. Missing/null means unspecified. */
  vendor?: string | null;
}

export interface CatalogPart {
  id: string;
  product_id: string;
  name: string;
  is_tracked: boolean;
  is_color_only: boolean;
  default_filament_id: string;
  grams: number;
  print_minutes: number;
  unit_cost: number;
  mesh_file: string;
  sort_order: number;
}

export interface Product {
  id: string;
  name: string;
  sku: string;
  price_cents: number;
  packed_weight_oz: number;
  default_box_name: string;
  box_cost_cents: number;
  supports_custom_text: boolean;
  parts: CatalogPart[];
}

export interface PartUnit {
  id: string;
  order_id: string;
  order_code: string;
  customer_name: string;
  line_id: string;
  line_label: string;
  product_id: string;
  product_name: string;
  part_id: string;
  part_name: string;
  unit_index: number;
  filament_id: string;
  filament_name: string;
  filament_hex: string;
  filament_material: string;
  state: string;
  printer_id: string | null;
  printer_name: string | null;
  plate_job_id: string | null;
  reprint_count: number;
  unit_cost: number;
  print_minutes: number;
  grams: number;
  updated_at: string;
}

export interface OrderLine {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  item_label: string;
  quantity: number;
  unit_price_cents: number;
  custom_text: string | null;
  /** Website order line's customer view angle (store_orders.lines[].view_camera, shop
   *  viewer space: Z-up, mm). Absent for manual orders and 2D-only products. */
  view_camera?: StoreViewCamera | null;
  units: PartUnit[];
}

/** Shop order "Customer view angle": raw three.js camera.position / controls.target
 *  in the shop 3D viewer's world space, vertical fov in degrees. Same shape as
 *  OrderViewport3D's ViewCamera. */
export interface StoreViewCamera {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export interface Order {
  id: string;
  /** Content hash; lets the backend leave unchanged orders out of replies. */
  order_hash?: string;
  order_code: string;
  customer_name: string;
  customer_email: string;
  source: string;
  /** store_orders.id for website orders (local dedupe key); absent for manual orders. */
  remote_id?: string | null;
  is_rush: boolean;
  is_on_hold: boolean;
  notes: string;
  shipping_charged_cents: number;
  shipping_cost_cents: number;
  created_at: string;
  updated_at: string;
  overall_state: string;
  progress_pct: number;
  bottleneck_note: string | null;
  ship_by_status: string;
  queue_hours_ahead: number;
  total_revenue_cents: number;
  estimated_cost_cents: number;
  reprint_loss_cents: number;
  net_profit_cents: number;
  margin_pct: number;
  has_margin_warning: boolean;
  margin_warning_note: string | null;
  lines: OrderLine[];
}

export interface PrinterSlot {
  slot_index: number;
  filament_id: string;
  filament_name: string;
  filament_hex: string;
  material: string;
}

export interface Printer {
  id: string;
  name: string;
  model: string;
  nozzle_mm: number;
  status: string;
  loaded_slots: PrinterSlot[];
  active_units: PartUnit[];
  staged_units: PartUnit[];
  remaining_minutes: number;
  utilization_pct: number;
  /** Bed width (X) in mm; null/absent = unknown (use the 220 mm default). */
  bed_x_mm?: number | null;
  /** Bed depth (Y) in mm; null/absent = unknown (use the 220 mm default). */
  bed_y_mm?: number | null;
  /** Build height (Z) in mm; null/absent = not set. Not used by plate building or Print!. */
  bed_z_mm?: number | null;
  /** Units holding this printer's spools, in order. Absent on older snapshots. */
  feeders?: PrinterFeeder[];
}

/** A named unit on a printer holding spools (see fp-core `PrinterFeeder`). Feeders that
 *  feed the printer group consecutive slot numbers; a dry box holds unloaded spools. */
export interface PrinterFeeder {
  id: string;
  name: string;
  slot_count: number;
  is_dry_box: boolean;
  note?: string | null;
  /** First printer slot number in this feeder; null for a dry box. */
  first_slot?: number | null;
  /** Spools in it (empty slots left out). Feeding: printer slot number; dry box: position in the box. */
  spools: PrinterSlot[];
  /** Not saved by the user (the default feeder, or loaded slots past the last feeder). */
  auto?: boolean;
}

export interface OverstockItem {
  id: string;
  product_id: string;
  product_name: string;
  part_id: string;
  part_name: string;
  filament_id: string;
  filament_name: string;
  filament_hex: string;
  quantity: number;
}

export interface FlowEvent {
  id: string;
  seq: number;
  created_at: string;
  kind: string;
  order_id: string | null;
  order_code: string | null;
  customer_name: string | null;
  line_id: string | null;
  item_label: string | null;
  product_id: string | null;
  product_name: string | null;
  part_id: string | null;
  part_name: string | null;
  unit_id: string | null;
  filament_name: string;
  filament_hex: string;
  from_state: string | null;
  to_state: string;
  printer_id: string | null;
  printer_name: string | null;
  actor_device: string;
  source_surface: string;
  action_label: string;
  failure_reason: string | null;
  failure_note: string | null;
  cost_impact_cents: number;
  /** True only while this event's action can still be undone. */
  can_undo: boolean;
  /** Shared by every event of one action; Undo reverts the whole batch. */
  batch_id?: string | null;
  /** Set once the action was undone. */
  undone?: boolean;
  /** Plate job the part was in just before this event (older backends leave it out). */
  prev_plate_job_id?: string | null;
}

export type TransitionEvent = FlowEvent;

export interface BottleneckCallout {
  filament_id: string;
  filament_name: string;
  filament_hex: string;
  material: string;
  blocked_units: number;
  affected_orders: number;
  blocked_hours: number;
  recommendation: string;
}

export interface AnalyticsSummary {
  total_orders: number;
  active_orders: number;
  ready_to_ship_orders: number;
  at_risk_orders: number;
  units_queued: number;
  units_staged: number;
  units_printing: number;
  units_printed: number;
  units_post_processing: number;
  units_ready: number;
  total_revenue_cents: number;
  total_material_cost_cents: number;
  total_reprint_loss_cents: number;
  total_reprint_grams: number;
  total_net_profit_cents: number;
  average_margin_pct: number;
  fleet_utilization_pct: number;
  estimated_queue_hours: number;
  first_pass_yield_pct: number;
  failure_by_reason: Array<[string, number, number]>;
  bottlenecks: BottleneckCallout[];
}

export interface ShippingBoxPreset {
  id: string;
  name: string;
  length_in: number;
  width_in: number;
  height_in: number;
  box_weight_oz: number;
  cost_cents: number;
}

/** Not set / Don't ship / Small / Medium / Large (fp-core `ShippingTier`). */
export type ShippingTier = "not_set" | "ignore" | "small" | "medium" | "large";

export interface ShippingTierRates {
  small: number;
  medium: number;
  large: number;
}

export interface ProductShippingSetting {
  product_id: string;
  box_class: ShippingTier;
  per_box: number;
}

/** "Ships together" rule: product_id -> max units per shared box. */
export interface ShipsTogetherRule {
  id: string;
  box_class: ShippingTier;
  limits: Record<string, number>;
}

/** Mirrors fp-core `ShopSettings` field-for-field. */
export interface ShopSettings {
  /** Advanced: https latest.json override; "" = built-in default feed. */
  update_feed_url?: string;
  shop_name: string;
  operator_name: string;
  /** ANDON age badge turns red after this many days (0 = 3 days). */
  orders_late_after_days?: number;
  app_lock_enabled: boolean;
  /** "biometric" | "password" | "" (auto). */
  app_lock_method?: string;
  /** Always "" in the UI; the backend keeps the argon2 hash. */
  app_lock_password_hash?: string;
  setup_completed?: boolean;
  units?: string;
  currency?: string;
  printer_multi_spool?: Record<string, boolean>;
  /** Printers board grouping: "job" | "order" ("" = "job"). */
  printers_board_view?: string;
  /** Suggested Groups shows a small printer hint. Default off. */
  suggest_printer?: boolean;
  navigation_chrome: string;
  part_grid_preferred_columns: number;
  appearance_mode: string;
  card_scale_pct: number;
  wall_tv_auto_rotate_secs: number;
  product_library_path: string;
  print_queue_folder: string;
  group_print_queue_as_3mf: boolean;
  open_staged_in_slicer: boolean;
  slicer_app_name: string;
  slicer_bundle_id: string;
  slicer_app_path: string;
  default_electricity_cost_per_hr_cents: number;
  min_margin_warning_pct: number;
  store_url: string;
  supabase_url: string;
  supabase_anon_key: string;
  stripe_publishable_key: string;
  supabase_sync_enabled: boolean;
  shipping_enabled: boolean;
  flat_shipping_cents: number;
  free_shipping_threshold_cents: number;
  /** Shop shows 3D product pages (catalog `product_page_3d`). */
  product_page_3d?: boolean;
  /** New Order shows the Test bench section. Default off. */
  test_bench_enabled?: boolean;
  /** Website import marks imported shop orders (imported_at). Absent = on; false = off. Local only. */
  store_ingest_claim_enabled?: boolean | null;
  /** True only once the user changed the 3D product pages toggle. */
  product_page_3d_set?: boolean;
  shipping_origin_zip: string;
  shipping_rates_cents: ShippingTierRates;
  product_shipping: ProductShippingSetting[];
  ships_together: ShipsTogetherRule[];
  box_presets: ShippingBoxPreset[];
  process_steps: ProcessStepSetting[];
  printer_accents: Record<string, string>;
  logo_path: string;
  appearance_studio: AppearanceStudio;
}

export interface ProcessStepSetting {
  id: string;
  name: string;
  color_hex: string;
  /** Hide from ANDON lanes and status pickers (fixed steps only, e.g. Staged). */
  hidden?: boolean;
}

export interface OutlineStroke {
  /** "#RRGGBB" or "gradient:<axis>:<angle>:#A,#B" */
  color: string;
  weight: number;
  opacity: number;
}

/** Surface backgrounds: "" (system), "#RRGGBB", or "gradient:<axis>:<angle>:#A,#B". */
export interface AppearanceStudio {
  window_bg_light: string;
  window_bg_dark: string;
  card_bg_light: string;
  card_bg_dark: string;
  tile_bg_light: string;
  tile_bg_dark: string;
  window_bg_blur: number;
  card_bg_blur: number;
  tile_bg_blur: number;
  tile_outline_enabled: boolean;
  tile_outline_follows_status: boolean;
  tile_outline_strokes: OutlineStroke[];
  card_header_frost_enabled: boolean;
  card_header_frost_tint: string;
  card_header_frost_custom_hex: string;
}

export const EMPTY_APPEARANCE_STUDIO: AppearanceStudio = {
  window_bg_light: "",
  window_bg_dark: "",
  card_bg_light: "",
  card_bg_dark: "",
  tile_bg_light: "",
  tile_bg_dark: "",
  window_bg_blur: 0,
  card_bg_blur: 0,
  tile_bg_blur: 0,
  tile_outline_enabled: false,
  tile_outline_follows_status: false,
  tile_outline_strokes: [],
  card_header_frost_enabled: false,
  card_header_frost_tint: "",
  card_header_frost_custom_hex: "",
};

export const EMPTY_SHOP_SETTINGS: ShopSettings = {
  shop_name: "",
  operator_name: "",
  orders_late_after_days: 0,
  app_lock_enabled: false,
  navigation_chrome: "",
  part_grid_preferred_columns: 0,
  appearance_mode: "",
  card_scale_pct: 0,
  wall_tv_auto_rotate_secs: 0,
  product_library_path: "",
  print_queue_folder: "",
  group_print_queue_as_3mf: false,
  open_staged_in_slicer: false,
  printers_board_view: "",
  suggest_printer: false,
  slicer_app_name: "",
  slicer_bundle_id: "",
  slicer_app_path: "",
  default_electricity_cost_per_hr_cents: 0,
  min_margin_warning_pct: 0,
  store_url: "",
  supabase_url: "",
  supabase_anon_key: "",
  stripe_publishable_key: "",
  supabase_sync_enabled: false,
  shipping_enabled: false,
  flat_shipping_cents: 0,
  free_shipping_threshold_cents: 0,
  product_page_3d: false,
  test_bench_enabled: false,
  product_page_3d_set: false,
  shipping_origin_zip: "",
  shipping_rates_cents: { small: 0, medium: 0, large: 0 },
  product_shipping: [],
  ships_together: [],
  box_presets: [],
  process_steps: [],
  printer_accents: {},
  logo_path: "",
  appearance_studio: EMPTY_APPEARANCE_STUDIO,
};

export interface ShopSnapshot {
  filaments: FilamentSwatch[];
  products: Product[];
  printers: Printer[];
  orders: Order[];
  overstock: OverstockItem[];
  flow_events: FlowEvent[];
  analytics: AnalyticsSummary;
}

export interface TransitionRequest {
  unit_ids: string[];
  to_state: string;
  printer_id: string | null;
  actor_device: string;
  source_surface: string;
  action_label: string;
  failure_reason: string | null;
  failure_note: string | null;
  filament_id?: string | null;
}
