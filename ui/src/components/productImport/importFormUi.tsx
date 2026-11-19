import React from "react";

export const FILAMENT_SWATCHES: { name: string; hex: string }[] = [
  { name: "Black", hex: "#111827" },
  { name: "Blue", hex: "#0047AB" },
  { name: "Red", hex: "#DC2626" },
  { name: "Orange", hex: "#EA580C" },
  { name: "Green", hex: "#16A34A" },
  { name: "Purple", hex: "#9333EA" },
  { name: "White", hex: "#F8FAFC" },
  { name: "Gold", hex: "#EAB308" },
  { name: "Gray", hex: "#64748B" },
];

export function FormSection({
  title,
  footer,
  headerExtra,
  children,
}: {
  title: string;
  footer?: string;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 4px 6px" }}>
        <div style={{ fontSize: 12, fontWeight: 650, opacity: 0.6, flex: 1 }}>{title}</div>
        {headerExtra}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, borderRadius: 10, background: "color-mix(in srgb, canvastext 5%, canvas)" }}>
        {children}
      </div>
      {footer && <div style={{ fontSize: 11, opacity: 0.55, margin: "6px 4px 0" }}>{footer}</div>}
    </section>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 8, alignItems: "center", fontSize: 13 }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export const fieldStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid color-mix(in srgb, canvastext 18%, transparent)",
  borderRadius: 6,
  padding: "5px 8px",
  background: "canvas",
  color: "canvastext",
  font: "13px -apple-system, BlinkMacSystemFont, sans-serif",
};

export const plainButton: React.CSSProperties = {
  border: "1px solid color-mix(in srgb, canvastext 18%, transparent)",
  background: "color-mix(in srgb, canvastext 4%, canvas)",
  color: "inherit",
  borderRadius: 6,
  padding: "4px 10px",
  font: "13px -apple-system, BlinkMacSystemFont, sans-serif",
  cursor: "pointer",
};

export const prominentButton: React.CSSProperties = {
  border: "none",
  background: "#0a84ff",
  color: "white",
  borderRadius: 6,
  padding: "5px 12px",
  font: "600 13px -apple-system, BlinkMacSystemFont, sans-serif",
  cursor: "pointer",
};

export function chipButton(active: boolean): React.CSSProperties {
  return {
    ...plainButton,
    borderColor: active ? "#0a84ff" : undefined,
    color: active ? "#0a84ff" : "inherit",
  };
}

export function segmentButton(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    border: "none",
    padding: "6px 4px",
    font: "12px -apple-system, BlinkMacSystemFont, sans-serif",
    background: active ? "#0a84ff" : "transparent",
    color: active ? "white" : "inherit",
    cursor: "pointer",
  };
}

export const iconChip: React.CSSProperties = {
  border: "none",
  background: "color-mix(in srgb, canvas 70%, transparent)",
  borderRadius: 999,
  width: 26,
  height: 26,
  cursor: "pointer",
};

export const menuPop: React.CSSProperties = {
  position: "absolute",
  right: 0,
  top: "100%",
  zIndex: 5,
  minWidth: 180,
  padding: 4,
  borderRadius: 8,
  background: "canvas",
  border: "1px solid color-mix(in srgb, canvastext 16%, transparent)",
  boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
  display: "flex",
  flexDirection: "column",
};

export const menuItem: React.CSSProperties = {
  textAlign: "left",
  border: "none",
  background: "transparent",
  color: "inherit",
  padding: "6px 8px",
  borderRadius: 6,
  cursor: "pointer",
  font: "13px -apple-system, BlinkMacSystemFont, sans-serif",
};
