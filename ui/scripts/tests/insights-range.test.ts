// Insights range presets, previous-period labels and number formatting.
import { delta, fmtHours, fmtValue, niceMax, parseLocalDate, rangeFileLabel, rangeQuery } from "../../src/views/insights/insightsRange";
import { check, done } from "./check";

const now = new Date(2026, 10, 25, 15, 30); // 25 Nov 2026, local
const day = 86400000;

const w = rangeQuery("7d", now);
check(w.start !== null && w.end !== null, "7 days has a start and end");
check(Math.round((Date.parse(w.end!) - Date.parse(w.start!)) / day) === 7, "7 days spans 7 days");
check(new Date(w.end!).getDate() === 26 && new Date(w.end!).getHours() === 0, "ends at the end of today");
check(w.tz_offset_minutes === -now.getTimezoneOffset(), "sends the local offset");
check(Math.round((Date.parse(rangeQuery("30d", now).end!) - Date.parse(rangeQuery("30d", now).start!)) / day) === 30, "30 days");
check(Math.round((Date.parse(rangeQuery("90d", now).end!) - Date.parse(rangeQuery("90d", now).start!)) / day) === 90, "90 days");
const y = new Date(rangeQuery("ytd", now).start!);
check(y.getMonth() === 0 && y.getDate() === 1 && y.getFullYear() === 2026, "year to date starts 1 Jan");
check(rangeQuery("all", now).start === null, "all time sends no start");
const c = rangeQuery("custom", now, { from: "2026-11-10", to: "2026-11-01" });
check(new Date(c.start!).getDate() === 1 && new Date(c.end!).getDate() === 11, "custom is inclusive and swaps backwards dates");
check(parseLocalDate("2026-02-30") === null && parseLocalDate("nope") === null, "bad dates rejected");
check(rangeFileLabel(c) === "2026-11-01_to_2026-11-10", "file label uses the inclusive dates");
check(rangeFileLabel(rangeQuery("all", now)) === "all-time_to_2026-11-25", "all time file label");

check(fmtValue(null, "pct") === "Not enough data", "no value says so");
check(fmtValue(0.5, "pct") === "50.0%" && fmtValue(12345, "cents") === "$123.45" && fmtValue(3, "count") === "3", "formats");
check(fmtHours(0.5) === "30 min" && fmtHours(5) === "5.0 h" && fmtHours(72) === "3.0 days", "hours");

const d1 = delta({ value: 10, previous: 8, unit: "hours", better: "down" });
check(d1.good === false && d1.text.startsWith("▲ 25%"), "lead time going up is bad");
const d2 = delta({ value: 0.9, previous: 0.8, unit: "pct", better: "up" });
check(d2.good === true && d2.text.includes("10.0 pts"), "rates compare in points");
check(delta({ value: 5, previous: null, unit: "count", better: "up" }).good === null, "no previous = no compare");
check(delta({ value: 3, previous: 0, unit: "count", better: "up" }).text.includes("from 0"), "from zero");
check(delta({ value: 2, previous: 2, unit: "count", better: "up" }).good === null, "no change");
check(niceMax(0) === 1 && niceMax(7) === 10 && niceMax(130) === 200 && niceMax(4.2) === 5, "nice axis tops");

done();
