// Print areas: optional parts of a printer's bed that a print can use, for printers whose
// nozzles each reach only part of the bed. Every size and offset is what the user typed;
// nothing is filled in for a printer model. No areas = the whole bed, as before.
// Mirrors fp-core `print_areas` (keep the two in step).
import type { AreaNozzle, FeederNozzle, PrintArea, Printer, PrinterFeeder } from "../../types";

export const MIN_AREA_MM = 1;
export const MAX_AREA_MM = 2000;
export const MAX_AREA_OFFSET_MM = 2000;

/** Name suggestions for the name field's datalist (the user can type anything). */
export const AREA_NAME_SUGGESTIONS = ["Left nozzle", "Right nozzle", "Both nozzles"] as const;

export const AREA_NOZZLE_LABEL: Record<AreaNozzle, string> = { left: "Left", right: "Right", both: "Both" };

/** Name used when the user leaves an area's name blank (matches fp-core). */
export const defaultAreaName = (n: AreaNozzle): string =>
  n === "left" ? "Left nozzle" : n === "right" ? "Right nozzle" : "Both nozzles";

/** Whether a printer has print areas (the feeder nozzle setting is only offered then). */
export const hasPrintAreas = (p: Pick<Printer, "print_areas"> | null | undefined): boolean => (p?.print_areas?.length ?? 0) > 0;

/** Which nozzles a part needs, from the feeders holding the slots it prints with. */
export type NozzleNeed = "left" | "right" | "both" | "unknown";

function needFrom(nozzles: readonly (FeederNozzle | undefined)[]): NozzleNeed {
  if (nozzles.length === 0 || nozzles.some((n) => !n)) return "unknown";
  const left = nozzles.includes("left");
  const right = nozzles.includes("right");
  return left && right ? "both" : left ? "left" : "right";
}

/** Nozzle need for printer slot numbers (1-based, as in `loaded_slots`). Dry boxes never count. */
export function nozzleNeedForSlots(p: Pick<Printer, "feeders">, slotIndexes: readonly number[]): NozzleNeed {
  const feeding = (p.feeders ?? []).filter((f) => !f.is_dry_box);
  const feederFor = (slot: number): PrinterFeeder | undefined =>
    feeding.find((f) => {
      const first = f.first_slot ?? 1;
      return slot >= first && slot < first + f.slot_count;
    });
  return needFrom(slotIndexes.map((s) => feederFor(s)?.nozzle));
}

/** Nozzle need for feeder ids (unknown ids and dry boxes count as unknown). */
export function nozzleNeedForFeeders(p: Pick<Printer, "feeders">, feederIds: readonly string[]): NozzleNeed {
  const feeding = (p.feeders ?? []).filter((f) => !f.is_dry_box);
  return needFrom(feederIds.map((id) => feeding.find((f) => f.id === id)?.nozzle));
}

/** The area for a nozzle need, or null for the whole bed (see `printAreaForSlots`). */
export function printAreaForNeed(p: Pick<Printer, "print_areas">, need: NozzleNeed): PrintArea | null {
  const areas = p.print_areas ?? [];
  const find = (n: AreaNozzle) => areas.find((a) => a.nozzle === n) ?? null;
  if (need === "left") return find("left") ?? find("both");
  if (need === "right") return find("right") ?? find("both");
  return find("both");
}

/**
 * The print area a part must sit in, or null for the whole bed. Same rules as fp-core
 * `print_area_for_slots`: pass the printer slot numbers the part prints with.
 * All on left-nozzle feeders -> the first "left" area; all right -> the first "right" area;
 * a mix -> the first "both" area. A missing one-nozzle area falls back to the "both" area.
 * A slot with no nozzle set (or no slots) -> the "both" area. No suitable area (and every
 * printer without print areas) -> null, the whole bed.
 * The area covers x_mm..x_mm+width_mm by y_mm..y_mm+depth_mm from the bed's front-left
 * corner; parts must be no taller than height_mm.
 */
export const printAreaForSlots = (p: Pick<Printer, "feeders" | "print_areas">, slotIndexes: readonly number[]): PrintArea | null =>
  printAreaForNeed(p, nozzleNeedForSlots(p, slotIndexes));

/** `printAreaForSlots` keyed by feeder ids instead of slot numbers. */
export const printAreaForFeeders = (p: Pick<Printer, "feeders" | "print_areas">, feederIds: readonly string[]): PrintArea | null =>
  printAreaForNeed(p, nozzleNeedForFeeders(p, feederIds));

// --- Editing ----------------------------------------------------------------------

/** One area as typed; numbers stay text until saved so a half-typed value isn't lost. */
export interface PrintAreaDraft {
  id?: string;
  name: string;
  nozzle: AreaNozzle;
  width_mm: string;
  depth_mm: string;
  height_mm: string;
  x_mm: string;
  y_mm: string;
}

