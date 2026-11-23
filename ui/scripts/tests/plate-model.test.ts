import {
  angleDelta,
  biggerThanBed,
  convexOverlap,
  effectiveOrder,
  fitHeadline,
  layoutFor,
  liveProblems,
  normalizeSettings,
  offsetOutline,
  removeFromJob,
  reorder,
  type PlatePart,
  type V2,
} from "../../src/views/printers/plate/plateModel";
import { check, done } from "./check";

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
done();
