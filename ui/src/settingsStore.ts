// Shared, live ShopSettings store. Loaded once at launch, replaced after every
// successful save in Settings, so every screen re-renders without a restart.
import { useSyncExternalStore } from "react";
import { invoke } from "./tauriInvoke";
import { applyThemeMode, onSystemThemeChange, resolveTheme, systemPrefersDark } from "./theme";
import {
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
  applyTheme(current);
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

// --- Light / Dark ------------------------------------------------------------------

onSystemThemeChange(() => applyTheme(current));

/**
 * Applies the Light / Dark choice. The old Appearance Studio colors, blurs and header frost
 * are still read and saved (so older settings files round-trip) but no longer applied; the
 * thumbnail outline settings live in thumbnailOutline.ts.
 */
export function applyTheme(s: Pick<ShopSettings, "appearance_mode">) {
  applyThemeMode(resolveTheme(s.appearance_mode, systemPrefersDark()));
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
