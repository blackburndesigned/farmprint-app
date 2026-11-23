// Print areas: which part of the bed a part may use on a printer whose nozzles each reach
// only part of it, and the Settings editor's drafts. Mirrors fp-core `print_areas` tests.
import {
  addAreaDraft, areaDraftsChanged, areaDraftsProblem, areaFitWarning, areaOverBed, areaPayload, draftsFromAreas, hasPrintAreas,
  nozzleNeedForSlots, printAreaForFeeders, printAreaForSlots,
} from "../../src/views/printers/printAreas";
import { draftsFromFeeders, feederPayload } from "../../src/views/printers/printerFeeders";
import type { PrintArea, Printer, PrinterFeeder } from "../../src/types";
import { check, done } from "./check";

// Example sizes from a dual-nozzle printer; offsets left at 0 (not known here).
const areas: PrintArea[] = [
  { id: "a1", name: "Left nozzle", nozzle: "left", width_mm: 325, depth_mm: 320, height_mm: 320, x_mm: 0, y_mm: 0 },
  { id: "a2", name: "Right nozzle", nozzle: "right", width_mm: 305, depth_mm: 320, height_mm: 325, x_mm: 0, y_mm: 0 },
  { id: "a3", name: "Both nozzles", nozzle: "both", width_mm: 300, depth_mm: 320, height_mm: 320, x_mm: 0, y_mm: 0 },
];
const feeders: PrinterFeeder[] = [
  { id: "f1", name: "Feeder 1", slot_count: 4, is_dry_box: false, first_slot: 1, spools: [], nozzle: "left" },
  { id: "d1", name: "Dry box", slot_count: 2, is_dry_box: true, first_slot: null, spools: [] },
  { id: "f2", name: "Feeder 2", slot_count: 4, is_dry_box: false, first_slot: 5, spools: [], nozzle: "right" },
  { id: "f3", name: "Feeder 3", slot_count: 1, is_dry_box: false, first_slot: 9, spools: [] },
];
const p: Pick<Printer, "feeders" | "print_areas"> = { feeders, print_areas: areas };
const name = (slots: number[]) => printAreaForSlots(p, slots)?.name ?? "whole bed";

check(name([1, 4]) === "Left nozzle", "all left-nozzle slots -> left area");
check(name([5, 8]) === "Right nozzle", "all right-nozzle slots -> right area");
check(name([2, 6]) === "Both nozzles", "mixed -> both area");
check(name([9]) === "Both nozzles" && name([1, 9]) === "Both nozzles", "a slot with no nozzle -> both area");
check(name([40]) === "Both nozzles" && name([]) === "Both nozzles", "unknown slot or no slots -> both area");
check(nozzleNeedForSlots(p, [2, 3]) === "left" && nozzleNeedForSlots(p, [3, 6]) === "both", "nozzle need");
check(printAreaForFeeders(p, ["f1"])?.name === "Left nozzle" && printAreaForFeeders(p, ["f1", "f2"])?.name === "Both nozzles", "by feeder id");
check(printAreaForFeeders(p, ["d1"])?.name === "Both nozzles", "a dry box counts as unknown");

const noRight = { feeders, print_areas: areas.filter((a) => a.nozzle !== "right") };
check(printAreaForSlots(noRight, [5])?.name === "Both nozzles", "missing right area falls back to both");
const noBoth = { feeders, print_areas: areas.filter((a) => a.nozzle !== "both") };
check(printAreaForSlots(noBoth, [1, 5]) === null && printAreaForSlots(noBoth, [9]) === null, "no both area -> whole bed");
check(printAreaForSlots({ feeders, print_areas: [] }, [1]) === null, "no areas -> whole bed");
check(printAreaForSlots({ feeders }, [1]) === null, "older snapshot without print_areas -> whole bed");
check(!hasPrintAreas({}) && !hasPrintAreas({ print_areas: [] }) && hasPrintAreas(p), "hasPrintAreas");

// Editor drafts.
const drafts = draftsFromAreas(areas);
check(!areaDraftsChanged(areas, drafts), "unchanged drafts are not dirty");
check(areaDraftsProblem(drafts) === null, "valid drafts");
check(JSON.stringify(areaPayload(drafts)[1]) === JSON.stringify({ id: "a2", name: "Right nozzle", nozzle: "right", width_mm: 305, depth_mm: 320, height_mm: 325, x_mm: 0, y_mm: 0 }), "payload");
const added = addAreaDraft([]);
check(added[0].nozzle === "left" && added[0].name === "Left nozzle" && added[0].width_mm === "", "first new area is left, sizes blank");
check(addAreaDraft(added)[1].nozzle === "right" && addAreaDraft(addAreaDraft(added))[2].nozzle === "both", "next new areas are right then both");
check(areaDraftsProblem(added) === "Left nozzle: width needs to be between 1 and 2000 mm.", "blank size blocks saving");
check(areaDraftsProblem([{ ...drafts[0], height_mm: "2001" }])!.includes("height"), "too tall blocks");
check(areaDraftsProblem([{ ...drafts[0], x_mm: "-1" }])!.includes("X offset"), "negative offset blocks");
check(areaDraftsProblem([{ ...drafts[0], x_mm: "" }]) === null && areaPayload([{ ...drafts[0], x_mm: "" }])[0].x_mm === 0, "blank offset is 0");
check(areaDraftsChanged(areas, [{ ...drafts[0], width_mm: "324" }, drafts[1], drafts[2]]), "an edit is dirty");

// Fit warnings never block.
const bed = { bed_x_mm: 310, bed_y_mm: 320 };
const over = [drafts[0], { ...drafts[1], x_mm: "10" }, drafts[2]];
check(over.map((d) => `${areaOverBed(bed, d).x}/${areaOverBed(bed, d).y}`).join() === "true/false,true/false,false/false", "which areas run past the bed");
const w = areaFitWarning(bed, over);
check(w === "Left nozzle and Right nozzle run past the 310 × 320 mm bed set above. Check the bed size or the area; it still saves.", `fit warning: ${w}`);
check(areaFitWarning(bed, [drafts[2]]) === null, "an area inside the bed: no warning");
check(areaFitWarning({ bed_x_mm: null, bed_y_mm: null }, drafts) === null, "no bed size, no warning");

// Feeder nozzle survives editing, even when the picker is hidden; a dry box sends none.
const payload = feederPayload(draftsFromFeeders(feeders));
check(payload.map((f) => f.nozzle ?? "-").join() === "left,-,right,-", `feeder payload nozzles: ${payload.map((f) => f.nozzle).join()}`);
check(feederPayload([{ ...draftsFromFeeders(feeders)[1], nozzle: "left" }])[0].nozzle === null, "a dry box never sends a nozzle");

done();
