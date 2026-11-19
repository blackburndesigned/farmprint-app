import React from "react";
import { revealLabel } from "../../platform";
import { invoke } from "../../tauriInvoke";
import { errorText } from "../../errorText";
import { ShopSettings } from "../../types";

export type Setter = (patch: Partial<ShopSettings>) => void;

export const caption: React.CSSProperties = { fontSize: 11.5, color: "rgba(235,235,245,0.6)" };
export const sectionTitle: React.CSSProperties = { fontSize: 13.5, fontWeight: 700 };
export const inputStyle: React.CSSProperties = { width: "100%", padding: "6px 8px", borderRadius: 6 };

export const Section: React.FC<{ title?: string; footer?: string; children: React.ReactNode }> = ({
  title,
  footer,
  children,
}) => (
  <div className="fp-card" style={{ display: "flex", flexDirection: "column", gap: 8, textAlign: "left" }}>
    {title && <div style={sectionTitle}>{title}</div>}
    {children}
    {footer && <div style={caption}>{footer}</div>}
  </div>
);

export const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 12.5 }}>
    <span style={{ whiteSpace: "nowrap" }}>{label}</span>
    <span style={{ textAlign: "right", flex: 1, display: "flex", justifyContent: "flex-end" }}>{children}</span>
  </div>
);

export const Check: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({
  label,
  checked,
  onChange,
}) => (
  <label style={{ fontSize: 12.5, display: "flex", gap: 8, alignItems: "center" }}>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    {label}
  </label>
);

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {options.map(([v, label]) => (
        <button
          key={String(v)}
          type="button"
          className={`fp-btn fp-btn-sm ${value === v ? "fp-btn-primary" : ""}`}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Integer input where blank means 0 (never a made-up default). */
export const NumField: React.FC<{ value: number; onChange: (n: number) => void; placeholder?: string; width?: number }> = ({
  value,
  onChange,
  placeholder,
  width,
}) => (
  <input
    type="number"
    min={0}
    value={value ? value : ""}
    placeholder={placeholder ?? "—"}
    onChange={(e) => onChange(Math.max(0, parseInt(e.target.value, 10) || 0))}
    style={{ ...inputStyle, width: width ?? 90 }}
  />
);

export const copyText = (t: string) => {
  if (t) navigator.clipboard?.writeText(t).catch(() => {});
};

// --- Shared helpers for native pickers -----------------------------------------

export async function choosePath(folder: boolean, prompt: string): Promise<string | null> {
  try {
    const r = await invoke<{ path: string | null }>("settings_choose_path", { folder, prompt });
    return r?.path ? r.path.replace(/\/$/, folder ? "" : "") : null;
  } catch {
    return null;
  }
}
/**
 * Branding logo picker (PNG, JPEG, WebP or GIF, at most 10 MB). Resolves to the path, or
 * null when cancelled or outside the app. Throws with a message for the user when the
 * picked file is not an accepted image (the backend checks the file's bytes too).
 */
export async function chooseLogoPath(prompt: string): Promise<string | null> {
  let r: { path: string | null } | null;
  try {
    r = await invoke<{ path: string | null }>("settings_choose_path", { folder: false, prompt });
  } catch (e) {
    const msg = errorText(e);
    if (/backend unavailable|unknown invoke command|404/i.test(msg)) return null;
    throw new Error(msg);
  }
  return r?.path || null;
}
export const revealInFileManager = (path: string) => {
  if (path) invoke("settings_reveal_in_finder", { path }).catch(() => {});
};

export const ColorInput: React.FC<{ value: string; onChange: (hex: string) => void; title?: string }> = ({
  value,
  onChange,
  title,
}) => (
  <input
    type="color"
    title={title}
    value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#808080"}
    onChange={(e) => onChange(e.target.value.toUpperCase())}
    style={{ width: 34, height: 24, padding: 0, border: "none", background: "transparent" }}
  />
);

export const PathRow: React.FC<{
  label: string;
  path: string;
  empty: string;
  onChoose: () => void;
  onClear?: () => void;
  extra?: React.ReactNode;
}> = ({ label, path, empty, onChoose, onClear, extra }) => (
  <>
    <Row label={label}>
      <span style={{ fontSize: 11.5, userSelect: "text", wordBreak: "break-all" }}>{path || empty}</span>
    </Row>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button type="button" className="fp-btn fp-btn-sm" onClick={onChoose}>
        Choose…
      </button>
      <button type="button" className="fp-btn fp-btn-sm" disabled={!path} onClick={() => revealInFileManager(path)}>
        {revealLabel()}
      </button>
      {onClear && (
        <button type="button" className="fp-btn fp-btn-sm" disabled={!path} onClick={onClear}>
          Clear
        </button>
      )}
      {extra}
    </div>
  </>
);
