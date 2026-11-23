/** Label shown for a spool with no brand. Not stored as a real brand name. */
export const NO_BRAND_LABEL = "No brand";
/** Label shown when a spool has no vendor/source. */
export const UNSPECIFIED_VENDOR_LABEL = "Unspecified";

export function displayBrand(brand?: string | null): string {
  const t = (brand || "").trim();
  return t ? t : NO_BRAND_LABEL;
}

export function displayVendor(vendor?: string | null): string {
  const t = (vendor || "").trim();
  return t ? t : UNSPECIFIED_VENDOR_LABEL;
}

/** Unique non-blank values, trimmed, in the order first seen. */
export function suggestionValues(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const t = (raw || "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Short material/type label for tight UI (feeder dots). Blank stays blank. */
export function shortTypeLabel(material?: string | null, maxLen = 6): string {
  const t = (material || "").trim();
  if (!t) return "";
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(1, maxLen - 1))}…`;
}

