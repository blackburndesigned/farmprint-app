import React, { useEffect, useMemo, useState } from "react";
import { actorDevice } from "../../deviceLabel";
import { getProcessSteps } from "../../settingsStore";
import { invoke } from "../../tauriInvoke";
import { isThumbnailOnlyUnit } from "../../partThumbnails";
import { notifyError } from "../../uiFeedback";
import { FilamentSwatch, Order, PartUnit, Printer, Product, ShopSnapshot, TransitionRequest } from "../../types";
import { printerOptionLabel } from "../../printerLabels";
import { CreatedCatalogProductPayload } from "../../components/ProductImportModal3D";
import { forgetOrderThumbs } from "../../orderLineThumbs";
import { KittingCardModal } from "./KittingCardModal";
import { BulkOrderConfirmModal } from "./BulkOrderConfirmModal";
import { OrderEditorSheet, useOrderEditorState } from "./OrderEditorSheet";
import { OrderDetailLineCard, OrderSummaryCard, type UnitStatusConfirm } from "./OrderDetailParts";
import { ArrowLeft, ChevronLeft, ChevronRight, Tag } from "lucide-react";
import { Icon } from "../../icons";

/**
 * Full `OrderDetailView.swift` + `OrderEditorSheet.swift` + `AssignPrinterForPrintingSheet.swift` + `KittingCardPrint.swift` 1:1 port.
 */
