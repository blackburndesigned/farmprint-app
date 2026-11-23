import React from "react";
import type { PrinterFeeder } from "../../types";
import { shortTypeLabel } from "../../filamentLabels";
import { type FeederCell, feederBrandLine, feederCaption, feederCells, slotHoverTitle } from "./printerFeeders";

/** Which cell is picked in the spool sheet. */
export interface FeederCellRef { feederId: string; position: number }

type Variant = "lane" | "wall" | "sheet" | "tile";

const DOT: Record<Variant, number> = { lane: 14, wall: 18, sheet: 22, tile: 12 };

/**
 * Each feeder as its own box of spool colors. Feeders that feed the printer show their
 * slot numbers; a dry box is drawn with a dashed border and no slot numbers.
 * Compact views put a short type label under each loaded dot and one brand line on the box.
 * Wall TV and the edit sheet show color name, brand and type in full beside each slot.
 */
export const FeederBoxes: React.FC<{
  feeders: PrinterFeeder[];
  variant: Variant;
  selected?: FeederCellRef | null;
  onCellClick?: (feeder: PrinterFeeder, cell: FeederCell) => void;
}> = ({ feeders, variant, selected, onCellClick }) => {
  const dot = DOT[variant];
  const compact = variant === "lane" || variant === "tile";
  const label = variant === "wall" || variant === "sheet";
  return (
    <div className={`fp-feeders fp-feeders-${variant}`}>
      {feeders.map((f) => {
        const brands = feederBrandLine(f);
        return (
          <div
            key={f.id}
            className={`fp-feeder${f.is_dry_box ? " fp-feeder-dry" : ""}`}
            title={`${f.name} · ${feederCaption(f)}${f.note ? ` · ${f.note}` : ""}${brands ? ` · ${brands}` : ""}`}
            aria-label={`${f.name}, ${feederCaption(f)}${brands ? `, ${brands}` : ""}`}
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
                const type = compact ? shortTypeLabel(c.spool?.material) : "";
                const meta = c.spool
                  ? [c.spool.brand?.trim() ? c.spool.brand.trim() : null, (c.spool.material || "").trim()].filter(Boolean).join(" · ")
                  : "";
                const title = slotHoverTitle(f, c);
                const dotEl = (
                  <span className="fp-feeder-swatch">
                    <span
                      className={`fp-feeder-dot${c.spool ? "" : " fp-feeder-dot-empty"}`}
                      style={{ width: dot, height: dot, background: c.spool ? c.spool.filament_hex || "#888888" : undefined }}
                    />
                    {type ? <span className="fp-feeder-type">{type}</span> : null}
                  </span>
                );
                const body = (
                  <>
                    {c.slotNumber !== null && !compact && <span className="fp-feeder-num">{c.slotNumber}</span>}
                    {dotEl}
                    {label && (
                      <span className="fp-feeder-spool-block">
                        <span className="fp-feeder-spool">{c.spool ? c.spool.filament_name : "Empty"}</span>
                        {meta ? <span className="fp-feeder-spool-meta">{meta}</span> : null}
                      </span>
                    )}
                  </>
                );
                return onCellClick ? (
                  <button
                    key={c.position}
                    type="button"
                    className={`fp-feeder-cell${isSel ? " fp-feeder-cell-sel" : ""}`}
                    title={title}
                    aria-label={title}
                    aria-pressed={isSel}
                    onClick={(e) => { e.stopPropagation(); onCellClick(f, c); }}
                  >
                    {body}
                  </button>
                ) : (
                  <span key={c.position} className="fp-feeder-cell" title={title}>
                    {body}
                  </span>
                );
              })}
            </div>
            {variant !== "tile" && brands ? (
              <div className="fp-feeder-brands" title={brands}>{brands}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};
