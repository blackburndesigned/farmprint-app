// Light / Dark appearance. The choice is stored in ShopSettings.appearance_mode; until one is
// saved the app follows the computer's own setting (prefers-color-scheme).

export type ThemeMode = "light" | "dark";

/**
 * The explicit choice in a stored `appearance_mode`, or null when there is none. Older
 * values map onto the two modes: "light"/"dark" in any case are kept; "", "system", "auto"
 * and anything unknown mean "no choice yet", which follows the computer.
 */
export function savedThemeChoice(mode: string | null | undefined): ThemeMode | null {
  const m = (mode || "").trim().toLowerCase();
  if (m === "light" || m === "aqua") return "light";
  if (m === "dark" || m === "darkaqua") return "dark";
  return null;
}

/** The mode to show: the saved choice, else the computer's setting. */
export function resolveTheme(mode: string | null | undefined, systemPrefersDark: boolean): ThemeMode {
  return savedThemeChoice(mode) ?? (systemPrefersDark ? "dark" : "light");
}

const darkQuery =
  typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

/** The computer's setting (dark when it can't be read: the app was dark-only before). */
export function systemPrefersDark(): boolean {
  return darkQuery ? darkQuery.matches : true;
}

/** Calls `fn` whenever the computer switches between light and dark. */
export function onSystemThemeChange(fn: () => void): void {
  darkQuery?.addEventListener?.("change", fn);
}

/** Puts `mode` on <html data-theme> (CSS in theme.css) and sets the native color-scheme. */
export function applyThemeMode(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
}
