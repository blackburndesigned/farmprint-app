// Product pictures keep their aspect inside the square thumbnail.
import { containRect, frameRect } from "../../src/containRect";
import { check, done } from "./check";

const sq = containRect(1024, 1024, 240, 240);
check(sq.x === 0 && sq.y === 0 && sq.w === 240 && sq.h === 240, "square picture fills the square exactly");
check(JSON.stringify(containRect(256, 256, 640, 640)) === JSON.stringify({ x: 0, y: 0, w: 640, h: 640 }), "square at any size fills the box");

const wide = containRect(3420, 1814, 240, 240);
check(wide.w === 240 && Math.abs(wide.h - (240 * 1814) / 3420) < 1e-9, "wide picture keeps its aspect");
check(Math.abs(wide.y - (240 - wide.h) / 2) < 1e-9 && wide.x === 0, "wide picture is centred vertically");

const tall = containRect(500, 1000, 240, 240);
check(tall.h === 240 && tall.w === 120 && tall.x === 60 && tall.y === 0, "tall picture is centred horizontally");

const bad = containRect(0, 0, 240, 240);
check(bad.w === 240 && bad.h === 240, "unreadable size falls back to the full box");

// A layer downscaled with rounding (256×136 from 3420×1814) lines up with the frame exactly.
const f = { w: 3420, h: 1814 };
check(JSON.stringify(frameRect(f, 256, 136, 240, 240)) === JSON.stringify(containRect(3420, 1814, 240, 240)), "rounded layer uses the frame rect");
const other = frameRect(f, 1000, 1000, 240, 240);
check(other.w === 240 && other.h === 240, "a layer with a different aspect is fitted on its own, same centring");

done();
