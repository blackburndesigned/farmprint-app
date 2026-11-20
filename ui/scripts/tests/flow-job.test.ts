// Flow page: failure label with the typed note, and a plate job's parts and history.
import { failureLabel, jobHistory, jobIdForUnit } from "../../src/views/flowJob";
import type { FlowEvent } from "../../src/types";
import { check, done } from "./check";

let seq = 0;
const ev = (unit_id: string, from_state: string | null, to_state: string, prev_plate_job_id: string | null, extra: Partial<FlowEvent> = {}): FlowEvent => ({
  id: `e${++seq}`, seq, created_at: `2026-11-20T10:${String(seq).padStart(2, "0")}:00Z`, kind: "StatusChanged",
  order_id: "o1", order_code: "O1", customer_name: "Customer", line_id: "l1", item_label: null, product_id: "p1", product_name: "Product",
  part_id: "pt", part_name: "Part", unit_id, filament_name: "Red", filament_hex: "#ff0000", from_state, to_state,
  printer_id: "pr1", printer_name: "Printer 1", actor_device: "Test", source_surface: "Test", action_label: to_state,
  failure_reason: null, failure_note: null, cost_impact_cents: 0, can_undo: false, prev_plate_job_id, ...extra,
});

check(failureLabel({ failure_reason: "Other", failure_note: "Extruder Jam" }) === "Failed · Other: Extruder Jam", "typed note shows after the reason");
check(failureLabel({ failure_reason: "Other", failure_note: "Other — queued for reprint" }) === "Failed · Other", "the automatic note is left out");
check(failureLabel({ failure_reason: "Spaghetti", failure_note: "Failed on Printers" }) === "Failed · Spaghetti", "the 'Failed on …' note is left out");
check(failureLabel({ failure_reason: "Spaghetti", failure_note: "Marked Failed / Needs Reprint" }) === "Failed · Spaghetti", "the part-tile note is left out");
check(failureLabel({ failure_reason: null, failure_note: null }) === "Failed", "nothing recorded: just Failed");

// a and b staged together (job S), then printed (job P); a fails in P. c is in another job.
const events = [
  ev("a", "Queued", "Staged", null),
  ev("b", "Queued", "Staged", null),
  ev("c", "Queued", "Staged", null),
  ev("a", "Staged", "Printing", "S"),
  ev("b", "Staged", "Printing", "S"),
  ev("a", "Printing", "Queued", "P", { kind: "FailedPrint", failure_reason: "Other", failure_note: "Extruder Jam" }),
];
const units = [
  { id: "a", plate_job_id: "P" }, // failed parts keep their last job id
  { id: "b", plate_job_id: "P" },
  { id: "c", plate_job_id: "X" },
];
check(jobIdForUnit({ id: "a", plate_job_id: null }, events) === "P", "a part with no job falls back to the job it failed in");
const h = jobHistory("P", events, units);
check(h.jobIds.join() === "P,S", "Printing job follows back to its staged job");
check(h.unitIds.sort().join() === "a,b", "job parts: a and b, not c");
check(h.events.map((e) => e.id).join() === "e1,e2,e4,e5,e6", "history: both stagings, both prints and the failure, oldest first");
check(!h.events.some((e) => e.unit_id === "c"), "another job's events stay out");

done();
