/** Shapes returned by fp-core `insights.rs` (`insights`, `insights_drilldown`, `insights_csv`). */

export interface InsightsQuery {
  start: string | null;
  end: string | null;
  tz_offset_minutes: number;
}

export interface Headline {
  id: string;
  label: string;
  value: number | null;
  previous: number | null;
  unit: "hours" | "pct" | "cents" | "count";
  better: "up" | "down";
  estimate: boolean;
  note: string | null;
  collecting_since: string | null;
}

export interface CountRow { key: string; count: number }
export interface SeriesPoint { date: string; parts_printed: number; orders_shipped: number; revenue_cents: number; orders_placed: number }
export interface QueueRow { key: string; parts: number; minutes: number }
export interface YieldRow { key: string; passed: number; total: number; rate: number | null }
export interface ReasonRow { reason: string; count: number; cost_cents: number }
export interface ProductRow {
  product: string; units_sold: number; revenue_cents: number; cost_cents: number; margin_pct: number | null;
  printer_minutes: number; revenue_share: number | null; minutes_share: number | null;
}
export interface ChannelRow { source: string; orders: number; revenue_cents: number }
export interface CustomerRow { key: string; name: string; orders: number; revenue_cents: number; last_order: string }
export interface FilamentUse { key: string; hex: string | null; grams: number; cost_cents: number }
export interface PrinterUse { printer_id: string; name: string; printing_hours: number; observed_hours: number; rate: number | null }

export interface Insights {
  range: { start: string; end: string; prev_start: string | null; prev_end: string | null; bucket: "day" | "week" };
  headline: Headline[];
  lead_time: { shipped: number; median_hours: number | null; p90_hours: number | null; prev_median_hours: number | null; prev_p90_hours: number | null };
  on_time: { with_target: number; on_time: number; rate: number | null; prev_rate: number | null; default_target_days: number | null; collecting_since: string | null };
  wait_work: { orders: number; waiting_hours: number | null; printing_hours: number | null; after_print_hours: number | null };
  aging: CountRow[];
  throughput: { bucket: string; parts_printed: number; orders_shipped: number; prev_parts_printed: number | null; prev_orders_shipped: number | null };
  series: SeriesPoint[];
  bottleneck: { by_printer: QueueRow[]; by_material: QueueRow[] };
  yield: { overall: YieldRow; prev_rate: number | null; by_product: YieldRow[]; by_printer: YieldRow[]; by_material: YieldRow[] };
  failures: ReasonRow[];
  scrap_cost_cents: number;
  prev_scrap_cost_cents: number | null;
  money: { revenue_cents: number; orders: number; aov_cents: number | null; prev_revenue_cents: number | null; prev_orders: number | null; prev_aov_cents: number | null };
  profit: {
    revenue_cents: number; parts_cost_cents: number; reprint_cost_cents: number; packaging_cents: number;
    shipping_cost_cents: number; net_cents: number; margin: number | null; prev_net_cents: number | null; prev_margin: number | null;
  };
  /** Parts of open orders by state, right now. */
  wip: CountRow[];
  products: ProductRow[];
  packaging_cost_set: boolean;
  channels: ChannelRow[];
  customers: { customers: number; repeat_customers: number; repeat_rate: number | null; prev_repeat_rate: number | null; median_days_between_orders: number | null; top: CustomerRow[] };
  filament: { grams: number; cost_cents: number; failed_grams: number; failed_cost_cents: number; by_material: FilamentUse[]; by_color: FilamentUse[] };
  utilization: { rate: number | null; prev_rate: number | null; by_printer: PrinterUse[]; collecting_since: string | null };
}

export interface InsightsTable {
  title: string;
  columns: string[];
  rows: string[][];
  order_ids: (string | null)[];
}
