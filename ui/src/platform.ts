// One place for OS-specific wording (display text only; no behavior changes).
export type OsKind = "mac" | "windows" | "linux";

export function osKind(): OsKind {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const p = `${(nav as { userAgentData?: { platform?: string } } | undefined)?.userAgentData?.platform || ""} ${nav?.platform || ""} ${nav?.userAgent || ""}`.toLowerCase();
  if (p.includes("mac")) return "mac";
  if (p.includes("win")) return "windows";
  return "linux";
}

/** "Finder" / "File Explorer" / "file manager". */
export function fileManagerName(): string {
  const os = osKind();
  return os === "mac" ? "Finder" : os === "windows" ? "File Explorer" : "file manager";
}

/** Button label for revealing a file: "Reveal in Finder" / "Show in File Explorer" / "Show in folder". */
export function revealLabel(): string {
  const os = osKind();
  return os === "mac" ? "Reveal in Finder" : os === "windows" ? "Show in File Explorer" : "Show in folder";
}

/** Shortcut hint: "⌘1" on macOS, "Ctrl+1" elsewhere. `shift` adds ⇧ / Shift+. */
export function shortcut(key: string, shift = false): string {
  if (osKind() === "mac") return `${shift ? "⇧" : ""}⌘${key}`;
  return `Ctrl+${shift ? "Shift+" : ""}${key}`;
}

/** Modifier word for click hints: "⌘" on macOS, "Ctrl" elsewhere. */
export function modKey(): string {
  return osKind() === "mac" ? "⌘" : "Ctrl";
}

/** Name of the system unlock method, for display only. */
export function biometricName(): string {
  const os = osKind();
  return os === "mac" ? "Touch ID" : os === "windows" ? "Windows Hello" : "password";
}

/** Where apps usually live, for file-picker prompts. */
export function appsFolderHint(): string {
  const os = osKind();
  return os === "mac" ? "/Applications" : os === "windows" ? "Program Files" : "your applications folder";
}

/** "#RRGGBB" or "#RRGGBBAA" -> { rgb: "#RRGGBB", alpha: 0..1 }. Tolerates no '#', 3-digit, junk. */
export function splitHexAlpha(hex: string): { rgb: string; alpha: number } {
  const h = (hex || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{8}$/i.test(h)) return { rgb: `#${h.slice(0, 6)}`, alpha: parseInt(h.slice(6), 16) / 255 };
  if (/^[0-9a-f]{6}$/i.test(h)) return { rgb: `#${h}`, alpha: 1 };
  if (/^[0-9a-f]{3}$/i.test(h)) return { rgb: `#${h.split("").map((c) => c + c).join("")}`, alpha: 1 };
  return { rgb: "#000000", alpha: 1 };
}

/** Joins back; fully opaque stays 6-digit so older readers are unaffected. */
export function joinHexAlpha(rgb: string, alpha: number): string {
  const base = splitHexAlpha(rgb).rgb.toUpperCase();
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  return a >= 255 ? base : `${base}${a.toString(16).padStart(2, "0").toUpperCase()}`;
}

/** CSS background for a swatch: color over a checkerboard so alpha is visible. */
export function swatchBackground(hex: string): string {
  const { rgb, alpha } = splitHexAlpha(hex);
  const n = parseInt(rgb.slice(1), 16);
  const rgba = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha.toFixed(3)})`;
  return `linear-gradient(${rgba},${rgba}), repeating-conic-gradient(#cbd5e1 0% 25%, #f8fafc 0% 50%) 0 0 / 8px 8px`;
}
