// Part status popover: the current state is a marker ("Printed (current)"), never a
// highlighted "Move to Printed" button; every other step is a "Move to …" button.
import { unitStatusRows } from "../../src/views/modals/unitStatusRows";
import { check, done } from "./check";

const steps = [
  { id: "Queued", name: "In Queue" },
  { id: "Staged", name: "Staged" },
  { id: "Printing", name: "Printing" },
  { id: "Printed", name: "Printed" },
  { id: "PostProcess", name: "Post-Process" },
  { id: "Closed", name: "Closed / Ready" },
];

const rows = unitStatusRows(steps, "Printed");
check(rows.length === steps.length, "one row per step");
check(rows.filter((r) => r.current).length === 1, "exactly one current row");
const cur = rows.find((r) => r.current)!;
check(cur.id === "Printed" && cur.label === "Printed (current)", `current row reads "Printed (current)" (got "${cur.label}")`);
check(!rows.some((r) => r.label === "Move to Printed"), "no 'Move to Printed' for a Printed part");
check(rows.filter((r) => !r.current).every((r) => r.label === `Move to ${r.name}`), "other steps are 'Move to …'");
check(rows.map((r) => r.id).join() === steps.map((s) => s.id).join(), "step order unchanged");

const q = unitStatusRows(steps, "Queued");
check(q[0].current && q[0].label === "In Queue (current)", "In Queue part: first row is the current marker");
check(q.slice(1).every((r) => !r.current), "In Queue part: the rest are moves");

const off = unitStatusRows(steps, "Shipped", "Shipped");
check(off.length === steps.length + 1 && off[0].current && off[0].label === "Shipped (current)", "a state outside the steps is still shown as current, first");
check(off.slice(1).every((r) => !r.current && r.label.startsWith("Move to ")), "…and every step is a move");
done();
