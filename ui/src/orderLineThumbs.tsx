/**
 * Per-order-line pictures. Each order line keeps its OWN picture + camera, saved
 * by the 3D order builder (New Order), Re-pose (order details), or rendered once for
 * website orders. Never shared or cached per product: two orders of the same product
 * keep their own colors and angle.
 *
 * LOCAL ONLY: stored by the backend under <data>/order_thumbs/<order_id>/<line_id>.png + .json
 * (commands save_order_line_thumbnail / load_order_line_thumbnails /
 * delete_order_line_thumbnails; delete_order removes the folder). Never synced to the shop.
 *
 * Rendering itself lives in components/OrderViewport3D.tsx; this file only stores
 * and shows the results.
 */
import React, { Suspense, useEffect, useSyncExternalStore } from "react";
import { invoke } from "./tauriInvoke";
import type { FilamentSwatch, Order, OrderLine, Product } from "./types";
import type { CameraState } from "./viewportCamera";
import type { OrderThumbnailCapture, ViewCamera } from "./components/OrderViewport3D";
import { cameraFromJson } from "./components/orderModelCache";
import { OrderRePoseModal, renderOrderThumbnail } from "./lazy3D";
import { useOutlinedSrc } from "./thumbnailOutline";
import { fitBox } from "./partThumbnails";

export type OrderThumbSource = "new_order" | "re_pose" | "website" | "recolor";

export interface SavedOrderLineThumb {
  orderLineId: string;
  pngDataUrl: string;
  camera: CameraState | null;
  partColors: Record<string, string>;
  productId: string | null;
  source: OrderThumbSource | string;
  savedAt: string | null;
}

type OrderThumbMap = ReadonlyMap<string, SavedOrderLineThumb>;

// ---- tiny external store -------------------------------------------------------------
const byOrder = new Map<string, OrderThumbMap>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

function setLine(orderId: string, t: SavedOrderLineThumb) {
  const next = new Map(byOrder.get(orderId) || []);
  next.set(t.orderLineId, t);
  byOrder.set(orderId, next);
  emit();
}

function fromBackend(input: unknown): SavedOrderLineThumb | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  if (typeof row.order_line_id !== "string" || typeof row.png_data_url !== "string") return null;
  const meta = (row.meta && typeof row.meta === "object" ? row.meta : {}) as Record<string, unknown>;
  return {
    orderLineId: row.order_line_id,
    pngDataUrl: row.png_data_url,
    camera: cameraFromJson(meta.camera),
    partColors: (meta.partColors && typeof meta.partColors === "object" ? meta.partColors : {}) as Record<string, string>,
    productId: typeof meta.productId === "string" ? meta.productId : null,
    source: typeof meta.source === "string" ? meta.source : "new_order",
    savedAt: typeof meta.savedAt === "string" ? meta.savedAt : null,
  };
}

/** Loads one order's saved pictures once (cached; a failed load counts as "none saved"). */
export function ensureOrderThumbsLoaded(orderId: string): Promise<void> {
  if (!orderId || byOrder.has(orderId)) return Promise.resolve();
  const running = inflight.get(orderId);
  if (running) return running;
  const job = invoke<{ lines?: unknown[] }>("load_order_line_thumbnails", { orderId })
    .then((res) => {
      const m = new Map<string, SavedOrderLineThumb>();
      for (const row of res?.lines || []) { const t = fromBackend(row); if (t) m.set(t.orderLineId, t); }
      // Keep anything saved while the load was running.
      for (const [k, v] of byOrder.get(orderId) || []) m.set(k, v);
      byOrder.set(orderId, m);
    })
    .catch(() => { if (!byOrder.has(orderId)) byOrder.set(orderId, new Map()); })
    .finally(() => { inflight.delete(orderId); emit(); });
  inflight.set(orderId, job);
  return job;
}

