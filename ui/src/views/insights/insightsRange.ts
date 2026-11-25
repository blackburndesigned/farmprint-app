/**
 * Insights date range and number formatting. Pure, so the UI tests run it without a browser.
 * Ranges are [start, end) in local days; the backend gets ISO instants plus the time zone
 * offset so days and weeks match the user's calendar.
 */
import type { Headline, InsightsQuery } from "./insightsTypes";

export type RangePreset = "7d" | "30d" | "90d" | "ytd" | "all" | "custom";

export const RANGE_PRESETS: Array<[RangePreset, string]> = [
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
  ["ytd", "Year to date"],
  ["all", "All time"],
  ["custom", "Custom"],
];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** "YYYY-MM-DD" in local time. */
export function localDateText(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local midnight of a "YYYY-MM-DD" date; null when not a date. */
export function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) || d.getDate() !== Number(m[3]) ? null : d;
}

/**
 * The query for a preset. "7 days" = today and the 6 days before; ends at the end of today.
 * Custom uses the two dates inclusive (swapped if backwards). All time sends no start.
 */
export function rangeQuery(preset: RangePreset, now: Date, custom?: { from: string; to: string }): InsightsQuery {
  const tz = -now.getTimezoneOffset();
  const tomorrow = addDays(startOfDay(now), 1);
  const q = (start: Date | null, end: Date): InsightsQuery => ({
    start: start ? start.toISOString() : null,
    end: end.toISOString(),
    tz_offset_minutes: tz,
  });
  switch (preset) {
    case "7d":
      return q(addDays(tomorrow, -7), tomorrow);
    case "30d":
      return q(addDays(tomorrow, -30), tomorrow);
    case "90d":
      return q(addDays(tomorrow, -90), tomorrow);
    case "ytd":
      return q(new Date(now.getFullYear(), 0, 1), tomorrow);
    case "all":
      return q(null, tomorrow);
    case "custom": {
      let a = parseLocalDate(custom?.from ?? "");
      let b = parseLocalDate(custom?.to ?? "");
      if (!a || !b) return q(addDays(tomorrow, -30), tomorrow);
      if (a > b) [a, b] = [b, a];
      return q(a, addDays(b, 1));
    }
  }
}

/** File-name piece for CSV export: "2026-11-01_to_2026-11-25" or "all-time_to_…". */
export function rangeFileLabel(q: InsightsQuery): string {
  const end = addDays(new Date(q.end ?? Date.now()), -1);
  const start = q.start ? localDateText(new Date(q.start)) : "all-time";
  return `${start}_to_${localDateText(end)}`;
}

export const usd = (cents: number) =>
  (cents < 0 ? "-" : "") + "$" + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

/** A headline value as text; "Not enough data" when there's none. */
export function fmtValue(v: number | null | undefined, unit: Headline["unit"]): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "Not enough data";
  switch (unit) {
    case "pct":
      return `${(v * 100).toFixed(1)}%`;
    case "cents":
      return usd(Math.round(v));
    case "hours":
      return fmtHours(v);
    default:
      return Math.round(v).toLocaleString("en-US");
  }
}

/**
 * Change vs the previous period. `good` is null when there's nothing to compare or no
 * change. Percentages compare in points; others as a relative change.
 */
export function delta(h: Pick<Headline, "value" | "previous" | "unit" | "better">): { text: string; good: boolean | null } {
  const { value: v, previous: p } = h;
  if (v === null || p === null || v === undefined || p === undefined) return { text: "", good: null };
  const diff = v - p;
  if (Math.abs(diff) < 1e-9) return { text: "No change vs previous", good: null };
  const up = diff > 0;
  const good = h.better === "up" ? up : !up;
  const arrow = up ? "▲" : "▼";
  if (h.unit === "pct") return { text: `${arrow} ${Math.abs(diff * 100).toFixed(1)} pts vs previous`, good };
  if (p === 0) return { text: `${arrow} from 0 vs previous`, good };
  return { text: `${arrow} ${Math.abs((diff / p) * 100).toFixed(0)}% vs previous`, good };
}

/** Nice round top for a chart axis (1, 2, 5 x 10^n) at or above `max`. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= max) return m * pow;
  return 10 * pow;
}
