// By-object extruder clearance: four optional printer fields with the slicer's names, and
// which value the plate view should use. Mirrors fp-core `clearance` tests.
import { clearanceFallback, clearanceOf, effectiveClearance, parseClearance } from "../../src/views/printers/extruderClearance";
import { check, done } from "./check";

const empty = { extruder_clearance_radius: null, extruder_clearance_dist_to_rod: null, extruder_clearance_height_to_rod: null, extruder_clearance_height_to_lid: null };
check(JSON.stringify(clearanceOf({})) === JSON.stringify(empty), "older snapshots read as all empty");

const none = effectiveClearance({}, undefined);
check(none.radius === 35 && none.height_to_rod === 30 && none.dist_to_rod === null && none.height_to_lid === null, "nothing set: plate defaults, no rod distance or lid");
const plate = { spacing_mm: 5, clearance_radius_mm: 42, clearance_height_mm: 28 };
const fromPlate = effectiveClearance({}, plate);
check(fromPlate.radius === 42 && fromPlate.height_to_rod === 28, "plate view values next");
const own = effectiveClearance({ extruder_clearance_radius: 57, extruder_clearance_height_to_lid: 90 }, plate);
check(own.radius === 57 && own.height_to_rod === 28 && own.height_to_lid === 90, "printer fields win");
check(effectiveClearance({}, { clearance_radius_mm: "wide", clearance_height_mm: -4 }).radius === 35, "junk plate values are ignored");

check(clearanceFallback("extruder_clearance_radius", plate) === 42 && clearanceFallback("extruder_clearance_height_to_rod", undefined) === 30, "placeholders show the plate value or default");
check(clearanceFallback("extruder_clearance_dist_to_rod", plate) === null && clearanceFallback("extruder_clearance_height_to_lid", plate) === null, "no placeholder without a plate equivalent");

const text = { extruder_clearance_radius: "40", extruder_clearance_dist_to_rod: " ", extruder_clearance_height_to_rod: "25,5", extruder_clearance_height_to_lid: "0" };
const parsed = parseClearance(text);
check(!("error" in parsed) && parsed.extruder_clearance_radius === 40 && parsed.extruder_clearance_dist_to_rod === null && parsed.extruder_clearance_height_to_rod === 25.5 && parsed.extruder_clearance_height_to_lid === 0, "parse: blank is empty, 0 allowed, comma decimal");
const bad = parseClearance({ ...text, extruder_clearance_height_to_lid: "2001" });
check("error" in bad && bad.error === "Height to lid needs to be between 0 and 2000 mm, or empty.", "out of range");
check("error" in parseClearance({ ...text, extruder_clearance_radius: "-1" }), "negative rejected");

done();
