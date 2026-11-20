// Flow page helpers: the failure label on a row, and a plate job's parts and history,
// rebuilt from the flow ledger (each event records the job the part was in before it).
import type { FlowEvent, PartUnit } from "../types";

/** Notes the app writes on its own when nobody typed one; they add nothing to the label. */
function isAutoNote(note: string, reason: string | null): boolean {
  const n = note.trim();
  if (!n) return true;
  if (/^Failed on /.test(n) || n === "Marked Failed / Needs Reprint") return true;
  return !!reason && n === `${reason} — queued for reprint`;
}

/** The note someone typed when marking a part failed, or null. */
export function typedFailureNote(ev: Pick<FlowEvent, "failure_reason" | "failure_note">): string | null {
  const note = (ev.failure_note || "").trim();
  return note && !isAutoNote(note, ev.failure_reason) ? note : null;
}

/** "Other: Extruder Jam", "Spaghetti", or just the typed note when there's no reason. */
export function failureText(ev: Pick<FlowEvent, "failure_reason" | "failure_note">): string {
  const reason = (ev.failure_reason || "").trim();
  const note = typedFailureNote(ev);
  if (reason && note) return `${reason}: ${note}`;
  return reason || note || "";
}

/** "Failed · Other: Extruder Jam" (or "Failed" when nothing was recorded). */
export function failureLabel(ev: Pick<FlowEvent, "failure_reason" | "failure_note">): string {
  const t = failureText(ev);
  return t ? `Failed · ${t}` : "Failed";
}

const bySeq = (a: FlowEvent, b: FlowEvent) => (a.seq ?? 0) - (b.seq ?? 0) || a.created_at.localeCompare(b.created_at);

/**
 * The plate job a part belongs to for the Flow detail: its current job, or the last job
 * the ledger saw it in (a failed part keeps the job it failed in). Null = never sent.
 */
export function jobIdForUnit(unit: Pick<PartUnit, "id" | "plate_job_id">, events: FlowEvent[]): string | null {
  if (unit.plate_job_id) return unit.plate_job_id;
  const own = events.filter((e) => e.unit_id === unit.id && !e.undone).sort(bySeq);
  for (let i = own.length - 1; i >= 0; i--) {
    if (own[i].prev_plate_job_id) return own[i].prev_plate_job_id!;
  }
  return null;
}

export interface JobHistory {
  /** The clicked job and the jobs it came from (Staged → Printing gives the part a new job). */
  jobIds: string[];
  /** Ids of every part that was in the job. */
  unitIds: string[];
  /** The job's events, oldest first. */
  events: FlowEvent[];
}

/**
 * Everything the ledger knows about one plate job. An event belongs to job J when the part
 * was in J before it (prev_plate_job_id = J), or when it put the part into J (the part's next
 * event has prev = J, or the part is still in J and this is its latest event).
 */
export function jobHistory(jobId: string, events: FlowEvent[], units: Pick<PartUnit, "id" | "plate_job_id">[]): JobHistory {
  const perUnit = new Map<string, FlowEvent[]>();
  for (const e of events) {
    if (!e.unit_id) continue;
    const list = perUnit.get(e.unit_id);
    if (list) list.push(e);
    else perUnit.set(e.unit_id, [e]);
  }
  for (const list of perUnit.values()) list.sort(bySeq);
  const currentJob = new Map(units.map((u) => [u.id, u.plate_job_id]));

  /** The event that put this part into `job`, if the ledger still has it. */
  const entryInto = (unitId: string, list: FlowEvent[], job: string): FlowEvent | null => {
    const live = list.filter((e) => !e.undone);
    for (let i = 0; i < live.length; i++) {
      const next = live[i + 1];
      const into = next ? next.prev_plate_job_id === job : currentJob.get(unitId) === job;
      if (into && live[i].prev_plate_job_id !== job) return live[i];
    }
    return null;
  };

  const jobIds = [jobId];
  const picked = new Set<string>();
  const unitIds = new Set<string>();
  for (let k = 0; k < jobIds.length && k < 8; k++) {
    const job = jobIds[k];
    for (const [unitId, list] of perUnit) {
      let inJob = currentJob.get(unitId) === job;
      for (const e of list) {
        if (e.prev_plate_job_id === job) {
          picked.add(e.id);
          inJob = true;
        }
      }
      if (!inJob) continue;
      unitIds.add(unitId);
      const entry = entryInto(unitId, list, job);
      if (entry) {
        picked.add(entry.id);
        // Printing after Staged starts a new job: follow it back to the staged one.
        if (entry.prev_plate_job_id && !jobIds.includes(entry.prev_plate_job_id) && entry.to_state === "Printing") {
          jobIds.push(entry.prev_plate_job_id);
        }
      }
    }
    for (const u of units) if (u.plate_job_id === job) unitIds.add(u.id);
  }
  return {
    jobIds,
    unitIds: [...unitIds],
    events: events.filter((e) => picked.has(e.id)).sort(bySeq),
  };
}
