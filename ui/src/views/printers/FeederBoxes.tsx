import React from "react";
import { Wind } from "lucide-react";
import type { PrinterFeeder } from "../../types";
import { Icon } from "../../icons";
import { swatchBackground } from "../../platform";
import {
  type FeederCell, feederBrandLine, feederCaption, feederCells, slotChipText, slotHoverTitle, swatchRing,
} from "./printerFeeders";

/** Which cell is picked in the spool sheet. */
export interface FeederCellRef { feederId: string; position: number }

type Variant = "lane" | "wall" | "sheet" | "tile";

const SWATCH: Record<Variant, number> = { lane: 26, wall: 30, sheet: 26, tile: 12 };

/** The spool color as a round swatch; very light or dark colors get a contrasting ring. */
const Swatch: React.FC<{ cell: FeederCell; size: number }> = ({ cell, size }) => {
  if (!cell.spool) return <span className="fp-slot-swatch fp-slot-swatch-empty" style={{ width: size, height: size }} />;
  const hex = cell.spool.filament_hex || "#888888";
  const ring = swatchRing(hex);
  return (
    <span
      className={`fp-slot-swatch${ring ? ` fp-slot-swatch-ring-${ring}` : ""}`}
      style={{ width: size, height: size, background: swatchBackground(hex) }}
    />
  );
};

/** Slot number, or a dry-box marker for a dry box spot. */
const SlotMark: React.FC<{ cell: FeederCell }> = ({ cell }) =>
  cell.slotNumber !== null ? (
    <span className="fp-slot-num">{cell.slotNumber}</span>
  ) : (
    <span className="fp-slot-num fp-slot-num-dry" aria-label="Dry box">
      <Icon icon={Wind} size={9} strokeWidth={2.5} />
    </span>
  );

/**
 * Each feeder as its own box of slot chips. One chip is one slot: the color swatch with the
 * spool's type and brand in the same bordered chip, and the slot number in its corner (a dry
 * box spot shows a dry-box marker instead). Empty slots are dashed chips.
 * The lane row is one line that scrolls sideways; Wall TV and the spool sheet list each slot
 * as a wider chip with the color name too. Settings tiles show swatches only.
 */
export const FeederBoxes: React.FC<{
  feeders: PrinterFeeder[];
  variant: Variant;
  selected?: FeederCellRef | null;
  onCellClick?: (feeder: PrinterFeeder, cell: FeederCell) => void;
}> = ({ feeders, variant, selected, onCellClick }) => {
  const size = SWATCH[variant];
  const wide = variant === "wall" || variant === "sheet";
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
                {f.is_dry_box ? <Icon icon={Wind} size={variant === "lane" ? 10 : 12} strokeWidth={2.5} className="fp-feeder-dry-icon" /> : null}
                <span className="fp-feeder-name">{f.name}</span>
                <span className="fp-feeder-caption">{feederCaption(f)}</span>
              </div>
            )}
            <div className="fp-feeder-cells">
              {feederCells(f).map((c) => {
                const isSel = !!selected && selected.feederId === f.id && selected.position === c.position;
                const title = slotHoverTitle(f, c);
                const { type, brand } = slotChipText(c.spool);
                const cls = [
                  variant === "tile" ? "fp-feeder-cell" : "fp-slot-chip",
                  c.spool ? "" : "fp-slot-chip-empty",
                  f.is_dry_box ? "fp-slot-chip-dry" : "",
                  isSel ? "fp-slot-chip-sel" : "",
                ].filter(Boolean).join(" ");
                let body: React.ReactNode;
                if (variant === "tile") {
                  body = <Swatch cell={c} size={size} />;
                } else if (wide) {
                  body = (
                    <>
                      <SlotMark cell={c} />
                      <Swatch cell={c} size={size} />
                      <span className="fp-slot-text">
                        <span className="fp-slot-name">{c.spool ? c.spool.filament_name || "Unknown" : "Empty"}</span>
                        {c.spool ? (
                          <span className="fp-slot-meta">
                            <span className="fp-slot-type">{type}</span>
                            <span className="fp-slot-sep" aria-hidden="true">·</span>
                            <span className="fp-slot-brand">{brand}</span>
                          </span>
                        ) : null}
                      </span>
                    </>
                  );
                } else {
                  body = (
                    <>
                      <SlotMark cell={c} />
                      <Swatch cell={c} size={size} />
                      <span className="fp-slot-type">{type}</span>
                      {c.spool ? <span className="fp-slot-brand">{brand}</span> : null}
                    </>
                  );
                }
                return onCellClick ? (
                  <button
                    key={c.position}
                    type="button"
                    className={cls}
                    title={title}
                    aria-label={title}
                    aria-pressed={isSel}
                    onClick={(e) => { e.stopPropagation(); onCellClick(f, c); }}
                  >
                    {body}
                  </button>
                ) : (
                  <span key={c.position} className={cls} title={title} aria-label={title}>
                    {body}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};
