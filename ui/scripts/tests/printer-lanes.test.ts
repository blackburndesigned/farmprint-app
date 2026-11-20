// Printers board grouping: By job keeps a multi-order batch together; By order is the old split.
import { groupLaneUnits, laneCountLabel } from "../../src/views/printers/laneGroups";
import type { PartUnit } from "../../src/types";
import { check, done } from "./check";

const u = (id: string, order_id: string, plate_job_id: string | null, state = "Staged", updated_at = "2026-11-19T10:00:00Z"): PartUnit => ({
  id, order_id, order_code: order_id.toUpperCase(), customer_name: `Customer ${order_id}`, line_id: `${order_id}-l1`, line_label: "",
  product_id: "p1", product_name: "Product", part_id: "pt1", part_name: "Part", unit_index: 1, filament_id: "f1",
  filament_name: "Red", filament_hex: "#ff0000", filament_material: "PLA", state, printer_id: "printer-1", printer_name: "Printer 1",
  plate_job_id, reprint_count: 0, unit_cost: 0, print_minutes: 10, grams: 1, updated_at,
});

// One batch sent with parts from orders a, b and c, plus an older job and two loose parts.
const lane = [
  u("a1", "a", "JOB-1"), u("b1", "b", "JOB-1"), u("a2", "a", "JOB-1"), u("c1", "c", "JOB-1"),
  u("d1", "d", "JOB-0", "Staged", "2026-11-18T09:00:00Z"),
  u("x1", "a", null), u("x2", "e", null),
];

const byJob = groupLaneUnits(lane, "job");
check(byJob.length === 3, "By job: two jobs plus one Loose parts card");
check(byJob[0].key === "job:JOB-0" && byJob[1].key === "job:JOB-1", "By job: oldest job first when neither is printing");
check(byJob[1].units.map((x) => x.id).join() === "a1,b1,a2,c1", "By job: the multi-order batch stays one card, in lane order");
check(byJob[2].kind === "loose" && byJob[2].units.map((x) => x.id).join() === "x1,x2", "By job: parts with no job id go in Loose parts, last");
check(laneCountLabel(byJob, "job") === "2 jobs + loose", "By job: header counts jobs and notes loose parts");

const printingFirst = groupLaneUnits([u("d1", "d", "JOB-0"), u("a1", "a", "JOB-1", "Printing", "2026-11-19T12:00:00Z")], "job");
check(printingFirst[0].key === "job:JOB-1", "By job: a printing job comes before a staged one");

const byOrder = groupLaneUnits(lane, "order");
check(byOrder.map((g) => g.key).join() === "order:a,order:b,order:c,order:d,order:e", "By order: one card per order, in lane order (today's split)");
check(byOrder[0].units.map((x) => x.id).join() === "a1,a2,x1", "By order: an order's parts collect across jobs");
check(laneCountLabel(byOrder, "order") === "5 orders", "By order: header counts orders");
check(groupLaneUnits([], "job").length === 0 && laneCountLabel([], "job") === "0 jobs", "Idle lane: no cards");

done();
