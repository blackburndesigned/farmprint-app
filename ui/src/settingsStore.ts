// Shared, live ShopSettings store. Loaded once at launch, replaced after every
// successful save in Settings, so every screen re-renders without a restart.
import { useSyncExternalStore } from "react";
import { invoke } from "./tauriInvoke";
import {
  AppearanceStudio,
  EMPTY_APPEARANCE_STUDIO,
  EMPTY_SHOP_SETTINGS,
  ShopSettings,
} from "./types";

let current: ShopSettings = EMPTY_SHOP_SETTINGS;
/** True once `current` came from fp-core, so a partial save never writes blank defaults. */
let loadedFromCore = false;
let logoDataUrl: string | null = null;
let logoFor = "";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function normalizeSettings(s: Partial<ShopSettings> | null | undefined): ShopSettings {
  return {
    ...EMPTY_SHOP_SETTINGS,
    ...(s || {}),
    appearance_studio: { ...EMPTY_APPEARANCE_STUDIO, ...((s && s.appearance_studio) || {}) },
    printer_accents: { ...((s && s.printer_accents) || {}) },
    process_steps: (s && s.process_steps) || [],
  };
}

export function getShopSettings(): ShopSettings {
  return current;
}

export function setShopSettings(next: Partial<ShopSettings> | null | undefined) {
  current = normalizeSettings(next);
  applyAppearance(current.appearance_studio);
  void refreshLogo(current.logo_path);
  emit();
}

export async function loadShopSettings(): Promise<ShopSettings> {
  try {
    const s = await invoke<ShopSettings>("get_shop_settings");
    setShopSettings(s);
    loadedFromCore = true;
  } catch {
    setShopSettings(current);
  }
  return current;
}

/**
 * Saves one or two fields outside the Settings window (e.g. the Printers board
 * view toggle). Starts from the settings loaded from fp-core, never from blank
 * defaults, and only applies the result once the save succeeded.
 */
export async function saveShopSettingsPatch(patch: Partial<ShopSettings>): Promise<ShopSettings> {
  if (!loadedFromCore) await loadShopSettings();
  if (!loadedFromCore) throw new Error("Settings haven't loaded yet");
  const saved = await invoke<ShopSettings>("save_shop_settings", { settings: { ...current, ...patch } });
  setShopSettings(saved);
  return current;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useShopSettings(): ShopSettings {
  return useSyncExternalStore(subscribe, getShopSettings, getShopSettings);
}

// --- Process steps --------------------------------------------------------------

export interface ProcessStep {
  id: string;
  name: string;
  bg: string;
  fg: string;
  hidden?: boolean;
}

/**
 * Steps the queue/printer logic depends on (fp-core sets them directly), so they
 * can't be deleted, only hidden. Value = why, shown in Settings › Process.
 */
export const FIXED_STEP_REASONS: Readonly<Record<string, string>> = {
  Staged:
    "Fixed step: Print!, Set to Print, printer trays and printer suggestions move parts into Staged, so it can't be deleted. You can hide it; staged parts then show under In Queue.",
};

export const BUILTIN_PROCESS_STEPS: readonly ProcessStep[] = [
  { id: "Queued", name: "In Queue", bg: "#475569", fg: "#f8fafc" },
  { id: "Staged", name: "Staged", bg: "#d97706", fg: "#ffffff" },
  { id: "Printing", name: "Printing", bg: "#2563eb", fg: "#ffffff" },
  { id: "Printed", name: "Printed", bg: "#0d9488", fg: "#ffffff" },
  { id: "Post-Processing", name: "Post-Process", bg: "#7c3aed", fg: "#ffffff" },
  { id: "Ready", name: "Closed / Ready", bg: "#16a34a", fg: "#ffffff" },
];

export function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? "#111111" : "#ffffff";
}

let stepsCacheKey: unknown = null;
let allStepsCache: ProcessStep[] = [...BUILTIN_PROCESS_STEPS];
let stepsCache: ProcessStep[] = [...BUILTIN_PROCESS_STEPS];

function refreshSteps() {
  const cfg = current.process_steps;
  if (stepsCacheKey === cfg) return;
  stepsCacheKey = cfg;
  allStepsCache = cfg.length
    ? cfg.map((s) => {
        const builtin = BUILTIN_PROCESS_STEPS.find((b) => b.id === s.id);
        const bg = /^#[0-9a-f]{6}$/i.test(s.color_hex) ? s.color_hex : builtin?.bg || "#64748b";
        const hidden = !!s.hidden && s.id in FIXED_STEP_REASONS;
        return { id: s.id, name: s.name.trim() || builtin?.name || s.id, bg, fg: readableOn(bg), hidden };
      })
    : [...BUILTIN_PROCESS_STEPS];
  stepsCache = allStepsCache.filter((s) => !s.hidden);
}

/** Visible steps (lanes, pickers): configured steps, or the built-ins when none are configured. */
export function getProcessSteps(): ProcessStep[] {
  refreshSteps();
  return stepsCache;
}

/** All steps including hidden ones (labels / lookups). */
export function getAllProcessSteps(): ProcessStep[] {
  refreshSteps();
  return allStepsCache;
}

export function isStepHidden(id: string): boolean {
  return !!getAllProcessSteps().find((s) => s.id === id)?.hidden;
}

export function useProcessSteps(): ProcessStep[] {
  useShopSettings();
  return getProcessSteps();
}

/** Display name for a unit/order state ("Ready" → configured name). */
export function stepLabel(state: string): string {
  return getAllProcessSteps().find((s) => s.id === state)?.name || state;
}

