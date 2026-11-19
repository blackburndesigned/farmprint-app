import React, { useMemo, useState } from "react";
import { actorDevice } from "../../deviceLabel";
import { ImportNotesBanner, importNoteCount, recordImportNotes, useImportNotes } from "../../storeImportNotes";
import { getProcessSteps, getShopSettings } from "../../settingsStore";
import { invoke } from "../../tauriInvoke";
import { Order, PartUnit, Printer, Product, ShopSnapshot, TransitionRequest } from "../../types";
import { isThumbnailOnlyUnit } from "../../partThumbnails";
import { forgetOrderThumbs } from "../../orderLineThumbs";
import { notifyError } from "../../uiFeedback";
import { LazyMount } from "../../components/LazyMount";
import { StatusLegendHeader } from "./StatusLegendHeader";
import { ShopOrderCard } from "./ShopOrderCard";
import { type AttentionRow, type DismissedAttentionRow, NeedsAttentionSheet } from "./NeedsAttentionSheet";
import { PrintPickTray } from "./PrintPickTray";
import { SampleShopEmptyState } from "../../components/SampleShop";

/**
 * Full `OrdersListView.swift` + `OrderProductFolderCanvas.swift` + `PrintPickTray.swift` + `NeedsAttentionSheet.swift` 1:1 port.
 */
