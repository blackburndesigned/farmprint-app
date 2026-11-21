import React from "react";
import type { Printer, TransitionRequest } from "../../types";
import { CircleDashed, CirclePlay, Printer as PrinterIcon } from "lucide-react";
import { Icon } from "../../icons";
import { canConfirmPick, type PrintPickMode } from "./markPrinting";

export interface PendingPrintPick {
  req: TransitionRequest;
  /** "" = no printer picked yet (allowed for Mark Printing: the job goes to Unassigned). */
  printerId: string;
  mode: PrintPickMode;
  /** Some of the parts are already staged on a printer. */
  stagedOnPrinter?: boolean;
}

/**
 * "Which printer?" for Print! and Mark Printing. Print! builds a plate and opens the slicer,
 * so it needs a printer. Mark Printing moves the parts to Printing the same way (one job,
 * same history) without a plate or slicer, and the printer is optional.
 */
export const PrinterPickModal: React.FC<{
  pending: PendingPrintPick;
  printers: Printer[];
  onChange: (next: PendingPrintPick) => void;
  onCancel: () => void;
  onConfirm: (mode: PrintPickMode) => void;
}> = ({ pending, printers, onChange, onCancel, onConfirm }) => {
  const n = pending.req.unit_ids.length;
  const parts = `${n} part${n === 1 ? "" : "s"}`;
  const mark = pending.mode === "mark";
  /** Parts already staged on a printer keep it when no printer is picked (fp-core keeps the
   *  previous printer), so the picker says so. */
  const staged = !!pending.stagedOnPrinter;
  const canPrint = canConfirmPick("print", pending.printerId, printers);
  const canMark = canConfirmPick("mark", pending.printerId, printers);
  const row = (id: string, body: React.ReactNode) => (
    <label
      key={id || "none"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px",
        borderRadius: 8,
        cursor: "pointer",
        background: pending.printerId === id ? "rgba(10,132,255,0.18)" : "transparent",
      }}
    >
      <input type="radio" name="fp-print-printer" checked={pending.printerId === id} onChange={() => onChange({ ...pending, printerId: id })} />
      {body}
    </label>
  );
  return (
    <div className="fp-modal-backdrop" onClick={(e) => { e.stopPropagation(); onCancel(); }}>
      <div className="fp-modal-window" role="dialog" aria-modal="true" aria-label={mark ? "Mark Printing" : "Print!"} style={{ width: "min(440px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="fp-modal-header">
          <div>
            <div className="fp-modal-title">{mark ? `Mark ${parts} Printing on which printer?` : `Send ${parts} to which printer?`}</div>
            {mark && (
              <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>
                No slicer opens and no .3mf is written. The printer is optional.
              </div>
            )}
          </div>
        </div>
        <div className="fp-modal-body" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {printers.length === 0 && <div style={{ opacity: 0.7, fontSize: 13 }}>Add a printer first, on the Printers tab, or mark the parts Printing with no printer.</div>}
          {printers.map((p) =>
            row(
              p.id,
              <>
                <span style={{ fontWeight: 600 }}>{p.name}</span>
                {p.model && <span style={{ opacity: 0.6, fontSize: 12 }}>{p.model}{p.status ? ` · ${p.status}` : ""}</span>}
              </>
            )
          )}
          {row(
            "",
            <>
              <Icon icon={CircleDashed} size={14} />
              <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>No printer yet</span>
              <span style={{ opacity: 0.6, fontSize: 12 }}>Mark Printing only · shows under Unassigned{staged ? "; staged parts keep their printer" : ""}</span>
            </>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button type="button" className="fp-btn fp-btn-sm" onClick={onCancel}>Cancel</button>
            <button
              type="button"
              className={`fp-btn fp-btn-sm${mark ? " fp-btn-primary" : ""}`}
              disabled={!canMark}
              title="Move the parts to Printing without building a plate or opening the slicer"
              onClick={() => onConfirm("mark")}
            >
              <Icon icon={CirclePlay} size={14} /> Mark Printing
            </button>
            {!mark && (
              <button
                type="button"
                className="fp-btn fp-btn-sm fp-btn-primary"
                disabled={!canPrint}
                title={canPrint ? "Build the plate and open it in the slicer" : "Pick a printer first"}
                onClick={() => onConfirm("print")}
              >
                <Icon icon={PrinterIcon} size={14} /> Print!
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
