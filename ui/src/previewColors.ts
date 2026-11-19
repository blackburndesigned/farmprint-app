/**
 * Shared part-color policy for product previews (product-agnostic).
 *
 *  - "preview": catalog/browsing views (Products page, New Order picker). Parts that
 *    print or are color-only get a deterministic pseudo-random filament color seeded by
 *    product id + part id, so it is stable across redraws and sessions. Adjacent parts
 *    (by sort_order) never share a color. Picture-only parts (is_tracked false and
 *    is_color_only false) always keep their saved default color.
 *  - "saved": every part uses its saved default filament color (Thumbnail Creator /
 *    product editing).
 * Order-specific views should NOT use this; they pass the order's chosen filament_hex.
 */
import type { CatalogPart, FilamentSwatch, Product } from "./types";
import type { CompositePartColor } from "./partThumbnails";

export type PreviewColorMode = "preview" | "saved";

/** Fallback palette when the shop has no usable filament colors. */
export const PREVIEW_PALETTE = [
  "#E4572E", "#2E86AB", "#F2C14E", "#4CB944", "#A23B72", "#F18F01",
  "#3B1F2B", "#7FB7BE", "#D7263D", "#1B998B", "#8E7DBE", "#F5F5F5",
];

export function isPictureOnlyCatalogPart(pt: Pick<CatalogPart, "is_tracked" | "is_color_only">): boolean {
  return !pt.is_tracked && !pt.is_color_only;
}

function hash32(s: string): number {
  // FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function paletteFrom(filaments?: FilamentSwatch[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of filaments || []) {
    const hex = (f.hex || "").trim().toUpperCase().slice(0, 7); // drop #RRGGBBAA alpha
    if (/^#[0-9A-F]{6}$/.test(hex) && !seen.has(hex)) {
      seen.add(hex);
      out.push(hex);
    }
  }
  return out.length >= 3 ? out : PREVIEW_PALETTE;
}

/** Map of part id -> hex for one product. */
export function previewColorsForProduct(
  product: Pick<Product, "id" | "parts">,
  mode: PreviewColorMode,
  filaments: FilamentSwatch[] = []
): Map<string, string> {
  const hexById = new Map(filaments.map((f) => [f.id, f.hex]));
  const saved = (pt: CatalogPart) => hexById.get(pt.default_filament_id) || "#8E8E93";
  const out = new Map<string, string>();
  const parts = [...(product.parts || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  if (mode === "saved") {
    for (const pt of parts) out.set(pt.id, saved(pt));
    return out;
  }
  const palette = paletteFrom(filaments);
  let prev: string | undefined;
  for (const pt of parts) {
    if (isPictureOnlyCatalogPart(pt)) {
      const hex = saved(pt);
      out.set(pt.id, hex);
      prev = hex.toUpperCase();
      continue;
    }
    let idx = hash32(`${product.id}::${pt.id || pt.name}`) % palette.length;
    for (let tries = 0; tries < palette.length && palette[idx].toUpperCase() === prev; tries++) {
      idx = (idx + 1) % palette.length;
    }
    out.set(pt.id, palette[idx]);
    prev = palette[idx].toUpperCase();
  }
  return out;
}

/** Ready-to-pass parts for ProductCompositeThumb / ProductCompositeThumbnail3D. */
export function previewCompositeParts(
  product: Pick<Product, "id" | "parts">,
  mode: PreviewColorMode,
  filaments: FilamentSwatch[] = []
): CompositePartColor[] {
  const colors = previewColorsForProduct(product, mode, filaments);
  return (product.parts || []).map((pt) => ({
    partId: pt.id,
    partName: pt.name,
    colorHex: colors.get(pt.id) || "#8E8E93",
  }));
}
