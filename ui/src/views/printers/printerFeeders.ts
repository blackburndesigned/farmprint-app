// A printer's feeders as the UI shows and edits them. Feeders are named units holding
// spools, each with its own slot count. Feeders that feed the printer only group the
// printer's slot numbers (slot N is still filament N in the slicer); a dry box holds
// spools that are not loaded and has no slot numbers. Names are whatever the user types.
import type { Printer, PrinterFeeder, PrinterSlot } from "../../types";
import { setSlotFilament, slotIdsByPosition } from "./printerSlots";

/** Slots in the default feeder when fewer are loaded (matches fp-core). */
export const DEFAULT_FEEDER_SLOTS = 4;
/** Most slots one feeder can have (matches fp-core). */
export const MAX_FEEDER_SLOTS = 64;

/** The printer's feeders; a snapshot without them (older build, Unassigned lane) gets
 *  one default feeder holding the loaded slots, the same way fp-core reads old data. */
export function feedersOf(p: Pick<Printer, "id" | "loaded_slots" | "feeders">): PrinterFeeder[] {
  if (p.feeders && p.feeders.length > 0) return p.feeders;
  const loaded = [...(p.loaded_slots ?? [])].filter((s) => s.slot_index >= 1).sort((a, b) => a.slot_index - b.slot_index);
  const highest = loaded.length ? loaded[loaded.length - 1].slot_index : 0;
  return [{
    id: `${p.id}-feeder-1`, name: "Feeder 1", slot_count: Math.max(highest, DEFAULT_FEEDER_SLOTS),
    is_dry_box: false, note: null, first_slot: 1, spools: loaded, auto: true,
  }];
}

export interface FeederCell {
  /** 1-based position inside the feeder. */
  position: number;
  /** Printer slot number; null in a dry box. */
  slotNumber: number | null;
  spool: PrinterSlot | null;
}

/** Every slot of a feeder in order, empty ones included. */
export function feederCells(f: PrinterFeeder): FeederCell[] {
  const first = f.is_dry_box ? null : (f.first_slot ?? 1);
  const count = Math.max(0, Math.trunc(f.slot_count));
  const cells: FeederCell[] = [];
  for (let k = 1; k <= count; k++) {
    const slotNumber = first === null ? null : first + k - 1;
    const key = slotNumber ?? k;
    cells.push({ position: k, slotNumber, spool: f.spools.find((s) => s.slot_index === key) ?? null });
  }
  return cells;
}

/** Slots in feeders that feed the printer (dry boxes left out). */
export const feedingCapacity = (feeders: readonly PrinterFeeder[]): number =>
  feeders.filter((f) => !f.is_dry_box).reduce((n, f) => n + Math.max(0, Math.trunc(f.slot_count)), 0);

/** Short caption: "Slots 1–4", "Slot 5", or "Dry box · 2 slots". */
export function feederCaption(f: PrinterFeeder): string {
  const n = Math.max(0, Math.trunc(f.slot_count));
  if (f.is_dry_box) return `Dry box · ${n} slot${n === 1 ? "" : "s"}`;
  const first = f.first_slot ?? 1;
  return n === 1 ? `Slot ${first}` : `Slots ${first}–${first + n - 1}`;
}

/** Loads a swatch into the first empty feeding slot. Null when every feeding slot is full. */
export function loadIntoFeeders(ids: readonly string[], feeders: readonly PrinterFeeder[], filamentId: string): string[] | null {
  const cap = feedingCapacity(feeders);
  for (let k = 1; k <= cap; k++) {
    if (!ids[k - 1]) return setSlotFilament(ids, k, filamentId);
  }
  return null;
}

/** A dry box's spools by position ("" empty), for `set_dry_box_spools`. */
export const dryBoxIds = (f: PrinterFeeder): string[] => slotIdsByPosition(f.spools);

// --- Editing the feeder list -------------------------------------------------------

export interface FeederDraft {
  /** Existing feeder id (keeps its spools); absent for a new feeder. */
  id?: string;
  name: string;
  slot_count: number;
  is_dry_box: boolean;
  note: string;
}

export const draftsFromFeeders = (feeders: readonly PrinterFeeder[]): FeederDraft[] =>
  feeders.map((f) => ({ id: f.id, name: f.name, slot_count: f.slot_count, is_dry_box: f.is_dry_box, note: f.note ?? "" }));

/** Adds a feeder named "Feeder N" with the first unused N. */
export function addFeederDraft(drafts: readonly FeederDraft[]): FeederDraft[] {
  const taken = new Set(drafts.map((d) => d.name.trim().toLowerCase()));
  let n = drafts.length + 1;
  while (taken.has(`feeder ${n}`)) n++;
  return [...drafts, { name: `Feeder ${n}`, slot_count: DEFAULT_FEEDER_SLOTS, is_dry_box: false, note: "" }];
}

/** Moves one feeder up (-1) or down (+1); out-of-range moves change nothing. */
export function moveFeederDraft(drafts: readonly FeederDraft[], index: number, dir: -1 | 1): FeederDraft[] {
  const to = index + dir;
  if (index < 0 || index >= drafts.length || to < 0 || to >= drafts.length) return [...drafts];
  const out = [...drafts];
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}

/** A problem that stops the list from saving, or null. */
export function feederDraftsProblem(drafts: readonly FeederDraft[]): string | null {
  if (drafts.length === 0) return "A printer needs at least one feeder.";
  for (const [i, d] of drafts.entries()) {
    const n = Number(d.slot_count);
    if (!Number.isInteger(n) || n < 1 || n > MAX_FEEDER_SLOTS) {
      return `${d.name.trim() || `Feeder ${i + 1}`} needs between 1 and ${MAX_FEEDER_SLOTS} slots.`;
    }
  }
  return null;
}

/** Spools that saving these drafts would unload: removed feeders and slots cut off the end. */
export function spoolsUnloadedBy(feeders: readonly PrinterFeeder[], drafts: readonly FeederDraft[]): number {
  let lost = 0;
  for (const f of feeders) {
    const d = drafts.find((x) => x.id === f.id);
    const base = f.is_dry_box ? 1 : (f.first_slot ?? 1);
    for (const s of f.spools) {
      if (!d || s.slot_index - base >= Number(d.slot_count)) lost++;
    }
  }
  return lost;
}

/** The `set_printer_feeders` payload. */
export const feederPayload = (drafts: readonly FeederDraft[]) =>
  drafts.map((d) => ({
    id: d.id ?? null,
    name: d.name.trim(),
    slot_count: Math.trunc(Number(d.slot_count)),
    is_dry_box: d.is_dry_box,
    note: d.note.trim() || null,
  }));

/** Whether the drafts differ from the saved feeders (auto feeders count as unsaved). */
export function feederDraftsChanged(feeders: readonly PrinterFeeder[], drafts: readonly FeederDraft[]): boolean {
  const saved = feeders.filter((f) => !f.auto);
  if (saved.length !== feeders.length) return true;
  const a = JSON.stringify(feederPayload(draftsFromFeeders(feeders)));
  return a !== JSON.stringify(feederPayload(drafts));
}
