import React from "react";
import { actorDevice } from "../../deviceLabel";
import { PartUnit, Printer, TransitionRequest } from "../../types";
import { printerOptionLabel } from "../../printerLabels";

/** PrintPickTray.swift side drawer: pick queued parts across orders and send them to one printer. */
export const PrintPickTray: React.FC<{
  pickedUnitIds: Set<string>;
  setPickTrayOpen: React.Dispatch<React.SetStateAction<boolean>>;
  allQueuedUnits: PartUnit[];
  setPickedUnitIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  pickPrinterId: string;
  setPickPrinterId: React.Dispatch<React.SetStateAction<string>>;
  printers: Printer[];
  onRunTransition?: (req: TransitionRequest) => void;
}> = ({ pickedUnitIds, setPickTrayOpen, allQueuedUnits, setPickedUnitIds, pickPrinterId, setPickPrinterId, printers, onRunTransition }) => (
  <div
    style={{
      width: 320,
      flexShrink: 0,
      borderLeft: "1px solid rgba(255,255,255,0.12)",
      background: "rgba(20, 23, 30, 0.96)",
      display: "flex",
      flexDirection: "column",
      minHeight: 0,
    }}
  >
    <div
      style={{
        padding: "12px 14px",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 800 }}>
          Pick Parts to Print ({pickedUnitIds.size})
        </div>
        <div style={{ fontSize: 11, color: "rgba(235,235,245,0.6)" }}>
          Check In Queue parts to stage a mixed plate
        </div>
      </div>
      <button
        type="button"
        className="fp-btn fp-btn-sm"
        onClick={() => setPickTrayOpen(false)}
      >
        Close
      </button>
    </div>

    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: "8px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {allQueuedUnits.length === 0 ? (
        <div style={{ fontSize: 12, color: "rgba(235,235,245,0.5)", padding: 16 }}>
          No parts are currently In Queue.
        </div>
      ) : (
        allQueuedUnits.map((u) => {
          const checked = pickedUnitIds.has(u.id);
          return (
            <label
              key={u.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 8,
                background: checked
                  ? "rgba(10, 132, 255, 0.18)"
                  : "rgba(255,255,255,0.03)",
                border: checked
                  ? "1px solid rgba(10, 132, 255, 0.5)"
                  : "1px solid rgba(255,255,255,0.07)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => {
                  setPickedUnitIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(u.id)) next.delete(u.id);
                    else next.add(u.id);
                    return next;
                  });
                }}
              />
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: u.filament_hex,
                  border: "1px solid rgba(255,255,255,0.7)",
                  flexShrink: 0,
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 700 }}>
                  {u.part_name} · {u.filament_name}
                </div>
                <div style={{ fontSize: 10.5, color: "rgba(235,235,245,0.6)" }}>
                  {u.customer_name} ({u.order_code})
                </div>
              </div>
            </label>
          );
        })
      )}
    </div>

    <div
      style={{
        padding: "10px 12px 76px",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <select
        className="fp-select"
        style={{ width: "100%", height: 28, fontSize: 12 }}
        value={pickPrinterId}
        onChange={(e) => setPickPrinterId(e.target.value)}
      >
        {printers.map((p) => (
          <option key={p.id} value={p.id}>
            Target Printer: {printerOptionLabel(p.name, p.model)}
          </option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          className="fp-btn fp-btn-sm fp-btn-primary"
          style={{ flex: 1 }}
          disabled={pickedUnitIds.size === 0}
          onClick={() => {
            const ids = Array.from(pickedUnitIds);
            onRunTransition?.({
              unit_ids: ids,
              to_state: "Printing",
              printer_id: pickPrinterId || printers[0]?.id || null,
              actor_device: actorDevice(),
              source_surface: "Pick Parts to Print Tray",
              action_label: `Staged & printing ${ids.length} picked part(s)`,
              failure_reason: null,
              failure_note: null,
            });
            setPickedUnitIds(new Set());
          }}
        >
          Print Picked ({pickedUnitIds.size})
        </button>
        <button
          type="button"
          className="fp-btn fp-btn-sm"
          disabled={pickedUnitIds.size === 0}
          onClick={() => setPickedUnitIds(new Set())}
        >
          Clear
        </button>
      </div>
    </div>
  </div>
);
