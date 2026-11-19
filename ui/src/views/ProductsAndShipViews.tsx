import React, { useEffect, useRef, useState } from "react";
import { invoke, showContextMenu } from "../tauriInvoke";
import { CatalogPart, FilamentSwatch, Order, Product, TransitionRequest } from "../types";
import { CreatedCatalogProductPayload } from "../components/ProductImportModal3D";
import { PartThumb, ProductCompositeThumb, registerProductComposite } from "../partThumbnails";
import { fmtUsd } from "./shared";
import { previewColorsForProduct, previewCompositeParts } from "../previewColors";
import { useShopSettings } from "../settingsStore";
import { parsePriceCents } from "../shopHelpers";
import { askConfirm, notifyError } from "../uiFeedback";
import { actorDevice } from "../deviceLabel";

type PartRole = "Prints" | "Picture only" | "Color only";

function roleOf(part: CatalogPart): PartRole {
  if (part.is_color_only) return "Color only";
  if (!part.is_tracked) return "Picture only";
  return "Prints";
}

function applyRole(part: CatalogPart, role: PartRole): CatalogPart {
  if (role === "Color only") return { ...part, is_tracked: false, is_color_only: true };
  if (role === "Picture only") return { ...part, is_tracked: false, is_color_only: false };
  return { ...part, is_tracked: true, is_color_only: false };
}

