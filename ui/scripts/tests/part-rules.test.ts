// The picture-only rule (isThumbnailOnlyPart / isThumbnailOnlyUnit): one helper for every screen.
// Picture-only parts must never reach Print!, counts, or customer-facing text.
import { isThumbnailOnlyPart, isThumbnailOnlyUnit, registerCatalogProducts } from "../../src/partThumbnails";
import { findProductPart, isPictureOnlyPart } from "../../src/partRules";
import type { CatalogPart, Product } from "../../src/types";
import { check, done } from "./check";

const part = (id: string, name: string, is_tracked: boolean, is_color_only: boolean) =>
  ({ id, product_id: "prod-a", name, is_tracked, is_color_only, default_filament_id: "", grams: 0, print_minutes: 0, unit_cost: 0, mesh_file: "", sort_order: 0 }) as CatalogPart;
const product = (parts: CatalogPart[]): Product =>
  ({ id: "prod-a", name: "Product A", sku: "", price_cents: 0, packed_weight_oz: 0, default_box_name: "", box_cost_cents: 0, supports_custom_text: false, parts }) as Product;

// Flags alone decide it.
check(!isPictureOnlyPart({ is_tracked: true, is_color_only: false }), "tracked part prints");
check(isPictureOnlyPart({ is_tracked: false, is_color_only: false }), "untracked part is picture-only");
check(isPictureOnlyPart({ is_tracked: true, is_color_only: true }), "color-only part is picture-only");

const prod = product([part("p-body", "Body", true, false), part("p-glow", "Glow Insert", true, true), part("p-sticker", "Sticker", false, false)]);
check(findProductPart(prod, "  BODY ")?.id === "p-body", "product part lookup is case-insensitive and trims the key");
check(findProductPart(prod, "p-glow")?.name === "Glow Insert", "product part lookup by id");

// Registered catalog (what most screens use, by product id).
registerCatalogProducts([prod]);
check(!isThumbnailOnlyPart("Body", "prod-a"), "registered: Body prints");
check(isThumbnailOnlyPart("Glow Insert", "prod-a"), "registered: color-only by name");
check(isThumbnailOnlyPart("p-sticker"), "registered: untracked by part id, no product needed");
check(isThumbnailOnlyPart("sticker", "Product A"), "registered: product resolved by name too");
check(!isThumbnailOnlyPart("Unknown part", "prod-a"), "unknown part is never hidden");
check(!isThumbnailOnlyPart("", undefined), "empty name is never hidden");

// Units: part id first, then product + name.
check(isThumbnailOnlyUnit({ part_id: "P-GLOW", part_name: "renamed", product_id: "prod-a" }), "unit: part id wins over a renamed part");
check(!isThumbnailOnlyUnit({ part_name: "Body", product_id: "prod-a" }), "unit without part id falls back to name");

// Passing the live Product: its flags win over a stale registry (the Printers/Parts/Flow form).
const live = product([part("p-body", "Body", false, false), part("p-glow", "Glow Insert", true, false), part("p-sticker", "Sticker", false, false)]);
check(isThumbnailOnlyPart("Body", live), "live product: Body just became picture-only");
check(!isThumbnailOnlyPart("Glow Insert", live), "live product: Glow Insert now prints");
check(isThumbnailOnlyPart("p-glow", product([])) === true, "part missing from the live product falls back to the registry");
check(!isThumbnailOnlyPart("Body", undefined), "no product at all uses the registry");
done();
