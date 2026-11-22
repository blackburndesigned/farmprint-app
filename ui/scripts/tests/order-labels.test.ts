// Multi-product orders: each part is labeled with its own product, never the first line.
import { lineForUnit, orderProductHeading, partProductLabel, unitsProductHeading } from "../../src/orderLabels";
import type { Order, OrderLine, PartUnit } from "../../src/types";
import { check, done } from "./check";

const line = (id: string, product_name: string, quantity = 1, units: PartUnit[] = []): OrderLine =>
  ({
    id,
    order_id: "ord",
    product_id: id,
    product_name,
    item_label: product_name,
    quantity,
    unit_price_cents: 1000,
    custom_text: null,
    units,
  }) as OrderLine;

const unit = (id: string, line_id: string, product_name: string, part_name: string): PartUnit =>
  ({
    id,
    order_id: "ord",
    order_code: "SAMPLE-1009",
    customer_name: "Hannah L.",
    line_id,
    line_label: product_name,
    product_id: line_id,
    product_name,
    part_id: id,
    part_name,
    unit_index: 1,
    filament_id: "f",
    filament_name: "Green",
    filament_hex: "#00ff00",
    filament_material: "PLA",
    state: "Queued",
    printer_id: null,
    printer_name: null,
    plate_job_id: null,
    reprint_count: 0,
    unit_cost: 0,
    print_minutes: 0,
    grams: 0,
    updated_at: "",
  }) as PartUnit;

const cup = unit("u-cup", "line-cup", "Pen Cup", "Cup");
const arm = unit("u-arm", "line-clip", "Bag Clip", "Lower Arm");
const pin = unit("u-pin", "line-clip-2", "Bag Clip", "Hinge Pin");
const order = {
  id: "ord",
  lines: [line("line-cup", "Pen Cup", 1, [cup]), line("line-clip", "Bag Clip", 1, [arm]), line("line-clip-2", "Bag Clip", 1, [pin])],
} as Order;

check(partProductLabel(arm) === "Bag Clip · Lower Arm", "Bag Clip part is labeled with Bag Clip, not Pen Cup");
check(partProductLabel(cup) === "Pen Cup · Cup", "Pen Cup part keeps its own product");
check(partProductLabel({ product_name: "", part_name: "Lower Arm" }) === "Lower Arm", "part name only when product is missing");

check(orderProductHeading(order.lines) === "Pen Cup · Bag Clip ×2", "card heading lists every product, collapsing repeats");
check(orderProductHeading([line("a", "Pen Cup", 1)]) === "Pen Cup", "single product heading omits ×1");
check(orderProductHeading([line("a", "Pen Cup", 2)]) === "Pen Cup ×2", "single product heading shows quantity above 1");
check(orderProductHeading([]) === "", "empty lines have no heading");

check(unitsProductHeading([cup, arm, pin]) === "Pen Cup · Bag Clip", "unit heading lists unique products in first-seen order");
check(unitsProductHeading([arm, pin]) === "Bag Clip", "units from one product stay a single name");

check(lineForUnit(order, arm)?.product_name === "Bag Clip", "unit resolves to its own line");
check(lineForUnit(order, cup)?.id === "line-cup", "first-line unit still resolves by line_id");
check(lineForUnit(order, { ...arm, line_id: "missing" }) === undefined, "unknown line_id does not fall back to the first product");
check(lineForUnit(undefined, arm) === undefined, "no order means no line");

done();
