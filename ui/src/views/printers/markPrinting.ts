// "Mark Printing": move parts to Printing exactly like Print! (same printer picker, one
// plate job per action, the same Flow history and undo), but with no plate, no .3mf and
// no slicer. The printer is optional; a job with no printer shows in the Printers board's
// "Unassigned" lane. Plain TS so scripts/tests can run it.
import type { PartUnit, Printer, TransitionRequest } from "../../types";

/** Lane id used by the Printers board for Printing/Staged parts with no (known) printer. */
export const UNASSIGNED_LANE_ID = "__unassigned__";

/** What the printer picker does with the parts. */
export type PrintPickMode = "print" | "mark";

/** Parts shown on one printer's lane: Printing or Staged on that printer. */
export function printerLaneUnits(units: PartUnit[], printerId: string): PartUnit[] {
  return units.filter((u) => u.printer_id === printerId && (u.state === "Printing" || u.state === "Staged"));
}

/** Printing or Staged parts with no printer, or whose printer is no longer in the shop. */
export function unassignedLaneUnits(units: PartUnit[], printers: Pick<Printer, "id">[]): PartUnit[] {
  const known = new Set(printers.map((p) => p.id));
  return units.filter(
    (u) => (u.state === "Printing" || u.state === "Staged") && (!u.printer_id || !known.has(u.printer_id))
  );
}

/** Flow / banner label for a Mark Printing action. */
export function markPrintingLabel(count: number, printerName: string | null | undefined): string {
  const parts = `${count} part${count === 1 ? "" : "s"}`;
  return printerName ? `Marked ${parts} Printing on ${printerName} (no slicer)` : `Marked ${parts} Printing, no printer yet (no slicer)`;
}

/** Print! needs a real printer (the plate uses its bed and slots); Mark Printing does not. */
export function canConfirmPick(mode: PrintPickMode, printerId: string, printers: Pick<Printer, "id">[]): boolean {
  if (printers.some((p) => p.id === printerId)) return true;
  return mode === "mark" && printerId === "";
}

/** The request sent for a confirmed pick. A Mark Printing pick never sends an unknown printer id. */
export function confirmedPickRequest(
  req: TransitionRequest,
  mode: PrintPickMode,
  printerId: string,
  printers: Pick<Printer, "id" | "name">[]
): TransitionRequest {
  const prn = printers.find((p) => p.id === printerId);
  if (mode === "mark") {
    return { ...req, printer_id: prn ? prn.id : null, action_label: markPrintingLabel(req.unit_ids.length, prn?.name) };
  }
  const label = req.action_label.replace(/ (on|→) [^()]+$/, "");
  return { ...req, printer_id: prn ? prn.id : null, action_label: prn ? `${label} on ${prn.name}` : label };
}

/** Arguments for the `transition_units` command. `skip_slicer` is only ever sent for Mark Printing. */
export function transitionArgs(
  req: TransitionRequest,
  opts: { allowWithoutSlicer?: boolean; skipSlicer?: boolean; layout?: unknown } = {}
): Record<string, unknown> {
  const args: Record<string, unknown> = { request: req, allow_without_slicer: !!opts.allowWithoutSlicer };
  if (opts.skipSlicer) args.skip_slicer = true;
  // From the plate view: send exactly this layout. Without it, Print! arranges automatically.
  else if (opts.layout) args.layout = opts.layout;
  return args;
}

/** Extra options for running a transition from a view. */
export interface TransitionOptions {
  /** The printer was already picked (skip the picker). */
  confirmed?: boolean;
  /** Print!'s "Mark Printing anyway" after the slicer failed to open. */
  allowWithoutSlicer?: boolean;
  /** Mark Printing: open the picker in Mark Printing mode / send with no slicer. */
  markPrinting?: boolean;
  /** Print! from the plate view: the parts' plates, positions and turns (plateModel.PrintLayout). */
  layout?: unknown;
}
