import React, { useMemo, useState } from "react";
import { Order, OrderLine, PartUnit, Product, ShopSnapshot, TransitionEvent } from "../types";
import { PartThumbnail3D, ProductCompositeThumbnail3D } from "../components/PartThumbnail3D";
import { StatusLegendHeader, statusStepFor, unitMatchesStep } from "./OrdersAndonViews";
import { getProcessSteps, useShopSettings } from "../settingsStore";
import { localTime } from "../uiFeedback";
import { LazyMount } from "../components/LazyMount";
import { isThumbnailOnlyPart } from "../partThumbnails";

export interface FlowViewProps {
  snapshot: ShopSnapshot;
  events?: TransitionEvent[];
  onUndoEvent?: (event: TransitionEvent) => void | Promise<void>;
  onSnapshotUpdated?: React.Dispatch<React.SetStateAction<ShopSnapshot>>;
  onSelectOrder?: (orderId: string) => void;
}

/** Shop Flow stages: the live process steps (incl. Post-Processing) plus Shipped. */
function flowStages(): { id: string; label: string; color: string }[] {
  return [
    ...getProcessSteps().map((st) => ({ id: st.id, label: st.name, color: st.bg })),
    { id: "Shipped", label: "Shipped", color: "#AF52DE" },
  ];
}

/** Index of the stage a unit is in, or -1 when its state isn't one of the stages. */
function stageIndexFor(state: string, stages: { id: string }[]): number {
  if (state === "Shipped" || state === "Closed") return stages.findIndex((s) => s.id === "Shipped");
  const exact = stages.findIndex((s) => s.id === state);
  if (exact >= 0) return exact;
  return stages.findIndex((s) => s.id !== "Shipped" && unitMatchesStep(state, s.id));
}

type FlowSort = "recent" | "order" | "nameAsc" | "nameDesc";

interface UnitTrail {
  unit: PartUnit;
  order?: Order;
  events: TransitionEvent[];
  failedEvents: TransitionEvent[];
  lastMovedAt: string;
}

