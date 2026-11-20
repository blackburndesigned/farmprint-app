// Slicer picker for Print! (Settings › Print library › Slicer). Mirrors `slicer.rs`
// in the app: the saved name, bundle id or chosen app file says which slicer Print! opens;
// nothing saved means Bambu Studio.
import type { ShopSettings } from "./types";

export type SlicerKey = "bambu" | "orca" | "prusa";

export const SLICERS: Array<{ key: SlicerKey; name: string; bundleId: string }> = [
  { key: "bambu", name: "Bambu Studio", bundleId: "com.bambulab.bambu-studio" },
  { key: "orca", name: "OrcaSlicer", bundleId: "com.orcaslicer.OrcaSlicer" },
  { key: "prusa", name: "PrusaSlicer", bundleId: "com.prusa3d.slic3r" },
];

/** Recognises a slicer from a name, bundle id or app file name; null when unknown. */
export function detectSlicer(text: string): SlicerKey | null {
  const t = (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (t.includes("orca") || t.includes("softfever")) return "orca";
  if (t.includes("prusa")) return "prusa";
  if (t.includes("bambu")) return "bambu";
  return null;
}

type SlicerFields = Pick<ShopSettings, "slicer_app_name" | "slicer_bundle_id" | "slicer_app_path">;

const fileName = (path: string) => (path || "").split(/[\\/]/).filter(Boolean).pop() || "";

/** Which slicer the saved settings pick: a known key, or "other" for an unknown chosen app. */
export function savedSlicer(s: SlicerFields): SlicerKey | "other" {
  const known = detectSlicer(s.slicer_app_name) ?? detectSlicer(s.slicer_bundle_id) ?? detectSlicer(fileName(s.slicer_app_path));
  if (known) return known;
  if ((s.slicer_app_name || "").trim() || (s.slicer_app_path || "").trim()) return "other";
  return "bambu";
}

/** Settings patch for picking a known slicer from the list. A chosen app location is
 *  kept only when it is that same slicer. */
export function pickSlicerPatch(key: SlicerKey, current: SlicerFields): SlicerFields {
  const s = SLICERS.find((x) => x.key === key)!;
  const keepPath = detectSlicer(fileName(current.slicer_app_path)) === key;
  return { slicer_app_name: s.name, slicer_bundle_id: s.bundleId, slicer_app_path: keepPath ? current.slicer_app_path : "" };
}

/** Settings patch for an app chosen with Choose…. */
export function chooseSlicerAppPatch(path: string): SlicerFields {
  const base = fileName(path).replace(/\.(app|exe|AppImage)$/i, "");
  const known = SLICERS.find((x) => x.key === detectSlicer(base));
  return known
    ? { slicer_app_name: known.name, slicer_bundle_id: known.bundleId, slicer_app_path: path }
    : { slicer_app_name: base, slicer_bundle_id: "", slicer_app_path: path };
}
