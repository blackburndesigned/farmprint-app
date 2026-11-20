import React from "react";
import { ImportNotesBanner } from "../../storeImportNotes";
import { invoke } from "../../tauriInvoke";
import { Product, ShopSnapshot } from "../../types";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { Icon } from "../../icons";

export interface AttentionRow {
  id: string;
  customerName: string;
  amountText: string;
  whenText: string;
  rawSku: string;
  reasonText: string;
  matchedProductId?: string;
}

export interface DismissedAttentionRow extends AttentionRow {
  dismissReason: string;
}

/** NeedsAttentionSheet.swift: website-import rows that need a person, plus the dismissed group. */
export const NeedsAttentionSheet: React.FC<{
  setShowNeedsAttention: React.Dispatch<React.SetStateAction<boolean>>;
  attentionRows: AttentionRow[];
  products: Product[];
  setAttentionRows: React.Dispatch<React.SetStateAction<AttentionRow[]>>;
  onSnapshotUpdated?: (s: ShopSnapshot) => void;
  setDismissedRows: React.Dispatch<React.SetStateAction<DismissedAttentionRow[]>>;
  setShowDismissedGroup: React.Dispatch<React.SetStateAction<boolean>>;
  showDismissedGroup: boolean;
  dismissedRows: DismissedAttentionRow[];
}> = ({ setShowNeedsAttention, attentionRows, products, setAttentionRows, onSnapshotUpdated, setDismissedRows, setShowDismissedGroup, showDismissedGroup, dismissedRows }) => (
  <div className="fp-modal-backdrop" onClick={() => setShowNeedsAttention(false)}>
    <div
      className="fp-modal-window"
      style={{ width: "min(620px, 92vw)", maxHeight: "84vh" }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="fp-modal-header">
        <div>
          <div className="fp-modal-title">Needs Attention</div>
          <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>
            Paid shop orders that need a product match or decision show up here.
          </div>
        </div>
        <button
          type="button"
          className="fp-btn fp-btn-sm fp-btn-primary"
          onClick={() => setShowNeedsAttention(false)}
        >
          Done
        </button>
      </div>
      <div className="fp-modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <ImportNotesBanner inline />
        {attentionRows.length === 0 ? (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              borderRadius: 10,
              background: "rgba(255,255,255,0.03)",
              border: "1px dashed rgba(255,255,255,0.12)",
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <Icon icon={Check} /> Nothing waiting
            </div>
            <div style={{ fontSize: 12.5, color: "rgba(235,235,245,0.6)" }}>
              All paid website orders are matched to catalog products.
            </div>
          </div>
        ) : (
          attentionRows.map((item) => (
            <div
              key={item.id}
              style={{
                padding: 12,
                borderRadius: 10,
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <strong>{item.customerName}</strong>
                <span className="fp-mono">{item.amountText}</span>
              </div>
              <div style={{ fontSize: 12, color: "rgba(235,235,245,0.65)" }}>
                {item.reasonText} · SKU: {item.rawSku}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  className="fp-select"
                  value={item.matchedProductId || products[0]?.id || ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    setAttentionRows((prev) =>
                      prev.map((r) =>
                        r.id === item.id ? { ...r, matchedProductId: val } : r
                      )
                    );
                  }}
                >
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      Match to: {p.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="fp-btn fp-btn-sm fp-btn-primary"
                  onClick={async () => {
                    const next = await invoke<ShopSnapshot>("create_order", {
                      input: {
                        customer_name: item.customerName,
                        customer_email: "",
                        product_id: item.matchedProductId || products[0]?.id || "",
                        quantity: 1,
                        is_rush: false,
                        custom_text: null,
                      },
                    });
                    onSnapshotUpdated?.(next);
                    setAttentionRows((prev) => prev.filter((r) => r.id !== item.id));
                  }}
                >
                  Match &amp; Import
                </button>
                <select
                  className="fp-select"
                  value=""
                  onChange={(e) => {
                    const reason = e.target.value;
                    if (!reason) return;
                    setDismissedRows((prev) => [
                      { ...item, dismissReason: reason },
                      ...prev,
                    ]);
                    setAttentionRows((prev) => prev.filter((r) => r.id !== item.id));
                  }}
                >
                  <option value="">Dismiss…</option>
                  <option value="Refunded in Stripe">Refunded in Stripe</option>
                  <option value="Duplicate">Duplicate</option>
                  <option value="Test order">Test order</option>
                  <option value="Handled by hand">Handled by hand</option>
                </select>
              </div>
            </div>
          ))
        )}

        <div
          style={{
            borderTop: "1px solid rgba(255,255,255,0.08)",
            paddingTop: 10,
          }}
        >
          <button
            type="button"
            className="fp-btn fp-btn-sm"
            onClick={() => setShowDismissedGroup((v) => !v)}
          >
            <Icon icon={showDismissedGroup ? ChevronDown : ChevronRight} size={14} /> Dismissed ({dismissedRows.length})
          </button>
          {showDismissedGroup && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              {dismissedRows.length === 0 ? (
                <div style={{ fontSize: 12, color: "rgba(235,235,245,0.5)" }}>
                  None in the last 30 days.
                </div>
              ) : (
                dismissedRows.map((row) => (
                  <div
                    key={row.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "6px 10px",
                      borderRadius: 8,
                      background: "rgba(255,255,255,0.03)",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 12.5, fontWeight: 700 }}>
                        {row.customerName}
                      </div>
                      <div style={{ fontSize: 11, color: "rgba(235,235,245,0.55)" }}>
                        {row.dismissReason} · {row.whenText}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="fp-btn fp-btn-sm"
                      onClick={() => {
                        setAttentionRows((prev) => [...prev, row]);
                        setDismissedRows((prev) =>
                          prev.filter((r) => r.id !== row.id)
                        );
                      }}
                    >
                      Undo
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  </div>
);
