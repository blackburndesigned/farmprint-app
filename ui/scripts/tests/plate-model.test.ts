import {
  angleDelta,
  biggerThanBed,
  clearanceFieldsOf,
  reachFromPartArea,
  DEFAULT_SETTINGS,
  plateEntryOf,
  convexOverlap,
  effectiveOrder,
  fitHeadline,
  History,
  layoutFor,
  liveProblems,
  normalizeSettings,
  offsetOutline,
  removeFromJob,
  reorder,
  areaShading,
  outOfAreaMessage,
  reachOf,
  type PlateAreas,
  type PlatePart,
  type V2,
} from "../../src/views/printers/plate/plateModel";
import { check, done } from "./check";
import { printAreaForSlots } from "../../src/views/printers/printAreas";
import type { PrintArea, PrinterFeeder } from "../../src/types";
import { PLATE_DEFAULT_CLEARANCE_HEIGHT_MM, PLATE_DEFAULT_CLEARANCE_RADIUS_MM } from "../../src/views/printers/extruderClearance";


const sq = (s: number): V2[] => [[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]];
const part = (id: string, x: number, y: number, size = 20, plate = 0): PlatePart => ({
  unit_id: id,
  mesh_key: "m",
  name: id,
  product_name: "",
  order_code: "",
  customer_name: "",
  hex: "#ff0000",
  filament_name: "",
  orientation: [0, 0, 0, 1],
  footprint: { hull: sq(size), height: 10, origin: [0, 0, 0], area: size * size },
  placement: { plate, x, y, rot_deg: 0 },
});
const bed = { width_mm: 100, depth_mm: 100 };

check(convexOverlap(sq(10), sq(10)), "identical squares overlap");
check(!convexOverlap(sq(10), sq(10).map(([x, y]) => [x + 10, y] as V2)), "touching squares don't overlap");
check(!convexOverlap(sq(10), sq(10).map(([x, y]) => [x + 11, y] as V2)), "apart squares don't overlap");

const live = liveProblems([part("a", 20, 20), part("b", 30, 20), part("c", 95, 50), part("d", 30, 20, 20, 1)], 0, bed);
check(live.hit.has("a") && live.hit.has("b") && !live.hit.has("d"), "drag check: overlap on this plate only");
check(live.off.has("c") && !live.off.has("a"), "drag check: off the bed");

check(reorder([["a", "b", "c"]], 0, "c", 0).join() === "c,a,b", "reorder moves to the front");
const parts = [part("a", 20, 20), part("b", 60, 20), part("c", 20, 60, 20, 1)];
check(JSON.stringify(effectiveOrder(parts, [["b", "a"], ["c"]], [["a", "b"], ["c"]])) === JSON.stringify([["b", "a"], ["c"]]), "user print order is kept");
check(JSON.stringify(effectiveOrder(parts, [["b"]], [["a", "b"], ["c"]])) === JSON.stringify([["a", "b"], ["c"]]), "stale user order falls back to the check's");

check(removeFromJob(parts, new Set(["a"])).length === 2, "delete removes from this job");
check(removeFromJob(parts, new Set(["a", "b", "c"])).length === 3, "a job never ends up empty");

check(fitHeadline({ fits: true, plates: 1, off_plate: [], collisions: [], too_tall: [] }).tone === "ok", "fits on one plate");
check(fitHeadline({ fits: true, plates: 2, off_plate: [], collisions: [], too_tall: [] }).text === "Needs 2 plates", "needs 2 plates");
check(fitHeadline({ fits: false, plates: 1, off_plate: [], collisions: [["a", "b"]], too_tall: [] }).tone === "bad", "overlap is red");

check(angleDelta(350, 10) === 20 && angleDelta(10, 350) === -20, "tweens turn the short way");
const s = normalizeSettings({ spacing_mm: -3, sequence: "by_object", auto_rotate: false });
check(s.spacing_mm === 5 && s.sequence === "by_object" && !s.auto_rotate && s.clearance_radius_mm === 35, "settings are sanitized with defaults");

