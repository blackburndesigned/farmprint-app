import React from "react";
import { actorDevice } from "../../deviceLabel";
import { Order, PartUnit, TransitionRequest } from "../../types";

/** "Mark Entire Order Processed" confirmation: moves every unfinished part of the order to Ready. */
export const BulkOrderConfirmModal: React.FC<{
  pendingBulkOrder: { order: Order; unfinishedUnits: PartUnit[] };
  onCloseBulkOrder: () => void;
  onRunTransition: (req: TransitionRequest) => void;
}> = ({ pendingBulkOrder, onCloseBulkOrder, onRunTransition }) => (
  <div className="fp-modal-backdrop" onClick={onCloseBulkOrder}>
    <div
      className="fp-modal-window" role="dialog" aria-modal="true"
      style={{ width: "min(560px, 92vw)", padding: 18 }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>
        Mark Entire Order Processed — {pendingBulkOrder.order.order_code}
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: "rgba(235,235,245,0.68)",
          marginBottom: 12,
        }}
      >
        The following {pendingBulkOrder.unfinishedUnits.length} part(s) are
        not yet marked Ready. Confirming will transition all of them to{" "}
        <strong>Ready</strong> and record an auditable batch event in Flow:
      </div>
      <div
        style={{
          maxHeight: 200,
          overflowY: "auto",
          display: "grid",
          gap: 6,
          marginBottom: 14,
        }}
      >
        {pendingBulkOrder.unfinishedUnits.map((u) => (
          <div
            key={u.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "6px 10px",
              background: "rgba(255,255,255,0.05)",
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            <span>
              {u.part_name} ({u.filament_name})
            </span>
            <span className="fp-badge fp-badge-amber">
              {u.state} → Ready
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="fp-btn" onClick={onCloseBulkOrder}>
          Cancel
        </button>
        <button
          className="fp-btn fp-btn-green"
          onClick={() => {
            const ord = pendingBulkOrder.order;
            const ids = pendingBulkOrder.unfinishedUnits.map((u) => u.id);
            onCloseBulkOrder();
            onRunTransition({
              unit_ids: ids,
              to_state: "Ready",
              actor_device: actorDevice(),
              source_surface: "Order Processed Confirmation Modal",
              printer_id: null,
              action_label: `Bulk Processed ${ord.order_code} (${ids.length} parts → Ready)`,
              failure_reason: null,
              failure_note: null,
            });
          }}
        >
          ✓ Confirm &amp; Move {pendingBulkOrder.unfinishedUnits.length} Parts to Ready
        </button>
      </div>
    </div>
  </div>
);
