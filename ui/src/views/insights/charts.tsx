/** Small SVG charts for Insights. No chart library; colors work in light and dark. */
import React from "react";
import { niceMax } from "./insightsRange";

export const INS_COLORS = ["#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff453a", "#64d2ff", "#ffd60a", "#ac8e68"];

export interface ColumnPoint {
  key: string;
  label: string;
  value: number;
  title: string;
}

/** Vertical bars over time. Click a bar to see what's behind it. */
export const ColumnChart: React.FC<{
  points: ColumnPoint[];
  color?: string;
  format: (v: number) => string;
  onBarClick?: (p: ColumnPoint) => void;
  ariaLabel: string;
}> = ({ points, color = INS_COLORS[0], format, onBarClick, ariaLabel }) => {
  const W = 600;
  const H = 180;
  const left = 46;
  const bottom = 22;
  const top = 8;
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const n = Math.max(1, points.length);
  const slot = (W - left - 4) / n;
  const bw = Math.max(1.5, Math.min(28, slot * 0.72));
  const y = (v: number) => top + (H - top - bottom) * (1 - v / max);
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  return (
    <svg className="fp-ins-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line className="axis" x1={left} x2={W - 4} y1={y(max * f)} y2={y(max * f)} strokeDasharray={f ? "3 3" : undefined} />
          <text x={left - 6} y={y(max * f) + 3} textAnchor="end">{format(max * f)}</text>
        </g>
      ))}
      {points.map((p, i) => {
        const x = left + slot * i + (slot - bw) / 2;
        const h = Math.max(p.value > 0 ? 1.5 : 0, H - bottom - y(p.value));
        return (
          <g key={p.key}>
            <rect className="bar" x={x} y={H - bottom - h} width={bw} height={h} rx={Math.min(3, bw / 3)} fill={color}
              onClick={() => onBarClick?.(p)} data-key={p.key}>
              <title>{p.title}</title>
            </rect>
            {/* Invisible hit area so empty days are still clickable. */}
            <rect x={left + slot * i} y={top} width={slot} height={H - top - bottom} fill="transparent" style={{ cursor: "pointer" }}
              onClick={() => onBarClick?.(p)}>
              <title>{p.title}</title>
            </rect>
            {i % labelEvery === 0 && (
              <text x={x + bw / 2} y={H - 6} textAnchor="middle">{p.label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

export interface BarRow {
  key: string;
  label: string;
  value: number;
  valueText: string;
  color?: string;
  swatch?: string | null;
  title?: string;
}

/** Horizontal bars, one per row, scaled to the largest (or to `max`). */
export const BarList: React.FC<{ rows: BarRow[]; max?: number; onClick?: (r: BarRow) => void; color?: string }> = ({
  rows,
  max,
  onClick,
  color = INS_COLORS[0],
}) => {
  const top = max ?? Math.max(0, ...rows.map((r) => r.value));
  return (
    <div className="fp-ins-bars">
      {rows.map((r) => (
        <button key={r.key} type="button" className="fp-ins-bar" onClick={() => onClick?.(r)} title={r.title ?? `${r.label}: ${r.valueText}`}>
          <span className="fp-ins-bar-label">
            {r.swatch !== undefined && <span className="fp-ins-swatch" style={{ background: r.swatch || "transparent" }} />}
            {r.label}
          </span>
          <svg viewBox="0 0 100 10" preserveAspectRatio="none" style={{ width: "100%", height: 10 }} aria-hidden>
            <rect className="fp-ins-track" x={0} y={0} width={100} height={10} rx={3} />
            <rect x={0} y={0} width={top > 0 ? Math.max(r.value > 0 ? 1 : 0, (r.value / top) * 100) : 0} height={10} rx={3} fill={r.color ?? color} />
          </svg>
          <span className="fp-ins-bar-value">{r.valueText}</span>
        </button>
      ))}
    </div>
  );
};

/** Two bars per row (e.g. revenue share vs printer-time share). */
export const PairBars: React.FC<{
  rows: Array<{ key: string; label: string; a: number; b: number; aText: string; bText: string }>;
  aLabel: string;
  bLabel: string;
  onClick?: (key: string) => void;
}> = ({ rows, aLabel, bLabel, onClick }) => (
  <div className="fp-ins-bars">
    <div className="fp-ins-legend">
      <span><i style={{ background: INS_COLORS[0] }} />{aLabel}</span>
      <span><i style={{ background: INS_COLORS[2] }} />{bLabel}</span>
    </div>
    {rows.map((r) => (
      <button key={r.key} type="button" className="fp-ins-bar" onClick={() => onClick?.(r.key)} title={`${r.label}: ${aLabel} ${r.aText}, ${bLabel} ${r.bText}`}>
        <span className="fp-ins-bar-label">{r.label}</span>
        <svg viewBox="0 0 100 14" preserveAspectRatio="none" style={{ width: "100%", height: 14 }} aria-hidden>
          <rect className="fp-ins-track" x={0} y={0} width={100} height={6} rx={2} />
          <rect x={0} y={0} width={Math.min(100, r.a * 100)} height={6} rx={2} fill={INS_COLORS[0]} />
          <rect className="fp-ins-track" x={0} y={8} width={100} height={6} rx={2} />
          <rect x={0} y={8} width={Math.min(100, r.b * 100)} height={6} rx={2} fill={INS_COLORS[2]} />
        </svg>
        <span className="fp-ins-bar-value">{r.aText} / {r.bText}</span>
      </button>
    ))}
  </div>
);

/** One bar split into parts (e.g. waiting / printing / after printing). */
export const StackBar: React.FC<{ parts: Array<{ label: string; value: number; text: string; color: string }>; onClick?: () => void }> = ({
  parts,
  onClick,
}) => {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  let x = 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, cursor: onClick ? "pointer" : undefined }} onClick={onClick}>
      <svg viewBox="0 0 100 14" preserveAspectRatio="none" style={{ width: "100%", height: 18 }} aria-hidden>
        <rect className="fp-ins-track" x={0} y={0} width={100} height={14} rx={4} />
        {total > 0 &&
          parts.map((p) => {
            const w = (Math.max(0, p.value) / total) * 100;
            const r = <rect key={p.label} x={x} y={0} width={w} height={14} fill={p.color} />;
            x += w;
            return r;
          })}
      </svg>
      <div className="fp-ins-legend">
        {parts.map((p) => (
          <span key={p.label}><i style={{ background: p.color }} />{p.label}: {p.text}</span>
        ))}
      </div>
    </div>
  );
};
