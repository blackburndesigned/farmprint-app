import React, { useEffect, useState } from "react";
import "./feeders.css";
import type { FeederNozzle, PrinterFeeder } from "../../types";
import { askConfirm } from "../../uiFeedback";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { Icon } from "../../icons";
import {
  type FeederDraft, MAX_FEEDER_SLOTS, addFeederDraft, draftsFromFeeders, feederDraftsChanged, feederDraftsProblem,
  feederPayload, moveFeederDraft, spoolsUnloadedBy,
} from "./printerFeeders";

/**
 * Edits a printer's feeder list: names, slot counts, dry box, note, order. Nothing is
 * saved until Save feeders; saving asks first when spools would be unloaded.
 * `showNozzle` (only on printers with print areas) adds the nozzle each feeder feeds;
 * when hidden, saved nozzles are kept as they are.
 */
export const FeederEditor: React.FC<{
  printerName: string;
  feeders: PrinterFeeder[];
  showNozzle?: boolean;
  onSave: (payload: ReturnType<typeof feederPayload>) => Promise<void>;
}> = ({ printerName, feeders, showNozzle = false, onSave }) => {
  const savedKey = JSON.stringify(feeders.map((f) => [f.id, f.name, f.slot_count, f.is_dry_box, f.note ?? "", !!f.auto, f.nozzle ?? ""]));
  const [drafts, setDrafts] = useState<FeederDraft[]>(() => draftsFromFeeders(feeders));
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDrafts(draftsFromFeeders(feeders)), [savedKey]);
  const problem = feederDraftsProblem(drafts);
  const dirty = feederDraftsChanged(feeders, drafts);
  const patch = (i: number, p: Partial<FeederDraft>) => setDrafts((ds) => ds.map((d, k) => (k === i ? { ...d, ...p } : d)));

  const save = async () => {
    if (problem || busy) return;
    const lost = spoolsUnloadedBy(feeders, drafts);
    if (lost > 0) {
      const ok = await askConfirm({
        title: `Unload ${lost} spool${lost === 1 ? "" : "s"} from ${printerName}?`,
        message: "Removed feeders and slots cut from the end of a feeder are emptied. The spools stay in your filament library.",
        confirmLabel: "Save feeders",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await onSave(feederPayload(drafts));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fp-feeder-editor">
      {drafts.map((d, i) => (
        <div key={d.id ?? `new-${i}`} className="fp-feeder-edit-row">
          <input
            type="text"
            aria-label={`Feeder ${i + 1} name`}
            value={d.name}
            placeholder={`Feeder ${i + 1}`}
            onChange={(e) => patch(i, { name: e.target.value })}
            style={showNozzle ? { flex: "1 1 96px", minWidth: 80 } : { flex: "1 1 120px", minWidth: 100 }}
          />
          <label>
            <input
              type="number"
              aria-label={`Feeder ${i + 1} slots`}
              min={1}
              max={MAX_FEEDER_SLOTS}
              step={1}
              value={Number.isFinite(d.slot_count) ? d.slot_count : ""}
              onChange={(e) => patch(i, { slot_count: e.target.value === "" ? NaN : Number(e.target.value) })}
              style={{ width: 58 }}
            />
            slots
          </label>
          <label title="Holds spools but doesn't feed the printer. Its spools are not offered to Print!.">
            <input type="checkbox" checked={d.is_dry_box} onChange={(e) => patch(i, { is_dry_box: e.target.checked })} />
            Dry box
          </label>
          {showNozzle && (
            <select
              className="fp-feeder-nozzle"
              aria-label={`Feeder ${i + 1} nozzle`}
              title={d.is_dry_box ? "A dry box doesn't feed a nozzle." : "Which nozzle this feeder feeds, so parts using it can be placed inside that nozzle's print area."}
              value={d.is_dry_box ? "" : (d.nozzle ?? "")}
              disabled={d.is_dry_box}
              onChange={(e) => patch(i, { nozzle: (e.target.value || null) as FeederNozzle | null })}
            >
              <option value="">No nozzle</option>
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          )}
          <input
            type="text"
            aria-label={`Feeder ${i + 1} note`}
            value={d.note}
            placeholder="Note (optional)"
            onChange={(e) => patch(i, { note: e.target.value })}
            style={showNozzle ? { flex: "1 1 90px", minWidth: 70 } : { flex: "1 1 110px", minWidth: 90 }}
          />
          <button type="button" className="fp-btn fp-btn-sm fp-btn-ghost" aria-label={`Move feeder ${i + 1} up`} title="Move up" disabled={i === 0} onClick={() => setDrafts((ds) => moveFeederDraft(ds, i, -1))}>
            <Icon icon={ArrowUp} size={13} />
          </button>
          <button type="button" className="fp-btn fp-btn-sm fp-btn-ghost" aria-label={`Move feeder ${i + 1} down`} title="Move down" disabled={i === drafts.length - 1} onClick={() => setDrafts((ds) => moveFeederDraft(ds, i, 1))}>
            <Icon icon={ArrowDown} size={13} />
          </button>
          <button type="button" className="fp-btn fp-btn-sm fp-btn-ghost" aria-label={`Remove feeder ${i + 1}`} title="Remove feeder" disabled={drafts.length <= 1} onClick={() => setDrafts((ds) => ds.filter((_, k) => k !== i))}>
            <Icon icon={X} size={13} />
          </button>
        </div>
      ))}
      <div className="fp-feeder-edit-foot">
        <button type="button" className="fp-btn fp-btn-sm" onClick={() => setDrafts((ds) => addFeederDraft(ds))}>
          + Add feeder
        </button>
        <button type="button" className="fp-btn fp-btn-sm fp-btn-primary" disabled={!dirty || !!problem || busy} onClick={() => void save()}>
          Save feeders
        </button>
        {dirty && (
          <button type="button" className="fp-btn fp-btn-sm fp-btn-ghost" disabled={busy} onClick={() => setDrafts(draftsFromFeeders(feeders))}>
            Revert
          </button>
        )}
        <span className="fp-feeder-edit-msg">
          {problem ?? "Feeders number their slots in order, so slot numbers in Print! follow this list. A dry box has no slot numbers."}
        </span>
      </div>
    </div>
  );
};
