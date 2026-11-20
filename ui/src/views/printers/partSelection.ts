// Parts to Print multi-select: which part units are picked to go out as one job.
// Selection is by unit id (never part id), so the same part from two orders is two picks.
import type { PartUnit } from "../../types";

export type Selection = ReadonlySet<string>;
export type GroupState = "none" | "some" | "all";

/** Cmd-click (Ctrl elsewhere): add or remove one unit. */
export function toggleUnit(sel: Selection, id: string): Set<string> {
  const next = new Set(sel);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Shift-click: add every unit between the anchor and the clicked one, in the order the
 *  tiles are shown (across orders and color groups). Without a usable anchor it adds just
 *  the clicked unit. Never removes anything. */
export function selectRange(sel: Selection, shownIds: readonly string[], anchorId: string | null, id: string): Set<string> {
  const next = new Set(sel);
  const to = shownIds.indexOf(id);
  const from = anchorId ? shownIds.indexOf(anchorId) : -1;
  if (to < 0) return next;
  if (from < 0) {
    next.add(id);
    return next;
  }
  const [a, b] = from <= to ? [from, to] : [to, from];
  for (let i = a; i <= b; i++) next.add(shownIds[i]);
  return next;
}

/** Header checkbox state for a group: none, some (mixed) or all selected. */
export function groupState(sel: Selection, groupIds: readonly string[]): GroupState {
  if (groupIds.length === 0) return "none";
  const n = groupIds.reduce((acc, id) => acc + (sel.has(id) ? 1 : 0), 0);
  return n === 0 ? "none" : n === groupIds.length ? "all" : "some";
}

/** Header checkbox click: a fully selected group is cleared; otherwise all of it is added. */
export function toggleGroup(sel: Selection, groupIds: readonly string[]): Set<string> {
  const next = new Set(sel);
  if (groupState(sel, groupIds) === "all") groupIds.forEach((id) => next.delete(id));
  else groupIds.forEach((id) => next.add(id));
  return next;
}

/** Drops picks that are no longer waiting to print (sent, removed, filtered out of the
 *  shop). This is what clears the selection after a successful send. Returns the same
 *  set when nothing changed so React can skip a render. */
export function pruneSelection(sel: Selection, waitingIds: ReadonlySet<string>): Selection {
  let changed = false;
  const next = new Set<string>();
  sel.forEach((id) => {
    if (waitingIds.has(id)) next.add(id);
    else changed = true;
  });
  return changed ? next : sel;
}

/** The selected units in the order they are shown, each once. */
export function selectedInOrder(sel: Selection, shown: readonly PartUnit[]): PartUnit[] {
  const seen = new Set<string>();
  const out: PartUnit[] = [];
  for (const u of shown) {
    if (sel.has(u.id) && !seen.has(u.id)) {
      seen.add(u.id);
      out.push(u);
    }
  }
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Bottom bar text, e.g. "7 parts · 3 orders · 2 colors". */
export function selectionSummary(units: readonly PartUnit[]): string {
  const orders = new Set(units.map((u) => u.order_id)).size;
  const colors = new Set(units.map((u) => `${u.filament_name.trim().toLowerCase()}|${(u.filament_hex || "").toLowerCase()}`)).size;
  return `${plural(units.length, "part")} · ${plural(orders, "order")} · ${plural(colors, "color")}`;
}

/** Cmd-click on macOS, Ctrl-click on Windows and Linux. */
export function isToggleClick(e: { metaKey: boolean; ctrlKey: boolean }, mac: boolean): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}