/** Saves (or overwrites) one order line's picture + camera. */
export async function saveOrderLineThumb(
  orderId: string,
  orderLineId: string,
  productId: string | null,
  capture: OrderThumbnailCapture,
  source: OrderThumbSource
): Promise<void> {
  const savedAt = new Date().toISOString();
  const meta = {
    renderVersion: capture.renderVersion,
    size: capture.size,
    camera: capture.camera,
    partColors: capture.partColors,
    productId,
    source,
    savedAt,
  };
  await invoke("save_order_line_thumbnail", { orderId, orderLineId, pngDataUrl: capture.pngDataUrl, meta });
  setLine(orderId, {
    orderLineId, pngDataUrl: capture.pngDataUrl, camera: capture.camera, partColors: capture.partColors,
    productId, source, savedAt,
  });
}

/** Drops cached pictures after the order (or a line) is deleted; the backend removes the files. */
export function forgetOrderThumbs(orderId: string, orderLineId?: string) {
  const cur = byOrder.get(orderId);
  if (!cur) return;
  if (orderLineId) {
    const next = new Map(cur);
    next.delete(orderLineId);
    byOrder.set(orderId, next);
  } else {
    byOrder.delete(orderId);
  }
  emit();
}

/** Saved picture for a line: undefined while loading, null when none is saved. */
export function useOrderLineThumb(orderId: string, orderLineId: string): SavedOrderLineThumb | null | undefined {
  const map = useSyncExternalStore(subscribe, () => byOrder.get(orderId));
  useEffect(() => { void ensureOrderThumbsLoaded(orderId); }, [orderId]);
  if (!map) return undefined;
  return map.get(orderLineId) ?? null;
}

// ---- line colors / website camera ----------------------------------------------------

/** part id → hex from the line's units (the order's real filaments). */
export function lineUnitColors(line: OrderLine): Record<string, string> {
  const out: Record<string, string> = {};
  for (const u of line.units) if (u.part_id && u.filament_hex) out[u.part_id] = u.filament_hex;
  return out;
}

const hex6 = (h: string) => (h || "").replace(/^#/, "").slice(0, 6).toUpperCase();

/** True when the saved picture's colors no longer match the line (a filament was changed). */
export function thumbColorsStale(saved: SavedOrderLineThumb, line: OrderLine): boolean {
  const now = lineUnitColors(line);
  for (const [pid, hex] of Object.entries(now)) {
    const was = saved.partColors[pid];
    if (was && hex6(was) !== hex6(hex)) return true;
  }
  return false;
}

/** Website order line's customer angle (store_orders.lines[].view_camera), raw shop shape.
 *  renderOrderThumbnail / OrderRePoseModal convert it and fall back to the
 *  product angle when it is missing or broken. */
export function lineViewCamera(line: OrderLine): ViewCamera | null {
  const raw: ViewCamera | null | undefined = line.view_camera;
  return raw && typeof raw === "object" ? raw : null;
}

/** Orders that came from the shop (FarmPrint's own New Order writes "manual"). */
export function isWebsiteOrder(order: Order): boolean {
  return (order.source || "").trim().toLowerCase() !== "manual";
}

// ---- background renders (website orders, recolors): one at a time ---------------------
let renderChain: Promise<unknown> = Promise.resolve();
const attempted = new Set<string>();

function queueRender(key: string, job: () => Promise<void>) {
  if (attempted.has(key)) return;
  attempted.add(key);
  // Wait for an idle moment before each job, so a backlog at launch doesn't freeze the window.
  renderChain = renderChain.then(whenIdle).then(job).catch((e) => console.warn(`[order picture] ${key}: ${String(e)}`));
}

function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 1500 });
    else setTimeout(resolve, 50);
  });
}

function autoRender(order: Order, line: OrderLine, product: Product, filaments: FilamentSwatch[], saved: SavedOrderLineThumb | null) {
  const colors = lineUnitColors(line);
  if (!saved) {
    // Website order with no picture yet: the customer's angle when the shop sent one,
    // else the product's default angle, in the customer's colors.
    queueRender(`${order.id}:${line.id}:website`, async () => {
      const shot = await renderOrderThumbnail(product, colors, lineViewCamera(line), { filaments, layers: false, supersample: 1 });
      if (shot) await saveOrderLineThumb(order.id, line.id, product.id, shot, "website");
    });
    return;
  }
  // Filament changed after the picture was saved: redraw from the SAME saved angle.
  const sig = Object.entries(colors).sort().map(([k, v]) => `${k}=${hex6(v)}`).join(",");
  queueRender(`${order.id}:${line.id}:recolor:${sig}`, async () => {
    const shot = await renderOrderThumbnail(product, colors, saved.camera, { filaments, layers: false, supersample: 1 });
    if (shot) await saveOrderLineThumb(order.id, line.id, product.id, shot, "recolor");
  });
}

