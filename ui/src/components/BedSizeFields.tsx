import React, { useEffect, useState } from "react";

/**
 * Printer bed size (mm). Width and depth both empty = unknown: plate building keeps its
 * 220 mm default. Height is optional and independent (blank = not set) and is not used
 * by plate building or Print!. Stored per printer as `bed_x_mm` / `bed_y_mm` / `bed_z_mm`.
 */
export type BedSize = { bed_x_mm: number | null; bed_y_mm: number | null; bed_z_mm: number | null };

function parseDim(text: string, label: string): number | null | { error: string } {
  const t = text.trim();
  if (!t) return null;
  const v = Number(t.replace(",", "."));
  if (!Number.isFinite(v) || v < 50 || v > 2000) return { error: `${label} must be 50–2000 mm.` };
  return v;
}

/** Parses width, depth and optional height: both width and depth empty → unknown;
 *  otherwise both 50–2000 mm. Height may be empty (not set) or 50–2000 mm. */
export function parseBedSize(xText: string, yText: string, zText = ""): BedSize | { error: string } {
  const xs = xText.trim();
  const ys = yText.trim();
  let bed_x_mm: number | null = null;
  let bed_y_mm: number | null = null;
  if (!xs && !ys) {
    // unknown width/depth
  } else if (!xs || !ys) {
    return { error: "Enter both bed width and depth, or leave both empty." };
  } else {
    const x = parseDim(xs, "Bed size");
    const y = parseDim(ys, "Bed size");
    if (x && typeof x === "object" && "error" in x) return x;
    if (y && typeof y === "object" && "error" in y) return y;
    bed_x_mm = x as number;
    bed_y_mm = y as number;
  }
  const z = parseDim(zText, "Build height");
  if (z && typeof z === "object" && "error" in z) return z;
  return { bed_x_mm, bed_y_mm, bed_z_mm: z };
}

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

/** Width, depth and optional height inputs. Calls `onCommit` when focus leaves the group (or on Enter). */
export const BedSizeFields: React.FC<{
  bedX?: number | null;
  bedY?: number | null;
  bedZ?: number | null;
  onCommit?: (size: BedSize) => void;
  onChangeText?: (x: string, y: string, z: string) => void;
  inputStyle?: React.CSSProperties;
}> = ({ bedX, bedY, bedZ, onCommit, onChangeText, inputStyle }) => {
  const [x, setX] = useState(fmt(bedX));
  const [y, setY] = useState(fmt(bedY));
  const [z, setZ] = useState(fmt(bedZ));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setX(fmt(bedX));
    setY(fmt(bedY));
    setZ(fmt(bedZ));
  }, [bedX, bedY, bedZ]);

  const commit = () => {
    if (!onCommit) return;
    const parsed = parseBedSize(x, y, z);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    if (
      parsed.bed_x_mm === (bedX ?? null) &&
      parsed.bed_y_mm === (bedY ?? null) &&
      parsed.bed_z_mm === (bedZ ?? null)
    )
      return;
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
          onChangeText?.(e.target.value, y, z);
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
          onChangeText?.(x, e.target.value, z);
        }}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        style={style}
      />
      <span style={{ fontSize: 11.5, opacity: 0.7 }}>×</span>
      <input
        type="text"
        inputMode="decimal"
        placeholder="Height"
        aria-label="Build height (mm)"
        value={z}
        onChange={(e) => {
          setZ(e.target.value);
          onChangeText?.(x, y, e.target.value);
        }}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        style={style}
      />
      <span style={{ fontSize: 11.5, opacity: 0.7 }}>mm{!x && !y ? " (unknown, uses 220)" : ""}</span>
      {error && <span style={{ fontSize: 11, color: "#ff6961", width: "100%" }}>{error}</span>}
    </div>
  );
};
