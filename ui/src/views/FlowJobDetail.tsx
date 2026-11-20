import React, { useEffect, useMemo } from "react";
import type { FlowEvent, Order, PartUnit, ShopSnapshot } from "../types";
import { PartThumbnail3D } from "../components/PartThumbnail3D";
import { statusStepFor } from "./orders/orderStatus";
import { stepLabel } from "../settingsStore";
import { failureText, jobHistory, jobIdForUnit } from "./flowJob";

function when(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const muted = "rgba(235,235,245,0.6)";
const sectionTitle: React.CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: muted, margin: "4px 0 6px" };

/**
 * Flow row detail: the plate job the clicked part was in, with its parts, orders, printer
 * and the job's history from the flow ledger. A part that was never sent shows on its own.
 */
export const FlowJobDetail: React.FC<{
  unit: PartUnit;
  snapshot: ShopSnapshot;
  onClose: () => void;
  onSelectOrder?: (orderId: string) => void;
}> = ({ unit, snapshot, onClose, onSelectOrder }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const events = useMemo(() => snapshot.flow_events || [], [snapshot.flow_events]);
  const allUnits = useMemo(() => snapshot.orders.flatMap((o) => o.lines.flatMap((l) => l.units)), [snapshot.orders]);
  const orderById = useMemo(() => new Map<string, Order>(snapshot.orders.map((o) => [o.id, o])), [snapshot.orders]);
  const printerName = (id: string | null | undefined) => (id ? snapshot.printers.find((p) => p.id === id)?.name : undefined);

  const jobId = jobIdForUnit(unit, events);
  const { parts, history } = useMemo(() => {
    if (!jobId) {
      const own = events.filter((e) => e.unit_id === unit.id).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      return { parts: [unit], history: own };
    }
    const h = jobHistory(jobId, events, allUnits);
    const ids = new Set(h.unitIds);
    ids.add(unit.id);
    const unitById = new Map(allUnits.map((u) => [u.id, u]));
    const list = [...ids].map((id) => unitById.get(id)).filter((u): u is PartUnit => !!u);
    // Clicked part first, then the rest in order of order code and part name.
    list.sort((a, b) => (a.id === unit.id ? -1 : b.id === unit.id ? 1 : a.order_code.localeCompare(b.order_code) || a.part_name.localeCompare(b.part_name)));
    return { parts: list, history: h.events };
  }, [jobId, events, allUnits, unit]);

  const orders = useMemo(() => {
    const seen = new Map<string, { id: string; code: string; customer: string; count: number }>();
    for (const p of parts) {
      const o = orderById.get(p.order_id);
      const cur = seen.get(p.order_id);
      if (cur) cur.count++;
      else seen.set(p.order_id, { id: p.order_id, code: o?.order_code || p.order_code, customer: o?.customer_name || p.customer_name, count: 1 });
    }
    return [...seen.values()];
  }, [parts, orderById]);

  const printers = [...new Set([...history.map((e) => e.printer_name || printerName(e.printer_id)), printerName(unit.printer_id)].filter(Boolean))] as string[];
  const failures = history.filter((e) => !e.undone && (e.failure_reason || e.kind === "FailedPrint"));
  const sentAt = history[0]?.created_at;
  const title = jobId ? `Job · ${parts.length} ${parts.length === 1 ? "part" : "parts"}${orders.length > 1 ? ` · ${orders.length} orders` : ""}` : unit.part_name;

  const openOrder = (orderId: string) => {
    onClose();
    onSelectOrder?.(orderId);
  };

  return (
    <div className="fp-modal-backdrop" onClick={onClose}>
      <div
        className="fp-modal-window"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width: "min(720px, 94vw)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fp-modal-header">
          <div style={{ minWidth: 0 }}>
            <div className="fp-modal-title">{title}</div>
            <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
              {[printers.length ? `🖨 ${printers.join(", ")}` : "No printer", sentAt ? `Started ${when(sentAt)}` : "", jobId ? `#${jobId.slice(0, 8)}` : "Not sent to a printer yet"]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          <button type="button" className="fp-btn fp-btn-sm" onClick={onClose}>
            Done
          </button>
        </div>
        <div className="fp-modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {failures.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 10px", borderRadius: 10, background: "rgba(255,69,58,0.12)", border: "1px solid rgba(255,69,58,0.4)" }}>
              {failures.map((f) => (
                <div key={f.id} style={{ fontSize: 12.5, fontWeight: 700, color: "#ff6961" }}>
                  ✕ {f.part_name}: Failed · {failureText(f) || "no reason given"}
                  <span style={{ fontWeight: 500, color: muted }}> — {when(f.created_at)}</span>
                </div>
              ))}
            </div>
          )}

          <div>
            <div style={sectionTitle}>Parts</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
              {parts.map((p) => {
                const st = statusStepFor(p.state);
                return (
                  <div
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: 6,
                      borderRadius: 10,
                      background: "rgba(255,255,255,0.04)",
                      border: p.id === unit.id ? "1.5px solid #0a84ff" : "1px solid rgba(255,255,255,0.08)",
                    }}
                  >
                    <div style={{ width: 46, height: 46, borderRadius: 8, border: `2px solid ${st.bg}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: "rgba(255,255,255,0.04)" }}>
                      <PartThumbnail3D partName={p.part_name} partId={p.part_id} productId={p.product_id} colorHex={p.filament_hex} size={38} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.part_name}</div>
                      <div style={{ fontSize: 10.5, color: muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {p.product_name} · {p.filament_name}
                      </div>
                      <span style={{ display: "inline-block", marginTop: 2, fontSize: 9.5, fontWeight: 700, padding: "1px 6px", borderRadius: 999, background: st.bg, color: st.fg }}>
                        {stepLabel(p.state)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div style={sectionTitle}>{orders.length === 1 ? "Order" : "Orders"}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {orders.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className="fp-btn fp-btn-sm"
                  disabled={!onSelectOrder}
                  onClick={() => openOrder(o.id)}
                  title="Open this order"
                >
                  {o.customer} <span style={{ color: muted, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>{o.code}</span>
                  {orders.length > 1 ? ` · ${o.count}` : ""} →
                </button>
              ))}
            </div>
          </div>

          <div>
            <div style={sectionTitle}>History</div>
            {history.length === 0 ? (
              <div style={{ fontSize: 12, color: muted }}>No moves recorded for this {jobId ? "job" : "part"} yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {history.map((e: FlowEvent) => {
                  const failed = !!e.failure_reason || e.kind === "FailedPrint";
                  const to = statusStepFor(e.to_state);
                  return (
                    <div
                      key={e.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "118px 1fr",
                        gap: 10,
                        padding: "6px 8px",
                        borderRadius: 8,
                        background: failed ? "rgba(255,69,58,0.08)" : "rgba(255,255,255,0.025)",
                        opacity: e.undone ? 0.5 : 1,
                        textDecoration: e.undone ? "line-through" : undefined,
                      }}
                    >
                      <div style={{ fontSize: 11, color: muted, fontVariantNumeric: "tabular-nums" }}>{when(e.created_at)}</div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span>{e.part_name || "Part"}</span>
                          <span style={{ color: muted, fontWeight: 500 }}>
                            {e.from_state ? stepLabel(e.from_state) : "—"} →
                          </span>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 999, background: to.bg, color: to.fg }}>{stepLabel(e.to_state)}</span>
                          {failed && <span style={{ color: "#ff6961" }}>Failed · {failureText(e) || "no reason given"}</span>}
                          {e.undone && <span style={{ color: muted, fontWeight: 500 }}>(undone)</span>}
                        </div>
                        <div style={{ fontSize: 10.5, color: muted, marginTop: 1 }}>
                          {[e.action_label, e.printer_name ? `🖨 ${e.printer_name}` : "", `${e.actor_device}${e.source_surface ? ` · ${e.source_surface}` : ""}`, e.order_code ? `${e.customer_name || ""} (${e.order_code})` : ""]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {history.length > 0 && (snapshot.flow_events || []).length >= 500 && (
              <div style={{ fontSize: 10.5, color: muted, marginTop: 6 }}>Only the 500 most recent shop moves are loaded, so older steps may be missing.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