const grown = offsetOutline(sq(10), 5);
check(grown.every(([x, y]) => Math.max(Math.abs(x), Math.abs(y)) <= 10.0001) && grown.some(([x]) => Math.abs(x - 10) < 1e-6), "clearance capsule grows the outline by r");

check(biggerThanBed([part("big", 50, 50, 150)], bed).join() === "big", "a part wider than the bed is flagged");
const lay = layoutFor(parts, [["a", "b"], ["c"]]);
check(lay.parts.length === 3 && lay.parts[2].placement.plate === 1, "layout carries every part's plate and spot");
const h = new History();
const s0 = { parts: [part("a", 10, 10)], plateCount: 1, order: null };
const s1 = { parts: [part("a", 50, 10)], plateCount: 1, order: null };
h.push(s0);
const back = h.undo(s1);
check(back === s0 && h.canRedo, "undo returns the earlier layout");
check(h.redo(s0) === s1 && !h.canRedo, "redo returns the later layout");
h.undo(s1);
h.push(s0);
check(!h.canRedo, "a new change clears redo");
// Print areas. Test data only (not any printer's real numbers): a 325 x 320 bed, the left
// nozzle reaching x 0..325, the right x 20..325, and a "Both" area x 20..320.
{
  const areas: PlateAreas = {
    list: [
      { name: "Left nozzle", rect: [0, 0, 325, 320], height_mm: 320, nozzle: "left" },
      { name: "Right nozzle", rect: [20, 0, 325, 320], height_mm: 325, nozzle: "right" },
      { name: "Both", rect: [20, 0, 320, 320], height_mm: 320, nozzle: null },
    ],
    shared: { rect: [20, 0, 320, 320], height_mm: 320, label: "Both nozzles" },
  };
  const right = { rect: [20, 0, 325, 320] as [number, number, number, number], height_mm: 325, label: "Right nozzle" };
  const p = (id: string, x: number, reach = right, area?: string): PlatePart => ({ ...part(id, x, 100, 10), auto_reach: reach, area });
  const big = { width_mm: 325, depth_mm: 320 };
  const l = liveProblems([p("r-in", 100), p("r-out", 10), p("off", 330)], 0, big, areas);
  check(l.out.has("r-out") && !l.out.has("r-in"), "drag check: right-nozzle part in the left-only strip is out of area");
  check(l.off.has("off") && !l.out.has("off"), "off the bed is off-plate, not out-of-area");
  check(outOfAreaMessage(reachOf(p("x", 10), areas)) === "Right nozzle can't reach here", "out-of-area message names the nozzle");
  check(reachOf(p("x", 10, right, "Left nozzle"), areas)?.rect[0] === 0, "a picked area overrides auto");
  check(reachOf(p("x", 10, right, "shared"), areas)?.label === "Both nozzles", "shared pick");
  check(reachOf(p("x", 10), { list: [], shared: null }) === null, "no areas: whole bed");
  check(liveProblems([p("r-out", 10)], 0, big).out.size === 0, "no areas passed: no out-of-area");
  const sh = areaShading(big, areas);
  check(sh.none.length === 0, "every bed cell is reached by some nozzle");
  check(sh.partial.some((r) => r[0] === 0 && r[2] === 20) && sh.partial.some((r) => r[0] === 320 && r[2] === 325), "one-nozzle strips are shaded");
  check(areaShading(big, { list: [], shared: null }).partial.length === 0, "no areas: no shading");
  check(fitHeadline({ fits: false, plates: 1, off_plate: [], collisions: [], too_tall: [], out_of_area: ["a"] }).tone === "bad", "out of area is a bad fit");
  check(layoutFor([p("a", 100, right, "Left nozzle"), p("b", 100)], []).parts.map((x) => x.area ?? "-").join() === "Left nozzle,-", "layout carries picked areas only");
}
// A part no nozzle area fits, and the computed overlap when there is no "both" area.
// Test data only.
{
  const printer = (areas: PrintArea[]) => ({
    feeders: [
      { id: "fl", name: "L", slot_count: 4, is_dry_box: false, first_slot: 1, spools: [], auto: false, nozzle: "left" },
      { id: "fr", name: "R", slot_count: 4, is_dry_box: false, first_slot: 5, spools: [], auto: false, nozzle: "right" },
    ] as unknown as PrinterFeeder[],
    print_areas: areas,
  });
  const area = (name: string, nozzle: "left" | "right" | "both", x: number, w: number): PrintArea => ({ id: name, name, nozzle, x_mm: x, y_mm: 0, width_mm: w, depth_mm: 320, height_mm: 320 });
  const onlyLeft = printer([area("Left nozzle", "left", 0, 325)]);
  const gone = reachFromPartArea(printAreaForSlots(onlyLeft, [5]));
  check(!!gone?.unreachable, "right-nozzle part with only a left area is unreachable");
  check(reachFromPartArea(printAreaForSlots(printer([]), [5])) === null, "no areas: whole bed");
  check(outOfAreaMessage(gone) === "No nozzle area fits this part", "unreachable message");
  const areas: PlateAreas = { list: [{ name: "Left nozzle", rect: [0, 0, 325, 320], height_mm: 320, nozzle: "left" }], shared: null };
  const u = { ...part("u", 100, 100, 10), auto_reach: gone };
  const inBed = liveProblems([u, part("v", 100, 100, 10)], 0, { width_mm: 325, depth_mm: 320 }, areas);
  check(inBed.out.has("u") && !inBed.hit.has("u") && !inBed.hit.has("v"), "unreachable is red even inside the bed, and never collides");
  const beside = liveProblems([{ ...u, placement: { plate: 0, x: -30, y: 100, rot_deg: 0 } }], 0, { width_mm: 325, depth_mm: 320 }, areas);
  check(beside.out.has("u") && !beside.off.has("u"), "beside the bed it is unreachable, not off-plate");
  const h = fitHeadline({ fits: false, plates: 1, off_plate: [], collisions: [], too_tall: [], out_of_area: ["u"], unreachable: ["u"] });
  check(h.tone === "bad" && h.text === "No nozzle area fits this part", "headline names the unreachable part");
  // No "both" area: shared parts get the left/right overlap, never the whole bed.
  const lr = printer([area("Left nozzle", "left", 0, 325), area("Right nozzle", "right", 20, 305)]);
  const ov = reachFromPartArea(printAreaForSlots(lr, [1, 5]));
  check(!!ov && !ov.unreachable && ov.rect.join() === "20,0,325,320" && ov.label === "Overlap", "mixed part gets the computed overlap");
  check(reachFromPartArea(printAreaForSlots(lr, []))?.rect.join() === "20,0,325,320", "unknown nozzle gets the overlap too");
  check(reachFromPartArea(printAreaForSlots(lr, [1]))?.label === "Left nozzle", "one-nozzle part keeps its own area");
}