// --- Printer accents ----------------------------------------------------------------

export function printerAccent(printerId: string | null | undefined): string | undefined {
  if (!printerId) return undefined;
  const hex = current.printer_accents[printerId];
  return hex && /^#[0-9a-f]{6}$/i.test(hex) ? hex : undefined;
}

// --- Appearance Studio → CSS variables ------------------------------------------

/** "" | "#RRGGBB" | "gradient:<axis>:<angle>:#A,#B" → CSS background, or "" for system. */
export function backgroundCss(token: string): string {
  if (/^#[0-9a-f]{6}$/i.test(token)) return token;
  const m = /^gradient:([a-z]+):(\d+(?:\.\d+)?):(#[0-9a-f]{6}),(#[0-9a-f]{6})$/i.exec(token || "");
  if (!m) return "";
  const [, axis, angle, a, b] = m;
  if (axis === "radial") return `radial-gradient(circle, ${a}, ${b})`;
  const deg = ({ horizontal: 90, vertical: 180, diagonal: 135 } as Record<string, number>)[axis] ?? parseFloat(angle);
  return `linear-gradient(${deg}deg, ${a}, ${b})`;
}

const darkQuery =
  typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
darkQuery?.addEventListener?.("change", () => applyAppearance(current.appearance_studio));

function setVar(name: string, value: string) {
  const root = document.documentElement.style;
  if (value) root.setProperty(name, value);
  else root.removeProperty(name);
}

export function applyAppearance(st: AppearanceStudio) {
  if (typeof document === "undefined") return;
  // The shell is a dark UI by default; follow macOS appearance when it reports light.
  const dark = darkQuery ? darkQuery.matches : true;
  const pick = (light: string, darkV: string) => backgroundCss(dark ? darkV : light);
  setVar("--fp-window-bg", pick(st.window_bg_light, st.window_bg_dark));
  setVar("--fp-card-bg", pick(st.card_bg_light, st.card_bg_dark));
  setVar("--fp-tile-bg", pick(st.tile_bg_light, st.tile_bg_dark));
  setVar("--fp-window-blur", st.window_bg_blur > 0 ? `${st.window_bg_blur}px` : "");
  setVar("--fp-card-blur", st.card_bg_blur > 0 ? `${st.card_bg_blur}px` : "");
  setVar("--fp-tile-blur", st.tile_bg_blur > 0 ? `${st.tile_bg_blur}px` : "");
  const body = document.body.classList;
  body.toggle("fp-has-window-bg", !!pick(st.window_bg_light, st.window_bg_dark));
  body.toggle("fp-has-card-bg", !!pick(st.card_bg_light, st.card_bg_dark));
  body.toggle("fp-has-tile-bg", !!pick(st.tile_bg_light, st.tile_bg_dark));

  // Header frost
  const frostTint =
    st.card_header_frost_tint === "light"
      ? "rgba(255,255,255,0.28)"
      : st.card_header_frost_tint === "dark"
        ? "rgba(0,0,0,0.28)"
        : st.card_header_frost_tint === "custom" && /^#[0-9a-f]{6}$/i.test(st.card_header_frost_custom_hex)
          ? `${st.card_header_frost_custom_hex}55`
          : "transparent";
  body.toggle("fp-header-frost", st.card_header_frost_enabled);
  setVar("--fp-header-frost-tint", st.card_header_frost_enabled ? frostTint : "");
}

/** Outline strokes for a part thumbnail, outermost last, as stacked box-shadows. */
export function thumbnailOutlineShadow(statusHex: string): string | undefined {
  const st = current.appearance_studio;
  if (!st.tile_outline_enabled || st.tile_outline_strokes.length === 0) return undefined;
  let offset = 0;
  const parts: string[] = [];
  for (const s of st.tile_outline_strokes) {
    const w = Math.max(0, s.weight || 0);
    if (w <= 0) continue;
    offset += w;
    const raw = st.tile_outline_follows_status ? statusHex : firstHex(s.color) || statusHex;
    parts.push(`0 0 0 ${offset}px ${withAlpha(raw, s.opacity)}`);
  }
  return parts.length ? parts.join(", ") : undefined;
}

/** When outlines follow status, Swift hides the tile ring. */
export function outlineHidesRing(): boolean {
  const st = current.appearance_studio;
  return st.tile_outline_enabled && st.tile_outline_follows_status && st.tile_outline_strokes.length > 0;
}

function firstHex(token: string): string {
  if (/^#[0-9a-f]{6}$/i.test(token)) return token;
  const m = /(#[0-9a-f]{6})/i.exec(token || "");
  return m ? m[1] : "";
}
function withAlpha(hex: string, opacity: number): string {
  const a = Math.round(Math.min(1, Math.max(0, opacity)) * 255)
    .toString(16)
    .padStart(2, "0");
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${a}` : hex;
}

// --- Branding logo --------------------------------------------------------------

async function refreshLogo(path: string) {
  if (path === logoFor) return;
  logoFor = path;
  logoDataUrl = null;
  if (path) {
    try {
      const r = await invoke<{ data_url: string | null }>("read_logo_image", { path });
      if (logoFor === path) logoDataUrl = r?.data_url || null;
    } catch {
      logoDataUrl = null;
    }
  }
  emit();
}

export function useLogoDataUrl(): string | null {
  useShopSettings();
  return useSyncExternalStore(subscribe, () => logoDataUrl, () => logoDataUrl);
}
