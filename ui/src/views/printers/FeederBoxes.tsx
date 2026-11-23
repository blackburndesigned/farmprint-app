import React from "react";
import type { PrinterFeeder } from "../../types";
import { type FeederCell, feederCaption, feederCells } from "./printerFeeders";

/** Which cell is picked in the spool sheet. */
export interface FeederCellRef { feederId: string; position: number }

type Variant = "lane" | "wall" | "sheet" | "tile";

const DOT: Record<Variant, number> = { lane: 14, wall: 18, sheet: 22, tile: 12 };

const cellTitle = (f: PrinterFeeder, c: FeederCell) => {
  const where = c.slotNumber !== null ? `Slot ${c.slotNumber}` : `${f.name} · spot ${c.position}`;
  return `${where}: ${c.spool ? `${c.spool.filament_name || "Unknown"}${c.spool.material ? ` · ${c.spool.material}` : ""}` : "Empty"}`;
};

/**
 * Each feeder as its own box of spool colors. Feeders that feed the printer show their
 * slot numbers; a dry box is drawn with a dashed border and no slot numbers.
 */
export const FeederBoxes: React.FC<{
  feeders: PrinterFeeder[];
  variant: Variant;
  selected?: FeederCellRef | null;
  onCellClick?: (feeder: PrinterFeeder, cell: FeederCell) => void;
}> = ({ feeders, variant, selected, onCellClick }) => {
  const dot = DOT[variant];
  const compact = variant === "lane" || variant === "tile";
  return (
    <div className={`fp-feeders fp-feeders-${variant}`}>
      {feeders.map((f) => (
        <div
          key={f.id}
          className={`fp-feeder${f.is_dry_box ? " fp-feeder-dry" : ""}`}
          title={`${f.name} · ${feederCaption(f)}${f.note ? ` · ${f.note}` : ""}`}
          aria-label={`${f.name}, ${feederCaption(f)}`}
        >
          {variant !== "tile" && (
            <div className="fp-feeder-head">
              <span className="fp-feeder-name">{f.name}</span>
              {!compact && <span className="fp-feeder-caption">{feederCaption(f)}</span>}
              {compact && f.is_dry_box && !/dry/i.test(f.name) && <span className="fp-feeder-caption">Dry</span>}
            </div>
          )}
          <div className="fp-feeder-cells">
            {feederCells(f).map((c) => {
              const isSel = !!selected && selected.feederId === f.id && selected.position === c.position;
              const dotEl = (
                <span
                  className={`fp-feeder-dot${c.spool ? "" : " fp-feeder-dot-empty"}`}
                  style={{ width: dot, height: dot, background: c.spool ? c.spool.filament_hex || "#888888" : undefined }}
                />
              );
              const label = variant === "wall" || variant === "sheet";
              const body = (
                <>
                  {c.slotNumber !== null && !compact && <span className="fp-feeder-num">{c.slotNumber}</span>}
                  {dotEl}
                  {label && <span className="fp-feeder-spool">{c.spool ? c.spool.filament_name : "Empty"}</span>}
                </>
              );
              return onCellClick ? (
                <button
                  key={c.position}
                  type="button"
                  className={`fp-feeder-cell${isSel ? " fp-feeder-cell-sel" : ""}`}
                  title={cellTitle(f, c)}
                  aria-label={cellTitle(f, c)}
                  aria-pressed={isSel}
                  onClick={(e) => { e.stopPropagation(); onCellClick(f, c); }}
                >
                  {body}
                </button>
              ) : (
                <span key={c.position} className="fp-feeder-cell" title={cellTitle(f, c)}>
                  {body}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};
