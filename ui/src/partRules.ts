// The picture-only rule, from catalog flags only (no product- or part-specific special cases).
// A part that is not tracked, or is color-only, is "picture-only": it is drawn in product
// pictures but never printed, counted, or named in customer-facing text.
import type { CatalogPart, Product } from "./types";

/** True when a catalog part's flags make it picture-only. */
export function isPictureOnlyPart(part: Pick<CatalogPart, "is_tracked" | "is_color_only">): boolean {
  return !part.is_tracked || part.is_color_only;
}

/** The product's part whose name or id matches `partIdOrName` (case-insensitive, key trimmed). */
export function findProductPart(product: Product, partIdOrName: string): CatalogPart | undefined {
  const n = (partIdOrName || "").trim().toLowerCase();
  return product.parts.find((p) => p.name.toLowerCase() === n || p.id.toLowerCase() === n);
}
