// By-object extruder clearance per printer, with the slicer's parameter names (mm). All
// optional and empty by default. Mirrors fp-core `clearance` (keep the two in step).
import type { Printer } from "../../types";

export const CLEARANCE_KEYS = [
  "extruder_clearance_radius",
  "extruder_clearance_dist_to_rod",
  "extruder_clearance_height_to_rod",
  "extruder_clearance_height_to_lid",
] as const;
export type ClearanceKey = (typeof CLEARANCE_KEYS)[number];
export type ExtruderClearance = Record<ClearanceKey, number | null>;

export const CLEARANCE_LABEL: Record<ClearanceKey, string> = {
  extruder_clearance_radius: "Max radius",
  extruder_clearance_dist_to_rod: "Distance to rod",
  extruder_clearance_height_to_rod: "Height to rod",
  extruder_clearance_height_to_lid: "Height to lid",
};

export const MAX_CLEARANCE_MM = 2000;
/** The plate view's by-object defaults (fp-mesh `DEFAULT_CLEARANCE_*`). */
export const PLATE_DEFAULT_CLEARANCE_RADIUS_MM = 35;
export const PLATE_DEFAULT_CLEARANCE_HEIGHT_MM = 30;

/** The plate view's remembered entry for a printer (shop settings `printer_plate`). */
export type PlateEntry = { clearance_radius_mm?: unknown; clearance_height_mm?: unknown } | null | undefined;

const plateNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const field = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const clearanceOf = (p: Partial<Pick<Printer, ClearanceKey>>): ExtruderClearance => ({
  extruder_clearance_radius: field(p.extruder_clearance_radius),
  extruder_clearance_dist_to_rod: field(p.extruder_clearance_dist_to_rod),
  extruder_clearance_height_to_rod: field(p.extruder_clearance_height_to_rod),
  extruder_clearance_height_to_lid: field(p.extruder_clearance_height_to_lid),
});

/** What an empty field falls back to (shown as its placeholder): the plate view's value or
 *  the plate default for radius and height to rod; nothing for the other two. */
export function clearanceFallback(key: ClearanceKey, plate: PlateEntry): number | null {
  if (key === "extruder_clearance_radius") return plateNum(plate?.clearance_radius_mm) ?? PLATE_DEFAULT_CLEARANCE_RADIUS_MM;
  if (key === "extruder_clearance_height_to_rod") return plateNum(plate?.clearance_height_mm) ?? PLATE_DEFAULT_CLEARANCE_HEIGHT_MM;
  return null;
}

export interface EffectiveClearance {
  radius: number;
  height_to_rod: number;
  dist_to_rod: number | null;
  height_to_lid: number | null;
}

/** Effective clearance (fp-core `effective_extruder_clearance`): printer field, else the
 *  plate view's remembered value, else the plate default. */
export function effectiveClearance(p: Partial<Pick<Printer, ClearanceKey>>, plate: PlateEntry): EffectiveClearance {
  const c = clearanceOf(p);
  return {
    radius: c.extruder_clearance_radius ?? (clearanceFallback("extruder_clearance_radius", plate) as number),
    height_to_rod: c.extruder_clearance_height_to_rod ?? (clearanceFallback("extruder_clearance_height_to_rod", plate) as number),
    dist_to_rod: c.extruder_clearance_dist_to_rod,
    height_to_lid: c.extruder_clearance_height_to_lid,
  };
}

/** Parses the four typed fields: blank = empty; otherwise 0–2000 mm. */
export function parseClearance(text: Record<ClearanceKey, string>): ExtruderClearance | { error: string } {
  const out = {} as ExtruderClearance;
  for (const k of CLEARANCE_KEYS) {
    const t = text[k].trim();
    if (!t) {
      out[k] = null;
      continue;
    }
    const v = Number(t.replace(",", "."));
    if (!Number.isFinite(v) || v < 0 || v > MAX_CLEARANCE_MM) return { error: `${CLEARANCE_LABEL[k]} needs to be between 0 and ${MAX_CLEARANCE_MM} mm, or empty.` };
    out[k] = v;
  }
  return out;
}
