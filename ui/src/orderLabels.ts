// Product labels for orders and parts. Always resolve a unit through its own
// order line (unit.line_id -> line -> product), never the order's first line.
import type { Order, OrderLine, PartUnit } from "./types";

/** The order line this unit belongs to, or undefined when the line is missing. */
export function lineForUnit(order: Order | undefined, unit: PartUnit): OrderLine | undefined {
  if (!order) return undefined;
  return order.lines.find((l) => l.id === unit.line_id);
}

/** Visible / tooltip label: "Bag Clip · Lower Arm". Uses the unit's own product. */
export function partProductLabel(unit: Pick<PartUnit, "product_name" | "part_name">): string {
  const product = (unit.product_name || "").trim();
  const part = (unit.part_name || "").trim();
  if (product && part) return `${product} · ${part}`;
  return part || product || "Part";
}

/** Product names on an order or card heading, e.g. "Pen Cup · Bag Clip ×2". */
export function orderProductHeading(
  lines: Pick<OrderLine, "product_name" | "quantity">[]
): string {
  const sums = new Map<string, number>();
  const names: string[] = [];
  for (const line of lines) {
    const name = (line.product_name || "").trim();
    if (!name) continue;
    if (!sums.has(name)) names.push(name);
    sums.set(name, (sums.get(name) || 0) + (line.quantity || 0));
  }
  return names
    .map((name) => {
      const qty = sums.get(name) || 0;
      return qty > 1 ? `${name} ×${qty}` : name;
    })
    .join(" · ");
}

/** Unique product names from units, in first-seen order. */
export function unitsProductHeading(units: Pick<PartUnit, "product_name">[]): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const unit of units) {
    const name = (unit.product_name || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.join(" · ");
}
