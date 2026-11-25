// Edit Order: the order window filled in from an order, and the payload Save Changes sends.
import { draftLinesFromOrder, lineFilamentFor, orderEditPayload, shippingCents, startedByPart } from "../../src/views/orderEditDraft";
import type { FilamentSwatch, Order, OrderLine, PartUnit, Product } from "../../src/types";
import { check, done } from "./check";

const fil = (id: string, hex: string) => ({ id, name: id, brand: "B", material: "PLA", hex }) as unknown as FilamentSwatch;
const filaments = [fil("red", "#FF0000"), fil("blue", "#0000FF"), fil("white", "#FFFFFF")];
const part = (id: string, def: string, sort: number) =>
  ({ id, product_id: "p1", name: id, is_tracked: true, is_color_only: false, default_filament_id: def, grams: 1, print_minutes: 1, unit_cost: 1, mesh_file: "", sort_order: sort });
const product: Product = {
  id: "p1", name: "Widget", sku: "W", price_cents: 1000, packed_weight_oz: 1, default_box_name: "", box_cost_cents: 0,
  supports_custom_text: true, parts: [part("base", "red", 0), part("lid", "blue", 1)],
} as unknown as Product;
const unit = (id: string, partId: string, idx: number, state: string, filament: string): PartUnit =>
  ({ id, part_id: partId, unit_index: idx, state, filament_id: filament, filament_hex: "#123456" }) as unknown as PartUnit;
const line: OrderLine = {
  id: "l1", order_id: "o1", product_id: "p1", product_name: "Widget", item_label: "Widget", quantity: 2, unit_price_cents: 1000,
  custom_text: "Ada",
  units: [
    unit("u1", "base", 1, "Printed", "red"),
    unit("u2", "lid", 1, "Queued", "blue"),
    unit("u3", "base", 2, "Queued", "white"),
    unit("u4", "lid", 2, "Queued", "blue"),
  ],
};
const gone: OrderLine = { ...line, id: "l2", product_id: "gone", product_name: "Old Thing", quantity: 1, custom_text: null, units: [] };
const order = {
  id: "o1", order_code: "FP-1", customer_name: "Sam", customer_email: "s@example.com", source: "website", remote_id: "r1",
  is_rush: true, is_on_hold: false, notes: "Gift", shipping_charged_cents: 599, lines: [line, gone],
} as unknown as Order;

check(lineFilamentFor(line, "base", "red") === "white", "a part shows its first queued unit's color");
check(lineFilamentFor(line, "lid", "red") === "blue", "lid color from its units");
check(lineFilamentFor(line, "other", "red") === "red", "no units: catalog default");

const drafts = draftLinesFromOrder(order, [product], filaments);
check(drafts.length === 2, "one draft line per order line");
const d = drafts[0];
check(d.lineId === "l1" && d.product.id === "p1" && d.quantityText === "2" && d.customText === "Ada", "line, product, quantity and inscription filled in");
check(d.partFilaments.base === "white" && d.partFilaments.lid === "blue", "colors filled in");
check(d.previewHex.base === "#FFFFFF", "preview uses the library color");
check(drafts[1].product.name === "Old Thing" && drafts[1].product.parts.length === 0, "a line whose product left the catalog stays");

// Unchanged: no colors sent for loaded lines, quantities and ids as they were.
const same = orderEditPayload(order, drafts, { customerName: " Sam ", customerEmail: "s@example.com", notes: "Gift", isRush: true, isOnHold: false, shippingText: "5.99" });
check(same.order_id === "o1" && same.customer_name === "Sam" && same.shipping_charged_cents === 599, "details sent");
check(same.lines[0].line_id === "l1" && same.lines[0].quantity === 2 && Object.keys(same.lines[0].part_filaments).length === 0, "unchanged line sends no colors");
check(same.lines[0].custom_text === "Ada" && same.lines[1].custom_text === null, "inscription sent, blank = none");
check(same.confirm_started === false, "no confirmation by default");

// A changed color is sent for that part only; a new line sends all its colors.
const edited = [
  { ...d, quantityText: "3", partFilaments: { ...d.partFilaments, lid: "red" } },
  { id: "n", product, quantityText: "1", partFilaments: { base: "red", lid: "blue" }, previewHex: {}, customText: "" },
];
const p2 = orderEditPayload(order, edited, { customerName: "Sam", customerEmail: "", notes: "", isRush: false, isOnHold: false, shippingText: "" }, true);
check(JSON.stringify(p2.lines[0].part_filaments) === JSON.stringify({ lid: "red" }), "only the changed part's color is sent");
check(p2.lines[0].quantity === 3, "new quantity");
check(p2.lines[1].line_id === null && Object.keys(p2.lines[1].part_filaments).length === 2, "new line sends every color");
check(p2.shipping_charged_cents === null && p2.confirm_started, "blank shipping keeps the charge; confirmation passed on");

check(same.ship_by === null, "no ship-by in details keeps the current one");
const p3 = orderEditPayload(order, drafts, { customerName: "Sam", customerEmail: "", notes: "", isRush: false, isOnHold: false, shippingText: "", shipBy: "2026-12-01" });
const p4 = orderEditPayload(order, drafts, { customerName: "Sam", customerEmail: "", notes: "", isRush: false, isOnHold: false, shippingText: "", shipBy: "" });
check(p3.ship_by === "2026-12-01" && p4.ship_by === "", "ship-by date sent; blank clears it");

check(shippingCents("") === null && shippingCents("$5") === 500 && shippingCents("5.5") === 550 && Number.isNaN(shippingCents("abc")), "shipping text");

const started = startedByPart(order, "l1");
check(started.get("base") === 1 && !started.has("lid"), "started parts per part");
check(startedByPart(order, undefined).size === 0, "new line: nothing started");

done();
