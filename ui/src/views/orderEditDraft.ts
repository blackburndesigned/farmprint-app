/**
 * Edit Order: the New Order window filled in from an existing order, and the payload that
 * saves it (`plan_order_edit` / `apply_order_edit` in fp-core order_edit.rs). Pure helpers,
 * so the UI tests can run them without a browser.
 */
import type { FilamentSwatch, Order, OrderLine, Product } from "../types";

/** Same rule as fp-core `unit_started`: a unit that left the queue keeps its state. */
export const unitStarted = (state: string) => state !== "Queued";

/** One product line in the order window (new or loaded from an order). */
export interface OrderDraftLine {
  id: string;
  /** The order line this came from (Edit Order); absent for a new line or a new product. */
  lineId?: string;
  product: Product;
  quantityText: string;
  /** part id -> filament id (library swatch). Missing = no library match; hex in previewHex. */
  partFilaments: Record<string, string>;
  /** part id -> hex shown when no filament chosen yet. */
  previewHex: Record<string, string>;
  customText: string;
  /** Colors the line was loaded with (Edit Order), to send only the parts the user changed. */
  initialFilaments?: Record<string, string>;
}

export const draftQty = (l: { quantityText: string }) => Math.max(1, parseInt(l.quantityText, 10) || 1);

/**
 * The color a loaded line shows for a part: the filament of its first queued unit (what a
 * new color would change), else of its first unit, else the catalog default.
 */
export function lineFilamentFor(line: OrderLine, partId: string, fallback: string): string {
  const units = line.units.filter((u) => u.part_id === partId).sort((a, b) => a.unit_index - b.unit_index);
  return (units.find((u) => !unitStarted(u.state)) ?? units[0])?.filament_id || fallback;
}

/** Stand-in for a line whose product is no longer in the catalog: it stays as it is. */
function missingProduct(line: OrderLine): Product {
  return {
    id: line.product_id,
    name: line.product_name || line.item_label,
    sku: "",
    price_cents: line.unit_price_cents,
    packed_weight_oz: 0,
    default_box_name: "",
    box_cost_cents: 0,
    supports_custom_text: !!line.custom_text,
    parts: [],
  };
}

/** Draft lines for an existing order, with its products, quantities, colors and text. */
export function draftLinesFromOrder(order: Order, products: Product[], filaments: FilamentSwatch[]): OrderDraftLine[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const hexOf = new Map(filaments.map((f) => [f.id, f.hex]));
  return order.lines.map((line) => {
    const product = byId.get(line.product_id) ?? missingProduct(line);
    const partFilaments: Record<string, string> = {};
    const previewHex: Record<string, string> = {};
    for (const pt of product.parts) {
      const fil = lineFilamentFor(line, pt.id, pt.default_filament_id);
      partFilaments[pt.id] = fil;
      const unitHex = line.units.find((u) => u.part_id === pt.id && u.filament_id === fil)?.filament_hex;
      previewHex[pt.id] = hexOf.get(fil) || unitHex || "#8E8E93";
    }
    return {
      id: `line:${line.id}`,
      lineId: line.id,
      product,
      quantityText: String(Math.max(1, line.quantity)),
      partFilaments,
      previewHex,
      customText: line.custom_text || "",
      initialFilaments: { ...partFilaments },
    };
  });
}

export interface OrderEditDetails {
  customerName: string;
  customerEmail: string;
  notes: string;
  isRush: boolean;
  isOnHold: boolean;
  /** Dollars as typed; blank keeps the current charge. */
  shippingText: string;
  /** Ship-by date YYYY-MM-DD; "" clears it; undefined keeps the current one. */
  shipBy?: string;
}

/** Shipping text ("5.99", "$5", "") to cents; null when blank, NaN when not a number. */
export function shippingCents(text: string): number | null {
  const t = text.trim().replace(/^\$/, "");
  if (!t) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return NaN;
  return Math.round(parseFloat(t) * 100);
}

/** The `OrderEditInput` fp-core takes. */
export function orderEditPayload(
  order: Order,
  lines: OrderDraftLine[],
  d: OrderEditDetails,
  confirmStarted = false
) {
  const ship = shippingCents(d.shippingText);
  return {
    order_id: order.id,
    customer_name: d.customerName.trim(),
    customer_email: d.customerEmail.trim(),
    notes: d.notes.trim(),
    is_rush: d.isRush,
    is_on_hold: d.isOnHold,
    shipping_charged_cents: ship === null || Number.isNaN(ship) ? null : ship,
    ship_by: d.shipBy === undefined ? null : d.shipBy.trim(),
    confirm_started: confirmStarted,
    actor_device: "Orders · Edit Order",
    lines: lines.map((l) => {
      const keep = !!l.lineId && !!l.initialFilaments;
      const part_filaments: Record<string, string> = {};
      for (const [pid, fil] of Object.entries(l.partFilaments)) {
        // A loaded line sends only the parts whose color changed, so units of one part
        // that differ (randomized test orders) aren't all set to one color.
        if (!fil || (keep && l.initialFilaments![pid] === fil)) continue;
        part_filaments[pid] = fil;
      }
      return {
        line_id: l.lineId ?? null,
        product_id: l.product.id,
        quantity: draftQty(l),
        custom_text: l.customText.trim() || null,
        part_filaments,
      };
    }),
  };
}

/** Units of a loaded line that already started, per part id. */
export function startedByPart(order: Order | null | undefined, lineId: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  const line = lineId ? order?.lines.find((l) => l.id === lineId) : undefined;
  for (const u of line?.units ?? []) if (unitStarted(u.state)) out.set(u.part_id, (out.get(u.part_id) || 0) + 1);
  return out;
}

/** The plan fp-core returns before saving (the parts the window shows). */
export interface OrderEditPlan {
  needs_confirm: boolean;
  started_units_removed: number;
  started_color_kept: number;
  warnings: string[];
}
