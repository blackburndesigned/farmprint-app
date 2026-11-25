/**
 * Insights tab: headline numbers for a date range (each vs the previous period of the same
 * length), charts below, a drill-down list behind every number or bar, and CSV export.
 * All numbers come from fp-core `insights.rs`; nothing here makes numbers up. Missing data
 * reads "Not enough data"; estimates carry an "Estimate" badge and a note.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./insights.css";
import { invoke } from "../../tauriInvoke";
import { errorText } from "../../errorText";
import { notifyBanner, notifyError, saveTextFile } from "../../uiFeedback";
import { BarList, ColumnChart, INS_COLORS, PairBars, StackBar } from "./charts";
import { DrilldownModal, type Drill } from "./DrilldownModal";
import { delta, fmtHours, fmtValue, localDateText, RANGE_PRESETS, rangeFileLabel, rangeQuery, usd, type RangePreset } from "./insightsRange";
import type { Headline, Insights, InsightsQuery } from "./insightsTypes";

const NOTE_WAIT_WORK = "Estimate from Flow times: waiting = placed to first print start; printing = first start to last part printed; after = last part printed to shipped.";
const NOTE_SCRAP = "Estimate: catalog part cost of failed prints only (no machine time, labor or filament weight).";
const NOTE_MARGIN = "Estimate: line price minus catalog part cost, reprints and packaging. Shipping, machine time and labor aren't included.";
const NOTE_CUSTOMERS = "Estimate: customers are matched by email, or by name when there's no email.";
const NOTE_FILAMENT = "Estimate: catalog grams per part for each printed or failed print, at the filament's cost per kg.";

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);

const EstimateBadge: React.FC = () => <span className="fp-ins-badge">Estimate</span>;

const Card: React.FC<{
  title: string;
  estimate?: boolean;
  note?: string | null;
  collectingSince?: string | null;
  onCsv?: () => void;
  children: React.ReactNode;
}> = ({ title, estimate, note, collectingSince, onCsv, children }) => (
  <div className="fp-ins-card">
    <div className="fp-ins-card-head">
      <div className="fp-ins-card-title">
        {title}
        {estimate && <EstimateBadge />}
      </div>
      {onCsv && (
        <button type="button" className="fp-btn fp-btn-sm fp-btn-ghost" onClick={onCsv} title={`Export ${title} as CSV`}>
          CSV
        </button>
      )}
    </div>
    {collectingSince && <div className="fp-ins-collecting">Collecting since {collectingSince}</div>}
    {children}
    {note && <div className="fp-ins-note">{note}</div>}
  </div>
);

const Empty: React.FC<{ text?: string }> = ({ text }) => <div className="fp-ins-empty">{text ?? "Not enough data"}</div>;

const StatCard: React.FC<{ h: Headline; onOpen: () => void }> = ({ h, onOpen }) => {
  const d = delta(h);
  const has = h.value !== null && h.value !== undefined;
  return (
    <button type="button" className="fp-ins-stat" onClick={onOpen} data-metric={h.id} title={h.note ?? `See what's behind ${h.label}`}>
      <span className="fp-ins-stat-label">
        {h.label}
        {h.estimate && <EstimateBadge />}
      </span>
      <span className={`fp-ins-stat-value${has ? "" : " empty"}`}>{fmtValue(h.value, h.unit)}</span>
      {has && h.previous !== null && (
        <span className={`fp-ins-delta${d.good === true ? " good" : d.good === false ? " bad" : ""}`}>
          {d.text || "—"} <span style={{ opacity: 0.8 }}>({fmtValue(h.previous, h.unit)})</span>
        </span>
      )}
      {h.collecting_since && <span className="fp-ins-collecting">Collecting since {h.collecting_since}</span>}
    </button>
  );
};

const shortDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export const InsightsView: React.FC<{
  /** Changes when shop data changes, so the numbers refresh. */
  refreshKey: unknown;
  onSelectOrder: (id: string) => void;
}> = ({ refreshKey, onSelectOrder }) => {
  const [preset, setPreset] = useState<RangePreset>("30d");
  const today = localDateText(new Date());
  const [from, setFrom] = useState(() => localDateText(new Date(Date.now() - 29 * 86400000)));
  const [to, setTo] = useState(today);
  const [data, setData] = useState<Insights | null>(null);
  const [err, setErr] = useState("");
  const [drill, setDrill] = useState<Drill | null>(null);

  // The query is fixed per range choice (and per day), so drill-downs match the numbers.
  const query: InsightsQuery = useMemo(
    () => rangeQuery(preset, new Date(), { from, to }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preset, from, to, today]
  );
  const rangeLabel = useMemo(() => {
    const label = RANGE_PRESETS.find(([p]) => p === preset)?.[1] ?? "";
    return `${label} · ${rangeFileLabel(query).replace("_to_", " to ").replace("all-time", "Start")}`;
  }, [preset, query]);

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      invoke<Insights>("insights", { query })
        .then((d) => {
          if (!live) return;
          setData(d);
          setErr("");
        })
        .catch((e) => live && setErr(errorText(e)));
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query, refreshKey]);

  const open = useCallback((metric: string, title: string, key?: string | null) => setDrill({ metric, title, key: key ?? null }), []);

  const exportCsv = useCallback(
    async (metric: string | null) => {
      try {
        const res = await invoke<{ csv: string }>("insights_csv", { query, metric });
        const name = `insights-${metric ?? "all"}-${rangeFileLabel(query)}.csv`;
        const path = await saveTextFile(name, res.csv);
        if (path) notifyBanner(`Saved ${path}`);
      } catch (e) {
        notifyError("Couldn't export the CSV", e);
      }
    },
    [query]
  );

  const header = (
    <div className="fp-ins-head">
      <div>
        <div className="fp-ins-title">Insights</div>
        <div className="fp-ins-sub">
          {rangeLabel}
          {data?.range.prev_start ? " · compared with the previous period of the same length" : " · no previous period to compare"}
        </div>
      </div>
      <div className="fp-ins-controls">
        {RANGE_PRESETS.map(([p, label]) => (
          <button key={p} type="button" className={`fp-btn fp-btn-sm ${preset === p ? "fp-btn-primary" : ""}`} onClick={() => setPreset(p)}>
            {label}
          </button>
        ))}
        {preset === "custom" && (
          <>
            <input type="date" aria-label="From date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            <span className="fp-ins-sub">to</span>
            <input type="date" aria-label="To date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </>
        )}
        <button type="button" className="fp-btn fp-btn-sm" onClick={() => void exportCsv(null)} title="Every metric for this range in one CSV">
          Export all CSV
        </button>
      </div>
    </div>
  );

  if (!data) {
    return (
      <div className="fp-scroll">
        <div className="fp-ins">
          {header}
          <Empty text={err || "Loading…"} />
        </div>
      </div>
    );
  }

  const d = data;
  const bucketWord = d.range.bucket === "week" ? "week" : "day";
  const series = d.series;
  const hasSeries = series.some((p) => p.parts_printed || p.orders_shipped || p.orders_placed);
  const packagingNote = d.packaging_cost_set ? null : "Packaging cost not set (counted as 0). Set it in Settings › General.";

  return (
    <div className="fp-scroll">
      <div className="fp-ins" data-fp-insights="1">
        {header}
        {err && <div className="fp-ins-note">{err}</div>}

        <div className="fp-ins-headline">
          {d.headline.map((h) => (
            <StatCard key={h.id} h={h} onOpen={() => open(h.id, h.label)} />
          ))}
        </div>

        {/* ---------------- Speed ---------------- */}
        <div className="fp-ins-section-title">Speed</div>
        <div className="fp-ins-grid">
          <Card title="Lead time (placed → shipped)" onCsv={() => void exportCsv("lead_time")}>
            {d.lead_time.shipped === 0 ? (
              <Empty />
            ) : (
              <div className="fp-ins-kv">
                {[
                  ["Median", d.lead_time.median_hours, d.lead_time.prev_median_hours],
                  ["P90", d.lead_time.p90_hours, d.lead_time.prev_p90_hours],
                ].map(([k, v, p]) => (
                  <button key={k as string} type="button" onClick={() => open("lead_time", "Lead time")}>
                    <span className="fp-ins-kv-k">{k as string}</span>
                    <span className="fp-ins-kv-v">{v == null ? "—" : fmtHours(v as number)}</span>
                    <span className="fp-ins-kv-p">{p == null ? "No previous" : `Previous ${fmtHours(p as number)}`}</span>
                  </button>
                ))}
                <button type="button" onClick={() => open("lead_time", "Orders shipped")}>
                  <span className="fp-ins-kv-k">Orders shipped</span>
                  <span className="fp-ins-kv-v">{d.lead_time.shipped}</span>
                </button>
              </div>
            )}
          </Card>

          <Card
            title="On time"
            collectingSince={d.on_time.collecting_since}
            note={
              d.on_time.default_target_days
                ? `Target: the order's ship-by date, else ${d.on_time.default_target_days} days after it was placed.`
                : "Target: the order's ship-by date. Set a default target in Settings › General to cover orders without one."
            }
            onCsv={() => void exportCsv("on_time")}
          >
            {d.on_time.with_target === 0 ? (
              <Empty />
            ) : (
              <div className="fp-ins-kv">
                <button type="button" onClick={() => open("on_time", "Shipped with a target")}>
                  <span className="fp-ins-kv-k">On-time rate</span>
                  <span className="fp-ins-kv-v">{pct(d.on_time.rate)}</span>
                  <span className="fp-ins-kv-p">{d.on_time.prev_rate == null ? "No previous" : `Previous ${pct(d.on_time.prev_rate)}`}</span>
                </button>
                <button type="button" onClick={() => open("on_time", "Shipped late", "late")}>
                  <span className="fp-ins-kv-k">Late</span>
                  <span className="fp-ins-kv-v">{d.on_time.with_target - d.on_time.on_time}</span>
                  <span className="fp-ins-kv-p">of {d.on_time.with_target} with a target</span>
                </button>
              </div>
            )}
          </Card>

          <Card title="Wait vs work" estimate note={NOTE_WAIT_WORK} onCsv={() => void exportCsv("wait_work")}>
            {d.wait_work.orders === 0 ? (
              <Empty />
            ) : (
              <StackBar
                onClick={() => open("wait_work", "Wait vs work")}
                parts={[
                  { label: "Waiting", value: d.wait_work.waiting_hours ?? 0, text: fmtHours(d.wait_work.waiting_hours ?? 0), color: INS_COLORS[2] },
                  { label: "Printing", value: d.wait_work.printing_hours ?? 0, text: fmtHours(d.wait_work.printing_hours ?? 0), color: INS_COLORS[0] },
                  { label: "After printing", value: d.wait_work.after_print_hours ?? 0, text: fmtHours(d.wait_work.after_print_hours ?? 0), color: INS_COLORS[3] },
                ]}
              />
            )}
            {d.wait_work.orders > 0 && <div className="fp-ins-note">Median of {d.wait_work.orders} shipped orders.</div>}
          </Card>

          <Card title="Open orders by age (days)" note="Open orders placed in this range, by age right now." onCsv={() => void exportCsv("aging")}>
            {d.aging.every((a) => a.count === 0) ? (
              <Empty text="No open orders" />
            ) : (
              <BarList
                color={INS_COLORS[2]}
                rows={d.aging.map((a) => ({ key: a.key, label: `${a.key} days`, value: a.count, valueText: String(a.count) }))}
                onClick={(r) => open("aging", `Open orders ${r.label} old`, r.key)}
              />
            )}
          </Card>

          <Card title={`Throughput per ${bucketWord}`} onCsv={() => void exportCsv("throughput")}>
            {!hasSeries ? (
              <Empty />
            ) : (
              <>
                <ColumnChart
                  ariaLabel="Parts printed over time"
                  points={series.map((p) => ({
                    key: p.date,
                    label: shortDate(p.date),
                    value: p.parts_printed,
                    title: `${shortDate(p.date)}: ${p.parts_printed} parts printed, ${p.orders_shipped} orders shipped`,
                  }))}
                  format={(v) => String(Math.round(v))}
                  onBarClick={(p) => open("throughput", `Parts printed · ${p.label}`, `date:${p.key}`)}
                />
                <div className="fp-ins-note">
                  {d.throughput.parts_printed} parts printed, {d.throughput.orders_shipped} orders shipped
                  {d.throughput.prev_parts_printed !== null
                    ? ` (previous: ${d.throughput.prev_parts_printed} parts, ${d.throughput.prev_orders_shipped} orders)`
                    : ""}
                  .
                </div>
              </>
            )}
          </Card>

          <Card title="Bottleneck right now" note="Live: parts on each printer (staged or printing), and parts waiting by material. Open orders not on hold." onCsv={() => void exportCsv("bottleneck")}>
            {d.bottleneck.by_printer.length === 0 && d.bottleneck.by_material.length === 0 ? (
              <Empty text="Nothing waiting" />
            ) : (
              <>
                {d.bottleneck.by_printer.length > 0 && (
                  <>
                    <div className="fp-ins-kv-k">By printer (print time)</div>
                    <BarList
                      rows={d.bottleneck.by_printer.map((q) => ({ key: q.key, label: q.key, value: q.minutes, valueText: `${fmtHours(q.minutes / 60)} · ${q.parts} parts` }))}
                      onClick={(r) => open("bottleneck", `Parts on ${r.label}`, `printer:${r.key}`)}
                    />
                  </>
                )}
                {d.bottleneck.by_material.length > 0 && (
                  <>
                    <div className="fp-ins-kv-k">Waiting by material (print time)</div>
                    <BarList
                      color={INS_COLORS[3]}
                      rows={d.bottleneck.by_material.map((q) => ({ key: q.key, label: q.key, value: q.minutes, valueText: `${fmtHours(q.minutes / 60)} · ${q.parts} parts` }))}
                      onClick={(r) => open("bottleneck", `${r.label} parts waiting`, `material:${r.key}`)}
                    />
                  </>
                )}
              </>
            )}
          </Card>
        </div>

        {/* ---------------- Quality ---------------- */}
        <div className="fp-ins-section-title">Quality</div>
        <div className="fp-ins-grid">
          <Card title="First-pass yield" note="Share of parts whose first print in this range succeeded. Undone Flow steps aren't counted." onCsv={() => void exportCsv("yield")}>
            {d.yield.overall.total === 0 ? (
              <Empty />
            ) : (
              <>
                {(
                  [
                    ["By product", "product", d.yield.by_product],
                    ["By printer", "printer", d.yield.by_printer],
                    ["By material", "material", d.yield.by_material],
                  ] as const
                ).map(([label, kind, rows]) => (
                  <React.Fragment key={kind}>
                    <div className="fp-ins-kv-k">{label}</div>
                    <BarList
                      max={1}
                      color={INS_COLORS[1]}
                      rows={rows.map((r) => ({ key: r.key, label: r.key, value: r.rate ?? 0, valueText: `${pct(r.rate)} (${r.passed}/${r.total})` }))}
                      onClick={(r) => open("yield", `First prints · ${r.label}`, `${kind}:${r.key}`)}
                    />
                  </React.Fragment>
                ))}
              </>
            )}
          </Card>

          <Card title="Failure reasons" onCsv={() => void exportCsv("failures")}>
            {d.failures.length === 0 ? (
              <Empty text="No failed prints" />
            ) : (
              <BarList
                color={INS_COLORS[4]}
                rows={d.failures.map((f) => ({ key: f.reason, label: f.reason, value: f.count, valueText: `${f.count} · ${usd(f.cost_cents)}` }))}
                onClick={(r) => open("failures", `Failed prints · ${r.label}`, r.key)}
              />
            )}
          </Card>

          <Card title="Scrap cost" estimate note={NOTE_SCRAP} onCsv={() => void exportCsv("scrap")}>
            <div className="fp-ins-kv">
              <button type="button" onClick={() => open("scrap", "Failed prints")}>
                <span className="fp-ins-kv-k">This period</span>
                <span className="fp-ins-kv-v">{usd(d.scrap_cost_cents)}</span>
                <span className="fp-ins-kv-p">{d.prev_scrap_cost_cents === null ? "No previous" : `Previous ${usd(d.prev_scrap_cost_cents)}`}</span>
              </button>
            </div>
          </Card>
        </div>

        {/* ---------------- Money ---------------- */}
        <div className="fp-ins-section-title">Money</div>
        <div className="fp-ins-grid">
          <Card title={`Revenue per ${bucketWord}`} note="Orders placed in the range: line prices plus shipping charged." onCsv={() => void exportCsv("revenue")}>
            {d.money.orders === 0 ? (
              <Empty />
            ) : (
              <>
                <ColumnChart
                  ariaLabel="Revenue over time"
                  color={INS_COLORS[1]}
                  points={series.map((p) => ({
                    key: p.date,
                    label: shortDate(p.date),
                    value: p.revenue_cents,
                    title: `${shortDate(p.date)}: ${usd(p.revenue_cents)} from ${p.orders_placed} orders`,
                  }))}
                  format={(v) => (v >= 100000 ? `$${Math.round(v / 100000)}k` : `$${Math.round(v / 100)}`)}
                  onBarClick={(p) => open("revenue", `Orders placed · ${p.label}`, p.key)}
                />
                <div className="fp-ins-kv">
                  <button type="button" onClick={() => open("revenue", "Orders placed")}>
                    <span className="fp-ins-kv-k">Revenue</span>
                    <span className="fp-ins-kv-v">{usd(d.money.revenue_cents)}</span>
                  </button>
                  <button type="button" onClick={() => open("orders", "Orders placed")}>
                    <span className="fp-ins-kv-k">Orders</span>
                    <span className="fp-ins-kv-v">{d.money.orders}</span>
                  </button>
                  <button type="button" onClick={() => open("aov", "Orders placed")}>
                    <span className="fp-ins-kv-k">Avg order value</span>
                    <span className="fp-ins-kv-v">{d.money.aov_cents === null ? "—" : usd(Math.round(d.money.aov_cents))}</span>
                  </button>
                </div>
              </>
            )}
          </Card>

          <Card title="Gross margin by product" estimate note={[NOTE_MARGIN, packagingNote].filter(Boolean).join(" ")} onCsv={() => void exportCsv("products")}>
            {d.products.length === 0 ? (
              <Empty />
            ) : (
              <BarList
                max={1}
                color={INS_COLORS[1]}
                rows={d.products.map((p) => ({
                  key: p.product,
                  label: p.product,
                  value: Math.max(0, p.margin_pct ?? 0),
                  valueText: `${pct(p.margin_pct)} · ${usd(p.revenue_cents - p.cost_cents)}`,
                  color: (p.margin_pct ?? 0) < 0 ? INS_COLORS[4] : undefined,
                }))}
                onClick={(r) => open("margin", `Order lines · ${r.label}`, r.key)}
              />
            )}
          </Card>

          <Card title="Product mix: revenue vs printer time" note="Printer time = catalog print minutes per part, including reprints." onCsv={() => void exportCsv("products")}>
            {d.products.length === 0 ? (
              <Empty />
            ) : (
              <PairBars
                aLabel="Revenue share"
                bLabel="Printer time share"
                rows={d.products.map((p) => ({
                  key: p.product,
                  label: p.product,
                  a: p.revenue_share ?? 0,
                  b: p.minutes_share ?? 0,
                  aText: pct(p.revenue_share),
                  bText: pct(p.minutes_share),
                }))}
                onClick={(k) => open("mix", `Order lines · ${k}`, k)}
              />
            )}
          </Card>

          <Card title="Sales channel" onCsv={() => void exportCsv("channel")}>
            {d.channels.length === 0 ? (
              <Empty />
            ) : (
              <BarList
                rows={d.channels.map((c, i) => ({
                  key: c.source,
                  label: c.source,
                  value: c.revenue_cents,
                  valueText: `${usd(c.revenue_cents)} · ${c.orders} orders`,
                  color: INS_COLORS[i % INS_COLORS.length],
                }))}
                onClick={(r) => open("channel", `${r.label} orders`, r.key)}
              />
            )}
          </Card>
        </div>

        {/* ---------------- Customers ---------------- */}
        <div className="fp-ins-section-title">Customers</div>
        <div className="fp-ins-grid">
          <Card title="Repeat customers" estimate note={NOTE_CUSTOMERS} onCsv={() => void exportCsv("repeat_rate")}>
            {d.customers.customers === 0 ? (
              <Empty />
            ) : (
              <div className="fp-ins-kv">
                <button type="button" onClick={() => open("repeat_rate", "Orders placed")}>
                  <span className="fp-ins-kv-k">Repeat rate</span>
                  <span className="fp-ins-kv-v">{pct(d.customers.repeat_rate)}</span>
                  <span className="fp-ins-kv-p">{d.customers.repeat_customers} of {d.customers.customers} customers</span>
                </button>
                <button type="button" onClick={() => open("repeat_rate", "Orders placed")}>
                  <span className="fp-ins-kv-k">Time between orders</span>
                  <span className="fp-ins-kv-v">
                    {d.customers.median_days_between_orders === null ? "Not enough data" : `${d.customers.median_days_between_orders.toFixed(1)} days`}
                  </span>
                  <span className="fp-ins-kv-p">median</span>
                </button>
              </div>
            )}
          </Card>
          <Card title="Top customers" estimate note={NOTE_CUSTOMERS} onCsv={() => void exportCsv("customers")}>
            {d.customers.top.length === 0 ? (
              <Empty />
            ) : (
              <BarList
                color={INS_COLORS[5]}
                rows={d.customers.top.map((c) => ({
                  key: c.key,
                  label: c.name || "(no name)",
                  value: c.revenue_cents,
                  valueText: `${usd(c.revenue_cents)} · ${c.orders} ${c.orders === 1 ? "order" : "orders"}`,
                }))}
                onClick={(r) => open("customers", `Orders · ${r.label}`, r.key)}
              />
            )}
          </Card>
        </div>

        {/* ---------------- Materials & printers ---------------- */}
        <div className="fp-ins-section-title">Materials &amp; printers</div>
        <div className="fp-ins-grid">
          <Card title="Filament used" estimate note={NOTE_FILAMENT} onCsv={() => void exportCsv("filament")}>
            {d.filament.by_material.length === 0 ? (
              <Empty />
            ) : (
              <>
                <div className="fp-ins-kv-k">
                  Total {Math.round(d.filament.grams).toLocaleString()} g · {usd(d.filament.cost_cents)}
                </div>
                <div className="fp-ins-kv-k">By material</div>
                <BarList
                  color={INS_COLORS[3]}
                  rows={d.filament.by_material.map((f) => ({ key: f.key, label: f.key, value: f.grams, valueText: `${Math.round(f.grams)} g · ${usd(f.cost_cents)}` }))}
                  onClick={(r) => open("filament", `Prints · ${r.label}`, `material:${r.key}`)}
                />
                <div className="fp-ins-kv-k">By color</div>
                <BarList
                  color={INS_COLORS[5]}
                  rows={d.filament.by_color.map((f) => ({ key: f.key, label: f.key, value: f.grams, swatch: f.hex, valueText: `${Math.round(f.grams)} g · ${usd(f.cost_cents)}` }))}
                  onClick={(r) => open("filament", `Prints · ${r.label}`, `color:${r.key}`)}
                />
              </>
            )}
          </Card>
          <Card
            title="Printer utilization"
            collectingSince={d.utilization.collecting_since}
            note="Share of tracked time each printer was printing, from its status history."
            onCsv={() => void exportCsv("utilization")}
          >
            {d.utilization.rate === null ? (
              <Empty />
            ) : (
              <BarList
                max={1}
                rows={d.utilization.by_printer.map((p) => ({
                  key: p.printer_id,
                  label: p.name,
                  value: p.rate ?? 0,
                  valueText: p.rate === null ? "Not enough data" : `${pct(p.rate)} · ${p.printing_hours.toFixed(1)} of ${p.observed_hours.toFixed(1)} h`,
                }))}
                onClick={(r) => open("utilization", `Status history · ${r.label}`, r.key)}
              />
            )}
          </Card>
        </div>
      </div>

      {drill && (
        <DrilldownModal
          drill={drill}
          query={query}
          rangeLabel={rangeLabel}
          onClose={() => setDrill(null)}
          onSelectOrder={(id) => {
            setDrill(null);
            onSelectOrder(id);
          }}
        />
      )}
    </div>
  );
};
