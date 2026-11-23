import React, { useEffect, useState } from "react";
import "./feeders.css";
import type { AreaNozzle, Printer } from "../../types";
import { X } from "lucide-react";
import { Icon } from "../../icons";
import {
  AREA_NAME_SUGGESTIONS, AREA_NOZZLE_LABEL, type PrintAreaDraft, addAreaDraft, areaDraftsChanged, areaDraftsProblem,
  areaFitWarning, areaOverBed, areaPayload, draftsFromAreas,
} from "./printAreas";

const NUM_FIELDS = [
  ["width_mm", "W", "Width (X) in mm"],
  ["depth_mm", "D", "Depth (Y) in mm"],
  ["height_mm", "H", "Height (Z) in mm"],
  ["x_mm", "X", "X offset from the bed's front-left corner, in mm"],
  ["y_mm", "Y", "Y offset from the bed's front-left corner, in mm"],
] as const;

/**
 * Edits a printer's optional print areas: for printers whose nozzles each reach only part
 * of the bed. Each row is a name, the nozzles that reach it, its size and where it sits on
 * the bed. Nothing is saved until Save print areas. No areas = the whole bed.
 */
export const PrintAreasEditor: React.FC<{
  printer: Pick<Printer, "print_areas" | "bed_x_mm" | "bed_y_mm">;
  datalistId: string;
  onSave: (payload: ReturnType<typeof areaPayload>) => Promise<void>;
}> = ({ printer, datalistId, onSave }) => {
  const savedKey = JSON.stringify(printer.print_areas ?? []);
  const [drafts, setDrafts] = useState<PrintAreaDraft[]>(() => draftsFromAreas(printer.print_areas));
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDrafts(draftsFromAreas(printer.print_areas)), [savedKey]);
  const problem = areaDraftsProblem(drafts);
  const dirty = areaDraftsChanged(printer.print_areas, drafts);
  const warning = problem ? null : areaFitWarning(printer, drafts);
  const patch = (i: number, p: Partial<PrintAreaDraft>) => setDrafts((ds) => ds.map((d, k) => (k === i ? { ...d, ...p } : d)));

  const save = async () => {
    if (problem || busy) return;
    setBusy(true);
    try {
      await onSave(areaPayload(drafts));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fp-feeder-editor fp-area-editor">
      <datalist id={datalistId}>
        {AREA_NAME_SUGGESTIONS.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {drafts.length > 0 && (
        <div className="fp-area-head" aria-hidden="true">
          <span className="fp-area-name">Name</span>
          <span className="fp-area-nozzle">Nozzles</span>
          {NUM_FIELDS.map(([k, short, long]) => (
            <span key={k} className="fp-area-num" title={long}>{short}</span>
          ))}
          <span className="fp-area-x" />
        </div>
      )}
      {drafts.map((d, i) => (
        <div key={d.id ?? `new-${i}`} className="fp-feeder-edit-row fp-area-row">
          <input
            type="text"
            className="fp-area-name"
            list={datalistId}
            aria-label={`Print area ${i + 1} name`}
            value={d.name}
            placeholder="Name"
            onChange={(e) => patch(i, { name: e.target.value })}
          />
          <select
            className="fp-feeder-nozzle fp-area-nozzle"
            aria-label={`Print area ${i + 1} nozzles`}
            title="Which nozzles can print inside this area"
            value={d.nozzle}
            onChange={(e) => patch(i, { nozzle: e.target.value as AreaNozzle })}
          >
            {(["left", "right", "both"] as const).map((n) => (
              <option key={n} value={n}>{AREA_NOZZLE_LABEL[n]}</option>
            ))}
          </select>
          {NUM_FIELDS.map(([k, , long]) => (
            <input
              key={k}
              type="number"
              className={`fp-area-num${(k === "width_mm" || k === "x_mm") && areaOverBed(printer, d).x ? " fp-area-over" : ""}${(k === "depth_mm" || k === "y_mm") && areaOverBed(printer, d).y ? " fp-area-over" : ""}`}
              inputMode="decimal"
              min={k === "x_mm" || k === "y_mm" ? 0 : 1}
              max={2000}
              step="any"
              aria-label={`Print area ${i + 1} ${long}`}
              title={long}
              value={d[k]}
              onChange={(e) => patch(i, { [k]: e.target.value } as Partial<PrintAreaDraft>)}
            />
          ))}
          <button type="button" className="fp-btn fp-btn-sm fp-btn-ghost fp-area-x" aria-label={`Remove print area ${i + 1}`} title="Remove print area" onClick={() => setDrafts((ds) => ds.filter((_, k) => k !== i))}>
            <Icon icon={X} size={13} />
          </button>
        </div>
      ))}
      <div className="fp-feeder-edit-foot">
        <button type="button" className="fp-btn fp-btn-sm" onClick={() => setDrafts((ds) => addAreaDraft(ds))}>
          + Add print area
        </button>
        {dirty && (
          <button type="button" className="fp-btn fp-btn-sm fp-btn-primary" disabled={!!problem || busy} onClick={() => void save()}>
            Save print areas
          </button>
        )}
        {dirty && (
          <button type="button" className="fp-btn fp-btn-sm fp-btn-ghost" disabled={busy} onClick={() => setDrafts(draftsFromAreas(printer.print_areas))}>
            Revert
          </button>
        )}
        <span className="fp-feeder-edit-msg">
          {problem ??
            (drafts.length === 0
              ? "Optional. For printers whose nozzles reach different parts of the bed. Without areas the whole bed is used."
              : "Sizes and X / Y offsets in mm, measured from the bed's front-left corner.")}
        </span>
      </div>
      {warning && (
        <div className="fp-area-warn" role="status">
          {warning}
        </div>
      )}
    </div>
  );
};
