// Printers board lane grouping (By job / By order). Plain TS so scripts/tests can run it.
import type { PartUnit } from "../../types";

/** One card on a Printers board lane. */
export interface LaneGroup {
  key: string;
  /** "job" = one send/Print! batch (`plate_job_id`), "order" = one order, "loose" = parts with no job id. */
  kind: "job" | "order" | "loose";
  units: PartUnit[];
}

const earliest = (units: PartUnit[]) => units.reduce((m, u) => (u.updated_at && u.updated_at < m ? u.updated_at : m), "\uffff");

/**
 * Groups a lane's parts for the Printers board.
 * - "job": by `plate_job_id`, which fp-core sets once per send (every part moved to
 *   Printing/Staged in one action shares it), so a batch with parts from several
 *   orders stays one card. Printing jobs first, then oldest first. Parts with no job
 *   id go in one "Loose parts" card at the end.
 * - "order": one card per order, in lane order (the board's original split).
 */
export function groupLaneUnits(laneUnits: PartUnit[], view: "job" | "order"): LaneGroup[] {
  if (view === "order") {
    const byOrder = new Map<string, PartUnit[]>();
    for (const u of laneUnits) byOrder.set(u.order_id, [...(byOrder.get(u.order_id) || []), u]);
    return Array.from(byOrder.entries()).map(([orderId, units]) => ({ key: `order:${orderId}`, kind: "order", units }));
  }
  const byJob = new Map<string, PartUnit[]>();
  const loose: PartUnit[] = [];
  for (const u of laneUnits) {
    if (u.plate_job_id) byJob.set(u.plate_job_id, [...(byJob.get(u.plate_job_id) || []), u]);
    else loose.push(u);
  }
  const jobs: LaneGroup[] = Array.from(byJob.entries()).map(([jobId, units]) => ({ key: `job:${jobId}`, kind: "job", units }));
  const printing = (g: LaneGroup) => (g.units.some((u) => u.state === "Printing") ? 0 : 1);
  jobs.sort((a, b) => printing(a) - printing(b) || earliest(a.units).localeCompare(earliest(b.units)) || a.key.localeCompare(b.key));
  if (loose.length) jobs.push({ key: "loose", kind: "loose", units: loose });
  return jobs;
}

/** Lane header count: "2 jobs" (+ loose parts) in By job, "3 orders" in By order. */
export function laneCountLabel(groups: LaneGroup[], view: "job" | "order"): string {
  if (view === "order") return `${groups.length} ${groups.length === 1 ? "order" : "orders"}`;
  const jobs = groups.filter((g) => g.kind === "job").length;
  const hasLoose = groups.some((g) => g.kind === "loose");
  return `${jobs} ${jobs === 1 ? "job" : "jobs"}${hasLoose ? " + loose" : ""}`;
}