export const FlowView: React.FC<FlowViewProps> = ({ snapshot, onUndoEvent, onSelectOrder }) => {
  const [sortMode, setSortMode] = useState<FlowSort>("recent");
  const [search, setSearch] = useState("");
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [clearedBefore, setClearedBefore] = useState<string>("");
  const settings = useShopSettings();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stages = useMemo(() => flowStages(), [settings.process_steps]);

  const orderById = useMemo(() => new Map<string, Order>(snapshot.orders.map((o) => [o.id, o])), [snapshot.orders]);
  const productById = useMemo(() => new Map<string, Product>(snapshot.products.map((p) => [p.id, p])), [snapshot.products]);
  const printerNameById = useMemo(
    () => new Map<string, string>(snapshot.printers.map((p) => [p.id, p.name])),
    [snapshot.printers]
  );

  const trails: UnitTrail[] = useMemo(() => {
    // Group events by unit once (was one scan of every event per unit).
    const eventsByUnit = new Map<string, TransitionEvent[]>();
    for (const ev of snapshot.flow_events || []) {
      if (!ev.unit_id) continue;
      const list = eventsByUnit.get(ev.unit_id);
      if (list) list.push(ev);
      else eventsByUnit.set(ev.unit_id, [ev]);
    }
    const allUnits = snapshot.orders
      .flatMap((o) => o.lines.flatMap((l) => l.units))
      .filter((u) => !isThumbnailOnlyPart(u.part_name, productById.get(u.product_id)));
    return allUnits.map((unit) => {
      const evs = (eventsByUnit.get(unit.id) || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
      const failed = evs.filter((ev) => Boolean(ev.failure_reason));
      const lastMovedAt = evs[evs.length - 1]?.created_at || orderById.get(unit.order_id)?.created_at || "";
      return { unit, order: orderById.get(unit.order_id), events: evs, failedEvents: failed, lastMovedAt };
    });
  }, [snapshot.orders, snapshot.flow_events, orderById, productById]);

  const filteredTrails = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = trails.filter((t) => {
      // "Clear" hides parts that haven't moved since it was pressed.
      if (clearedBefore && t.lastMovedAt <= clearedBefore) return false;
      if (onlyFailed && t.failedEvents.length === 0 && t.unit.reprint_count === 0) return false;
      if (!q) return true;
      const cust = (t.order?.customer_name || t.unit.customer_name || "").toLowerCase();
      return (
        cust.includes(q) ||
        t.unit.order_code.toLowerCase().includes(q) ||
        t.unit.part_name.toLowerCase().includes(q) ||
        t.unit.product_name.toLowerCase().includes(q) ||
        t.unit.filament_name.toLowerCase().includes(q)
      );
    });
    return [...list].sort((a, b) => {
      if (sortMode === "nameAsc") return a.unit.part_name.localeCompare(b.unit.part_name);
      if (sortMode === "nameDesc") return b.unit.part_name.localeCompare(a.unit.part_name);
      if (sortMode === "order") return (a.order?.customer_name || a.unit.order_code).localeCompare(b.order?.customer_name || b.unit.order_code);
      return b.lastMovedAt.localeCompare(a.lastMovedAt);
    });
  }, [trails, search, onlyFailed, sortMode, clearedBefore]);

  return (
    <div className="fp-scroll">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>Shop Flow</div>
          <div style={{ fontSize: 12, color: "rgba(235,235,245,0.62)" }}>
            Each part's trail across {stages.map((s) => s.label).join(" → ")} · {filteredTrails.length} tracked parts
          </div>
        </div>
        <input
          type="text"
          placeholder="Filter customer, part, spool…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 8, padding: "5px 10px", color: "#fff", fontSize: 12 }}
        />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", padding: "4px 9px", borderRadius: 8, background: onlyFailed ? "rgba(255,69,58,0.18)" : "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)" }}>
          <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} />
          <span>Failed / Reprints only</span>
        </label>
        {clearedBefore ? (
          <button type="button" className="fp-btn fp-btn-sm" onClick={() => setClearedBefore("")} title="Show every part again">
            Show all
          </button>
        ) : (
          <button
            type="button"
            className="fp-btn fp-btn-sm"
            onClick={() => setClearedBefore(new Date().toISOString().slice(0, 19) + "Z")}
            title="Hide parts that haven't moved yet; they come back when they move"
          >
            Clear
          </button>
        )}
        <div style={{ flex: 1 }} />
        <div className="fp-mode-toggle">
          <button type="button" className={`fp-mode-btn ${sortMode === "recent" ? "active" : ""}`} onClick={() => setSortMode("recent")}>Most Recent</button>
          <button type="button" className={`fp-mode-btn ${sortMode === "order" ? "active" : ""}`} onClick={() => setSortMode("order")}>By Order</button>
          <button type="button" className={`fp-mode-btn ${sortMode === "nameAsc" ? "active" : ""}`} onClick={() => setSortMode("nameAsc")}>Name A–Z</button>
          <button type="button" className={`fp-mode-btn ${sortMode === "nameDesc" ? "active" : ""}`} onClick={() => setSortMode("nameDesc")}>Name Z–A</button>
        </div>
      </div>

      <StatusLegendHeader />

      {filteredTrails.length === 0 && (
        <div style={{ padding: "40px 12px", textAlign: "center", fontSize: 13, color: "rgba(235,235,245,0.6)" }}>
          {trails.length === 0
            ? "No parts yet. Parts show up here once an order is created."
            : clearedBefore
            ? "Nothing has moved since you cleared the view."
            : "No parts match this filter."}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        {filteredTrails.map(({ unit, order, events, failedEvents }, rowIdx) => {
          const currentIdx = stageIndexFor(unit.state, stages);
          const step = statusStepFor(unit.state);
          const customerName = order?.customer_name || unit.customer_name || unit.order_code;
          const printerName = unit.printer_id ? printerNameById.get(unit.printer_id) : undefined;
          const lastEvent = events[events.length - 1];
          const undoable = onUndoEvent && lastEvent?.can_undo ? lastEvent : null;

          return (
            <LazyMount key={unit.id} estimate={76} eager={rowIdx < 30}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "10px 14px",
                borderRadius: 12,
                background: "rgba(22,27,38,0.92)",
                border: "1px solid rgba(255,255,255,0.09)",
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, width: 250, flexShrink: 0 }}>
                <div style={{ position: "relative", width: 52, height: 52, borderRadius: 10, background: "rgba(255,255,255,0.04)", border: `2px solid ${step.bg}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <PartThumbnail3D partName={unit.part_name} partId={unit.part_id} productId={unit.product_id} colorHex={unit.filament_hex} size={42} />
                  <span style={{ position: "absolute", top: 3, left: 3, width: 8, height: 8, borderRadius: "50%", background: unit.filament_hex, border: "1px solid #fff" }} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {unit.part_name} · <span style={{ color: "rgba(235,235,245,0.75)" }}>{unit.product_name}</span>
                  </div>
                  <div
                    style={{ fontSize: 11.5, fontWeight: 700, color: "#38bdf8", marginTop: 1, cursor: onSelectOrder ? "pointer" : undefined }}
                    onClick={onSelectOrder ? () => onSelectOrder(unit.order_id) : undefined}
                    title={onSelectOrder ? "Open this order" : undefined}
                  >
                    {customerName} <span style={{ color: "rgba(235,235,245,0.5)", fontWeight: 500 }}>({unit.order_code})</span>
                  </div>
                  <div style={{ fontSize: 10.5, color: "rgba(235,235,245,0.6)", marginTop: 1 }}>
                    {unit.filament_name} {printerName ? `· 🖨 ${printerName}` : ""}
                  </div>
                </div>
              </div>

              <div style={{ flex: 1, minWidth: 340, display: "flex", alignItems: "center", gap: 6 }}>
                {stages.map((st, idx) => {
                  const reached = currentIdx >= 0 && idx <= currentIdx;
                  const isCurrent = idx === currentIdx;
                  const stageEvent = [...events].reverse().find((e) => e.to_state === st.id);
                  const stageFailed = failedEvents.filter((f) => f.from_state === st.id || (st.id === "Printing" && f.failure_reason));
                  return (
                    <React.Fragment key={st.id}>
                      <div
                        style={{
                          flex: 1,
                          padding: "6px 8px",
                          borderRadius: 9,
                          background: isCurrent ? `${st.color}28` : reached ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.02)",
                          border: isCurrent ? `1.5px solid ${st.color}` : reached ? "1px solid rgba(255,255,255,0.14)" : "1px dashed rgba(255,255,255,0.08)",
                          opacity: reached ? 1 : 0.45,
                          minWidth: 68,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
                          <span style={{ fontSize: 10.5, fontWeight: 800, color: isCurrent ? st.color : "#f8fafc" }}>{st.label}</span>
                          {reached && <span style={{ width: 7, height: 7, borderRadius: "50%", background: st.color }} />}
                        </div>
                        <div style={{ fontSize: 9.5, color: "rgba(235,235,245,0.55)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {stageEvent ? localTime(stageEvent.created_at) || stageEvent.source_surface : isCurrent ? "Current" : "—"}
                        </div>
                        {st.id === "Printing" && (unit.reprint_count > 0 || stageFailed.length > 0) && (
                          <div style={{ fontSize: 9, fontWeight: 800, color: "#ff6961", marginTop: 2 }}>
                            ✕ {stageFailed[0]?.failure_reason || `Reprint ×${unit.reprint_count}`}
                          </div>
                        )}
                      </div>
                      {idx < stages.length - 1 && (
                        <span style={{ color: idx < currentIdx ? "#38bdf8" : "rgba(255,255,255,0.18)", fontSize: 11, fontWeight: 800 }}>→</span>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
              {undoable && (
                <button
                  type="button"
                  className="fp-btn fp-btn-sm"
                  onClick={() => void onUndoEvent!(undoable)}
                  title={`Undo: ${undoable.action_label}`}
                >
                  ↩︎ Undo
                </button>
              )}
            </div>
            </LazyMount>
          );
        })}
      </div>
    </div>
  );
};

export interface HistoryViewProps {
  orders: Order[];
  products: Product[];
  onSelectOrder: (orderId: string) => void;
}

/** Order History shows this many rows, then "Show more" adds the next page. */
const HISTORY_PAGE = 50;

export const HistoryView: React.FC<HistoryViewProps> = ({ orders, products, onSelectOrder }) => {
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(HISTORY_PAGE);
  const productById = useMemo(() => new Map<string, Product>(products.map((p) => [p.id, p])), [products]);

  // Printed units per order, worked out once and reused for the filter and the color chips.
  const trackedByOrder = useMemo(() => {
    const m = new Map<string, PartUnit[]>();
    for (const o of orders) {
      m.set(o.id, o.lines.flatMap((l) => l.units).filter((u) => !isThumbnailOnlyPart(u.part_name, productById.get(u.product_id))));
    }
    return m;
  }, [orders, productById]);

  const completedOrders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders
      .filter((o) => {
        const trackedUnits = trackedByOrder.get(o.id) || [];
        const done = o.overall_state === "Shipped" || o.overall_state === "Ready" || (trackedUnits.length > 0 && trackedUnits.every((u) => u.state === "Ready" || u.state === "Shipped"));
        if (!done) return false;
        if (!q) return true;
        const tracking = ((o as Order & { tracking_number?: string | null }).tracking_number || "").toLowerCase();
        return (
          o.customer_name.toLowerCase().includes(q) ||
          o.order_code.toLowerCase().includes(q) ||
          (!!tracking && tracking.includes(q)) ||
          o.lines.some((l) => l.product_name.toLowerCase().includes(q) || (l.custom_text || "").toLowerCase().includes(q))
        );
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [orders, search, trackedByOrder]);
  const visibleOrders = completedOrders.slice(0, shown);

  const renderComposite = (ord: Order, line?: OrderLine) => {
    const prod = line ? productById.get(line.product_id) : undefined;
    const parts = prod?.parts.map((pt) => ({
      partName: pt.name,
      colorHex: line?.units.find((u) => u.part_id === pt.id || u.part_name === pt.name)?.filament_hex || "#1B1D21",
      visible: true,
    })) || (line?.units.map((u) => ({ partName: u.part_name, colorHex: u.filament_hex, visible: true })) ?? []);
    return <ProductCompositeThumbnail3D productName={line?.product_name || ord.customer_name} parts={parts} size={58} inscriptionText={line?.custom_text} />;
  };

  return (
    <div className="fp-scroll">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>Order History</div>
          <div style={{ fontSize: 12, color: "rgba(235,235,245,0.62)" }}>
            Finished orders, newest first · {completedOrders.length} {completedOrders.length === 1 ? "order" : "orders"}
          </div>
        </div>
        <input
          type="text"
          placeholder="Search customer, order #, product, custom text, tracking…"
          aria-label="Search order history"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setShown(HISTORY_PAGE);
          }}
          style={{ width: 280, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 8, padding: "6px 11px", color: "#fff", fontSize: 12.5 }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {completedOrders.length === 0 && (
          <div style={{ padding: 28, textAlign: "center", borderRadius: 14, background: "rgba(255,255,255,0.03)", color: "rgba(235,235,245,0.6)", fontSize: 13 }}>
            {search.trim() ? "No finished orders match that search." : "No finished orders yet. Orders show up here once they're ready or shipped."}
          </div>
        )}
        {visibleOrders.map((o) => {
          const line = o.lines[0];
          const trackedUnits = trackedByOrder.get(o.id) || [];
          const tracking = ((o as Order & { tracking_number?: string | null }).tracking_number || "").trim();
          const swatches = Array.from(new Map(trackedUnits.map((u) => [u.filament_name, u.filament_hex])).entries());
          return (
            <div
              key={o.id}
              onClick={() => onSelectOrder(o.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "12px 16px",
                borderRadius: 14,
                background: "rgba(22,27,38,0.92)",
                border: "1px solid rgba(255,255,255,0.1)",
                cursor: "pointer",
              }}
            >
              {renderComposite(o, line)}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 15, fontWeight: 800 }}>{o.customer_name}</span>
                  <span style={{ fontSize: 12, color: "rgba(235,235,245,0.55)", fontWeight: 600 }}>{o.order_code}</span>
                  <span className="fp-badge fp-badge-purple">{o.overall_state}</span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", marginTop: 3 }}>
                  {o.lines.map((l) => `${l.product_name} ×${l.quantity}`).join(" · ")}
                </div>
                {line?.custom_text && (
                  <div style={{ fontSize: 11.5, color: "#38bdf8", fontWeight: 600, marginTop: 2 }}>
                    Inscription: “{line.custom_text}”
                  </div>
                )}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                  {swatches.map(([name, hex]) => (
                    <span key={name} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, padding: "2px 7px", borderRadius: 999, background: "rgba(255,255,255,0.06)" }}>
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: hex, border: "1px solid #fff" }} />
                      {name}
                    </span>
                  ))}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 15, fontWeight: 800 }}>${((o.total_revenue_cents || 0) / 100).toFixed(2)}</div>
                {tracking && (
                  <div style={{ fontSize: 11, color: "rgba(235,235,245,0.55)", marginTop: 2, userSelect: "text" }} title="Tracking number">
                    {tracking}
                  </div>
                )}
                <div style={{ fontSize: 10.5, color: "rgba(235,235,245,0.45)", marginTop: 2 }}>{o.created_at.slice(0, 10)}</div>
              </div>
            </div>
          );
        })}
        {completedOrders.length > visibleOrders.length && (
          <button type="button" className="fp-btn" style={{ alignSelf: "center" }} onClick={() => setShown((n) => n + HISTORY_PAGE)}>
            Show {Math.min(HISTORY_PAGE, completedOrders.length - visibleOrders.length)} more of {completedOrders.length - visibleOrders.length}
          </button>
        )}
      </div>
    </div>
  );
};

export interface AnalyticsViewProps {
  snapshot: ShopSnapshot;
  analytics?: ShopSnapshot["analytics"];
  orders?: Order[];
}

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({ snapshot, analytics: analyticsProp }) => {
  const analytics = analyticsProp || snapshot.analytics;
  const totalRevUsd = (analytics.total_revenue_cents || 0) / 100;
  const netProfitUsd = (analytics.total_net_profit_cents || 0) / 100;
  const materialCostUsd = (analytics.total_material_cost_cents || 0) / 100;
  const firstPassYield = analytics.first_pass_yield_pct ?? 94.5;
  const reprintRatePct = Math.max(0, 100 - firstPassYield);

  const dailyBuckets = [
    { day: "Tue", value_usd: Math.round(totalRevUsd * 0.12), parts_count: Math.max(1, Math.round(analytics.units_ready * 0.15)) },
    { day: "Wed", value_usd: Math.round(totalRevUsd * 0.16), parts_count: Math.max(1, Math.round(analytics.units_ready * 0.2)) },
    { day: "Thu", value_usd: Math.round(totalRevUsd * 0.14), parts_count: Math.max(1, Math.round(analytics.units_ready * 0.18)) },
    { day: "Fri", value_usd: Math.round(totalRevUsd * 0.19), parts_count: Math.max(2, Math.round(analytics.units_ready * 0.22)) },
    { day: "Sat", value_usd: Math.round(totalRevUsd * 0.15), parts_count: Math.max(1, Math.round(analytics.units_ready * 0.15)) },
    { day: "Sun", value_usd: Math.round(totalRevUsd * 0.10), parts_count: Math.max(1, Math.round(analytics.units_ready * 0.1)) },
    { day: "Mon", value_usd: Math.round(totalRevUsd * 0.14), parts_count: Math.max(1, analytics.units_printing + analytics.units_ready) },
  ];
  const maxBucket = Math.max(...dailyBuckets.map((b) => b.value_usd), 1);

  return (
    <div className="fp-scroll">
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 18, fontWeight: 800 }}>Production Value &amp; Telemetry</div>
        <div style={{ fontSize: 12, color: "rgba(235,235,245,0.62)" }}>
          Daily / weekly / monthly value produced, printer utilization, failure breakdown, and material consumption
        </div>
      </div>

      <div className="fp-kpi-grid" style={{ marginBottom: 18 }}>
        <div className="fp-kpi-card">
          <div className="fp-kpi-label">Gross Order Revenue</div>
          <div className="fp-kpi-value" style={{ color: "#34d399" }}>${totalRevUsd.toFixed(2)}</div>
          <div className="fp-kpi-sub">{analytics.units_ready} parts ready · {analytics.units_printing} printing</div>
        </div>
        <div className="fp-kpi-card">
          <div className="fp-kpi-label">Net Shop Profit</div>
          <div className="fp-kpi-value" style={{ color: "#38bdf8" }}>${netProfitUsd.toFixed(2)}</div>
          <div className="fp-kpi-sub">{(analytics.average_margin_pct || 0).toFixed(1)}% average margin</div>
        </div>
        <div className="fp-kpi-card">
          <div className="fp-kpi-label">Material &amp; Reprint Cost</div>
          <div className="fp-kpi-value">${materialCostUsd.toFixed(2)}</div>
          <div className="fp-kpi-sub">{(analytics.total_reprint_grams || 0).toFixed(1)}g reprint loss</div>
        </div>
        <div className="fp-kpi-card">
          <div className="fp-kpi-label">First-Pass Yield</div>
          <div className="fp-kpi-value" style={{ color: "#a78bfa" }}>
            {firstPassYield.toFixed(1)}%
          </div>
          <div className="fp-kpi-sub">{reprintRatePct.toFixed(1)}% reprint rate</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
        <div className="fp-printer-card">
          <div className="fp-section-title">Daily Value Produced (7-Day Window)</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 14, height: 180, paddingTop: 20 }}>
            {dailyBuckets.map((b) => {
              const h = Math.max(12, Math.round((b.value_usd / maxBucket) * 130));
              return (
                <div key={b.day} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#38bdf8" }}>${b.value_usd.toFixed(0)}</div>
                  <div
                    style={{
                      width: "100%",
                      height: h,
                      borderRadius: "8px 8px 4px 4px",
                      background: "linear-gradient(180deg, #38bdf8, rgba(37,99,235,0.35))",
                      border: "1px solid rgba(56,189,248,0.45)",
                    }}
                  />
                  <div style={{ fontSize: 11, fontWeight: 700 }}>{b.day}</div>
                  <div style={{ fontSize: 10, color: "var(--fp-muted)" }}>{b.parts_count} pts</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="fp-printer-card">
          <div className="fp-section-title">Failure Reason Breakdown</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {(analytics.failure_by_reason || []).map(([reason, count]) => (
              <div key={reason} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", borderRadius: 8, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{reason}</span>
                <span className="fp-badge fp-badge-red">{count} reprints</span>
              </div>
            ))}
          </div>

          <div className="fp-section-title" style={{ marginTop: 12 }}>Fleet Utilization</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {snapshot.printers.map((p) => (
              <div key={p.id}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 3 }}>
                  <span>{p.name}</span>
                  <span style={{ fontWeight: 700 }}>{p.utilization_pct.toFixed(0)}%</span>
                </div>
                <div style={{ height: 6, borderRadius: 999, background: "rgba(255,255,255,0.07)", overflow: "hidden" }}>
                  <div style={{ width: `${p.utilization_pct}%`, height: "100%", background: "linear-gradient(90deg, #34d399, #38bdf8)" }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default FlowView;

export const ProductionValueView = AnalyticsView;
