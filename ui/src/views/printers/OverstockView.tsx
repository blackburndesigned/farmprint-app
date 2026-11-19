import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "../../tauriInvoke";
import { OverstockItem, PartUnit, ShopSnapshot } from "../../types";
import { PartThumbnail3D } from "../../components/PartThumbnail3D";
import { csvText, notifyBanner, notifyError, saveTextFile } from "../../uiFeedback";
import { isThumbnailOnlyPart } from "../../partThumbnails";

/**
 * 1:1 port of `OverstockView.swift` + `OverstockEntrySheet.swift` + `OverstockDemand.swift`.
 */
export const OverstockView: React.FC<{
  overstock: OverstockItem[];
  snapshot?: ShopSnapshot;
  onSnapshotUpdated?: (next: ShopSnapshot) => void;
}> = ({ overstock, snapshot, onSnapshotUpdated }) => {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"nameAZ" | "nameZA" | "stockHigh" | "demandFirst">("demandFirst");
  const [needsQueueOnly, setNeedsQueueOnly] = useState(false);
  const [showAddSheet, setShowAddSheet] = useState(false);
  const [items, setItems] = useState<OverstockItem[]>(overstock);
  useEffect(() => {
    setItems(overstock);
  }, [overstock]);

  // Add Overstock Sheet state
  const products = snapshot?.products || [];
  const filaments = snapshot?.filaments || [];
  const [selProductId, setSelProductId] = useState<string>(products[0]?.id || "");
  const selProduct = products.find((p) => p.id === selProductId) || products[0];
  const printableParts = useMemo(
    () => (selProduct?.parts || []).filter((pt) => !isThumbnailOnlyPart(pt.name, selProduct)),
    [selProduct]
  );
  const [selPartId, setSelPartId] = useState<string>(printableParts[0]?.id || "");
  const [selFilamentId, setSelFilamentId] = useState<string>(filaments[0]?.id || "fil-black");
  const [addQty, setAddQty] = useState<number>(4);

  useEffect(() => {
    if (printableParts.length > 0 && !printableParts.some((pt) => pt.id === selPartId)) {
      setSelPartId(printableParts[0].id);
    }
  }, [printableParts, selPartId]);

  const waitingQueueUnits = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.orders
      .flatMap((o) => o.lines.flatMap((l) => l.units))
      .filter((u) => !isThumbnailOnlyPart(u.part_name) && (u.state === "Queued" || u.state === "Staged"));
  }, [snapshot]);

  // Waiting parts grouped by (product, part, filament) once, instead of a scan per lookup.
  const queueMatchIndex = useMemo(() => {
    const m = new Map<string, PartUnit[]>();
    for (const u of waitingQueueUnits) {
      const k = `${u.product_id}\u0000${u.part_name.toLowerCase()}\u0000${u.filament_name.toLowerCase()}`;
      const list = m.get(k);
      if (list) list.push(u);
      else m.set(k, [u]);
    }
    return m;
  }, [waitingQueueUnits]);
  const getQueueMatches = (ov: OverstockItem): PartUnit[] =>
    queueMatchIndex.get(`${ov.product_id}\u0000${ov.part_name.toLowerCase()}\u0000${ov.filament_name.toLowerCase()}`) || [];

  const handleAdjust = async (id: string, delta: number) => {
    try {
      const updated = await invoke<ShopSnapshot>("adjust_overstock", {
        overstockId: id,
        delta,
      });
      if (updated?.overstock) {
        setItems(updated.overstock);
        onSnapshotUpdated?.(updated);
      }
    } catch (e) {
      notifyError("Overstock was not updated", e);
    }
  };

  const handleExportOverstockCsv = async () => {
    // No made-up "Location" column: overstock has no bin location stored.
    const csv = csvText([
      ["Product", "Part", "Filament", "Quantity"],
      ...items.map((it) => [it.product_name, it.part_name, it.filament_name, it.quantity]),
    ]);
    try {
      const path = await saveTextFile("FarmPrint-Overstock.csv", csv);
      if (path) notifyBanner(`Saved ${items.length} overstock rows to ${path}`);
    } catch (e) {
      notifyError("The CSV was not saved", e);
    }
  };

  const filtered = useMemo(() => {
    const list = items.filter((i) => {
      if (isThumbnailOnlyPart(i.part_name)) return false;
      if (
        search.trim() &&
        !i.product_name.toLowerCase().includes(search.toLowerCase()) &&
        !i.part_name.toLowerCase().includes(search.toLowerCase()) &&
        !i.filament_name.toLowerCase().includes(search.toLowerCase())
      ) {
        return false;
      }
      if (needsQueueOnly && getQueueMatches(i).length === 0) return false;
      return true;
    });
    return list.sort((a, b) => {
      if (sortBy === "nameAZ") return a.part_name.localeCompare(b.part_name);
      if (sortBy === "nameZA") return b.part_name.localeCompare(a.part_name);
      if (sortBy === "stockHigh") return b.quantity - a.quantity;
      const da = Math.min(a.quantity, getQueueMatches(a).length);
      const db = Math.min(b.quantity, getQueueMatches(b).length);
      if (da !== db) return db - da;
      return b.quantity - a.quantity;
    });
  }, [items, search, sortBy, needsQueueOnly, queueMatchIndex]);

  const totalUnitsOnHand = useMemo(
    () => filtered.reduce((acc, i) => acc + i.quantity, 0),
    [filtered]
  );

  return (
    <div className="fp-scroll">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 14,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>Overstock</div>
          <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>
            {totalUnitsOnHand} spare parts across {filtered.length} SKUs
          </div>
        </div>
        <input
          type="text"
          placeholder="Search product, part, or color…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.14)",
            borderRadius: 8,
            padding: "6px 10px",
            color: "#fff",
            fontSize: 12.5,
            minWidth: 210,
          }}
        />
        <select
          className="fp-select"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
        >
          <option value="demandFirst">Sort: Needs queue first</option>
          <option value="stockHigh">Sort: Most stock</option>
          <option value="nameAZ">Sort: Name A–Z</option>
          <option value="nameZA">Sort: Name Z–A</option>
        </select>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={needsQueueOnly}
            onChange={(e) => setNeedsQueueOnly(e.target.checked)}
          />
          Needs queue only
        </label>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="fp-btn fp-btn-sm"
          onClick={handleExportOverstockCsv}
        >
          Export CSV
        </button>
        <button
          type="button"
          className="fp-btn fp-btn-sm fp-btn-primary"
          onClick={() => setShowAddSheet(true)}
        >
          + Add Overstock
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))",
          gap: 12,
        }}
      >
        {filtered.map((item) => {
          const matches = getQueueMatches(item);
          const fillable = Math.min(item.quantity, matches.length);
          return (
            <div
              key={item.id}
              className="fp-printer-card"
              style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
            >
              <div
                style={{
                  position: "relative",
                  width: 64,
                  height: 64,
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <PartThumbnail3D
                  partName={item.part_name}
                  productId={item.product_id}
                  colorHex={item.filament_hex}
                  size={54}
                />
                <span
                  style={{
                    position: "absolute",
                    top: 4,
                    left: 4,
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: item.filament_hex,
                    border: "1px solid rgba(255,255,255,0.7)",
                  }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 800 }}>
                  {item.part_name}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: "rgba(235,235,245,0.65)",
                    marginTop: 2,
                  }}
                >
                  {item.product_name} · {item.filament_name}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginTop: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    type="button"
                    className="fp-btn fp-btn-sm"
                    onClick={() => handleAdjust(item.id, -1)}
                  >
                    −
                  </button>
                  <span className="fp-badge fp-badge-green">
                    ×{item.quantity} in stock
                  </span>
                  <button
                    type="button"
                    className="fp-btn fp-btn-sm"
                    onClick={() => handleAdjust(item.id, 1)}
                  >
                    +
                  </button>
                  {fillable > 0 && (
                    <button
                      type="button"
                      className="fp-btn fp-btn-sm fp-btn-primary"
                      style={{ height: 22, padding: "0 8px", fontSize: 10.5 }}
                      onClick={async () => {
                        const next = await invoke<ShopSnapshot>("pull_from_overstock", {
                          overstockId: item.id,
                          unitId: matches[0].id,
                        });
                        if (next?.overstock) setItems(next.overstock);
                        onSnapshotUpdated?.(next);
                      }}
                    >
                      Pull → {matches[0].customer_name} ({fillable} fillable)
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* OverstockEntrySheet.swift Modal */}
      {showAddSheet && (
        <div className="fp-modal-backdrop" onClick={() => setShowAddSheet(false)}>
          <div
            className="fp-modal-window"
            style={{ width: "min(480px, 92vw)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="fp-modal-header">
              <div>
                <div className="fp-modal-title">Add Spare Parts to Overstock</div>
                <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>
                  Log extra printed parts so they can fulfill incoming queue orders
                </div>
              </div>
              <button
                type="button"
                className="fp-btn fp-btn-sm"
                onClick={() => setShowAddSheet(false)}
              >
                Cancel
              </button>
            </div>
            <div
              className="fp-modal-body"
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              <label style={{ fontSize: 12 }}>
                Product
                <select
                  className="fp-select"
                  style={{ width: "100%", marginTop: 4 }}
                  value={selProductId}
                  onChange={(e) => setSelProductId(e.target.value)}
                >
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ fontSize: 12 }}>
                Part
                <select
                  className="fp-select"
                  style={{ width: "100%", marginTop: 4 }}
                  value={selPartId}
                  onChange={(e) => setSelPartId(e.target.value)}
                >
                  {printableParts.map((pt) => (
                    <option key={pt.id} value={pt.id}>
                      {pt.name}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ fontSize: 12 }}>
                Filament Color
                <select
                  className="fp-select"
                  style={{ width: "100%", marginTop: 4 }}
                  value={selFilamentId}
                  onChange={(e) => setSelFilamentId(e.target.value)}
                >
                  {filaments.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} ({f.material})
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ fontSize: 12 }}>
                Quantity to Add
                <input
                  type="number"
                  min={1}
                  max={200}
                  className="fp-input"
                  style={{ width: "100%", marginTop: 4 }}
                  value={addQty}
                  onChange={(e) =>
                    setAddQty(Math.max(1, Number(e.target.value) || 1))
                  }
                />
              </label>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button
                  type="button"
                  className="fp-btn"
                  onClick={() => setShowAddSheet(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="fp-btn fp-btn-primary"
                  onClick={async () => {
                    const next = await invoke<ShopSnapshot>("add_overstock_entry", {
                      productId: selProductId,
                      partId: selPartId,
                      filamentId: selFilamentId,
                      quantity: addQty,
                    });
                    if (next?.overstock) setItems(next.overstock);
                    onSnapshotUpdated?.(next);
                    setShowAddSheet(false);
                  }}
                >
                  Add to Overstock
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
