import { modKey } from "../platform";
/**
 * New Order sheet — port of Swift `OrderEditorSheet` (.add mode).
 *
 * Flow (same as Swift):
 *   1. "Choose a product" grid (adaptive cards, composite preview + name).
 *   2. Configure: line chips bar (Change product / chips / Add product / Remove),
 *      left = color preview (fills the column; live 3D viewport when a model is available),
 *      right = Form (Order / Quantity / Test bench / Parts with thumb grid) or the filament picker panel.
 *   Toolbar: Cancel (left), Create Order (right, only while configuring, Enter).
 *
 * Colors: a new draft line starts from the catalog "preview" colors
 * (previewColors.ts — seeded arbitrary colors, picture-only parts keep their saved
 * color). Once a part gets a filament in this sheet, the line's chosen colors drive
 * the preview and are written onto the order.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { askConfirm } from "../uiFeedback";
import { invoke } from "../tauriInvoke";
import { useShopSettings } from "../settingsStore";
import { CatalogPart, FilamentSwatch, Product, ShopSnapshot } from "../types";
import { PartThumb, ProductCompositeThumb } from "../partThumbnails";
import { isPictureOnlyCatalogPart, previewColorsForProduct, previewCompositeParts } from "../previewColors";
import { OrderThumbnailCapture, OrderViewport3D, OrderViewport3DHandle, renderOrderThumbnail } from "../components/OrderViewport3D";
import type { CameraState } from "../viewportCamera";
import { Trash2, User } from "lucide-react";
import { Icon } from "../icons";

/** One created order line's own picture. Persist per order line, locally only. */
export interface NewOrderLineThumbnail {
  orderId: string;
  /** Created order line id (null if it couldn't be matched in the snapshot). */
  orderLineId: string | null;
  lineIndex: number;
  productId: string;
  thumbnail: OrderThumbnailCapture;
}

/** Swift OrderLogic.maxUnitOrderBurst */
const MAX_UNIT_ORDER_BURST = 200;
const PART_THUMB = 88;

interface DraftLine {
  id: string;
  product: Product;
  quantityText: string;
  /** part id -> filament id (library swatch). Missing = no library match; hex in previewHex. */
  partFilaments: Record<string, string>;
  /** part id -> hex shown when no filament chosen yet. */
  previewHex: Record<string, string>;
  customText: string;
}

const qtyOf = (l: DraftLine) => Math.max(1, parseInt(l.quantityText, 10) || 1);
const sortedParts = (p: Product) => [...p.parts].sort((a, b) => a.sort_order - b.sort_order);
/** Swift ThumbnailOnlyFilter.textParts: everything except picture-only parts. */
const colorPartsOf = (p: Product) => sortedParts(p).filter((pt) => !isPictureOnlyCatalogPart(pt));

let lineSeq = 0;
function makeLine(product: Product, filaments: FilamentSwatch[], quantity = 1, id?: string): DraftLine {
  const preview = previewColorsForProduct(product, "preview", filaments);
  const partFilaments: Record<string, string> = {};
  const previewHex: Record<string, string> = {};
  for (const pt of product.parts) {
    const hex = preview.get(pt.id) || "#8E8E93";
    previewHex[pt.id] = hex;
    if (isPictureOnlyCatalogPart(pt)) {
      partFilaments[pt.id] = pt.default_filament_id;
    } else {
      // Resolve the preview hex to a library swatch so the order gets a real filament.
      const hit = filaments.find((f) => f.hex.toUpperCase() === hex.toUpperCase());
      partFilaments[pt.id] = hit?.id || pt.default_filament_id;
    }
  }
  return {
    id: id || `draft-${Date.now()}-${lineSeq++}`,
    product,
    quantityText: String(Math.max(1, quantity)),
    partFilaments,
    previewHex,
    customText: "",
  };
}