const txt = (n: number) => (Number.isFinite(n) ? String(n) : "");

export const draftsFromAreas = (areas: readonly PrintArea[] | undefined): PrintAreaDraft[] =>
  (areas ?? []).map((a) => ({
    id: a.id, name: a.name, nozzle: a.nozzle,
    width_mm: txt(a.width_mm), depth_mm: txt(a.depth_mm), height_mm: txt(a.height_mm), x_mm: txt(a.x_mm), y_mm: txt(a.y_mm),
  }));

/** Adds an area for the first nozzle scope not used yet (left, right, both), sizes blank. */
export function addAreaDraft(drafts: readonly PrintAreaDraft[]): PrintAreaDraft[] {
  const used = new Set(drafts.map((d) => d.nozzle));
  const nozzle: AreaNozzle = (["left", "right", "both"] as const).find((n) => !used.has(n)) ?? "both";
  return [...drafts, { name: defaultAreaName(nozzle), nozzle, width_mm: "", depth_mm: "", height_mm: "", x_mm: "0", y_mm: "0" }];
}

const num = (s: string): number => (s.trim() === "" ? NaN : Number(s.trim()));

/** A problem that stops the list from saving, or null. */
export function areaDraftsProblem(drafts: readonly PrintAreaDraft[]): string | null {
  for (const [i, d] of drafts.entries()) {
    const label = d.name.trim() || `Print area ${i + 1}`;
    for (const [what, v] of [["width", d.width_mm], ["depth", d.depth_mm], ["height", d.height_mm]] as const) {
      const n = num(v);
      if (!Number.isFinite(n) || n < MIN_AREA_MM || n > MAX_AREA_MM) return `${label}: ${what} needs to be between ${MIN_AREA_MM} and ${MAX_AREA_MM} mm.`;
    }
    for (const [what, v] of [["X offset", d.x_mm], ["Y offset", d.y_mm]] as const) {
      const n = v.trim() === "" ? 0 : Number(v.trim());
      if (!Number.isFinite(n) || n < 0 || n > MAX_AREA_OFFSET_MM) return `${label}: ${what} needs to be between 0 and ${MAX_AREA_OFFSET_MM} mm.`;
    }
  }
  return null;
}

/** The `set_printer_print_areas` payload (assumes `areaDraftsProblem` is null). */
export const areaPayload = (drafts: readonly PrintAreaDraft[]) =>
  drafts.map((d) => ({
    id: d.id ?? null,
    name: d.name.trim(),
    nozzle: d.nozzle,
    width_mm: num(d.width_mm),
    depth_mm: num(d.depth_mm),
    height_mm: num(d.height_mm),
    x_mm: d.x_mm.trim() === "" ? 0 : Number(d.x_mm.trim()),
    y_mm: d.y_mm.trim() === "" ? 0 : Number(d.y_mm.trim()),
  }));

export const areaDraftsChanged = (areas: readonly PrintArea[] | undefined, drafts: readonly PrintAreaDraft[]): boolean =>
  JSON.stringify(areaPayload(draftsFromAreas(areas))) !== JSON.stringify(areaPayload(drafts));

/** Which drafts run past the bed width (`x`) or depth (`y`). Never blocks saving; all false
 *  when the bed size is unset. */
export function areaOverBed(bed: Pick<Printer, "bed_x_mm" | "bed_y_mm">, d: PrintAreaDraft): { x: boolean; y: boolean } {
  const x = d.x_mm.trim() === "" ? 0 : Number(d.x_mm), y = d.y_mm.trim() === "" ? 0 : Number(d.y_mm);
  const w = num(d.width_mm), dep = num(d.depth_mm);
  return {
    x: !!bed.bed_x_mm && Number.isFinite(w) && Number.isFinite(x) && x + w > bed.bed_x_mm + 1e-6,
    y: !!bed.bed_y_mm && Number.isFinite(dep) && Number.isFinite(y) && y + dep > bed.bed_y_mm + 1e-6,
  };
}

/** One warning line (never blocking) naming the areas that run past the bed, or null. */
export function areaFitWarning(bed: Pick<Printer, "bed_x_mm" | "bed_y_mm">, drafts: readonly PrintAreaDraft[]): string | null {
  const names = drafts
    .map((d, i) => ({ d, i, o: areaOverBed(bed, d) }))
    .filter(({ o }) => o.x || o.y)
    .map(({ d, i }) => d.name.trim() || `Print area ${i + 1}`);
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const verb = names.length === 1 ? "runs" : "run";
  return `${list} ${verb} past the ${bed.bed_x_mm ?? "?"} × ${bed.bed_y_mm ?? "?"} mm bed set above. Check the bed size or the area; it still saves.`;
}
