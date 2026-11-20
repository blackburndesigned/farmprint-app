// Parts to Print multi-select: per-unit picks, ranges across groups, group checkboxes,
// clearing after a send, and the bottom bar text.
import {
  groupState,
  isToggleClick,
  pruneSelection,
  selectRange,
  selectedInOrder,
  selectionSummary,
  toggleGroup,
  toggleUnit,
} from "../../src/views/printers/partSelection";
import type { PartUnit } from "../../src/types";
import { check, done } from "./check";

const unit = (id: string, order_id: string, part_id: string, filament_name: string, filament_hex: string): PartUnit =>
  ({ id, order_id, part_id, filament_name, filament_hex, part_name: part_id, state: "Queued" } as unknown as PartUnit);

// Two orders with the same part id ("base") in two colors, shown as two color groups.
const red = [unit("o1-base-0", "o1", "base", "Red", "#ff0000"), unit("o2-base-0", "o2", "base", "Red", "#ff0000")];
const blue = [unit("o1-lid-0", "o1", "lid", "Blue", "#0000ff"), unit("o2-lid-0", "o2", "lid", "Blue", "#0000ff"), unit("o3-lid-0", "o3", "lid", "Blue", "#0000ff")];
const shown = [...red, ...blue];
const ids = shown.map((u) => u.id);
const set = (...xs: string[]) => new Set(xs);
const same = (a: Set<string> | ReadonlySet<string>, b: string[]) => a.size === b.length && b.every((x) => a.has(x));

// Toggle is per unit: the same part id in another order is a separate pick.
let s = toggleUnit(set(), "o1-base-0");
check(same(s, ["o1-base-0"]), "toggle adds one unit");
check(!s.has("o2-base-0"), "the same part in another order isn't picked");
s = toggleUnit(s, "o1-base-0");
check(s.size === 0, "toggle again removes it");

// Shift range crosses color groups and orders, in shown order, either direction.
check(same(selectRange(set(), ids, "o2-base-0", "o2-lid-0"), ["o2-base-0", "o1-lid-0", "o2-lid-0"]), "range across groups");
check(same(selectRange(set(), ids, "o3-lid-0", "o1-base-0"), ids), "range backwards covers everything");
check(same(selectRange(set("o3-lid-0"), ids, null, "o1-base-0"), ["o3-lid-0", "o1-base-0"]), "no anchor: just the clicked unit");
check(same(selectRange(set("o3-lid-0"), ids, "o1-base-0", "o2-base-0"), ["o3-lid-0", "o1-base-0", "o2-base-0"]), "range adds, never removes");
check(same(selectRange(set(), ids, "gone", "o1-lid-0"), ["o1-lid-0"]), "stale anchor: just the clicked unit");

// Group header checkbox: none / mixed / all, and clicking it.
const blueIds = blue.map((u) => u.id);
check(groupState(set(), blueIds) === "none", "group none");
check(groupState(set("o1-lid-0"), blueIds) === "some", "group mixed");
check(groupState(set(...blueIds, "o1-base-0"), blueIds) === "all", "group all");
check(groupState(set("x"), []) === "none", "empty group is none");
check(same(toggleGroup(set("o1-lid-0", "o1-base-0"), blueIds), [...blueIds, "o1-base-0"]), "mixed group click selects the rest");
check(same(toggleGroup(set(...blueIds, "o1-base-0"), blueIds), ["o1-base-0"]), "full group click clears only that group");

// After a send the sent units stop waiting and drop out; nothing else changes.
const picked = set("o1-base-0", "o2-lid-0");
check(pruneSelection(picked, new Set(ids)) === picked, "nothing sent: same set object");
check(pruneSelection(picked, new Set(ids.filter((x) => x !== "o2-lid-0"))).size === 1, "sent unit drops out");
check(pruneSelection(picked, new Set()).size === 0, "all sent: cleared");

// What gets sent: exactly the picks, each once, in shown order.
const out = selectedInOrder(set("o3-lid-0", "o1-base-0"), [...shown, shown[0]]);
check(out.map((u) => u.id).join(",") === "o1-base-0,o3-lid-0", "selected in shown order, no doubles");

// Bottom bar.
check(selectionSummary(shown) === "5 parts · 3 orders · 2 colors", "summary plural");
check(selectionSummary([red[0]]) === "1 part · 1 order · 1 color", "summary singular");
check(selectionSummary([red[0], unit("o9", "o9", "base", "red ", "#FF0000")]) === "2 parts · 2 orders · 1 color", "color matched by name and hex, ignoring case");

// Cmd on macOS, Ctrl elsewhere.
check(isToggleClick({ metaKey: true, ctrlKey: false }, true) && !isToggleClick({ metaKey: false, ctrlKey: true }, true), "mac uses Cmd");
check(isToggleClick({ metaKey: false, ctrlKey: true }, false) && !isToggleClick({ metaKey: true, ctrlKey: false }, false), "others use Ctrl");

done();
