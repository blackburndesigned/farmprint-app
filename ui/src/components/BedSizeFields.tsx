import React, { useEffect, useState } from "react";

/**
 * Printer bed size (mm). Both fields empty = unknown: plate building keeps its 220 mm
 * default. Stored per printer as `bed_x_mm` / `bed_y_mm` (null when unknown).
 */
export type BedSize = { bed_x_mm: number | null; bed_y_mm: number | null };

/** Parses the two fields: both empty → unknown; otherwise both 50–2000 mm. */
export function parseBedSize(xText: string, yText: string): BedSize | { error: string } {
  const xs = xText.trim();
  const ys = yText.trim();
  if (!xs && !ys) return { bed_x_mm: null, bed_y_mm: null };
  if (!xs || !ys) return { error: "Enter both bed width and depth, or leave both empty." };
  const x = Number(xs.replace(",", "."));
  const y = Number(ys.replace(",", "."));
  for (const v of [x, y]) {
    if (!Number.isFinite(v) || v < 50 || v > 2000) return { error: "Bed size must be 50–2000 mm." };
  }
  return { bed_x_mm: x, bed_y_mm: y };
}

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

/** Two small mm inputs. Calls `onCommit` when focus leaves the pair (or on Enter). */
export const BedSizeFields: React.FC<{
  bedX?: number | null;
  bedY?: number | null;
  onCommit?: (size: BedSize) => void;
  onChangeText?: (x: string, y: string) => void;
  inputStyle?: React.CSSProperties;
}> = ({ bedX, bedY, onCommit, onChangeText, inputStyle }) => {
  const [x, setX] = useState(fmt(bedX));
  const [y, setY] = useState(fmt(bedY));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setX(fmt(bedX));
    setY(fmt(bedY));
  }, [bedX, bedY]);

  const commit = () => {
    if (!onCommit) return;
    const parsed = parseBedSize(x, y);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    if (parsed.bed_x_mm === (bedX ?? null) && parsed.bed_y_mm === (bedY ?? null)) return;
    onCommit(parsed);
  };
  const style: React.CSSProperties = { width: 64, ...inputStyle };
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit();
      }}
    >
      <span style={{ fontSize: 11.5, opacity: 0.7 }}>Bed</span>
      <input
        type="text"
        inputMode="decimal"
        placeholder="220"
        aria-label="Bed width (mm)"
        value={x}
        onChange={(e) => {
          setX(e.target.value);
          onChangeText?.(e.target.value, y);
        }}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        style={style}
      />
      <span style={{ fontSize: 11.5, opacity: 0.7 }}>×</span>
      <input
        type="text"
        inputMode="decimal"
        placeholder="220"
        aria-label="Bed depth (mm)"
        value={y}
        onChange={(e) => {
          setY(e.target.value);
          onChangeText?.(x, e.target.value);
        }}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        style={style}
      />
      <span style={{ fontSize: 11.5, opacity: 0.7 }}>mm{!x && !y ? " (unknown, uses 220)" : ""}</span>
      {error && <span style={{ fontSize: 11, color: "#ff6961", width: "100%" }}>{error}</span>}
    </div>
  );
};
