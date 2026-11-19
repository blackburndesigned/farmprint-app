import React, { useEffect, useState } from "react";
import { invoke } from "../../tauriInvoke";
import { isThumbnailOnlyUnit } from "../../partThumbnails";
import { askConfirm, notifyError } from "../../uiFeedback";
import { FilamentSwatch, Order, Product, ShopSnapshot } from "../../types";
import { forgetOrderThumbs } from "../../orderLineThumbs";

/** OrderEditorSheet state. It lives in OrderModals (not the sheet) so edits survive closing and
    reopening the sheet until the selected order changes, exactly as before the split. */
export function useOrderEditorState(selectedOrder: Order | null) {
  const [editCustomerName, setEditCustomerName] = useState("");
  const [editCustomerEmail, setEditCustomerEmail] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editIsRush, setEditIsRush] = useState(false);
  const [editIsOnHold, setEditIsOnHold] = useState(false);
  const [newLineProductId, setNewLineProductId] = useState("");
  const [newLineQty, setNewLineQty] = useState(1);
  const [newLineText, setNewLineText] = useState("");

  useEffect(() => {
    if (selectedOrder) {
      setEditCustomerName(selectedOrder.customer_name);
      setEditCustomerEmail(selectedOrder.customer_email || "");
      setEditNotes(selectedOrder.notes || "");
      setEditIsRush(selectedOrder.is_rush);
      setEditIsOnHold(selectedOrder.is_on_hold);
    }
  }, [selectedOrder]);
  return { editCustomerName, setEditCustomerName, editCustomerEmail, setEditCustomerEmail, editNotes, setEditNotes, editIsRush, setEditIsRush, editIsOnHold, setEditIsOnHold, newLineProductId, setNewLineProductId, newLineQty, setNewLineQty, newLineText, setNewLineText };
}

export type OrderEditorState = ReturnType<typeof useOrderEditorState>;

