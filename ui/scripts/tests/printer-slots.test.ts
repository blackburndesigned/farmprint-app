// Printer filament slots are positions, not a set of colors: the same swatch can fill
// several slots, and loading or unloading one slot never merges or renumbers the others.
import {
  loadIntoNextSlot, loadedSlotCount, setSlotFilament, slotIdsByPosition, slotsHoldingSwatch, unloadSlot,
} from "../../src/views/printers/printerSlots";
import type { PrinterSlot } from "../../src/types";
import { check, done } from "./check";

const black = { id: "fil-black", name: "Black", hex: "#111111" };
const white = { id: "fil-white", name: "White", hex: "#f5f5f5" };
const slot = (slot_index: number, f: { id: string; name: string; hex: string }): PrinterSlot => ({
  slot_index, filament_id: f.id, filament_name: f.name, filament_hex: f.hex, material: "PLA",
});

// Loading the same color twice gives two slots (the bug: the picker toggled it off instead).
let ids = loadIntoNextSlot([], black.id);
ids = loadIntoNextSlot(ids, black.id);
check(ids.join() === "fil-black,fil-black", "loading the same swatch again fills a second slot");
ids = loadIntoNextSlot(ids, white.id);
check(ids.join() === "fil-black,fil-black,fil-white", "a third swatch goes in slot 3");

const loaded = [slot(1, black), slot(2, black), slot(3, white)];
check(slotIdsByPosition(loaded).join() === "fil-black,fil-black,fil-white", "slot list keeps duplicate colors in their own slots");
check(slotsHoldingSwatch(loaded, black).join() === "1,2", "black is in slots 1 and 2 (lowest first)");
check(slotsHoldingSwatch(loaded, white).join() === "3", "white is in slot 3");
check(slotsHoldingSwatch(loaded, { id: "x", name: "Red", hex: "#f00" }).length === 0, "an unloaded swatch is in no slots");
check(slotsHoldingSwatch([slot(2, { ...black, id: "fil-black-2" })], black).join() === "2", "same name and color counts as the same spool");

// Unloading one of two black slots keeps the other black slot and the other slot numbers.
const afterUnload = unloadSlot(slotIdsByPosition(loaded), 1);
check(afterUnload.join() === ",fil-black,fil-white", "unloading slot 1 leaves black in slot 2 and white in slot 3");
check(loadedSlotCount(afterUnload) === 2, "two slots still loaded");
check(loadIntoNextSlot(afterUnload, white.id).join() === "fil-white,fil-black,fil-white", "the next load fills the empty slot 1 first");
check(unloadSlot(slotIdsByPosition(loaded), 3).join() === "fil-black,fil-black", "unloading the last slot drops it off the end");

// Gaps from the core (slot 2 empty) come back as "" so slot numbers stay put.
const gappy = [slot(1, black), slot(3, black)];
check(slotIdsByPosition(gappy).join() === "fil-black,,fil-black", "an empty slot 2 stays empty between two black slots");
check(setSlotFilament(slotIdsByPosition(gappy), 2, black.id).join() === "fil-black,fil-black,fil-black", "setting slot 2 to black allows three black slots");
check(setSlotFilament(["fil-black"], 3, white.id).join() === "fil-black,,fil-white", "setting slot 3 pads slot 2 as empty");
check(setSlotFilament(["fil-black", "fil-white"], 2, "").join() === "fil-black", "clearing the last slot trims it");

done();
