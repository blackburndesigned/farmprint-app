// Feeders group a printer's slot numbers without changing them; a dry box holds spools
// that are not loaded. Older snapshots without feeders read as one default feeder.
import {
  addFeederDraft, draftsFromFeeders, feederBrandLine, feederCaption, feederCells, feederDraftsChanged, feederDraftsProblem,
  feederPayload, feedersOf, feedingCapacity, loadIntoFeeders, moveFeederDraft, slotChipText, slotHoverTitle, spoolsUnloadedBy, swatchRing,
} from "../../src/views/printers/printerFeeders";
import type { PrinterFeeder, PrinterSlot } from "../../src/types";
import { check, done } from "./check";

const slot = (slot_index: number, id: string, extra: Partial<PrinterSlot> = {}): PrinterSlot => ({
  slot_index, filament_id: id, filament_name: id, filament_hex: "#123456", material: "PLA", ...extra,
});

// Old snapshot: no feeders field.
const legacy = feedersOf({ id: "p1", loaded_slots: [slot(3, "b"), slot(1, "a")] });
check(legacy.length === 1 && !!legacy[0].auto, "a printer without feeders gets one default feeder");
check(legacy[0].slot_count === 4 && legacy[0].first_slot === 1, "the default feeder has 4 slots from slot 1");
check(feederCells(legacy[0]).map((c) => c.spool?.filament_id ?? "").join() === "a,,b,", "cells keep empty slot 2 and 4");
check(feedersOf({ id: "p", loaded_slots: [slot(6, "x")] })[0].slot_count === 6, "the default feeder grows to the highest loaded slot");

const feeders: PrinterFeeder[] = [
  { id: "f1", name: "Left", slot_count: 2, is_dry_box: false, first_slot: 1, spools: [slot(1, "a"), slot(2, "b")] },
  { id: "d1", name: "Box", slot_count: 3, is_dry_box: true, first_slot: null, spools: [slot(2, "c")] },
  { id: "f2", name: "Right", slot_count: 2, is_dry_box: false, first_slot: 3, spools: [slot(4, "d")] },
];
check(feedingCapacity(feeders) === 4, "dry boxes do not add printer slots");
check(feederCells(feeders[2]).map((c) => c.slotNumber).join() === "3,4", "the second feeder holds slots 3 and 4");
check(feederCells(feeders[1]).map((c) => `${c.slotNumber}:${c.spool?.filament_id ?? ""}`).join() === "null:,null:c,null:", "a dry box has positions, no slot numbers");
check(feederCaption(feeders[0]) === "Slots 1–2" && feederCaption(feeders[1]) === "Dry box · 3 slots", "captions");

const branded: PrinterFeeder = {
  ...feeders[0],
  spools: [
    slot(1, "a", { brand: "Northline", material: "PLA", filament_name: "Matte Black" }),
    slot(2, "b", { brand: "Northline", material: "PETG", filament_name: "Signal Red" }),
  ],
};
check(feederBrandLine(branded) === "Northline", "one brand is listed once");
check(feederBrandLine({ ...branded, spools: [...branded.spools, slot(3, "c", { brand: "River", material: "PLA" })] }) === "Northline, River", "distinct brands stay in first-seen order");
check(feederBrandLine({ ...feeders[0], spools: [slot(1, "a", { brand: "" }), slot(2, "b", { brand: "  " })] }) === "No brand", "blank brands show as No brand");
check(feederBrandLine({ ...feeders[0], spools: [] }) === "", "an empty feeder has no brand line");
check(
  slotHoverTitle(branded, { position: 1, slotNumber: 1, spool: branded.spools[0] }) ===
    "Left · Slot 1: Northline · PLA · Matte Black",
  "hover names brand, type, color and slot",
);
check(
  slotHoverTitle(feeders[1], { position: 2, slotNumber: null, spool: feeders[1].spools[0] }) ===
    "Box · dry box: No brand · PLA · c",
  "a dry box hover says dry box and has no slot number",
);
check(
  slotHoverTitle(feeders[0], { position: 1, slotNumber: 1, spool: null }) === "Left · Slot 1: Empty",
  "an empty slot hover says Empty",
);

// Slot chips: type and brand sit with the swatch; blanks read clearly.
check(JSON.stringify(slotChipText(branded.spools[1])) === JSON.stringify({ type: "PETG", brand: "Northline" }), "a chip shows the spool's type and brand");
check(slotChipText(slot(1, "a", { brand: " ", material: " " })).brand === "No brand", "a chip with no brand says No brand");
check(slotChipText(slot(1, "a", { material: "" })).type === "\u2014", "a chip with no type shows a dash");
check(slotChipText(null).type === "Empty" && slotChipText(null).brand === "", "an empty chip says Empty");
check(swatchRing("#FFFFFF") === "light" && swatchRing("#f5f5f0") === "light", "near-white swatches get a dark ring");
check(swatchRing("#000000") === "dark" && swatchRing("#111") === "dark", "near-black swatches get a light ring");
check(swatchRing("#2563eb") === null && swatchRing("#d97706cc") === null, "mid colors need no ring");
check(swatchRing("") === null && swatchRing("nope") === null, "unreadable colors get no ring");


// Loading goes to the first empty feeding slot and never past the last feeder.
check(loadIntoFeeders(["a", "b", "", "d"], feeders, "e")?.join() === "a,b,e,d", "fills empty slot 3");
check(loadIntoFeeders(["a", "b", "e", "d"], feeders, "f") === null, "full feeders refuse");

// Editing.
let drafts = draftsFromFeeders(feeders);
check(!feederDraftsChanged(feeders, drafts), "unchanged drafts are not dirty");
check(feederDraftsChanged(legacy, draftsFromFeeders(legacy)), "an auto feeder counts as unsaved");
drafts = addFeederDraft(drafts);
check(drafts[3].name === "Feeder 4" && drafts[3].id === undefined && drafts[3].slot_count === 4, "a new feeder gets a neutral name");
check(addFeederDraft([{ name: "Feeder 2", slot_count: 1, is_dry_box: false, note: "" }])[1].name === "Feeder 3", "names don't repeat");
check(moveFeederDraft(drafts, 0, -1)[0].id === "f1", "moving the first feeder up does nothing");
check(moveFeederDraft(drafts, 0, 1).map((d) => d.id ?? "new").join() === "d1,f1,f2,new", "move down");
check(feederDraftsProblem([]) !== null, "an empty list cannot save");
check(feederDraftsProblem([{ name: "X", slot_count: 0, is_dry_box: false, note: "" }]) !== null, "0 slots cannot save");
check(feederDraftsProblem(drafts) === null, "valid drafts save");
// Shrinking Left to 1 slot drops its slot 2 spool; removing Right drops slot 4.
const shrunk = drafts.filter((d) => d.id !== "f2").map((d) => (d.id === "f1" ? { ...d, slot_count: 1 } : d));
check(spoolsUnloadedBy(feeders, shrunk) === 2, "two spools would be unloaded");
check(spoolsUnloadedBy(feeders, draftsFromFeeders(feeders)) === 0, "no change unloads nothing");
const payload = feederPayload([{ id: "f1", name: "  Left ", slot_count: 2, is_dry_box: false, note: "  " }]);
check(payload[0].name === "Left" && payload[0].note === null && payload[0].id === "f1", "payload trims names and blank notes");

done();
