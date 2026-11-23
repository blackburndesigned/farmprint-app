// The printer picker's small fit summary: what one-click Print! will send to the chosen
// printer (arranged automatically), and a way into the full plate view. Never opens the
// plate view by itself.
import React from "react";
import { CircleAlert, CircleCheck, LayoutGrid, TriangleAlert } from "lucide-react";
import { Icon } from "../../../icons";
import type { FitSummary } from "./plateModel";
import { areaShading, fitHeadline } from "./plateModel";
import "./plate.css";

/** Top-down drawing of one plate: the bed and each part's outline in its filament color. */
export const PlateOutlineThumb: React.FC<{ summary: Pick<FitSummary, "bed" | "outlines" | "areas">; plate?: number; size?: number; problems?: Set<string> }> = ({
  summary,
  plate = 0,
  size = 72,
  problems,
}) => {
  const { width_mm: w, depth_mm: d } = summary.bed;
  const s = size / Math.max(w, d);
  const pad = 3;
  const W = w * s + pad * 2;
  const H = d * s + pad * 2;
  const pts = (o: [number, number][]) => o.map(([x, y]) => `${(pad + x * s).toFixed(1)},${(pad + (d - y) * s).toFixed(1)}`).join(" ");
  const shade = summary.areas ? areaShading(summary.bed, summary.areas) : { none: [], partial: [] };
  const cell = (r: [number, number, number, number], k: string, cls: string) => (
    <rect key={k} x={pad + r[0] * s} y={pad + (d - r[3]) * s} width={(r[2] - r[0]) * s} height={(r[3] - r[1]) * s} className={cls} />
  );
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="fp-plate-thumb" aria-hidden>
      <rect x={pad} y={pad} width={w * s} height={d * s} rx={3} className="fp-plate-thumb-bed" />
      {shade.none.map((r, i) => cell(r, `n${i}`, "fp-plate-thumb-noarea"))}
      {shade.partial.map((r, i) => cell(r, `p${i}`, "fp-plate-thumb-partarea"))}
      {summary.outlines
        .filter((o) => o.plate === plate)
        .map((o) => (
          <polygon
            key={o.unit_id}
            points={pts(o.outline)}
            fill={o.hex || "#9aa0a6"}
            stroke={problems?.has(o.unit_id) ? "#ff453a" : "rgba(0,0,0,0.45)"}
            strokeWidth={problems?.has(o.unit_id) ? 1.6 : 0.6}
          />
        ))}
    </svg>
  );
};

/** "Needs 2 plates" / "Too big" chip next to a printer's name. */
export const FitChip: React.FC<{ summary?: FitSummary }> = ({ summary }) => {
  if (!summary) return null;
  const c = summary.check;
  if (c.off_plate.length || c.too_tall.length || c.out_of_area?.length) return <span className="fp-fit-chip fp-fit-bad">Doesn't fit</span>;
  if (c.plates > 1) return <span className="fp-fit-chip fp-fit-warn">Needs {c.plates} plates</span>;
  return null;
};

export const PlateFitSummary: React.FC<{
  summary?: FitSummary;
  loading: boolean;
  error?: string | null;
  printerName: string;
  onArrange: () => void;
}> = ({ summary, loading, error, printerName, onArrange }) => {
  if (error) {
    return (
      <div className="fp-fit-card fp-fit-card-muted">
        <Icon icon={CircleAlert} size={14} />
        <span>{error}</span>
      </div>
    );
  }
  if (!summary) {
    return <div className="fp-fit-card fp-fit-card-muted">{loading ? "Checking the plate…" : ""}</div>;
  }
  const c = summary.check;
  const h = fitHeadline(c);
  const problems = new Set([...c.off_plate, ...c.too_tall, ...c.collisions.flat(), ...(c.out_of_area ?? [])]);
  const areaNote = summary.areas?.list.length ? ` · ${summary.areas.list.length} print areas, each part kept where its nozzle reaches` : "";
  const seq = summary.settings.sequence === "by_object" ? "by object" : "by layer";
  const tallest = summary.bed.height_mm ? `tallest part ${Math.round(c.tallest_mm)} of ${Math.round(summary.bed.height_mm)} mm` : `tallest part ${Math.round(c.tallest_mm)} mm`;
  const detail =
    h.tone === "bad"
      ? c.too_tall.length
        ? `Too tall for ${printerName}. Pick another printer, or lay the part on a side in the plate view.`
        : c.out_of_area?.length && !c.off_plate.length
          ? `Bigger than the area its nozzle reaches on ${printerName}. Pick another printer, or turn the part in the plate view.`
          : `Bigger than ${printerName}'s bed. Pick a larger printer, or turn the part in the plate view.`
      : c.plates > 1
        ? `Print! sends ${c.plates} plates, one .3mf each.${areaNote}`
        : `Arranged automatically · ${seq} · ${summary.settings.spacing_mm} mm spacing · ${Math.round(c.plate1_fill * 100)}% of the bed used · ${tallest}${areaNote}`;
  return (
    <div className={`fp-fit-card${h.tone === "bad" ? " fp-fit-card-bad" : ""}`}>
      <PlateOutlineThumb summary={summary} problems={problems} />
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <span className={`fp-fit-chip fp-fit-${h.tone}`}>
          <Icon icon={h.tone === "ok" ? CircleCheck : h.tone === "warn" ? TriangleAlert : CircleAlert} size={12} /> {h.text}
        </span>
        <span className="fp-fit-detail">{detail}</span>
        {!summary.bed.known && <span className="fp-fit-detail">This printer has no bed size yet, so the 220 mm default is used.</span>}
        <button type="button" className="fp-link-btn" onClick={onArrange}>
          <Icon icon={LayoutGrid} size={12} /> Arrange plate…
        </button>
      </div>
    </div>
  );
};
