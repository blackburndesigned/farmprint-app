// Mark Printing: same picker and request as Print!, no slicer; printer optional (Unassigned lane).
import {
  UNASSIGNED_LANE_ID,
  canConfirmPick,
  confirmedPickRequest,
  markPrintingLabel,
  printerLaneUnits,
  transitionArgs,
  unassignedLaneUnits,
} from "../../src/views/printers/markPrinting";
import type { PartUnit, TransitionRequest } from "../../src/types";
import { check, done } from "./check";

const u = (id: string, state: string, printer_id: string | null): PartUnit => ({
  id, order_id: "o1", order_code: "O1", customer_name: "C", line_id: "l1", line_label: "",
  product_id: "p1", product_name: "Product", part_id: "pt1", part_name: "Part", unit_index: 1, filament_id: "f1",
  filament_name: "Red", filament_hex: "#ff0000", filament_material: "PLA", state, printer_id, printer_name: null,
  plate_job_id: "JOB", reprint_count: 0, unit_cost: 0, print_minutes: 10, grams: 1, updated_at: "2026-11-20T10:00:00Z",
});
const printers = [{ id: "p-1", name: "Printer 1" }, { id: "p-2", name: "Printer 2" }];
const req: TransitionRequest = {
  unit_ids: ["a", "b", "c"], to_state: "Printing", printer_id: null, actor_device: "Test",
  source_surface: "Parts to Print (selection)", action_label: "Print 3 selected parts", failure_reason: null, failure_note: null,
};

// Picker: Print! needs a real printer; Mark Printing also allows "no printer yet".
check(canConfirmPick("print", "p-1", printers), "Print! with a printer picked");
check(!canConfirmPick("print", "", printers), "Print! refuses no printer");
check(!canConfirmPick("print", "gone", printers), "Print! refuses an unknown printer");
check(canConfirmPick("mark", "p-2", printers), "Mark Printing with a printer picked");
check(canConfirmPick("mark", "", printers), "Mark Printing with no printer");
check(canConfirmPick("mark", "", []), "Mark Printing works in a shop with no printers");
check(!canConfirmPick("mark", "gone", printers), "Mark Printing refuses an unknown printer id");

// Confirmed requests: one request for all parts (one job), same surface, printer as picked.
const mark = confirmedPickRequest(req, "mark", "p-2", printers);
check(mark.unit_ids.join() === "a,b,c" && mark.to_state === "Printing", "Mark Printing sends every part in one Printing request");
check(mark.printer_id === "p-2" && mark.source_surface === req.source_surface, "Mark Printing keeps the picked printer and surface");
check(mark.action_label === "Marked 3 parts Printing on Printer 2 (no slicer)", "Mark Printing Flow label names the printer");
const none = confirmedPickRequest(req, "mark", "", printers);
check(none.printer_id === null && none.action_label === "Marked 3 parts Printing, no printer yet (no slicer)", "Mark Printing with no printer");
const print = confirmedPickRequest({ ...req, action_label: "Print 3 selected parts on Printer 1" }, "print", "p-2", printers);
check(print.printer_id === "p-2" && print.action_label === "Print 3 selected parts on Printer 2", "Print! label is unchanged");
check(markPrintingLabel(1, "X") === "Marked 1 part Printing on X (no slicer)", "Singular label");

// Command args: skip_slicer only for Mark Printing; Print! args unchanged.
const pArgs = transitionArgs(req);
check(!("skip_slicer" in pArgs) && pArgs.allow_without_slicer === false && pArgs.request === req, "Print! sends no skip_slicer");
check(transitionArgs(req, { allowWithoutSlicer: true }).allow_without_slicer === true, "Mark Printing anyway still allowed");
check(transitionArgs(req, { skipSlicer: true }).skip_slicer === true, "Mark Printing sends skip_slicer");

// Lanes: Unassigned holds Printing/Staged parts with no printer or a removed printer.
const all = [u("1", "Printing", null), u("2", "Printing", "p-1"), u("3", "Staged", "gone"), u("4", "Queued", null), u("5", "Printed", null)];
check(unassignedLaneUnits(all, printers).map((x) => x.id).join() === "1,3", "Unassigned lane: no printer or removed printer, Printing/Staged only");
check(printerLaneUnits(all, "p-1").map((x) => x.id).join() === "2", "Printer lane unchanged");
check(unassignedLaneUnits([u("2", "Printing", "p-1")], printers).length === 0, "No Unassigned lane when every job has a printer");
check(!printers.some((p) => p.id === UNASSIGNED_LANE_ID), "Lane id never collides with a printer id");

done();