export const NewOrderSheet: React.FC<{
  snapshot: ShopSnapshot;
  onClose: () => void;
  onCreated: (snap: ShopSnapshot, message: string) => void;
  /** Called after Create Order with each new line's picture + camera (before onCreated). */
  onOrderThumbnails?: (items: NewOrderLineThumbnail[]) => void | Promise<void>;
}> = ({ snapshot, onClose, onCreated, onOrderThumbnails }) => {
  const filaments = snapshot.filaments;
  const filamentById = useMemo(() => new Map(filaments.map((f) => [f.id, f])), [filaments]);

  const testBenchEnabled = !!useShopSettings().test_bench_enabled;
  const [step, setStep] = useState<"pickProduct" | "configure">("pickProduct");
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [pickingAdditionalLine, setPickingAdditionalLine] = useState(false);

  const [customerName, setCustomerName] = useState("");
  const [linkedCustomer, setLinkedCustomer] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [isRush, setIsRush] = useState(false);
  const [isOnHold, setIsOnHold] = useState(false);
  const [selectedPartIds, setSelectedPartIds] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [pickerPartId, setPickerPartId] = useState<string | null>(null);
  const [showPickerForSelection, setShowPickerForSelection] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [randomizeEachUnitOrder, setRandomizeEachUnitOrder] = useState(true);
  const [showBurstConfirm, setShowBurstConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  // Read by the Enter handler: state captured in a listener can be one render old, so
  // a fast double Enter could create the order twice.
  const busyRef = useRef(false);
  const previewWellRef = useRef<HTMLDivElement>(null);
  const orderViewportRef = useRef<OrderViewport3DHandle | null>(null);
  /** Each draft line's own 3D view, keyed line+product. Fresh per sheet: never reused across orders. */
  const lineCamerasRef = useRef<Record<string, CameraState>>({});
  const [previewBox, setPreviewBox] = useState(440);

  // Grow the preview square with the left column, never below the current 440 box.
  useEffect(() => {
    if (step !== "configure") return;
    const el = previewWellRef.current;
    if (!el) return;
    const measure = () => {
      const next = Math.max(440, Math.floor(Math.min(el.clientWidth, el.clientHeight)));
      setPreviewBox(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [step, activeLineId]);

  const activeIndex = Math.max(0, draftLines.findIndex((l) => l.id === activeLineId));
  const activeLine: DraftLine | undefined = draftLines[activeIndex];
  const product = activeLine?.product;
  const colorParts = product ? colorPartsOf(product) : [];
  const isMultiLine = draftLines.length > 1;
  const unitBurstCount = draftLines.reduce((s, l) => s + qtyOf(l), 0);
  const isPickerOpen = pickerPartId !== null || showPickerForSelection;

  const title =
    step === "pickProduct"
      ? pickingAdditionalLine ? "Add product" : "New Order"
      : isMultiLine ? `New Order — ${draftLines.length} products` : `New Order — ${product?.name ?? ""}`;

  const hexFor = (line: DraftLine, pt: CatalogPart) =>
    filamentById.get(line.partFilaments[pt.id])?.hex || line.previewHex[pt.id] || "#8E8E93";
  const filamentNameFor = (line: DraftLine, pt: CatalogPart) =>
    filamentById.get(line.partFilaments[pt.id])?.name || "";

  const updateActive = (fn: (l: DraftLine) => DraftLine) =>
    setDraftLines((prev) => prev.map((l, i) => (i === activeIndex ? fn(l) : l)));

  const resetSelection = () => {
    setSelectedPartIds(new Set());
    setAnchor(null);
    setPickerPartId(null);
    setShowPickerForSelection(false);
  };

  const selectProduct = (candidate: Product) => {
    if (pickingAdditionalLine && draftLines.length) {
      const line = makeLine(candidate, filaments);
      setDraftLines((p) => [...p, line]);
      setActiveLineId(line.id);
      setPickingAdditionalLine(false);
    } else if (!draftLines.length) {
      const line = makeLine(candidate, filaments);
      setDraftLines([line]);
      setActiveLineId(line.id);
    } else {
      const cur = draftLines[activeIndex];
      const updated = makeLine(candidate, filaments, qtyOf(cur), cur.id);
      setDraftLines((p) => p.map((l, i) => (i === activeIndex ? updated : l)));
      setActiveLineId(updated.id);
    }
    resetSelection();
    setStep("configure");
  };

  const removeActiveLine = () => {
    if (draftLines.length <= 1) return;
    const next = draftLines.filter((_, i) => i !== activeIndex);
    setDraftLines(next);
    setActiveLineId(next[Math.min(activeIndex, next.length - 1)].id);
    resetSelection();
  };

  const handlePartClick = (e: React.MouseEvent, part: CatalogPart, index: number) => {
    const cmd = e.metaKey || e.ctrlKey;
    if (cmd && e.shiftKey) {
      const a = anchor ?? index;
      const next = new Set(selectedPartIds);
      for (let i = Math.min(a, index); i <= Math.max(a, index); i++) if (colorParts[i]) next.add(colorParts[i].id);
      setSelectedPartIds(next);
      setAnchor(index);
      return;
    }
    if (cmd) {
      const next = new Set(selectedPartIds);
      if (next.has(part.id)) next.delete(part.id);
      else next.add(part.id);
      setSelectedPartIds(next);
      setAnchor(index);
      if (next.size > 1) { setPickerPartId(null); setShowPickerForSelection(true); }
      else if (next.size === 1) { setPickerPartId([...next][0]); setShowPickerForSelection(false); }
      else { setPickerPartId(null); setShowPickerForSelection(false); }
      return;
    }
    if (selectedPartIds.size > 1 && selectedPartIds.has(part.id)) {
      setAnchor(index); setPickerPartId(null); setShowPickerForSelection(true);
      return;
    }
    setSelectedPartIds(new Set([part.id]));
    setAnchor(index);
    setPickerPartId(part.id);
    setShowPickerForSelection(false);
  };

  const applyFilament = (f: FilamentSwatch) => {
    const ids = showPickerForSelection || (pickerPartId === null && selectedPartIds.size > 1)
      ? [...selectedPartIds]
      : pickerPartId ? [pickerPartId] : [...selectedPartIds];
    updateActive((l) => {
      const pf = { ...l.partFilaments };
      const ph = { ...l.previewHex };
      for (const id of ids) { pf[id] = f.id; ph[id] = f.hex; }
      return { ...l, partFilaments: pf, previewHex: ph };
    });
    if (pickerPartId && selectedPartIds.size <= 1) setSelectedPartIds(new Set([pickerPartId]));
    setPickerPartId(null);
    setShowPickerForSelection(false);
  };

  /** Swift product.defaultMaterial: the React Product has no such field, so use the
   *  most common material among the product's own default filaments. */
  const preferredMaterialOf = (p: Product): string => {
    const counts = new Map<string, number>();
    for (const pt of p.parts) {
      const m = filamentById.get(pt.default_filament_id)?.material?.trim();
      if (m) counts.set(m, (counts.get(m) || 0) + 1);
    }
    let best = "", n = 0;
    for (const [m, c] of counts) if (c > n) { best = m; n = c; }
    return best;
  };
  /** Swift libraryFilamentPool(preferredMaterial:): preferred material first, else whole library. */
  const libraryFilamentPool = (p: Product): FilamentSwatch[] => {
    const prefer = preferredMaterialOf(p).toLowerCase();
    const preferred = prefer ? filaments.filter((f) => f.material.trim().toLowerCase() === prefer) : [];
    return preferred.length ? preferred : filaments;
  };
  const randomFilamentMap = (p: Product, base: Record<string, string>) => {
    const out = { ...base };
    const pool = libraryFilamentPool(p);
    if (!pool.length) return out;
    for (const pt of colorPartsOf(p)) out[pt.id] = pool[Math.floor(Math.random() * pool.length)].id;
    return out;
  };

  const randomizeActiveLineFilaments = () =>
    updateActive((l) => {
      const pf = randomFilamentMap(l.product, l.partFilaments);
      const ph = { ...l.previewHex };
      for (const id of Object.keys(pf)) { const h = filamentById.get(pf[id])?.hex; if (h) ph[id] = h; }
      return { ...l, partFilaments: pf, previewHex: ph };
    });

  // ---- Persistence (existing fp-core commands only) ----
  const createOne = async (lines: Array<{ line: DraftLine; qty: number; filamentMap: Record<string, string> }>): Promise<ShopSnapshot> => {
    const name = customerName.trim();
    const before = new Set(snapshot.orders.map((o) => o.id));
    const currentBefore = before;
    const [first, ...rest] = lines;
    let snap = await invoke<ShopSnapshot>("create_order", {
      customerName: name,
      customerEmail: "",
      productId: first.line.product.id,
      quantity: first.qty,
      customText: first.line.customText.trim() || null,
      rush: isRush,
    });
    const created = snap.orders.find((o) => !currentBefore.has(o.id));
    if (!created) return snap;
    // First line: create_order seeds catalog defaults; apply the sheet's chosen filaments per unit.
    for (const ln of created.lines) {
      for (const u of ln.units) {
        const want = first.filamentMap[u.part_id];
        if (want && want !== u.filament_id) {
          snap = await invoke<ShopSnapshot>("update_part_filament", {
            unitId: u.id, filamentId: want, actorDevice: "Orders · New Order",
          });
        }
      }
    }
    for (const r of rest) {
      snap = await invoke<ShopSnapshot>("add_order_line", {
        orderId: created.id,
        productId: r.line.product.id,
        quantity: r.qty,
        customText: r.line.customText.trim() || null,
        filamentOverrides: r.filamentMap,
      });
    }
    if (notes.trim() || isOnHold) {
      snap = await invoke<ShopSnapshot>("update_order_metadata", {
        orderId: created.id,
        notes: notes.trim() || null,
        isOnHold: isOnHold ? true : null,
      });
    }
    return snap;
  };

  const validate = (): boolean => {
    if (!customerName.trim()) { setValidationError("Customer / name is required"); return false; }
    if (!draftLines.length) { setValidationError("Add at least one product"); return false; }
    setValidationError(null);
    return true;
  };

  // ---- Per-order pictures: this order's colors + this order's camera ----
  const camKey = (l: DraftLine) => `${l.id}:${l.product.id}`;
  const colorsFor = (l: DraftLine, map: Record<string, string> = l.partFilaments): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const pt of l.product.parts) out[pt.id] = filamentById.get(map[pt.id])?.hex || l.previewHex[pt.id] || "#8E8E93";
    return out;
  };
  const captureLines = async (): Promise<Array<OrderThumbnailCapture | null>> => {
    const out: Array<OrderThumbnailCapture | null> = [];
    for (const l of draftLines) {
      try {
        const live = l.id === activeLine?.id ? orderViewportRef.current?.capture(1024) ?? null : null;
        out.push(live ?? await renderOrderThumbnail(l.product, colorsFor(l), lineCamerasRef.current[camKey(l)] ?? null, { filaments }));
      } catch { out.push(null); }
    }
    return out;
  };
  const reportThumbnails = async (base: ShopSnapshot, snap: ShopSnapshot, shots: Array<{ line: DraftLine; shot: OrderThumbnailCapture | null }>) => {
    if (!onOrderThumbnails) return;
    const before = new Set(base.orders.map((o) => o.id));
    const created = snap.orders.find((o) => !before.has(o.id));
    if (!created) return;
    const used = new Set<string>();
    const items: NewOrderLineThumbnail[] = [];
    shots.forEach(({ line, shot }, lineIndex) => {
      if (!shot) return;
      const byIndex = created.lines[lineIndex];
      const ol = byIndex && byIndex.product_id === line.product.id && !used.has(byIndex.id)
        ? byIndex : created.lines.find((x) => x.product_id === line.product.id && !used.has(x.id));
      if (ol) used.add(ol.id);
      items.push({ orderId: created.id, orderLineId: ol?.id ?? null, lineIndex, productId: line.product.id, thumbnail: shot });
    });
    try { if (items.length) await onOrderThumbnails(items); } catch { /* picture is optional; the order exists */ }
  };

  const save = async () => {
    if (busyRef.current || !validate() || busy) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const shots = await captureLines();
      const snap = await createOne(draftLines.map((l) => ({ line: l, qty: qtyOf(l), filamentMap: l.partFilaments })));
      await reportThumbnails(snapshot, snap, draftLines.map((line, i) => ({ line, shot: shots[i] })));
      onCreated(snap, `Created order for ${customerName.trim()}`);
    } catch (e) {
      setValidationError(`Could not create order: ${String(e)}`);
    } finally { busyRef.current = false; setBusy(false); }
  };

  const requestBurst = () => {
    if (!validate()) return;
    if (unitBurstCount > MAX_UNIT_ORDER_BURST) {
      setValidationError(`Individual-order burst max is ${MAX_UNIT_ORDER_BURST} (this draft is ${unitBurstCount} units).`);
      return;
    }
    setShowBurstConfirm(true);
  };

  const commitBurst = async () => {
    setShowBurstConfirm(false);
    setBusy(true);
    try {
      let snap = snapshot;
      for (const l of draftLines) {
        for (let i = 0; i < qtyOf(l); i++) {
          const map = randomizeEachUnitOrder ? randomFilamentMap(l.product, l.partFilaments) : l.partFilaments;
          const base = snap;
          snap = await createOneFrom(snap, l, map);
          if (onOrderThumbnails) {
            const shot = await renderOrderThumbnail(l.product, colorsFor(l, map), lineCamerasRef.current[camKey(l)] ?? null, { filaments, layers: false }).catch(() => null);
            await reportThumbnails(base, snap, [{ line: l, shot }]);
          }
        }
      }
      onCreated(snap, `Created ${unitBurstCount} orders for ${customerName.trim()}`);
    } catch (e) {
      setValidationError(`Could not create orders: ${String(e)}`);
    } finally { setBusy(false); }
  };

  // Burst helper: one qty-1 order, diffing against the running snapshot.
  const createOneFrom = async (base: ShopSnapshot, l: DraftLine, map: Record<string, string>) => {
    const before = new Set(base.orders.map((o) => o.id));
    let snap = await invoke<ShopSnapshot>("create_order", {
      customerName: customerName.trim(), customerEmail: "", productId: l.product.id, quantity: 1,
      customText: l.customText.trim() || null, rush: isRush,
    });
    const created = snap.orders.find((o) => !before.has(o.id));
    if (created) {
      for (const ln of created.lines) for (const u of ln.units) {
        const want = map[u.part_id];
        if (want && want !== u.filament_id) snap = await invoke<ShopSnapshot>("update_part_filament", { unitId: u.id, filamentId: want, actorDevice: "Orders · New Order" });
      }
      if (notes.trim() || isOnHold) snap = await invoke<ShopSnapshot>("update_order_metadata", { orderId: created.id, notes: notes.trim() || null, isOnHold: isOnHold ? true : null });
    }
    return snap;
  };

  // Enter = Create Order while configuring (Swift .keyboardShortcut(.defaultAction)); Esc closes picker, then sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showBurstConfirm) {
        if (e.key === "Escape") setShowBurstConfirm(false);
        return;
      }
      if (e.key === "Escape") {
        if (isPickerOpen) { setPickerPartId(null); setShowPickerForSelection(false); } else onClose();
      } else if (e.key === "Enter" && step === "configure" && !(e.target instanceof HTMLTextAreaElement)) {
        // Enter on a focused button (a customer suggestion, Cancel, …) does that button.
        if (e.target instanceof HTMLButtonElement) return;
        // Enter in the name field while suggestions show picks the first one, not Create.
        if (e.target instanceof HTMLInputElement && e.target.dataset.fpCustomerName === "1" && suggestions.length > 0) {
          e.preventDefault();
          setCustomerName(suggestions[0]);
          setLinkedCustomer(suggestions[0]);
          return;
        }
        e.preventDefault(); void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Customer suggestions from existing orders (Swift CustomerStore.suggestions(forNamePrefix:)).
  const suggestions = useMemo(() => {
    const q = customerName.trim().toLowerCase();
    if (!q || linkedCustomer) return [] as string[];
    const names = new Set<string>();
    for (const o of snapshot.orders) {
      const n = o.customer_name.trim();
      if (n && n.toLowerCase().startsWith(q) && n.toLowerCase() !== q) names.add(n);
    }
    return [...names].slice(0, 5);
  }, [customerName, linkedCustomer, snapshot.orders]);

  // ---------- UI ----------
  const secondary = "rgba(235,235,245,0.6)";
  const caption: React.CSSProperties = { fontSize: 11.5, color: secondary };
  const linkBtn: React.CSSProperties = { background: "none", border: "none", color: "#0a84ff", cursor: "pointer", fontSize: 12, padding: 0 };
  const field: React.CSSProperties = { width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.05)", color: "inherit", fontSize: 13, boxSizing: "border-box" };
  const section = (heading: string, children: React.ReactNode) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: secondary, margin: "0 0 6px 4px" }}>{heading}</div>
      <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>
    </div>
  );
  const toggle = (label: string, value: boolean, set: (v: boolean) => void) => (
    <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
      {label}
      <input type="checkbox" role="switch" checked={value} onChange={(e) => set(e.target.checked)} />
    </label>
  );

  const compositeFor = (l: DraftLine) =>
    previewCompositeParts(l.product, "preview", filaments).map((cp) => {
      const pt = l.product.parts.find((p) => (cp.partId ? p.id === cp.partId : p.name === cp.partName));
      return pt ? { ...cp, colorHex: hexFor(l, pt) } : cp;
    });

  const productPicker = (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ padding: "20px 20px 12px" }}>
        <div style={{ fontSize: 17, fontWeight: 600 }}>{pickingAdditionalLine ? "Add another product" : "Choose a product"}</div>
        <div style={caption}>
          {pickingAdditionalLine ? "Adds a second (or more) product line on the same order." : "Pick which product this order is for. You can add more products after."}
        </div>
      </div>
      {pickingAdditionalLine && (
        <div style={{ padding: "0 20px 8px" }}>
          <button style={linkBtn} onClick={() => { setPickingAdditionalLine(false); setStep("configure"); }}>‹ Back to order</button>
        </div>
      )}
      <div style={{ overflowY: "auto", padding: 20, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 240px))", gap: 16 }}>
        {snapshot.products.length === 0 && <div style={caption}>No products yet. Add one in Catalog before creating an order.</div>}
        {snapshot.products.map((p) => (
          <button key={p.id} aria-label={`Choose ${p.name}`} onClick={() => selectProduct(p)}
            style={{ all: "unset", cursor: "pointer", padding: 10, borderRadius: 12, background: "rgba(255,255,255,0.04)", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <div style={{ width: 190, height: 190, borderRadius: 10, background: "rgba(208,208,208,0.85)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ProductCompositeThumb productIdOrName={p.id} parts={previewCompositeParts(p, "preview", filaments)} size={180} liveTint />
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }}>{p.name}</div>
          </button>
        ))}
      </div>
    </div>
  );

  const pickerSelectionId = pickerPartId
    ? activeLine?.partFilaments[pickerPartId]
    : selectedPartIds.size ? activeLine?.partFilaments[[...selectedPartIds][0]] : undefined;
  const pickerTitle = pickerPartId
    ? `Filament — ${colorParts.find((p) => p.id === pickerPartId)?.name ?? ""}`
    : selectedPartIds.size > 1 ? `Filament — ${selectedPartIds.size} parts` : "Choose filament";
  const grouped = useMemo(() => {
    const m = new Map<string, FilamentSwatch[]>();
    for (const f of filaments) {
      const k = [f.brand, f.material].filter(Boolean).join(" · ") || "Library";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(f);
    }
    // Swift FilamentPickerPopover(preferredMaterial:): the product's material comes first.
    const prefer = product ? preferredMaterialOf(product).toLowerCase() : "";
    const isPref = (k: string, list: FilamentSwatch[]) => !!prefer && list[0]?.material.trim().toLowerCase() === prefer;
    return [...m.entries()].sort((a, b) => Number(isPref(b[0], b[1])) - Number(isPref(a[0], a[1])));
  }, [filaments, product, filamentById]);

  const filamentPanel = (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "rgba(255,255,255,0.02)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{pickerTitle}</div>
        <button className="fp-btn" onClick={() => { setPickerPartId(null); setShowPickerForSelection(false); }}>Cancel</button>
      </div>
      <div style={{ overflowY: "auto", padding: 12 }}>
        {grouped.length === 0 && <div style={caption}>The filament library is empty.</div>}
        {grouped.map(([group, list]) => (
          <div key={group} style={{ marginBottom: 12 }}>
            <div style={{ ...caption, fontWeight: 600, marginBottom: 6 }}>{group}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 6 }}>
              {list.map((f) => (
                <button key={f.id} onClick={() => applyFilament(f)} title={`${f.brand} ${f.material} ${f.name}`}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 7px", borderRadius: 7, cursor: "pointer", fontSize: 12, color: "inherit", textAlign: "left",
                    background: f.id === pickerSelectionId ? "rgba(10,132,255,0.22)" : "rgba(255,255,255,0.05)",
                    border: f.id === pickerSelectionId ? "1.5px solid #0a84ff" : "1px solid rgba(255,255,255,0.08)" }}>
                  <span style={{ width: 16, height: 16, borderRadius: 8, background: f.hex, border: "1px solid rgba(255,255,255,0.3)", flex: "none" }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const controlsPane = activeLine && (
    <div style={{ overflowY: "auto", padding: 16, height: "100%", boxSizing: "border-box" }}>
      {section("Order", <>
        <input placeholder="Customer / name" value={customerName} style={field} autoFocus data-fp-customer-name="1"
          onChange={(e) => { setCustomerName(e.target.value); setLinkedCustomer(null); }} />
        {suggestions.map((s) => (
          <button key={s} style={{ ...linkBtn, color: secondary, textAlign: "left" }} onClick={() => { setCustomerName(s); setLinkedCustomer(s); }}><Icon icon={User} size={13} /> {s}</button>
        ))}
        <textarea placeholder="Notes" value={notes} rows={2} style={{ ...field, resize: "vertical" }} onChange={(e) => setNotes(e.target.value)} />
        {toggle("Rush", isRush, setIsRush)}
        {toggle("Hold", isOnHold, setIsOnHold)}
        <div style={caption}>Hold keeps the order on the Orders board and hides it from ANDON and Parts to Print.</div>
        {/* TODO(due date): add a "Due date" toggle + date picker once orders have a due_date field. */}
      </>)}
      {section(isMultiLine ? "Active product" : "Quantity", <>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{activeLine.product.name}</div>
        <input placeholder="Quantity" value={activeLine.quantityText} style={field} inputMode="numeric"
          onChange={(e) => { const v = e.target.value.replace(/\D/g, ""); updateActive((l) => ({ ...l, quantityText: v })); }} />
        <div style={caption}>
          {isMultiLine ? "Each product line keeps its own quantity and colors (one order)." : "Quantity stays on this product. Add another product for a second color mix."}
        </div>
        {activeLine.product.supports_custom_text && (
          <input placeholder="Inscription text" value={activeLine.customText} style={field}
            onChange={(e) => updateActive((l) => ({ ...l, customText: e.target.value }))} />
        )}
      </>)}
      {testBenchEnabled && section("Test bench", <>
        <div style={caption}>Need a pile of cards on All Orders? This splits the current quantity into separate qty-1 orders (max {MAX_UNIT_ORDER_BURST}).</div>
        {toggle("Randomize colors on each order", randomizeEachUnitOrder, setRandomizeEachUnitOrder)}
        <div><button className="fp-btn" disabled={!draftLines.length || busy} onClick={requestBurst}>Create {Math.max(1, unitBurstCount)} individual orders</button></div>
      </>)}
      {section("Parts", <>
        <div style={caption}>
          {colorParts.length} part(s). Click a part to set filament. {modKey()}-click multi-selects; {modKey()}+Shift-click ranges.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, flexWrap: "wrap" }}>
          <button className="fp-btn fp-btn-sm" disabled={!colorParts.length || selectedPartIds.size === colorParts.length}
            onClick={() => { setSelectedPartIds(new Set(colorParts.map((p) => p.id))); setAnchor(0); }}>Select all</button>
          {selectedPartIds.size > 0 && <>
            <span style={{ fontWeight: 600 }}>{selectedPartIds.size} selected</span>
            <button className="fp-btn fp-btn-sm" onClick={() => { setSelectedPartIds(new Set()); setAnchor(null); }}>Clear</button>
            <button className="fp-btn fp-btn-sm" style={{ fontWeight: 700 }} onClick={() => { setShowPickerForSelection(true); setPickerPartId(null); }}>Set color…</button>
          </>}
          <div style={{ flex: 1 }} />
          <button className="fp-btn fp-btn-sm" style={{ fontWeight: 700 }} disabled={!colorParts.length}
            title="Assign a random library filament to each part on this product (stress-test mixes)." onClick={randomizeActiveLineFilaments}>Randomize colors</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${PART_THUMB + 16}px, 1fr))`, gap: 10, alignContent: "start", padding: "4px 0" }}>
          {colorParts.map((pt, index) => {
            const hex = hexFor(activeLine, pt);
            const sel = selectedPartIds.has(pt.id);
            return (
              <button key={pt.id} onClick={(e) => handlePartClick(e, pt, index)} aria-label={`${pt.name}, ${filamentNameFor(activeLine, pt)}`}
                style={{ all: "unset", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div style={{ width: PART_THUMB + 8, height: PART_THUMB + 8, borderRadius: 8, background: `${hex}59`, boxSizing: "border-box",
                  border: sel ? "3px solid #0a84ff" : `2px solid ${hex}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <PartThumb partName={pt.name} colorHex={hex} size={PART_THUMB} productId={activeLine.product.id} />
                </div>
                <div style={{ fontSize: 10.5, fontWeight: 600, textAlign: "center", width: PART_THUMB + 12, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{pt.name}</div>
                <div style={{ fontSize: 9, color: secondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: PART_THUMB + 12 }}>{filamentNameFor(activeLine, pt)}</div>
              </button>
            );
          })}
        </div>
      </>)}
      {validationError && section("", <div style={{ color: "#ff453a", fontSize: 13 }}>{validationError}</div>)}
    </div>
  );

  const configurePane = activeLine && product && (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* lineChromeBar */}
      <div style={{ padding: "12px 16px 4px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {draftLines.length === 1 && (
            <button style={linkBtn} onClick={() => { setPickingAdditionalLine(false); setStep("pickProduct"); }}>‹ Change product</button>
          )}
          <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>
            {draftLines.map((l, i) => {
              const sel = i === activeIndex;
              return (
                <button key={l.id} aria-label={`${l.product.name}, quantity ${qtyOf(l)}`} aria-pressed={sel} onClick={() => { if (!sel) { setActiveLineId(l.id); resetSelection(); } }}
                  style={{ borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: sel ? 600 : 400, cursor: "pointer", whiteSpace: "nowrap", color: "inherit",
                    background: sel ? "rgba(10,132,255,0.18)" : "rgba(255,255,255,0.06)", border: sel ? "1.5px solid #0a84ff" : "1.5px solid transparent" }}>
                  {l.product.name} <span style={{ color: secondary }}>×{qtyOf(l)}</span>
                </button>
              );
            })}
          </div>
          <button style={{ ...linkBtn, fontWeight: 600 }} title="Add another product to this order"
            onClick={() => { setPickingAdditionalLine(true); setStep("pickProduct"); }}>＋ Add product</button>
          {draftLines.length > 1 && (
            <button style={{ ...linkBtn, color: "#ff453a" }} title="Remove this product line" onClick={removeActiveLine}><Icon icon={Trash2} size={13} /> Remove</button>
          )}
        </div>
        {isMultiLine && <div style={{ ...caption, fontSize: 10.5, marginTop: 6 }}>One order · {draftLines.length} products · {unitBurstCount} total units</div>}
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* left column: preview only (live 3D viewport, or the color composite as a fallback) */}
        <div style={{ flex: "1 1 560px", minWidth: 440, minHeight: 0, padding: 16, display: "flex", boxSizing: "border-box" }}>
          <div
            ref={previewWellRef}
            aria-label="Color preview"
            style={{
              width: "100%",
              height: "100%",
              minWidth: 440,
              minHeight: 440,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{
              width: previewBox,
              height: previewBox,
              borderRadius: 12,
              overflow: "hidden",
              background: "rgba(208,208,208,0.85)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "none",
            }}>
              {/* 3D order builder: turn the model, click a part to set its filament; the view is this order's picture. */}
              <OrderViewport3D
                key={camKey(activeLine)}
                ref={orderViewportRef}
                product={product}
                filaments={filaments}
                partColors={colorsFor(activeLine)}
                selectedPartIds={[...selectedPartIds]}
                onPartClick={(id, mods) => {
                  const index = colorParts.findIndex((p) => p.id === id);
                  if (index >= 0) handlePartClick(mods as unknown as React.MouseEvent, colorParts[index], index);
                }}
                initialCamera={lineCamerasRef.current[camKey(activeLine)] ?? null}
                onCameraChange={(cam) => { lineCamerasRef.current[camKey(activeLine)] = cam; }}
                fallback={
                  <ProductCompositeThumb productIdOrName={product.id} parts={compositeFor(activeLine)} size={Math.max(430, previewBox - 10)} liveTint
                    inscriptionText={product.supports_custom_text ? activeLine.customText : null} />
                }
              />
            </div>
          </div>
        </div>
        <div style={{ width: 1, background: "rgba(255,255,255,0.1)", flex: "none" }} />
        <div style={{ flex: "1 1 360px", minWidth: 320, minHeight: 0 }}>{isPickerOpen ? filamentPanel : controlsPane}</div>
      </div>
    </div>
  );

  // A click outside closes only an empty order; with any work in it, ask first.
  const handleBackdropClick = () => {
    const dirty = draftLines.length > 0 || customerName.trim() !== "" || notes.trim() !== "" || isRush || isOnHold;
    if (!dirty) {
      onClose();
      return;
    }
    void askConfirm({
      title: "Discard this new order?",
      message: "The products and details you entered have not been saved.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      danger: true,
    }).then((discard) => {
      if (discard) onClose();
    });
  };

  return (
    <div className="fp-modal-backdrop" onClick={handleBackdropClick}>
      <div className="fp-modal-window" style={{
          width: "min(1400px, 94vw)",
          minWidth: "min(900px, 94vw)",
          height: "min(92vh, calc(100vh - 56px))",
          minHeight: "min(680px, 92vh)",
          maxWidth: 1400,
          maxHeight: "min(92vh, calc(100vh - 56px))",
        }}
        onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="fp-modal-header">
          <button className="fp-btn" onClick={onClose}>Cancel</button>
          <div className="fp-modal-title">{title}</div>
          {step === "configure"
            ? <button className="fp-btn fp-btn-primary" disabled={busy} onClick={() => void save()}>Create Order</button>
            : <span style={{ width: 90 }} />}
        </div>
        {step === "pickProduct" ? productPicker : configurePane}
        {showBurstConfirm && (
          <div className="fp-modal-backdrop" style={{ position: "absolute" }} onClick={() => setShowBurstConfirm(false)}>
            <div className="fp-card" style={{ maxWidth: 380, display: "flex", flexDirection: "column", gap: 10 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ fontWeight: 700 }}>Create {unitBurstCount} individual orders?</div>
              <div style={caption}>Each unit becomes its own All Orders card (qty 1). This is for test load — normal Create Order still makes one commercial order.</div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button className="fp-btn" onClick={() => setShowBurstConfirm(false)}>Cancel</button>
                <button className="fp-btn fp-btn-primary" onClick={() => void commitBurst()}>Create {unitBurstCount} orders</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
