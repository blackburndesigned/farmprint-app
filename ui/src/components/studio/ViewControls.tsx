import React, { useEffect, useRef } from "react";
import { FramingPreset } from "../../viewportCamera";
import { PRESETS, framingPresetName } from "./viewportTypes";

const ctlBtn: React.CSSProperties = {
  minWidth: 32,
  height: 32,
  padding: "0 6px",
  border: "1px solid color-mix(in srgb, canvastext 16%, transparent)",
  borderRadius: 6,
  background: "color-mix(in srgb, canvastext 6%, transparent)",
  color: "inherit",
  font: "13px -apple-system, BlinkMacSystemFont, sans-serif",
  cursor: "pointer",
  touchAction: "manipulation",
};

/** Compact on-screen controls for mice without gestures and touchscreens. */
export function ViewControls(p: {
  open: boolean;
  onToggle: () => void;
  panMode: boolean;
  onPanMode: (v: boolean) => void;
  /** Start a hold-to-move jog. kind "orbit" uses (sx, sy) screen directions; "zoom" sx = +1 in / −1 out; "roll" sx = +1 clockwise. Returns stop(). */
  onJog: (kind: "orbit" | "zoom" | "roll", sx: number, sy: number) => () => void;
  onReset: () => void;
  onPreset: (preset: FramingPreset) => void;
  azimuth: number;
  elevation: number;
  onLightAngles: (azimuth: number, elevation: number) => void;
  /** Key-light sliders; off in order and read-only viewers, where light isn't edited. */
  showLight: boolean;
  keyIntensity: number;
  onKeyIntensity: (key: number) => void;
}) {
  const verb = p.panMode ? "Pan" : "Rotate";
  const b = (label: string, title: string, onClick: () => void, active = false) => (
    <button type="button" title={title} aria-label={title} aria-pressed={active || undefined} onClick={onClick}
      style={{ ...ctlBtn, ...(active ? { background: "#0a84ff", color: "white", borderColor: "#0a84ff" } : {}) }}>
      {label}
    </button>
  );
  const stopRef = useRef<(() => void) | null>(null);
  const stopJog = () => { stopRef.current?.(); stopRef.current = null; };
  useEffect(() => {
    window.addEventListener("blur", stopJog);
    window.addEventListener("pointerup", stopJog);
    return () => { window.removeEventListener("blur", stopJog); window.removeEventListener("pointerup", stopJog); stopJog(); };
  }, []);
  const hold = (label: string, title: string, kind: "orbit" | "zoom" | "roll", sx: number, sy: number) => (
    <button type="button" title={`${title} — hold to keep moving`} aria-label={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        stopJog();
        stopRef.current = p.onJog(kind, sx, sy);
      }}
      onPointerUp={stopJog}
      onPointerCancel={stopJog}
      onLostPointerCapture={stopJog}
      onPointerLeave={stopJog}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); stopJog(); stopRef.current = p.onJog(kind, sx, sy); }
      }}
      onKeyUp={stopJog}
      onBlur={stopJog}
      style={{ ...ctlBtn, touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}>
      {label}
    </button>
  );
  const row: React.CSSProperties = { display: "flex", gap: 4, alignItems: "center", justifyContent: "center" };
  const slider = (label: string, value: number, min: number, max: number, onChange: (v: number) => void, unit = "°") => (
    <label style={{ display: "grid", gridTemplateColumns: "58px 1fr 38px", alignItems: "center", gap: 4, fontSize: 11 }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <input type="range" min={min} max={max} value={value} aria-label={label} title={label}
        onChange={(e) => onChange(parseFloat(e.target.value))} style={{ width: "100%", minHeight: 24 }} />
      <span style={{ textAlign: "right", opacity: 0.7 }}>{Math.round(value)}{unit}</span>
    </label>
  );
  return (
    <div
      role="toolbar"
      aria-label="View controls"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute", right: 10, top: 10, display: "flex", flexDirection: "column", gap: 6,
        padding: 6, borderRadius: 8, width: p.open ? 188 : undefined,
        background: "color-mix(in srgb, canvas 78%, transparent)", boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
        font: "12px -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <div style={{ ...row, justifyContent: "space-between" }}>
        {p.open && <span style={{ fontSize: 11, opacity: 0.6, paddingLeft: 2 }}>View</span>}
        {b(p.open ? "×" : "✥", p.open ? "Hide view controls" : "Show view controls", p.onToggle)}
      </div>
      {p.open && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 32px)", gap: 4, justifyContent: "center" }}>
            {hold("⟲", "Spin counterclockwise ([)", "roll", -1, 0)}{hold("▲", `${verb} up (↑)`, "orbit", 0, 1)}{hold("⟳", "Spin clockwise (])", "roll", 1, 0)}
            {hold("◀", `${verb} left (←)`, "orbit", -1, 0)}
            {b("⌂", "Reset view (0)", p.onReset)}
            {hold("▶", `${verb} right (→)`, "orbit", 1, 0)}
            <span />{hold("▼", `${verb} down (↓)`, "orbit", 0, -1)}<span />
          </div>
          <div style={row}>
            {hold("−", "Zoom out (−)", "zoom", -1, 0)}
            {hold("+", "Zoom in (+)", "zoom", 1, 0)}
            {b("✋", p.panMode ? "Pan mode on — arrows pan. Click for rotate" : "Pan mode: make the arrows pan", () => p.onPanMode(!p.panMode), p.panMode)}
          </div>
          <div style={row}>
            {PRESETS.map((preset) => b(framingPresetName(preset), `${framingPresetName(preset)} view`, () => p.onPreset(preset)))}
          </div>
          {p.showLight && (
          <div style={{ borderTop: "1px solid color-mix(in srgb, canvastext 12%, transparent)", paddingTop: 4, display: "grid", gap: 2 }}>
            <span style={{ fontSize: 11, opacity: 0.6 }}>Key light</span>
            {slider("Azimuth", p.azimuth, -180, 180, (v) => p.onLightAngles(v, p.elevation))}
            {slider("Elevation", p.elevation, -89, 89, (v) => p.onLightAngles(p.azimuth, v))}
            {slider("Intensity", p.keyIntensity, 200, 2000, p.onKeyIntensity, "")}
          </div>
          )}
        </>
      )}
    </div>
  );
}

export function hudButton(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    border: "none",
    padding: "3px 0",
    font: "12px -apple-system, BlinkMacSystemFont, sans-serif",
    background: active ? "#0a84ff" : "transparent",
    color: active ? "white" : "inherit",
    cursor: "pointer",
  };
}

export function iconButton(active: boolean): React.CSSProperties {
  return {
    width: 28,
    height: 22,
    border: "none",
    background: "transparent",
    color: active ? "#0a84ff" : "inherit",
    cursor: "pointer",
    fontSize: 16,
  };
}

export const menuStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "inherit",
  font: "12px -apple-system, BlinkMacSystemFont, sans-serif",
};