// Clearance lives on the printer; printer_plate keeps only spacing/rotate/align/sequence.
{
  const s = normalizeSettings({ spacing_mm: 4, clearance_radius_mm: 40, clearance_height_mm: 22, clearance_dist_to_rod_mm: 55, clearance_height_to_lid_mm: 110, sequence: "by_object" });
  check(JSON.stringify(Object.keys(plateEntryOf(s)).sort()) === JSON.stringify(["align_y", "auto_rotate", "sequence", "spacing_mm"]), "printer_plate entry has no clearance keys");
  const c = clearanceFieldsOf(s);
  check(c.extruder_clearance_radius === 40 && c.extruder_clearance_height_to_rod === 22, "max radius and height to rod go to the printer fields");
  check(c.extruder_clearance_dist_to_rod === 55 && c.extruder_clearance_height_to_lid === 110, "distance to rod and height to lid go to the printer fields");
  const d = clearanceFieldsOf(normalizeSettings({}));
  check(d.extruder_clearance_dist_to_rod === null && d.extruder_clearance_height_to_lid === null, "unset distance to rod and height to lid stay empty");
  check(DEFAULT_SETTINGS.clearance_radius_mm === PLATE_DEFAULT_CLEARANCE_RADIUS_MM && DEFAULT_SETTINGS.clearance_height_mm === PLATE_DEFAULT_CLEARANCE_HEIGHT_MM, "plate defaults match the printer clearance fallbacks");
}

done();
