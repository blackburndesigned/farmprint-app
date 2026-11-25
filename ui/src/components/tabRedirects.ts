import type { DockTab } from "./DockAndHeader";

/** Tabs that were removed, and where they go now (old links, saved state). */
export const TAB_REDIRECTS: Record<string, DockTab> = {
  // Production Value was replaced by Insights (real numbers for a date range).
  value: "insights",
};

/** A tab id from anywhere (current or removed) as a tab that exists. */
export function normalizeTab(tab: string): DockTab {
  return TAB_REDIRECTS[tab] ?? (tab as DockTab);
}