/** OrderEditorSheet.swift: multi-line order editor (customer details, lines, inscription text, part colors). */
export const OrderEditorSheet: React.FC<{
  selectedOrder: Order;
  editor: OrderEditorState;
  productById: Map<string, Product>;
  filaments: FilamentSwatch[];
  onSnapshotUpdated?: (s: ShopSnapshot) => void;
  onClose: () => void;
}> = ({ selectedOrder, editor, productById, filaments, onSnapshotUpdated, onClose }) => {
  const { editCustomerName, setEditCustomerName, editCustomerEmail, setEditCustomerEmail, editNotes, setEditNotes, editIsRush, setEditIsRush, editIsOnHold, setEditIsOnHold, newLineProductId, setNewLineProductId, newLineQty, setNewLineQty, newLineText, setNewLineText } = editor;
  return (
  <div
    className="fp-modal-backdrop"
    onClick={() => {
      // A click outside must not throw away unsaved order details.
      const dirty =
        editCustomerName !== selectedOrder.customer_name ||
        editCustomerEmail !== (selectedOrder.customer_email || "") ||
        editNotes !== (selectedOrder.notes || "") ||
        editIsRush !== selectedOrder.is_rush ||
        editIsOnHold !== selectedOrder.is_on_hold;
      if (!dirty) {
        onClose();
        return;
      }
      void askConfirm({
        title: "Discard order changes?",
        message: "Customer details, notes, Rush and On Hold changes have not been saved.",
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        danger: true,
      }).then((discard) => {
        if (discard) onClose();
      });
    }}
  >
    <div
      className="fp-modal-window" role="dialog" aria-modal="true"
      style={{ width: "min(760px, 94vw)", maxHeight: "88vh" }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="fp-modal-header">
        <div>
          <div className="fp-modal-title">
            Edit Order — {selectedOrder.order_code} ({selectedOrder.lines.length} product{" "}
            {selectedOrder.lines.length === 1 ? "line" : "lines"})
          </div>
          <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>
            Edit customer details, line items, custom inscription text, and per-part filament colors
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="fp-btn fp-btn-sm fp-btn-primary"
            onClick={async () => {
              try {
                const next = await invoke<ShopSnapshot>("update_order_metadata", {
                  orderId: selectedOrder.id,
                  customerName: editCustomerName,
                  customerEmail: editCustomerEmail,
                  notes: editNotes,
                  isRush: editIsRush,
                  isOnHold: editIsOnHold,
                });
                onSnapshotUpdated?.(next);
                onClose();
              } catch (e) {
                notifyError(`${selectedOrder.order_code} was not saved`, e);
              }
            }}
          >
            Save Order
          </button>
          <button
            type="button"
            className="fp-btn fp-btn-sm"
            onClick={() => onClose()}
          >
            Close
          </button>
        </div>
      </div>

      <div className="fp-modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            padding: 12,
            borderRadius: 10,
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <label style={{ fontSize: 12 }}>
            Customer Name
            <input
              className="fp-input"
              style={{ width: "100%", marginTop: 4 }}
              value={editCustomerName}
              onChange={(e) => setEditCustomerName(e.target.value)}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            Customer Email
            <input
              className="fp-input"
              style={{ width: "100%", marginTop: 4 }}
              value={editCustomerEmail}
              onChange={(e) => setEditCustomerEmail(e.target.value)}
            />
          </label>
          <label style={{ fontSize: 12, gridColumn: "1 / -1" }}>
            Order Notes
            <input
              className="fp-input"
              style={{ width: "100%", marginTop: 4 }}
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
            />
          </label>
          <div style={{ display: "flex", gap: 18, gridColumn: "1 / -1" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={editIsRush}
                onChange={(e) => setEditIsRush(e.target.checked)}
              />
              Rush Order
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={editIsOnHold}
                onChange={(e) => setEditIsOnHold(e.target.checked)}
              />
              On Hold
            </label>
          </div>
        </div>

        {/* Existing Lines */}
        <div style={{ fontSize: 13, fontWeight: 800 }}>
          Order Product Lines ({selectedOrder.lines.length})
        </div>
        {selectedOrder.lines.map((ln, idx) => (
          <div
            key={ln.id}
            style={{
              padding: 12,
              borderRadius: 10,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.1)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>
                Line #{idx + 1}: {ln.quantity}× {ln.product_name}
              </strong>
              {selectedOrder.lines.length > 1 && (
                <button
                  type="button"
                  className="fp-btn fp-btn-sm fp-btn-danger"
                  onClick={async () => {
                    const units = ln.units.filter((u) => !isThumbnailOnlyUnit(u));
                    const started = units.filter((u) => u.state !== "Queued").length;
                    const ok = await askConfirm({
                      title: `Remove line #${idx + 1} (${ln.quantity}× ${ln.product_name})?`,
                      message: started
                        ? `${started} of its ${units.length} parts are already staged, printing or done. They are removed from this order. This is logged in Flow.`
                        : `Its ${units.length} queued part${units.length === 1 ? "" : "s"} are removed from this order. This is logged in Flow.`,
                      confirmLabel: "Remove Line",
                      danger: true,
                    });
                    if (!ok) return;
                    try {
                      const next = await invoke<ShopSnapshot>("delete_order_line", {
                        lineId: ln.id,
                      });
                      forgetOrderThumbs(selectedOrder.id, ln.id);
                      onSnapshotUpdated?.(next);
                    } catch (e) {
                      notifyError("The line was not removed", e);
                    }
                  }}
                >
                  Remove Line
                </button>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "rgba(235,235,245,0.65)" }}>
                Custom Inscription Text:
              </span>
              <input
                className="fp-input"
                style={{ flex: 1, height: 26, fontSize: 12 }}
                placeholder="None"
                defaultValue={ln.custom_text || ""}
                onBlur={async (e) => {
                  const next = await invoke<ShopSnapshot>("update_order_line", {
                    lineId: ln.id,
                    customText: e.target.value,
                  });
                  onSnapshotUpdated?.(next);
                }}
              />
            </div>

            {/* Per-part filament selectors */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 8 }}>
              {ln.units
                .filter((u) => !isThumbnailOnlyUnit(u))
                .map((u) => (
                  <div
                    key={u.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 6,
                      padding: "6px 8px",
                      borderRadius: 8,
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.08)",
                    }}
                  >
                    <span style={{ fontSize: 11.5, fontWeight: 700 }}>
                      {u.part_name}
                    </span>
                    <select
                      className="fp-select"
                      style={{ height: 24, fontSize: 11, maxWidth: 130 }}
                      value={u.filament_id}
                      onChange={async (e) => {
                        try {
                          const next = await invoke<ShopSnapshot>("update_part_filament", {
                            unitId: u.id,
                            filamentId: e.target.value,
                            actorDevice: "Mac Studio (FarmPrint)",
                          });
                          onSnapshotUpdated?.(next);
                        } catch (err) {
                          notifyError(`Couldn't change the color of ${u.part_name}`, err);
                        }
                      }}
                    >
                      {filaments.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name} ({f.material})
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
            </div>
          </div>
        ))}

        {/* Add Product Line to Order */}
        <div
          style={{
            padding: 12,
            borderRadius: 10,
            background: "rgba(10,132,255,0.08)",
            border: "1px dashed rgba(10,132,255,0.35)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700 }}>+ Add Product Line:</span>
          <select
            className="fp-select"
            value={newLineProductId}
            onChange={(e) => setNewLineProductId(e.target.value)}
          >
            {Array.from(productById.values()).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={20}
            className="fp-input"
            style={{ width: 64, height: 28 }}
            value={newLineQty}
            onChange={(e) => setNewLineQty(Math.max(1, Number(e.target.value) || 1))}
          />
          <input
            className="fp-input"
            style={{ flex: 1, minWidth: 140, height: 28 }}
            placeholder="Optional inscription text"
            value={newLineText}
            onChange={(e) => setNewLineText(e.target.value)}
          />
          <button
            type="button"
            className="fp-btn fp-btn-sm fp-btn-primary"
            onClick={async () => {
              const next = await invoke<ShopSnapshot>("add_order_line", {
                orderId: selectedOrder.id,
                productId: newLineProductId || Array.from(productById.values())[0]?.id || "",
                quantity: newLineQty,
                customText: newLineText.trim() || null,
              });
              onSnapshotUpdated?.(next);
              setNewLineText("");
            }}
          >
            Add Line
          </button>
        </div>
      </div>
    </div>
  </div>
  );
};