/**
 * App-level: for open orders whose pictures are already loaded, queues the background
 * renders (website lines without a picture, recolors) even while the card is scrolled
 * away. Pictures themselves load lazily: an order's saved pictures are fetched when one
 * of its cards becomes visible (OrderLinePicture), not all orders up front, so a big
 * shop no longer makes one IPC call per order at launch. Renders run one at a time.
 */
export function useOrderThumbAutoRender(orders: Order[], productById: Map<string, Product>, filaments: FilamentSwatch[]) {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const order of orders) {
        if (cancelled) return;
        const map = byOrder.get(order.id);
        if (!map) continue;
        for (const line of order.lines) {
          const product = productById.get(line.product_id);
          if (!product) continue;
          const saved = map.get(line.id) ?? null;
          if (saved ? thumbColorsStale(saved, line) : isWebsiteOrder(order)) autoRender(order, line, product, filaments, saved);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [orders, productById, filaments]);
}

// ---- display ---------------------------------------------------------------------------

/**
 * Shows an order line's own saved picture, else `fallback` (the existing composite).
 * Website lines without a picture get one rendered once in the background; a saved
 * picture whose colors no longer match the line is redrawn from its saved angle.
 */
export const OrderLinePicture: React.FC<{
  order: Order;
  line: OrderLine;
  product?: Product;
  filaments?: FilamentSwatch[];
  /** Picture side in px. */
  size: number;
  fallback: React.ReactNode;
  /** Draw LineCompositeThumb's rounded frame around the picture (order details). */
  framed?: boolean;
  /** Skip the Settings outline (printed paper). */
  noOutline?: boolean;
  /** Shrink with the parent's width, `size` px at most (unframed only). */
  fluid?: boolean;
}> = ({ order, line, product, filaments, size, fallback, framed, noOutline, fluid = false }) => {
  const saved = useOrderLineThumb(order.id, line.id);
  const stale = !!saved && thumbColorsStale(saved, line);
  const shown = useOutlinedSrc(saved && !stale ? saved.pngDataUrl : "", framed ? Math.round(size * 0.9) : size, undefined, noOutline);

  useEffect(() => {
    if (saved === undefined || !product || !filaments) return;
    if (saved === null ? isWebsiteOrder(order) : stale) autoRender(order, line, product, filaments, saved);
  }, [saved, stale, order, line, product, filaments]);

  if (!saved || stale) return <>{fallback}</>;
  const img = (
    <img
      src={shown}
      alt={line.product_name}
      draggable={false}
      style={{ ...fitBox(framed ? Math.round(size * 0.9) : size, fluid && !framed), objectFit: "contain", display: "block" }}
    />
  );
  if (!framed) return img;
  return (
    <div style={{
      width: size, height: size, borderRadius: 12, background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    }}>
      {img}
    </div>
  );
};

/**
 * Order details "Re-pose": OrderRePoseModal, opened at this line's saved camera
 * (a website line without one opens at the customer's view_camera, else the product angle).
 * Saving overwrites this line's picture + camera.
 */
export const OrderLineRePoseModal: React.FC<{
  order: Order;
  line: OrderLine;
  product: Product;
  filaments: FilamentSwatch[];
  onClose: () => void;
}> = ({ order, line, product, filaments, onClose }) => {
  const saved = useOrderLineThumb(order.id, line.id);
  return (
    <Suspense fallback={null}>
      <OrderRePoseModal
        product={product}
        filaments={filaments}
        partColors={lineUnitColors(line)}
        savedCamera={saved?.camera ?? lineViewCamera(line)}
        title={`Re-pose picture — ${line.product_name} · ${order.customer_name}`}
        onClose={onClose}
        onSave={(capture) => saveOrderLineThumb(order.id, line.id, product.id, capture, "re_pose")}
      />
    </Suspense>
  );
};