export const ProductsCatalogView: React.FC<{
  products: Product[];
  filaments: FilamentSwatch[];
  customProducts: Record<string, CreatedCatalogProductPayload>;
  onOpenImportModal: () => void;
  onSaveProduct: (product: Product) => void;
  onDeleteProduct: (product: Product) => void;
  onOpenStudio: (product: Product) => void;
}> = ({
  products,
  filaments,
  customProducts,
  onOpenImportModal,
  onSaveProduct,
  onDeleteProduct,
  onOpenStudio,
}) => {
  const [selectedProductId, setSelectedProductId] = useState<string>(
    products[0]?.id || ""
  );
    const [editing, setEditing] = useState<Product | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Product | null>(null);

  useEffect(() => {
    for (const draft of Object.values(customProducts)) {
      if (draft.compositeThumbnailDataUrl) {
        registerProductComposite(draft.id, draft.compositeThumbnailDataUrl);
      }
    }
  }, [customProducts]);
  const boxPresets = useShopSettings().box_presets || [];
  const boxLabel = (v: string) => boxPresets.find((b) => b.id === v || b.name === v)?.name || v;
  const selectedProduct =
    products.find((p) => p.id === selectedProductId) || products[0];

  return (
    <div className="fp-scroll" style={{ padding: "18px 18px 96px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            Catalog ({products.length})
          </div>
          <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>
            Your products, their default colors, and what each one costs to make
          </div>
        </div>
        <button type="button" className="fp-btn fp-btn-primary" onClick={onOpenImportModal}>
          Add product
        </button>
      </div>

      {products.length === 0 && (
        <div className="fp-card" style={{ padding: 28, textAlign: "center", color: "rgba(235,235,245,0.6)" }}>
          No products yet. Import a 3MF or STL to add your first one.
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 14,
        }}
      >
        {products.map((prod) => {
          // Catalog browsing: arbitrary (seeded) colors; picture-only parts keep their saved color.
          const compositeParts = previewCompositeParts(prod, "preview", filaments);
          const previewHexByPart = previewColorsForProduct(prod, "preview", filaments);
          const trackedParts = prod.parts.filter(
            (pt) => pt.is_tracked && !pt.is_color_only
          );
          const totalGrams = trackedParts.reduce((s, p) => s + p.grams, 0);
          const totalMins = trackedParts.reduce((s, p) => s + p.print_minutes, 0);
          const isSelected = selectedProduct?.id === prod.id;

          return (
            <div
              key={prod.id}
              tabIndex={0}
              role="button"
              aria-label={`${prod.name}. Press Enter to edit.`}
              aria-pressed={isSelected}
              onClick={() => setSelectedProductId(prod.id)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  setSelectedProductId(prod.id);
                  setEditing(prod);
                } else if (e.key === " ") {
                  e.preventDefault();
                  setSelectedProductId(prod.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSelectedProductId(prod.id);
                void showContextMenu(
                  [
                    { id: "edit", label: "Edit product…" },
                    { id: "studio", label: "Edit in Product Editor…" },
                    { separator: true },
                    { id: "delete", label: "Delete product…" },
                  ],
                  { x: e.clientX, y: e.clientY }
                ).then((choice) => {
                  if (choice === "edit") setEditing(prod);
                  else if (choice === "studio") onOpenStudio(prod);
                  else if (choice === "delete") setPendingDelete(prod);
                });
              }}
              className="fp-card"
              style={{
                cursor: "pointer",
                border: isSelected
                  ? "2px solid #0a84ff"
                  : "1px solid rgba(255,255,255,0.10)",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  padding: 8,
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.03)",
                }}
              >
                <ProductCompositeThumb
                  productIdOrName={prod.id}
                  parts={compositeParts}
                  size={220}
                  liveTint
                />
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{prod.name}</div>
                  <div style={{ fontSize: 11, color: "rgba(235,235,245,0.55)" }}>
                    {[prod.sku.trim() ? `SKU: ${prod.sku}` : "", `${trackedParts.length} printed ${trackedParts.length === 1 ? "part" : "parts"}`].filter(Boolean).join(" • ")}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 800,
                    color: "#30d158",
                    background: "rgba(48,209,88,0.14)",
                    padding: "3px 8px",
                    borderRadius: 8,
                  }}
                >
                  {fmtUsd(prod.price_cents)}
                </span>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 11.5,
                  color: "rgba(235,235,245,0.68)",
                }}
              >
                <span>{totalGrams.toFixed(1)} g filament</span>
                <span>{totalMins}m print time</span>
                {prod.default_box_name.trim() && <span>Box: {boxLabel(prod.default_box_name)}</span>}
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {trackedParts.map((pt) => {
                  const hex = previewHexByPart.get(pt.id) || "#8E8E93";
                  return (
                    <div
                      key={pt.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                        padding: "3px 7px",
                        borderRadius: 6,
                        background: "rgba(255,255,255,0.05)",
                        fontSize: 11,
                      }}
                    >
                      <PartThumb
                        partName={pt.name}
                        colorHex={hex}
                        size={22}
                        productId={prod.id}
                      />
                      <span>{pt.name}</span>
                    </div>
                  );
                })}
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="fp-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(prod);
                  }}
                >
                  Edit…
                </button>
                <button
                  type="button"
                  className="fp-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDelete(prod);
                  }}
                  style={{ color: "#ff8a80" }}
                >
                  Delete…
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {pendingDelete && (
        <div style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="fp-card" role="alertdialog" aria-modal="true" aria-label={`Delete ${pendingDelete.name}?`} style={{ width: 420, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Delete {pendingDelete.name}?</div>
            <div style={{ fontSize: 13, color: "rgba(235,235,245,0.7)" }}>
              This removes the product from the catalog and can't be undone. Orders that already use it keep their parts.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="fp-btn" onClick={() => setPendingDelete(null)}>Cancel</button>
              <button
                type="button"
                className="fp-btn fp-btn-primary"
                onClick={() => {
                  onDeleteProduct(pendingDelete);
                  setPendingDelete(null);
                  setEditing((cur) => (cur?.id === pendingDelete.id ? null : cur));
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <ProductEditorModal
          product={editing}
          filaments={filaments}
          canOpenStudio
          onClose={() => setEditing(null)}
          onSave={(next) => {
            onSaveProduct(next);
            setEditing(null);
          }}
          onDelete={() => setPendingDelete(editing)}
          onOpenStudio={() => {
            onOpenStudio(editing);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
};

const ProductEditorModal: React.FC<{
  product: Product;
  filaments: FilamentSwatch[];
  canOpenStudio: boolean;
  onClose: () => void;
  onSave: (product: Product) => void;
  onDelete: () => void;
  onOpenStudio: () => void;
}> = ({ product, filaments, canOpenStudio, onClose, onSave, onDelete, onOpenStudio }) => {
  const settings = useShopSettings();
  const boxPresets = settings.box_presets || [];
  const [name, setName] = useState(product.name);
  const [sku, setSku] = useState(product.sku);
  const [price, setPrice] = useState((product.price_cents / 100).toFixed(2));
  // Saved as the box name (what the Product Editor and the shop publish match on).
  const origBox = product.default_box_name || "";
  const [box, setBox] = useState(origBox);
  const [parts, setParts] = useState<CatalogPart[]>(product.parts);
  const filamentById = new Map(filaments.map((f) => [f.id, f]));
  const priceCents = parsePriceCents(price);
  const dirty =
    name !== product.name ||
    sku !== product.sku ||
    priceCents !== product.price_cents ||
    box !== origBox ||
    JSON.stringify(parts) !== JSON.stringify(product.parts);
  const boxKnown = !box || boxPresets.some((b) => b.name === box || b.id === box);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fieldStyle: React.CSSProperties = {
    width: "100%",
    marginTop: 4,
    padding: "7px 8px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "#0f172a",
    color: "#f8fafc",
  };

  // Backdrop click and Esc only close without asking when nothing changed.
  const asking = useRef(false);
  const requestClose = async () => {
    if (!dirty) {
      onClose();
      return;
    }
    if (asking.current) return;
    asking.current = true;
    const ok = await askConfirm({
      title: `Discard changes to ${product.name}?`,
      message: "Your edits to this product haven't been saved.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      danger: true,
    }).finally(() => {
      asking.current = false;
    });
    if (ok) onClose();
  };
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(5,8,15,0.78)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }} onClick={() => void requestClose()}>
      <div
        ref={dialogRef}
        className="fp-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fp-edit-product-title"
        tabIndex={-1}
        style={{ width: "min(860px, 96vw)", maxHeight: "90vh", overflow: "auto", display: "flex", flexDirection: "column", gap: 14, outline: "none" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div id="fp-edit-product-title" style={{ fontSize: 18, fontWeight: 800 }}>Edit product</div>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 16 }}>
          <ProductCompositeThumb
            productIdOrName={product.id}
            parts={parts.map((pt) => ({
              partName: pt.name,
              colorHex: filamentById.get(pt.default_filament_id)?.hex || "#FF8D28",
              visible: !pt.is_color_only,
            }))}
            size={260}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ fontSize: 12 }}>Name
              <input value={name} onChange={(e) => setName(e.target.value)} style={fieldStyle} />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <label style={{ fontSize: 12 }}>SKU
                <input value={sku} onChange={(e) => setSku(e.target.value)} style={fieldStyle} />
              </label>
              <label style={{ fontSize: 12 }}>Price ($)
                <input
                  value={price}
                  inputMode="decimal"
                  aria-invalid={priceCents === null}
                  onChange={(e) => setPrice(e.target.value)}
                  style={{ ...fieldStyle, borderColor: priceCents === null ? "#ff453a" : fieldStyle.border as string }}
                />
                {priceCents === null && (
                  <span style={{ display: "block", marginTop: 3, fontSize: 11.5, color: "#ff8a80" }}>
                    Enter a price like 12.50.
                  </span>
                )}
              </label>
            </div>
            <label style={{ fontSize: 12 }}>Shipping box
              <select value={box} onChange={(e) => setBox(e.target.value)} style={fieldStyle}>
                <option value="">No box set</option>
                {boxPresets.map((b) => (
                  <option key={b.id} value={b.name}>
                    {b.name} ({b.length_in}×{b.width_in}×{b.height_in} in)
                  </option>
                ))}
                {!boxKnown && <option value={box}>{box} (not in your shipping boxes)</option>}
              </select>
              {boxPresets.length === 0 && (
                <span style={{ display: "block", marginTop: 3, fontSize: 11.5, color: "rgba(235,235,245,0.6)" }}>
                  Add your boxes in Settings › Store › Shipping boxes to pick one here.
                </span>
              )}
            </label>
          </div>
        </div>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Parts</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {parts.map((pt, idx) => {
            const missing = !filamentById.has(pt.default_filament_id);
            return (
              <div key={pt.id} style={{ display: "grid", gridTemplateColumns: "1.2fr 140px 1fr", gap: 8, alignItems: "center" }}>
                <input
                  aria-label="Part name"
                  value={pt.name}
                  onChange={(e) => setParts((prev) => prev.map((p, i) => i === idx ? { ...p, name: e.target.value } : p))}
                  style={fieldStyle}
                />
                <select
                  aria-label={`Role of ${pt.name}`}
                  value={roleOf(pt)}
                  onChange={(e) => setParts((prev) => prev.map((p, i) => i === idx ? applyRole(p, e.target.value as PartRole) : p))}
                  style={fieldStyle}
                >
                  <option>Prints</option>
                  <option>Picture only</option>
                  <option>Color only</option>
                </select>
                <select
                  aria-label={`Default color of ${pt.name}`}
                  aria-invalid={missing}
                  value={pt.default_filament_id}
                  onChange={(e) => setParts((prev) => prev.map((p, i) => i === idx ? { ...p, default_filament_id: e.target.value } : p))}
                  style={{ ...fieldStyle, borderColor: missing ? "#ff9f0a" : fieldStyle.border as string }}
                >
                  {missing && <option value={pt.default_filament_id}>Missing color, pick one</option>}
                  {filaments.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <button type="button" className="fp-btn" style={{ color: "#ff8a80" }} onClick={onDelete}>Delete product…</button>
          <div style={{ display: "flex", gap: 8 }}>
            {canOpenStudio && (
              <button type="button" className="fp-btn" onClick={onOpenStudio}>Edit in Product Editor…</button>
            )}
            <button type="button" className="fp-btn" onClick={() => void requestClose()}>Cancel</button>
            <button
              type="button"
              className="fp-btn fp-btn-primary"
              disabled={priceCents === null}
              onClick={() => {
                if (priceCents === null) return;
                onSave({
                  ...product,
                  name: name.trim() || product.name,
                  sku: sku.trim(),
                  price_cents: priceCents,
                  default_box_name: box,
                  parts,
                });
              }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/** Confirm step for Mark shipped, with an optional tracking number. */
const MarkShippedDialog: React.FC<{
  order: Order;
  onCancel: () => void;
  onConfirm: (tracking: string) => Promise<void>;
}> = ({ order, onCancel, onConfirm }) => {
  const [tracking, setTracking] = useState(
    ((order as Order & { tracking_number?: string | null }).tracking_number || "").trim(),
  );
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  const submit = async () => {
    setBusy(true);
    try {
      await onConfirm(tracking.trim());
    } finally {
      setBusy(false);
    }
  };
  const itemCount = order.lines.reduce((n, l) => n + (l.quantity || 0), 0);
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => !busy && onCancel()}
    >
      <div
        className="fp-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fp-mark-shipped-title"
        style={{ width: 440, display: "flex", flexDirection: "column", gap: 12 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div id="fp-mark-shipped-title" style={{ fontSize: 16, fontWeight: 700 }}>
          Mark {order.order_code} for {order.customer_name} as shipped?
        </div>
        <div style={{ fontSize: 13, color: "rgba(235,235,245,0.7)" }}>
          {itemCount} {itemCount === 1 ? "item" : "items"}. The order moves out of Ready to ship. You can undo this from the activity log.
        </div>
        <label style={{ fontSize: 12 }}>
          Tracking number (optional)
          <input
            ref={inputRef}
            value={tracking}
            maxLength={120}
            placeholder="Paste it here"
            onChange={(e) => setTracking(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void submit();
            }}
            style={{ width: "100%", marginTop: 4, padding: "7px 8px", borderRadius: 8 }}
          />
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="fp-btn" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="fp-btn fp-btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? "Saving…" : "Mark shipped"}
          </button>
        </div>
      </div>
    </div>
  );
};

export const ReadyToShipView: React.FC<{
  readyToShipOrders: Order[];
  /** Not used here; kept so callers don't change. */
  productById?: Map<string, Product>;
  /** Not used here; kept so callers don't change. */
  filaments?: FilamentSwatch[];
  /** Not used here; kept so callers don't change. */
  customProducts?: Record<string, CreatedCatalogProductPayload>;
  onRunTransition: (req: TransitionRequest) => void | Promise<void>;
}> = ({ readyToShipOrders, onRunTransition }) => {
  const [shipping, setShipping] = useState<Order | null>(null);

  const markShipped = async (ord: Order, tracking: string) => {
    const had = ((ord as Order & { tracking_number?: string | null }).tracking_number || "").trim();
    // Save the tracking first, so the snapshot the ship transition returns already has it.
    if (tracking !== had) {
      try {
        await invoke("set_order_tracking", { orderId: ord.id, trackingNumber: tracking });
      } catch (e) {
        notifyError(`Couldn't save the tracking number for ${ord.order_code}`, e);
        return;
      }
    }
    await onRunTransition({
      unit_ids: ord.lines.flatMap((l) => l.units.map((u) => u.id)),
      to_state: "Shipped",
      printer_id: null,
      actor_device: actorDevice(),
      source_surface: "Ready to Ship",
      action_label: tracking ? `Shipped order ${ord.order_code} (tracking ${tracking})` : `Shipped order ${ord.order_code}`,
      failure_reason: null,
      failure_note: null,
    });
    setShipping(null);
  };

  return (
    <div className="fp-scroll" style={{ padding: "18px 18px 96px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>
          Ready to Ship ({readyToShipOrders.length})
        </div>
        <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>
          Orders whose printed parts are all done, ready to pack and ship
        </div>
      </div>

      {readyToShipOrders.length === 0 ? (
        <div
          className="fp-card"
          style={{ padding: 28, textAlign: "center", color: "rgba(235,235,245,0.55)" }}
        >
          Nothing is ready to ship yet. Orders show up here once all their parts are printed.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))",
            gap: 14,
          }}
        >
          {readyToShipOrders.map((ord) => {
            const items = ord.lines.length;
            return (
              <div key={ord.id} className="fp-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{ord.customer_name}</div>
                    <div style={{ fontSize: 11.5, color: "rgba(235,235,245,0.55)" }}>
                      {ord.order_code} • {items} {items === 1 ? "item" : "items"}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: "rgba(48,209,88,0.2)",
                      color: "#30d158",
                    }}
                  >
                    Ready now
                  </span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span>Revenue: {fmtUsd(ord.total_revenue_cents)}</span>
                  <span>Net profit: {fmtUsd(ord.net_profit_cents)} ({ord.margin_pct}%)</span>
                </div>

                <button type="button" className="fp-btn fp-btn-primary" onClick={() => setShipping(ord)}>
                  Mark shipped…
                </button>
              </div>
            );
          })}
        </div>
      )}
      {shipping && (
        <MarkShippedDialog
          order={shipping}
          onCancel={() => setShipping(null)}
          onConfirm={(tracking) => markShipped(shipping, tracking)}
        />
      )}
    </div>
  );
};