export const OrderModals: React.FC<{
  pendingBulkOrder: { order: Order; unfinishedUnits: PartUnit[] } | null;
  onCloseBulkOrder: () => void;
  selectedOrder: Order | null;
  onCloseSelectedOrder: () => void;
  onSelectOrder?: (orderId: string | null) => void;
  allOrders?: Order[];
  orderById: Map<string, Order>;
  productById: Map<string, Product>;
  filaments: FilamentSwatch[];
  sortedPrinters?: Printer[];
  customProducts: Record<string, CreatedCatalogProductPayload>;
  onSelectUnit: (unit: PartUnit, e: React.MouseEvent<HTMLElement>) => void;
  onRunTransition: (req: TransitionRequest) => void;
  onSnapshotUpdated?: (s: ShopSnapshot) => void;
}> = ({
  pendingBulkOrder,
  onCloseBulkOrder,
  selectedOrder,
  onCloseSelectedOrder,
  onSelectOrder,
  allOrders = [],
  orderById,
  productById,
  filaments,
  sortedPrinters = [],
  customProducts,
  onSelectUnit,
  onRunTransition,
  onSnapshotUpdated,
}) => {
  const [confirmTarget, setConfirmTarget] = useState<UnitStatusConfirm | null>(null);

  const [showEditOrder, setShowEditOrder] = useState(false);
  const [enlargedLineId, setEnlargedLineId] = useState<string | null>(null);
  const [rePoseLineId, setRePoseLineId] = useState<string | null>(null);
  useEffect(() => {
    if (!enlargedLineId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setEnlargedLineId(null); return; }
      if (e.defaultPrevented) return; // arrow keys already used to turn the focused 3D view
      const lines = selectedOrder?.lines || [];
      if (lines.length < 2 || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const i = lines.findIndex((l) => l.id === enlargedLineId);
      if (i < 0) return;
      const next = (i + (e.key === "ArrowRight" ? 1 : -1) + lines.length) % lines.length;
      setEnlargedLineId(lines[next].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enlargedLineId, selectedOrder]);
  const [showKittingCard, setShowKittingCard] = useState(false);
  const [showAssignPrinter, setShowAssignPrinter] = useState(false);
  const [assignPrinterId, setAssignPrinterId] = useState<string>(
    sortedPrinters[0]?.id || ""
  );
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const editor = useOrderEditorState(selectedOrder);
  const { editNotes, setEditNotes } = editor;

  const adjacentOrders = useMemo(() => {
    if (!selectedOrder || allOrders.length === 0) return { prev: null, next: null };
    const idx = allOrders.findIndex((o) => o.id === selectedOrder.id);
    if (idx === -1) return { prev: null, next: null };
    return {
      prev: idx > 0 ? allOrders[idx - 1] : null,
      next: idx + 1 < allOrders.length ? allOrders[idx + 1] : null,
    };
  }, [selectedOrder, allOrders]);

  const remainingQueuedUnits = useMemo(() => {
    if (!selectedOrder) return [];
    return selectedOrder.lines
      .flatMap((l) => l.units)
      .filter((u) => !isThumbnailOnlyUnit(u) && u.state === "Queued");
  }, [selectedOrder]);

  return (
    <>
      {pendingBulkOrder && (
        <BulkOrderConfirmModal pendingBulkOrder={pendingBulkOrder} onCloseBulkOrder={onCloseBulkOrder} onRunTransition={onRunTransition} />
      )}

      {selectedOrder && (
        <div className="fp-modal-backdrop" onClick={onCloseSelectedOrder}>
          <div
            className="fp-modal-window" role="dialog" aria-modal="true"
            style={{
              width: "min(880px, 94vw)",
              padding: 0,
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* OrderDetailView.swift flipChrome top toolbar (pinned above scroll area) */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                padding: "14px 18px 12px",
                borderBottom: "1px solid rgba(255,255,255,0.08)",
                background: "rgba(24,24,28,0.96)",
                flexWrap: "wrap",
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  type="button"
                  className="fp-btn fp-btn-sm"
                  onClick={onCloseSelectedOrder}
                  title="Close order details and return to Orders board"
                >
                  <Icon icon={ArrowLeft} /> Back to Orders
                </button>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 17, display: "flex", alignItems: "center", gap: 8 }}>
                    <span>{selectedOrder.customer_name}</span>
                    <span
                      className="fp-mono"
                      style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}
                    >
                      {selectedOrder.order_code}
                    </span>
                    {selectedOrder.is_rush && (
                      <span className="fp-badge fp-badge-red">RUSH</span>
                    )}
                    {selectedOrder.is_on_hold && (
                      <span className="fp-badge fp-badge-amber">ON HOLD</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>
                    {selectedOrder.customer_email || "Direct shop order"}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                {onSelectOrder && (
                  <>
                    <button
                      type="button"
                      className="fp-btn fp-btn-sm"
                      disabled={!adjacentOrders.prev}
                      title={
                        adjacentOrders.prev
                          ? `Previous order · ${adjacentOrders.prev.customer_name}`
                          : "No previous order"
                      }
                      onClick={() =>
                        adjacentOrders.prev && onSelectOrder(adjacentOrders.prev.id)
                      }
                    >
                      <Icon icon={ChevronLeft} />
                    </button>
                    <button
                      type="button"
                      className="fp-btn fp-btn-sm"
                      disabled={!adjacentOrders.next}
                      title={
                        adjacentOrders.next
                          ? `Next order · ${adjacentOrders.next.customer_name}`
                          : "No next order"
                      }
                      onClick={() =>
                        adjacentOrders.next && onSelectOrder(adjacentOrders.next.id)
                      }
                    >
                      <Icon icon={ChevronRight} />
                    </button>
                  </>
                )}

                <select
                  className="fp-select"
                  style={{ height: 28, fontSize: 12 }}
                  value=""
                  onChange={(e) => {
                    const st = e.target.value as string;
                    if (!st) return;
                    const allIds = selectedOrder.lines.flatMap((l) =>
                      l.units
                        .filter((u) => !isThumbnailOnlyUnit(u))
                        .map((u) => u.id)
                    );
                    setConfirmTarget({
                      label: `Entire Order ${selectedOrder.order_code} (${allIds.length} parts)`,
                      unitIds: allIds,
                      toState: st,
                    });
                  }}
                >
                  <option value="">Set Order Status…</option>
                  {getProcessSteps().map(({ id: st, name: stName }) => (
                    <option key={st} value={st}>
                      Move all parts to {stName}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  className="fp-btn fp-btn-sm fp-btn-primary"
                  disabled={remainingQueuedUnits.length === 0}
                  onClick={() => setShowAssignPrinter(true)}
                  title="Stage remaining In Queue units to a printer"
                >
                  Print remaining ({remainingQueuedUnits.length})
                </button>

                <button
                  type="button"
                  className="fp-btn fp-btn-sm"
                  onClick={() => setShowKittingCard(true)}
                  title="Print a 4×6 kitting card for this order"
                >
                  <Icon icon={Tag} /> Print card
                </button>

                <button
                  type="button"
                  className="fp-btn fp-btn-sm"
                  onClick={async () => {
                    const next = await invoke<ShopSnapshot>("update_order_metadata", {
                      orderId: selectedOrder.id,
                      customerName: null,
                      customerEmail: null,
                      notes: null,
                      isRush: null,
                      isOnHold: !selectedOrder.is_on_hold,
                    });
                    onSnapshotUpdated?.(next);
                  }}
                >
                  {selectedOrder.is_on_hold ? "Resume" : "Hold"}
                </button>

                <button
                  type="button"
                  className="fp-btn fp-btn-sm"
                  onClick={() => setShowEditOrder(true)}
                >
                  Edit…
                </button>

                <button
                  type="button"
                  className="fp-btn fp-btn-sm fp-btn-danger"
                  onClick={() => setShowDeleteConfirm(true)}
                >
                  Delete…
                </button>

                <button className="fp-btn fp-btn-sm" onClick={onCloseSelectedOrder}>
                  Close
                </button>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
            {/* Delete Confirmation Banner */}
            {showDeleteConfirm && (
              <div
                style={{
                  marginBottom: 14,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: "rgba(255,69,58,0.16)",
                  border: "1px solid rgba(255,69,58,0.45)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <div style={{ fontSize: 12.5 }}>
                  Delete order <strong>{selectedOrder.order_code}</strong> ({selectedOrder.customer_name})?
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="fp-btn fp-btn-sm"
                    onClick={() => setShowDeleteConfirm(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="fp-btn fp-btn-sm fp-btn-danger"
                    onClick={async () => {
                      let next: ShopSnapshot;
                      try {
                        next = await invoke<ShopSnapshot>("delete_order", {
                          orderId: selectedOrder.id,
                        });
                      } catch (e) {
                        notifyError(`Order ${selectedOrder.order_code} was not deleted`, e);
                        return;
                      }
                      forgetOrderThumbs(selectedOrder.id); // the backend removed this order's pictures
                      onSnapshotUpdated?.(next);
                      setShowDeleteConfirm(false);
                      onCloseSelectedOrder();
                    }}
                  >
                    Delete Order
                  </button>
                </div>
              </div>
            )}

            {/* AssignPrinterForPrintingSheet Banner */}
            {showAssignPrinter && (
              <div
                style={{
                  marginBottom: 14,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: "rgba(48,209,88,0.14)",
                  border: "1px solid rgba(48,209,88,0.45)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ fontSize: 12.5 }}>
                  Stage &amp; Print <strong>{remainingQueuedUnits.length} remaining part(s)</strong> on:
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <select
                    className="fp-select"
                    value={assignPrinterId}
                    onChange={(e) => setAssignPrinterId(e.target.value)}
                  >
                    {sortedPrinters.map((p) => (
                      <option key={p.id} value={p.id}>
                        {printerOptionLabel(p.name, p.model)}
                      </option>
                    ))}
                  </select>
                  <button
                    className="fp-btn fp-btn-sm fp-btn-primary"
                    onClick={() => {
                      onRunTransition({
                        unit_ids: remainingQueuedUnits.map((u) => u.id),
                        to_state: "Printing",
                        printer_id: assignPrinterId || sortedPrinters[0]?.id || null,
                        actor_device: actorDevice(),
                        source_surface: "Order Detail · Print Remaining",
                        action_label: `Print remaining (${remainingQueuedUnits.length} parts)${(() => {
                          const prn = sortedPrinters.find((p) => p.id === assignPrinterId);
                          return prn ? ` on ${prn.name}` : "";
                        })()}`,
                        failure_reason: null,
                        failure_note: null,
                      });
                      setShowAssignPrinter(false);
                    }}
                  >
                    Send to Printer
                  </button>
                  <button
                    className="fp-btn fp-btn-sm"
                    onClick={() => setShowAssignPrinter(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {confirmTarget && (
              <div
                style={{
                  marginBottom: 14,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: "rgba(10,132,255,0.14)",
                  border: "1px solid rgba(10,132,255,0.45)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <div style={{ fontSize: 12.5 }}>
                  Confirm status change: <strong>{confirmTarget.label}</strong> →{" "}
                  <strong>{confirmTarget.toState}</strong>?{" "}
                  <span style={{ color: "rgba(235,235,245,0.6)" }}>
                    (Color-only parts will not change.)
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="fp-btn fp-btn-sm"
                    onClick={() => setConfirmTarget(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className="fp-btn fp-btn-sm fp-btn-primary"
                    onClick={() => {
                      onRunTransition({
                        unit_ids: confirmTarget.unitIds,
                        to_state: confirmTarget.toState,
                        actor_device: actorDevice(),
                        source_surface: "Order Detail Workbench",
                        printer_id: null,
                        action_label: `${confirmTarget.label} → ${confirmTarget.toState}`,
                        failure_reason: null,
                        failure_note: null,
                      });
                      setConfirmTarget(null);
                    }}
                  >
                    Confirm
                  </button>
                </div>
              </div>
            )}

            {/* 1. summaryCard matching Swift OrderDetailView.swift lines 253-347 */}
            <OrderSummaryCard selectedOrder={selectedOrder} editNotes={editNotes} setEditNotes={setEditNotes} onSnapshotUpdated={onSnapshotUpdated} />

            {/* 3. Parts Section matching OrderDetailView.swift multiProductParts (208x208 composite + 108px detailPartTile grid) */}
            <div style={{ fontSize: 16, fontWeight: 700, color: "#f8fafc", marginBottom: 10 }}>
              Parts
            </div>
            {selectedOrder.lines.map((line, lineIdx) => (
              <OrderDetailLineCard
                key={line.id}
                line={line}
                lineIdx={lineIdx}
                selectedOrder={selectedOrder}
                orderById={orderById}
                productById={productById}
                filaments={filaments}
                customProducts={customProducts}
                onSelectUnit={onSelectUnit}
                setConfirmTarget={setConfirmTarget}
                enlargedLineId={enlargedLineId}
                setEnlargedLineId={setEnlargedLineId}
                rePoseLineId={rePoseLineId}
                setRePoseLineId={setRePoseLineId}
              />
            ))}
            </div>
          </div>
        </div>
      )}

      {/* OrderEditorSheet.swift Multi-Line Order Editor Modal */}
      {showEditOrder && selectedOrder && (
        <OrderEditorSheet
          selectedOrder={selectedOrder}
          editor={editor}
          productById={productById}
          filaments={filaments}
          onSnapshotUpdated={onSnapshotUpdated}
          onClose={() => setShowEditOrder(false)}
        />
      )}

      {/* KittingCardPrint.swift 4×6 Kitting Card Modal */}
      {showKittingCard && selectedOrder && (
        <KittingCardModal
          orders={[selectedOrder]}
          onClose={() => setShowKittingCard(false)}
        />
      )}
    </>
  );
};