export const AllOrdersBoardView: React.FC<{
  activeOrders: Order[];
  products?: Product[];
  printers?: Printer[];
  selectedOrderId: string | null;
  onSelectOrder: (orderId: string | null) => void;
  onSelectUnit: (unit: PartUnit, e: React.MouseEvent<HTMLElement>) => void;
  onRunTransition?: (req: TransitionRequest) => void;
  onTriggerProcessed?: (order: Order) => void;
  onOpenNewOrderModal?: () => void;
  onSnapshotUpdated?: (s: ShopSnapshot) => void;
  onFlashBanner?: (msg: string) => void;
  onPrintKittingCards?: (orders: Order[]) => void;
}> = ({
  activeOrders,
  products = [],
  printers = [],
  selectedOrderId,
  onSelectOrder,
  onSelectUnit,
  onRunTransition,
  onTriggerProcessed,
  onOpenNewOrderModal,
  onSnapshotUpdated,
  onFlashBanner,
  onPrintKittingCards,
}) => {
  const [boardDensity, setBoardDensity] = useState<"stamps" | "small" | "medium" | "large">("medium");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [personFilter, setPersonFilter] = useState<string>("ALL");
  const [holdFilter, setHoldFilter] = useState<"ALL" | "HOLD">("ALL");
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "customerAZ" | "rushFirst" | "completion">("newest");

  // Multi-select orders (OrdersListView.swift selectedOrderIds)
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());

  // Multi-product folder view (OrderProductFolderCanvas.swift)
  const [folderOrderId, setFolderOrderId] = useState<string | null>(null);

  // Pick Parts to Print Tray (PrintPickTray.swift)
  const [pickTrayOpen, setPickTrayOpen] = useState(false);
  const [pickedUnitIds, setPickedUnitIds] = useState<Set<string>>(new Set());
  const [pickPrinterId, setPickPrinterId] = useState<string>(printers[0]?.id || "");

  // Website order ingest (import_store_orders): read-only pull from the shop, local dedupe.
  const [importingWebOrders, setImportingWebOrders] = useState(false);
  const importWebsiteOrders = async () => {
    if (importingWebOrders) return;
    setImportingWebOrders(true);
    try {
      const res = await invoke<{
        connected: boolean; signed_in?: boolean; message?: string; imported?: number; duplicates?: number;
        skipped_orders?: number; skipped_lines?: number; warnings?: string[]; snapshot?: ShopSnapshot;
        claimed_elsewhere?: number; claim_errors?: number; claimed_not_saved?: string[];
      }>("import_store_orders", {});
      if (!res?.connected) {
        onFlashBanner?.(res?.message || "No shop connected.");
        return;
      }
      if (res.signed_in === false || (res as { offline?: boolean }).offline) {
        onFlashBanner?.(res.message || "Sign in to the shop to import orders");
        return;
      }
      if (res.snapshot) onSnapshotUpdated?.(res.snapshot);
      recordImportNotes(res.warnings, res.claimed_not_saved);
      const n = res.imported || 0;
      const extra: string[] = [];
      if (res.skipped_orders) extra.push(`${res.skipped_orders} skipped`);
      if (res.skipped_lines) extra.push(`${res.skipped_lines} item${res.skipped_lines === 1 ? "" : "s"} skipped`);
      if (res.claimed_elsewhere) extra.push(`${res.claimed_elsewhere} taken by another device`);
      if (res.claim_errors) extra.push(`${res.claim_errors} couldn't reach the shop, will retry`);
      const notSaved = res.claimed_not_saved || [];
      if (notSaved.length) {
        console.error(`[store ingest] CLAIMED ON THE SHOP BUT NOT SAVED LOCALLY: ${notSaved.join(", ")}`);
        onFlashBanner?.(
          `⚠️ ${notSaved.length} website order${notSaved.length === 1 ? " was" : "s were"} claimed on the shop but NOT saved here: ${notSaved.join(", ")}. Add ${notSaved.length === 1 ? "it" : "them"} by hand.`
            + (n > 0 ? ` Imported ${n} other${n === 1 ? "" : "s"}.` : "")
        );
        return;
      }
      // Orders left on the shop (unmapped product/option) name their BD- number; show them.
      const held = (res.warnings || []).filter((w) => w.includes("left on the shop"));
      onFlashBanner?.(
        (n > 0 ? `Imported ${n} website order${n === 1 ? "" : "s"}` : "No new website orders")
          + (extra.length ? ` (${extra.join(", ")})` : "")
          + (held.length ? `. ⚠️ ${held.join(" ")}` : "")
      );
    } catch (err) {
      onFlashBanner?.(`Website import failed: ${String(err)}`);
    } finally {
      setImportingWebOrders(false);
    }
  };

  // Needs Attention Sheet (NeedsAttentionSheet.swift)
  const [showNeedsAttention, setShowNeedsAttention] = useState(false);
  const [attentionRows, setAttentionRows] = useState<AttentionRow[]>([]);
  const [dismissedRows, setDismissedRows] = useState<DismissedAttentionRow[]>([]);
  const [showDismissedGroup, setShowDismissedGroup] = useState(false);
  const importNotes = useImportNotes();

  const customerNames = useMemo(
    () => Array.from(new Set(activeOrders.map((o) => o.customer_name))).sort((a, b) => a.localeCompare(b)),
    [activeOrders]
  );

  const filteredOrders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = activeOrders.filter((o) => {
      if (q && !o.customer_name.toLowerCase().includes(q) && !o.order_code.toLowerCase().includes(q)) {
        return false;
      }
      if (personFilter !== "ALL" && o.customer_name !== personFilter) return false;
      if (holdFilter === "HOLD" && !o.is_on_hold) return false;
      if (statusFilter !== "ALL") {
        const units = o.lines.flatMap((l) => l.units).filter((u) => !isThumbnailOnlyUnit(u));
        if (!units.some((u) => u.state === statusFilter)) return false;
      }
      return true;
    });

    return [...filtered].sort((a, b) => {
      if (sortBy === "customerAZ") return a.customer_name.localeCompare(b.customer_name);
      if (sortBy === "rushFirst") {
        if (a.is_rush !== b.is_rush) return a.is_rush ? -1 : 1;
        return b.created_at.localeCompare(a.created_at);
      }
      if (sortBy === "completion") return b.progress_pct - a.progress_pct;
      if (sortBy === "oldest") return a.created_at.localeCompare(b.created_at);
      return b.created_at.localeCompare(a.created_at);
    });
  }, [activeOrders, searchQuery, personFilter, holdFilter, statusFilter, sortBy]);

  const cardWidth =
    boardDensity === "large"
      ? 324
      : boardDensity === "medium"
      ? 284
      : boardDensity === "small"
      ? 244
      : 204;
  const compositeSide = cardWidth - 28;

  const folderOrder = useMemo(
    () => activeOrders.find((o) => o.id === folderOrderId) || null,
    [activeOrders, folderOrderId]
  );

  const allQueuedUnits = useMemo(
    () =>
      activeOrders.flatMap((o) =>
        o.lines.flatMap((l) =>
          l.units.filter((u) => !isThumbnailOnlyUnit(u) && u.state === "Queued")
        )
      ),
    [activeOrders]
  );

  const toggleSelectOrder = (orderId: string) => {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  const [pendingDeleteOrder, setPendingDeleteOrder] = useState<Order | null>(null);
  const handleCardContextAction = async (
    order: Order,
    action: "stage" | "processed" | "details" | "kitting" | "hold" | "delete"
  ) => {
    if (action === "details") {
      onSelectOrder(order.id);
      return;
    }
    if (action === "delete") {
      setPendingDeleteOrder(order);
      return;
    }
    if (action === "kitting") {
      onPrintKittingCards?.([order]);
      return;
    }
    if (action === "hold") {
      try {
        const updated = await invoke<ShopSnapshot>("update_order_metadata", {
          orderId: order.id,
          customerName: null,
          customerEmail: null,
          notes: null,
          isRush: null,
          isOnHold: !order.is_on_hold,
        });
        onSnapshotUpdated?.(updated);
        onFlashBanner?.(
          `${order.customer_name} ${!order.is_on_hold ? "placed on hold" : "resumed"}`
        );
      } catch (e) {
        notifyError(`Couldn't ${order.is_on_hold ? "resume" : "hold"} ${order.customer_name}'s order`, e);
      }
      return;
    }
    if (action === "processed") {
      onTriggerProcessed?.(order);
      return;
    }
    if (action === "stage") {
      const queuedIds = order.lines
        .flatMap((l) => l.units)
        .filter((u) => !isThumbnailOnlyUnit(u) && u.state === "Queued")
        .map((u) => u.id);
      if (queuedIds.length === 0) {
        onFlashBanner?.("No queued parts remaining on this order");
        return;
      }
      onRunTransition?.({
        unit_ids: queuedIds,
        to_state: "Printing",
        printer_id: printers[0]?.id ?? null,
        actor_device: "Mac Studio (FarmPrint)",
        source_surface: "Orders Board · Stage & Print",
        action_label: `Print ${queuedIds.length} queued parts for ${order.customer_name}`,
        failure_reason: null,
        failure_note: null,
      });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* OrdersListView Filter Bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "8px 18px 4px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <input
            className="fp-input"
            style={{ width: 210, height: 28, fontSize: 12.5 }}
            placeholder="Search by customer name…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <select
            className="fp-select"
            style={{ height: 28, fontSize: 12 }}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="ALL">All Statuses</option>
            {getProcessSteps().map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <select
            className="fp-select"
            style={{ height: 28, fontSize: 12 }}
            value={personFilter}
            onChange={(e) => setPersonFilter(e.target.value)}
          >
            <option value="ALL">All People</option>
            {customerNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

          <select
            className="fp-select"
            style={{ height: 28, fontSize: 12 }}
            value={holdFilter}
            onChange={(e) => setHoldFilter(e.target.value as "ALL" | "HOLD")}
          >
            <option value="ALL">All orders</option>
            <option value="HOLD">On hold</option>
          </select>

          <select
            className="fp-select"
            style={{ height: 28, fontSize: 12 }}
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="customerAZ">Customer A–Z</option>
            <option value="rushFirst">Rush first</option>
            <option value="completion">Most complete</option>
          </select>

          {/* GridLayoutControls (Stamps / Small / Medium / Large) */}
          <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {(["stamps", "small", "medium", "large"] as const).map((d) => (
              <button
                key={d}
                type="button"
                className={`fp-btn fp-btn-sm ${boardDensity === d ? "fp-btn-primary" : ""}`}
                onClick={() => setBoardDensity(d)}
                style={{ textTransform: "capitalize" }}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        {/* Trailing toolbar or Multi-select toolbar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {selectedOrderIds.size > 0 ? (
            <>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#64d2ff" }}>
                {selectedOrderIds.size} selected
              </span>
              <select
                className="fp-select"
                style={{ height: 26, fontSize: 11.5 }}
                value=""
                onChange={(e) => {
                  const st = e.target.value;
                  if (!st) return;
                  const ids = activeOrders
                    .filter((o) => selectedOrderIds.has(o.id))
                    .flatMap((o) => o.lines.flatMap((l) => l.units))
                    .filter((u) => !isThumbnailOnlyUnit(u))
                    .map((u) => u.id);
                  onRunTransition?.({
                    unit_ids: ids,
                    to_state: st,
                    printer_id: null,
                    actor_device: actorDevice(),
                    source_surface: "Orders Multi-Select",
                    action_label: `Updated ${selectedOrderIds.size} order(s) → ${st}`,
                    failure_reason: null,
                    failure_note: null,
                  });
                  setSelectedOrderIds(new Set());
                }}
              >
                <option value="">Set status…</option>
                {getProcessSteps().map((s) => (
                  <option key={s.id} value={s.id}>
                    Set all to {s.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="fp-btn fp-btn-sm"
                onClick={() => {
                  const chosen = activeOrders.filter((o) => selectedOrderIds.has(o.id));
                  onPrintKittingCards?.(chosen);
                }}
              >
                🏷️ Print Cards ({selectedOrderIds.size})
              </button>
              <button
                type="button"
                className="fp-btn fp-btn-sm"
                onClick={() => setSelectedOrderIds(new Set())}
              >
                Clear
              </button>
            </>
          ) : (
            <>
              <span style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>
                {filteredOrders.length} of {activeOrders.length}
              </span>
              <button
                type="button"
                className="fp-btn fp-btn-sm"
                onClick={importWebsiteOrders}
                disabled={importingWebOrders}
                title="Bring in new paid orders from the website (claims each one on the shop first, unless turned off in Settings › Store)"
              >
                {importingWebOrders ? "Importing…" : "⬇️ Import Website Orders"}
              </button>
              <button
                type="button"
                className="fp-btn fp-btn-sm"
                onClick={() => setShowNeedsAttention(true)}
                title="Paid website orders that need product matching or review"
              >
                ⚠️ Needs Attention ({attentionRows.length + importNoteCount(importNotes)})
              </button>
              <button
                type="button"
                className={`fp-btn fp-btn-sm ${pickTrayOpen ? "fp-btn-primary" : ""}`}
                onClick={() => setPickTrayOpen((v) => !v)}
                title="Build a mixed plate from In Queue parts"
              >
                🧊 Pick Parts to Print
                {pickedUnitIds.size > 0 ? ` (${pickedUnitIds.size})` : ""}
              </button>
              {onOpenNewOrderModal && (
                <button
                  type="button"
                  className="fp-btn fp-btn-sm fp-btn-primary"
                  onClick={onOpenNewOrderModal}
                >
                  + New Order
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <StatusLegendHeader />
      <div style={{ margin: "0 18px" }}><ImportNotesBanner /></div>

      {/* Folder Canvas Banner when viewing a multi-product order folder (OrderProductFolderCanvas.swift) */}
      {folderOrder && (
        <div
          style={{
            margin: "4px 18px 8px",
            padding: "12px 16px",
            borderRadius: 12,
            background: "rgba(10, 132, 255, 0.12)",
            border: "1.5px solid rgba(100, 210, 255, 0.38)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <div>
              <div style={{ fontSize: 14.5, fontWeight: 800 }}>
                📁 {folderOrder.customer_name} · {folderOrder.order_code} ({folderOrder.lines.length} product lines)
              </div>
              <div style={{ fontSize: 11.5, color: "rgba(235,235,245,0.68)" }}>
                Individual product cards inside this order · Click any line card to open Order Detail
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="fp-btn fp-btn-sm"
                onClick={() => onPrintKittingCards?.([folderOrder])}
              >
                🏷️ Print 4×6 Kitting Card
              </button>
              <button
                type="button"
                className="fp-btn fp-btn-sm fp-btn-primary"
                onClick={() => setFolderOrderId(null)}
              >
                Close Folder
              </button>
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {folderOrder.lines.map((ln) => (
              <ShopOrderCard
                key={ln.id}
                order={folderOrder}
                line={ln}
                cardWidth={256}
                compositeSide={228}
                partColumns={(getShopSettings().part_grid_preferred_columns === 4 ? 4 : 3)}
                onOpenOrder={(id) => onSelectOrder(id)}
                onSelectUnit={onSelectUnit}
              />
            ))}
          </div>
        </div>
      )}

      {/* Main Orders Content + Optional PrintPickTray Side Drawer */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
        <div className="fp-scroll" style={{ flex: 1, padding: "8px 18px 88px" }}>
          {activeOrders.length === 0 && products.length === 0 && onSnapshotUpdated && (
            <SampleShopEmptyState onSnapshotUpdated={onSnapshotUpdated} onOpenNewOrderModal={onOpenNewOrderModal} />
          )}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))`,
              gap: 14,
              alignItems: "start",
              width: "100%",
            }}
          >
            {filteredOrders.map((order, idx) => (
              <LazyMount key={order.id} estimate={Math.round(cardWidth * 1.55)} eager={idx < 12}>
              <ShopOrderCard
                order={order}
                fullWidth={true}
                cardWidth={cardWidth}
                compositeSide={compositeSide}
                partColumns={boardDensity === "stamps" ? 4 : (getShopSettings().part_grid_preferred_columns === 4 ? 4 : 3)}
                selected={selectedOrderIds.has(order.id)}
                onToggleSelect={(id) => toggleSelectOrder(id)}
                onOpenOrder={(id) => onSelectOrder(selectedOrderId === id ? null : id)}
                onOpenFolder={(id) =>
                  setFolderOrderId((prev) => (prev === id ? null : id))
                }
                onSelectUnit={onSelectUnit}
                onContextAction={handleCardContextAction}
                onUnitTransition={(req) =>
                  onRunTransition?.({
                    ...req,
                    printer_id:
                      req.printer_id ??
                      (req.to_state === "Staged" || req.to_state === "Printing"
                        ? printers[0]?.id ?? null
                        : null),
                  })
                }
              />
              </LazyMount>
            ))}
          </div>
        </div>

        {pendingDeleteOrder && (
          <div style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div className="fp-card" style={{ width: 420, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>Delete order for {pendingDeleteOrder.customer_name}?</div>
              <div style={{ fontSize: 13, color: "rgba(235,235,245,0.7)" }}>
                This removes the order and all of its part units. This cannot be undone.
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="fp-btn" onClick={() => setPendingDeleteOrder(null)}>Cancel</button>
                <button
                  type="button"
                  className="fp-btn fp-btn-danger"
                  onClick={async () => {
                    const target = pendingDeleteOrder;
                    setPendingDeleteOrder(null);
                    try {
                      const updated = await invoke<ShopSnapshot>("delete_order", { orderId: target.id });
                      forgetOrderThumbs(target.id); // the backend removed this order's pictures
                      onSnapshotUpdated?.(updated);
                      if (selectedOrderId === target.id) onSelectOrder(null);
                      onFlashBanner?.(`Deleted order for ${target.customer_name}`);
                    } catch (err) {
                      onFlashBanner?.(`Delete failed: ${String(err)}`);
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {/* PrintPickTray.swift Side Drawer */}
        {pickTrayOpen && (
          <PrintPickTray
            pickedUnitIds={pickedUnitIds}
            setPickTrayOpen={setPickTrayOpen}
            allQueuedUnits={allQueuedUnits}
            setPickedUnitIds={setPickedUnitIds}
            pickPrinterId={pickPrinterId}
            setPickPrinterId={setPickPrinterId}
            printers={printers}
            onRunTransition={onRunTransition}
          />
        )}
      </div>

      {/* NeedsAttentionSheet.swift Modal */}
      {showNeedsAttention && (
        <NeedsAttentionSheet
          setShowNeedsAttention={setShowNeedsAttention}
          attentionRows={attentionRows}
          products={products}
          setAttentionRows={setAttentionRows}
          onSnapshotUpdated={onSnapshotUpdated}
          setDismissedRows={setDismissedRows}
          setShowDismissedGroup={setShowDismissedGroup}
          showDismissedGroup={showDismissedGroup}
          dismissedRows={dismissedRows}
        />
      )}
    </div>
  );
};
