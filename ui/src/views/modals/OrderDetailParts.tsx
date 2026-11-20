import React, { Suspense } from "react";
import { getProcessSteps } from "../../settingsStore";
import { invoke } from "../../tauriInvoke";
import { isThumbnailOnlyUnit } from "../../partThumbnails";
import { isCompletedUnitState } from "../OrdersAndonViews";
import { FilamentSwatch, Order, OrderLine, PartUnit, Product, ShopSnapshot } from "../../types";
import { CreatedCatalogProductPayload } from "../../components/ProductImportModal3D";
import { fmtUsd, LineCompositeThumb, PartTileCard } from "../shared";
import { OrderLinePicture, OrderLineRePoseModal } from "../../orderLineThumbs";
import { OrderLine3DViewer } from "../../lazy3D";
import { Maximize2, PenLine } from "lucide-react";
import { Icon } from "../../icons";

/** A pending "Set Item Status" change waiting for confirmation. */
export type UnitStatusConfirm = {
  label: string;
  unitIds: string[];
  toState: string;
};

/** OrderDetailView.swift summaryCard: progress, totals and the order notes field. */
export const OrderSummaryCard: React.FC<{
  selectedOrder: Order;
  editNotes: string;
  setEditNotes: (notes: string) => void;
  onSnapshotUpdated?: (s: ShopSnapshot) => void;
}> = ({ selectedOrder, editNotes, setEditNotes, onSnapshotUpdated }) => {
  const allTracked = selectedOrder.lines
    .flatMap((l) => l.units)
    .filter((u) => !isThumbnailOnlyUnit(u));
  const doneTracked = allTracked.filter((u) => isCompletedUnitState(u.state));
  const pct = allTracked.length > 0 ? Math.round((doneTracked.length / allTracked.length) * 100) : 0;
  const leftToPrint = Math.max(0, allTracked.length - doneTracked.length);
  const totalQty = selectedOrder.lines.reduce((s, l) => s + l.quantity, 0);
  const productNamesLabel = Array.from(new Set(selectedOrder.lines.map((l) => l.product_name))).join(" · ");
  const distinctColors: { name: string; hex: string }[] = [];
  const seenColor = new Set<string>();
  for (const u of allTracked) {
    const k = `${u.filament_name}-${u.filament_hex}`;
    if (!seenColor.has(k)) {
      seenColor.add(k);
      distinctColors.push({ name: u.filament_name, hex: u.filament_hex });
    }
  }
  return (
    <>
      <div
        style={{
          padding: 18,
          borderRadius: 16,
          background: "rgba(255,255,255,0.035)",
          border: "1px solid rgba(255,255,255,0.08)",
          marginBottom: 14,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 18 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 22, fontWeight: 700, color: "#f8fafc" }}>
                {selectedOrder.customer_name}
              </span>
              <span className="fp-mono" style={{ fontSize: 13, color: "rgba(235,235,245,0.55)" }}>
                {selectedOrder.order_code}
              </span>
              {selectedOrder.is_rush && <span className="fp-badge fp-badge-red">RUSH</span>}
              {selectedOrder.is_on_hold && <span className="fp-badge fp-badge-amber">HOLD</span>}
            </div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "rgba(235,235,245,0.65)" }}>
              {productNamesLabel}
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, color: "#f8fafc", lineHeight: 1.1 }}>
              Qty {totalQty}
            </div>
            {distinctColors.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 2 }}>
                {distinctColors.slice(0, 6).map((c) => (
                  <span key={`${c.name}-${c.hex}`} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: "50%",
                        background: c.hex,
                        border: "1px solid rgba(255,255,255,0.28)",
                      }}
                    />
                    <span style={{ fontSize: 12, color: "rgba(235,235,245,0.75)" }}>{c.name}</span>
                  </span>
                ))}
              </div>
            )}
            <div style={{ fontSize: 12, color: "rgba(235,235,245,0.5)" }}>
              Placed {new Date(selectedOrder.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                padding: "4px 10px",
                borderRadius: 999,
                background: "rgba(56,189,248,0.16)",
                color: "#38bdf8",
              }}
            >
              {pct >= 100 ? "Ready to Ship" : leftToPrint < allTracked.length ? "Printing" : "Waiting"}
            </span>
            <div className="fp-mono" style={{ fontSize: 26, fontWeight: 800, color: "#f8fafc" }}>
              {pct}%
            </div>
            <div
              style={{
                width: 140,
                height: 12,
                borderRadius: 999,
                background: "rgba(255,255,255,0.09)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  borderRadius: 999,
                  background: pct >= 100 ? "#30d158" : "#0a84ff",
                }}
              />
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(235,235,245,0.6)" }}>
              {leftToPrint} left to print
            </div>
          </div>
        </div>

        <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(235,235,245,0.6)", marginBottom: 6 }}>
            Notes
          </div>
          <input
            className="fp-input"
            style={{ width: "100%", height: 30, fontSize: 12.5 }}
            placeholder="Add a note for this order…"
            value={editNotes}
            onChange={(e) => setEditNotes(e.target.value)}
            onBlur={async () => {
              if (editNotes !== (selectedOrder.notes || "")) {
                const next = await invoke<ShopSnapshot>("update_order_metadata", {
                  orderId: selectedOrder.id,
                  customerName: null,
                  customerEmail: null,
                  notes: editNotes,
                  isRush: null,
                  isOnHold: null,
                });
                onSnapshotUpdated?.(next);
              }
            }}
          />
        </div>
      </div>

      {/* 2. identityCard ("Order" metadata facts) matching OrderDetailView.swift lines 351-363 */}
      <div
        style={{
          padding: 16,
          borderRadius: 16,
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.07)",
          marginBottom: 14,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: "#f8fafc", marginBottom: 10 }}>
          Order
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(145px, 1fr))",
            gap: 12,
          }}
        >
          {[
            { label: "Code", value: selectedOrder.order_code },
            { label: "Status", value: pct >= 100 ? "Ready to Ship" : leftToPrint < allTracked.length ? "Printing" : "Waiting" },
            { label: "Units", value: `${doneTracked.length}/${allTracked.length}` },
            { label: "Products", value: `${selectedOrder.lines.length} (${totalQty} qty)` },
            { label: "Placed", value: new Date(selectedOrder.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) },
            { label: "Source", value: selectedOrder.source || "website" },
            { label: "Cost", value: fmtUsd(selectedOrder.estimated_cost_cents) },
            { label: "Price", value: fmtUsd(selectedOrder.total_revenue_cents) },
          ].map((f) => (
            <div key={f.label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 11, color: "rgba(235,235,245,0.5)" }}>{f.label}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#f8fafc" }}>{f.value}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
};

/** OrderDetailView.swift multiProductParts: one product line (picture, status menu, part tiles). */
export const OrderDetailLineCard: React.FC<{
  line: OrderLine;
  lineIdx: number;
  selectedOrder: Order;
  orderById: Map<string, Order>;
  productById: Map<string, Product>;
  filaments: FilamentSwatch[];
  customProducts: Record<string, CreatedCatalogProductPayload>;
  onSelectUnit: (unit: PartUnit, e: React.MouseEvent<HTMLElement>) => void;
  setConfirmTarget: (t: UnitStatusConfirm | null) => void;
  enlargedLineId: string | null;
  setEnlargedLineId: (id: string | null) => void;
  rePoseLineId: string | null;
  setRePoseLineId: (id: string | null) => void;
}> = ({
  line,
  lineIdx,
  selectedOrder,
  orderById,
  productById,
  filaments,
  customProducts,
  onSelectUnit,
  setConfirmTarget,
  enlargedLineId,
  setEnlargedLineId,
  rePoseLineId,
  setRePoseLineId,
}) => {
  const trackedUnits = line.units.filter((u) => !isThumbnailOnlyUnit(u));
  return (
    <div
      style={{
        padding: 18,
        borderRadius: 16,
        background: "rgba(255,255,255,0.035)",
        border: "1px solid rgba(255,255,255,0.08)",
        marginBottom: 14,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: "#f8fafc" }}>
            {line.product_name}
          </span>
          {line.custom_text && (
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: "3px 9px",
                borderRadius: 999,
                background: "rgba(255,159,10,0.18)",
                color: "#ff9f0a",
              }}
            >
              <Icon icon={PenLine} size={12} /> “{line.custom_text}”
            </span>
          )}
          <span style={{ fontSize: 12, fontWeight: 600, color: "rgba(235,235,245,0.6)" }}>
            Qty {line.quantity}
          </span>
          {selectedOrder.lines.length > 1 && (
            <span style={{ fontSize: 11, color: "rgba(235,235,245,0.45)" }}>
              {lineIdx + 1} of {selectedOrder.lines.length}
            </span>
          )}
        </div>
        <select
          className="fp-select"
          value=""
          onChange={(e) => {
            const st = e.target.value as string;
            if (!st) return;
            setConfirmTarget({
              label: `${line.quantity}× ${line.product_name} (${trackedUnits.length} parts)`,
              unitIds: trackedUnits.map((u) => u.id),
              toState: st,
            });
          }}
        >
          <option value="">Set Item Status…</option>
          {getProcessSteps().map(({ id: st, name: stName }) => (
            <option key={st} value={st}>
              Move item parts to {stName}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
        <button
          type="button"
          aria-label={`Show a large picture of ${line.product_name}`}
          title="Click to show a large picture"
          onClick={() => setEnlargedLineId(line.id)}
          style={{
            all: "unset",
            cursor: "zoom-in",
            position: "relative",
            width: 208,
            height: 208,
            borderRadius: 14,
            overflow: "hidden",
            flexShrink: 0,
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <OrderLinePicture
            order={selectedOrder}
            line={line}
            product={productById.get(line.product_id)}
            filaments={filaments}
            size={208}
            framed
            fallback={
              <LineCompositeThumb
                line={line}
                product={productById.get(line.product_id)}
                filaments={filaments}
                customPayload={customProducts[line.product_id]}
                size={208}
              />
            }
          />
          <span style={{ position: "absolute", right: 8, bottom: 8, padding: "3px 8px", borderRadius: 999, background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 11, fontWeight: 600 }}>
            <Icon icon={Maximize2} size={12} /> Enlarge
          </span>
        </button>
        {productById.get(line.product_id) && (
          <button
            type="button"
            className="fp-btn fp-btn-sm"
            title="Turn the 3D model and save this item's picture from that angle"
            onClick={() => setRePoseLineId(line.id)}
            style={{ alignSelf: "flex-end" }}
          >
            Re-pose
          </button>
        )}
        {rePoseLineId === line.id && productById.get(line.product_id) && (
          <OrderLineRePoseModal
            order={selectedOrder}
            line={line}
            product={productById.get(line.product_id)!}
            filaments={filaments}
            onClose={() => setRePoseLineId(null)}
          />
        )}
        {enlargedLineId === line.id && (() => {
          const big = Math.max(240, Math.min(820, Math.round(Math.min(window.innerWidth * 0.82, window.innerHeight * 0.82 - 150))));
          const lineCount = selectedOrder.lines.length;
          const go = (delta: number) => setEnlargedLineId(selectedOrder.lines[(lineIdx + delta + lineCount) % lineCount].id);
          // Customer-facing list: picture-only parts stay in the image but never in the names.
          const colorRows: Array<{ part: string; color: string; hex: string; qty: number }> = [];
          for (const u of line.units) {
            if (isThumbnailOnlyUnit(u)) continue;
            const hit = colorRows.find((r) => r.part === u.part_name && r.color === u.filament_name);
            if (hit) hit.qty += 1;
            else colorRows.push({ part: u.part_name, color: u.filament_name, hex: u.filament_hex, qty: 1 });
          }
          const arrowBtn: React.CSSProperties = { width: 44, height: 44, borderRadius: 22, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.1)", color: "#fff", fontSize: 22, cursor: "pointer", flexShrink: 0 };
          const picture = (
            <OrderLinePicture
              order={selectedOrder}
              line={line}
              product={productById.get(line.product_id)}
              filaments={filaments}
              size={big}
              fallback={
                <LineCompositeThumb
                  line={line}
                  product={productById.get(line.product_id)}
                  filaments={filaments}
                  customPayload={customProducts[line.product_id]}
                  size={big}
                />
              }
            />
          );
          return (
            <div className="fp-modal-backdrop" onClick={() => setEnlargedLineId(null)}
              style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.78)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div onClick={(e) => e.stopPropagation()}
                style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: 20, borderRadius: 18, background: "#1c1c1e", border: "1px solid rgba(255,255,255,0.12)" }}>
                <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#f8fafc" }}>{line.product_name}</div>
                    <div style={{ fontSize: 13, color: "rgba(235,235,245,0.7)" }}>
                      {selectedOrder.customer_name}{line.custom_text ? ` · “${line.custom_text}”` : ""}
                    </div>
                  </div>
                  <button type="button" onClick={() => setEnlargedLineId(null)}
                    style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.08)", color: "#fff", cursor: "pointer", fontWeight: 600 }}>
                    Close
                  </button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  {lineCount > 1 && <button type="button" aria-label="Previous item" style={arrowBtn} onClick={() => go(-1)}>‹</button>}
                  <div style={{ width: big, height: big, borderRadius: 14, overflow: "hidden", background: "#ffffff" }}>
                    {/* Turnable read-only 3D view; the saved picture is the fallback (no 3D model / loading). */}
                    <Suspense fallback={picture}>
                      <OrderLine3DViewer
                        key={line.id}
                        order={selectedOrder}
                        line={line}
                        product={productById.get(line.product_id)}
                        filaments={filaments}
                        size={big}
                        fallback={picture}
                      />
                    </Suspense>
                  </div>
                  {lineCount > 1 && <button type="button" aria-label="Next item" style={arrowBtn} onClick={() => go(1)}>›</button>}
                </div>
                {lineCount > 1 && <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>Item {lineIdx + 1} of {lineCount}</div>}
                {colorRows.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "8px 18px", maxWidth: big + 120 }}>
                    {colorRows.map((r) => (
                      <span key={`${r.part}::${r.color}`} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 14, color: "#f8fafc" }}>
                        <span style={{ width: 14, height: 14, borderRadius: 7, background: r.hex, border: "1px solid rgba(255,255,255,0.5)" }} />
                        <b style={{ fontWeight: 700 }}>{r.part}{r.qty > 1 ? ` ×${r.qty}` : ""}</b>
                        <span style={{ color: "rgba(235,235,245,0.75)" }}>{r.color}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}
        <div style={{ flex: 1, minWidth: 260, display: "flex", flexWrap: "wrap", gap: 10 }}>
          {trackedUnits.map((u) => (
            <PartTileCard
              key={u.id}
              unit={u}
              order={orderById.get(u.order_id)}
              onSelectUnit={onSelectUnit}
            />
          ))}
        </div>
      </div>
    </div>
  );
};
