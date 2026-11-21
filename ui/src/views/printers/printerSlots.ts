// A printer's filament slots as the UI edits them. Index k of a slot list is slot k + 1
// (Settings shows "Slot 1"); "" is an empty slot. Slots are positions, not a set of colors:
// the same swatch can sit in several slots (two spools of black in an AMS), and unloading
// one slot leaves the other slots on their own numbers. The core keeps that numbering too
// (printer_slots is keyed by printer and slot number, never by filament).
import type { FilamentSwatch, PrinterSlot } from "../../types";

/** Slot list from a printer's loaded slots, by slot number; gaps come back as "". */
export function slotIdsByPosition(slots: readonly PrinterSlot[]): string[] {
  const ids: string[] = [];
  for (const s of slots) {
    const pos = Math.trunc(s.slot_index) - 1;
    if (pos < 0 || !s.filament_id) continue;
    while (ids.length < pos) ids.push("");
    ids[pos] = s.filament_id;
  }
  return ids;
}

const trimEmptyTail = (ids: string[]): string[] => {
  const out = [...ids];
  while (out.length > 0 && !out[out.length - 1]) out.pop();
  return out;
};

/** Loads a swatch into the first empty slot, or a new slot at the end. Never dedupes. */
export function loadIntoNextSlot(ids: readonly string[], filamentId: string): string[] {
  const out = [...ids];
  const free = out.findIndex((x) => !x);
  if (free >= 0) out[free] = filamentId;
  else out.push(filamentId);
  return out;
}

/** Empties one slot (1-based). Other slots keep their numbers; empty slots at the end drop off. */
export function unloadSlot(ids: readonly string[], slotNumber: number): string[] {
  return trimEmptyTail(ids.map((x, k) => (k === slotNumber - 1 ? "" : x)));
}

/** Puts a swatch (or "" for empty) in one slot (1-based). */
export function setSlotFilament(ids: readonly string[], slotNumber: number, filamentId: string): string[] {
  const out = [...ids];
  while (out.length < slotNumber) out.push("");
  out[slotNumber - 1] = filamentId;
  return trimEmptyTail(out);
}

/** Whether a loaded slot holds this swatch (same id, or same name and color). */
export function slotHoldsSwatch(slot: PrinterSlot, swatch: Pick<FilamentSwatch, "id" | "name" | "hex">): boolean {
  return slot.filament_id === swatch.id || (slot.filament_name === swatch.name && slot.filament_hex === swatch.hex);
}

/** Slot numbers holding this swatch, lowest first; empty when it isn't loaded. */
export function slotsHoldingSwatch(slots: readonly PrinterSlot[], swatch: Pick<FilamentSwatch, "id" | "name" | "hex">): number[] {
  return slots.filter((s) => slotHoldsSwatch(s, swatch)).map((s) => s.slot_index).sort((a, b) => a - b);
}

/** Number of slots in use (empty slots don't count). */
export const loadedSlotCount = (ids: readonly string[]): number => ids.filter(Boolean).length;
