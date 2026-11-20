import React, { useEffect, useState } from "react";
import { containRect, frameRect } from "./containRect";
import { splitHexAlpha } from "./platform";
import { toCatalogUrl } from "./catalogUrl";
import type { FilamentSwatch, Product } from "./types";
import { findProductPart, isPictureOnlyPart } from "./partRules";
import { useOutlinedSrc } from "./thumbnailOutline";

/**
 * Base URL for catalog pictures/meshes. In the desktop app they live in the user's data
 * folder (<app data>/catalog), served by the backend's `fpcatalog` URI scheme; release
 * builds don't bundle ui/public/catalog. Plain browser/vite dev falls back to `/catalog`.
 */
export const CATALOG_BASE: string = (() => {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return "/catalog";
  const isWindows = /Windows/i.test(navigator.userAgent);
  return isWindows ? "http://fpcatalog.localhost" : "fpcatalog://localhost";
})();

/**
 * Port of `Persistence/PartThumbTint.swift` & `OrderThumbComposite.swift`.
 *
 * Every product is resolved the same way, from data only:
 *  - part pictures: `${CATALOG_BASE}/<productId>/parts/<image_stem>.png`
 *  - composite layers: the catalog part definitions (`catalog.json` layers, or the
 *    product folder's `parts/layers.json`), drawn back to front by composite Z.
 *  - thumbnail-only parts: catalog flags (`is_tracked` / `is_color_only`).
 * No product ids or part names are special-cased here.
 */

const TINT_CACHE = new Map<string, string>();
const IMAGE_PROMISE_CACHE = new Map<string, Promise<HTMLImageElement>>();

/** Caches keyed by color combinations grow all day in a shop that leaves the app open, so
 *  each one keeps only its most recently stored `max` entries (Map order = insertion). */
const CACHE_LIMIT = { images: 400, tints: 600, tintCanvases: 300, composites: 400 } as const;
function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value as K;
    map.delete(oldest);
  }
}
const CUSTOM_STEM_DATA_URLS = new Map<string, string>();
const PRODUCT_HERO_DATA_URLS = new Map<string, string>();

interface CatalogLayerDef {
  imageStem: string;
  compositeZ: number;
}

interface CatalogPartDef {
  id: string;
  names: string[];
  imageStem: string;
  thumbnailOnly: boolean;
  defaultHex?: string;
  layers: CatalogLayerDef[];
}

interface CatalogProductDef {
  id: string;
  name: string;
  parts: CatalogPartDef[];
}

const PRODUCT_DEFS = new Map<string, CatalogProductDef>();
const PART_BY_ID = new Map<string, { product: CatalogProductDef; part: CatalogPartDef }>();
const LAYERS_JSON_CACHE = new Map<string, Promise<Array<CatalogLayerDef & { name: string; iconStem: string; partId: string }> | null>>();

function partStem(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "part";
}

function stemFromMeshFile(meshFile: string | undefined): string | null {
  const base = (meshFile || "").split(/[\\/]/).pop() || "";
  // A per-part mesh file names its picture; a whole-product 3MF does not.
  if (!/\.(stl|obj|png)$/i.test(base)) return null;
  return partStem(base.replace(/\.[^.]+$/, ""));
}

function indexProduct(def: CatalogProductDef) {
  PRODUCT_DEFS.set(def.id.toLowerCase(), def);
  for (const part of def.parts) {
    if (part.id) PART_BY_ID.set(part.id.toLowerCase(), { product: def, part });
  }
  clearCompositeCacheFor(def.id);
}

function mergeProduct(incoming: CatalogProductDef) {
  const existing = PRODUCT_DEFS.get(incoming.id.toLowerCase());
  if (!existing) {
    indexProduct(incoming);
    return;
  }
  const parts = existing.parts.map((p) => ({ ...p }));
  for (const np of incoming.parts) {
    const hit = parts.find(
      (p) =>
        (np.id && p.id.toLowerCase() === np.id.toLowerCase()) ||
        p.imageStem === np.imageStem
    );
    if (hit) {
      hit.names = Array.from(new Set([...hit.names, ...np.names]));
      hit.thumbnailOnly = np.thumbnailOnly;
      if (np.defaultHex) hit.defaultHex = np.defaultHex;
      if (!hit.layers.length && np.layers.length) hit.layers = np.layers;
      if (!hit.id) hit.id = np.id;
    } else {
      parts.push(np);
    }
  }
  indexProduct({ id: existing.id, name: incoming.name || existing.name, parts });
}


/** Neutral stand-in shown when a part or product picture is missing (e.g. a fresh, empty catalog). */
export const PART_PLACEHOLDER_SRC =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="14" y="14" width="36" height="36" rx="7" fill="#8e8e93" fill-opacity="0.28" stroke="#8e8e93" stroke-opacity="0.55" stroke-width="2"/></svg>'
  );

/** Fixed `size` square, or (fluid) a square that fills the parent's width up to `size`. */
export function fitBox(size: number, fluid: boolean): React.CSSProperties {
  return fluid
    ? { width: "100%", maxWidth: size, height: "auto", aspectRatio: "1 / 1", minWidth: 0 }
    : { width: size, height: size };
}

function swapToPlaceholder(e: { currentTarget: HTMLImageElement }) {
  if (e.currentTarget.src !== PART_PLACEHOLDER_SRC) e.currentTarget.src = PART_PLACEHOLDER_SRC;
}

let catalogJsonLoaded: Promise<void> | null = null;

/** Loads `${CATALOG_BASE}/catalog.json` once. Safe to call repeatedly. */
export function loadCatalogDefinitions(): Promise<void> {
  if (catalogJsonLoaded) return catalogJsonLoaded;
  catalogJsonLoaded = (async () => {
    try {
      const res = await fetch(`${CATALOG_BASE}/catalog.json`);
      if (!res.ok) return;
      const data = await res.json();
      for (const p of (data?.products || []) as any[]) {
        if (!p?.id) continue;
        mergeProduct({
          id: String(p.id),
          name: String(p.name || ""),
          parts: ((p.parts || []) as any[]).map((pt) => {
            // catalog.json is written snake_case by the Rust port and camelCase by the Swift app.
            const stemRaw = pt.image_stem ?? pt.imageStem;
            const display = pt.display_name ?? pt.displayName;
            const tracked = pt.is_tracked ?? pt.isTracked;
            const colorOnly = pt.is_color_only ?? pt.isColorOnly;
            const imageStem = partStem(String(stemRaw || display || pt.id || "part"));
            return {
              id: String(pt.id || ""),
              names: [display, pt.id, stemRaw].filter(Boolean).map((n: any) => String(n)),
              imageStem,
              thumbnailOnly: tracked === false || colorOnly === true,
              layers: ((pt.layers || []) as any[])
                .map((l) => ({ stem: l?.image_stem ?? l?.imageStem, z: l?.composite_z ?? l?.compositeZ }))
                .filter((l) => l.stem)
                .map((l) => ({ imageStem: String(l.stem), compositeZ: Number(l.z) || 0 })),
            };
          }),
        });
      }
    } catch {
      // No catalog file; products registered from the shop snapshot still resolve.
    }
  })();
  return catalogJsonLoaded;
}

if (typeof window !== "undefined") {
  void loadCatalogDefinitions();
}

/** Registers the shop's products so their part flags and pictures resolve from data. */
export function registerCatalogProducts(products: Product[], filaments: FilamentSwatch[] = []) {
  const hexById = new Map(filaments.map((f) => [f.id, f.hex]));
  for (const p of products || []) {
    if (!p?.id) continue;
    mergeProduct({
      id: p.id,
      name: p.name,
      parts: (p.parts || []).map((pt) => ({
        id: pt.id,
        names: [pt.name, pt.id].filter(Boolean),
        imageStem: stemFromMeshFile(pt.mesh_file) || partStem(pt.name || pt.id),
        thumbnailOnly: isPictureOnlyPart(pt),
        defaultHex: hexById.get(pt.default_filament_id),
        layers: [],
      })),
    });
  }
}

function findProductDef(productIdOrName?: string): CatalogProductDef | undefined {
  const key = (productIdOrName || "").trim().toLowerCase();
  if (!key) return undefined;
  const byId = PRODUCT_DEFS.get(key);
  if (byId) return byId;
  for (const def of PRODUCT_DEFS.values()) {
    if (def.name.trim().toLowerCase() === key) return def;
  }
  return undefined;
}

function findPartDef(
  partNameOrStem: string,
  productIdOrName?: string
): { product?: CatalogProductDef; part?: CatalogPartDef } {
  const raw = (partNameOrStem || "").trim().toLowerCase();
  const product = findProductDef(productIdOrName);
  const byId = PART_BY_ID.get(raw);
  if (byId && (!product || byId.product === product)) return byId;
  if (product) {
    const stem = partStem(raw);
    const part = product.parts.find(
      (p) =>
        p.imageStem === stem ||
        p.names.some((n) => n.trim().toLowerCase() === raw || partStem(n) === stem)
    );
    return { product, part };
  }
  return {};
}

/**
 * True when the catalog marks this part as picture-only (not printed and tracked). This is the
 * one picture-only check for a part name or id; `isThumbnailOnlyUnit` wraps it for units.
 *
 * Pass the shop's `Product` when you have it: its own part flags win (they are the live
 * snapshot), and the registered catalog is only the fallback. With a product id or name, only
 * the registered catalog (snapshot products + catalog.json) is consulted.
 */
export function isThumbnailOnlyPart(
  partIdOrName: string,
  product?: string | Product
): boolean {
  if (product && typeof product === "object") {
    const part = findProductPart(product, partIdOrName);
    if (part) return isPictureOnlyPart(part);
    return isThumbnailOnlyPart(partIdOrName, product.id);
  }
  return findPartDef(partIdOrName, product).part?.thumbnailOnly === true;
}

/** True when a part id is registered in the catalog (so it can stand in for the name). */
export function isKnownCatalogPartId(partId: string): boolean {
  return PART_BY_ID.has((partId || "").trim().toLowerCase());
}

/** Unit-level check: uses the unit's part id first, then its product and part name. */
export function isThumbnailOnlyUnit(u: { part_id?: string; part_name?: string; product_id?: string }): boolean {
  if (u.part_id) {
    const hit = PART_BY_ID.get(u.part_id.toLowerCase());
    if (hit) return hit.part.thumbnailOnly;
  }
  return isThumbnailOnlyPart(u.part_name || "", u.product_id);
}

export function registerCustomNeutralPartPng(stem: string, neutralDataUrl: string) {
  CUSTOM_STEM_DATA_URLS.set(stem.toLowerCase(), neutralDataUrl);
  for (const key of Array.from(TINT_CACHE.keys())) {
    if (key.startsWith(`${stem.toLowerCase()}::`)) {
      TINT_CACHE.delete(key);
    }
  }
}

function clearCompositeCacheFor(productId: string) {
  const prefix = (productId || "").toLowerCase();
  if (!prefix) return;
  for (const key of Array.from(COMPOSITE_CACHE.keys())) {
    if (key.toLowerCase().startsWith(prefix)) COMPOSITE_CACHE.delete(key);
  }
  for (const key of Array.from(COMPOSITE_PROMISE_CACHE.keys())) {
    if (key.toLowerCase().startsWith(prefix)) COMPOSITE_PROMISE_CACHE.delete(key);
  }
}

/** Drops a deleted product's parts and pictures so same-named parts elsewhere can't match them. */
export function forgetCatalogProduct(productId: string) {
  const id = (productId || "").trim().toLowerCase();
  if (!id) return;
  PRODUCT_DEFS.delete(id);
  for (const [key, hit] of Array.from(PART_BY_ID.entries())) {
    if (hit.product.id.toLowerCase() === id) PART_BY_ID.delete(key);
  }
  for (const key of Array.from(CUSTOM_STEM_DATA_URLS.keys())) {
    if (key.startsWith(`${id}::`)) CUSTOM_STEM_DATA_URLS.delete(key);
  }
  PRODUCT_HERO_DATA_URLS.delete(id);
  PRODUCT_HERO_DATA_URLS.delete(productId.trim());
  SESSION_LAYERS.delete(id);
  forgetProductPictureFiles(productId);
  clearCompositeCacheFor(productId);
}

/** Drops cached colorway pixels (~6 MB a product) and baked-file lookups for one product. */
function forgetProductPictureFiles(productId: string) {
  const raw = (productId || "").trim();
  if (!raw) return;
  for (const id of new Set([raw, raw.toLowerCase()])) {
    COLORWAY_CACHE.delete(id);
    for (const key of Array.from(BAKED_URL_CACHE.keys())) if (key.startsWith(`${id}/`)) BAKED_URL_CACHE.delete(key);
  }
}

export function registerProductComposite(productId: string, dataUrl: string) {
  const id = (productId || "").trim();
  if (!id || !dataUrl) return;
  PRODUCT_HERO_DATA_URLS.set(id, dataUrl);
  PRODUCT_HERO_DATA_URLS.set(id.toLowerCase(), dataUrl);
  clearCompositeCacheFor(id);
}

export function lookupProductComposite(productId: string): string | undefined {
  return PRODUCT_HERO_DATA_URLS.get(productId) || PRODUCT_HERO_DATA_URLS.get((productId || "").toLowerCase());
}

/** Catalog folder and file stem for a part, from data only. */
export function resolvePartCatalogStem(partNameOrStem: string, productId?: string): { folderId?: string; stem: string } {
  const s = (partNameOrStem || "").toLowerCase().trim();
  const { product, part } = findPartDef(s, productId);
  return { folderId: product?.id || productId, stem: part?.imageStem || partStem(s) };
}

/** Resolves a part's neutral picture from the catalog data for its product. */
export function resolvePartCatalogPngUrl(partNameOrStem: string, productId?: string): string {
  const s = (partNameOrStem || "").toLowerCase().trim();
  if (productId) {
    const scoped = `${productId.toLowerCase()}::${s}`;
    if (CUSTOM_STEM_DATA_URLS.has(scoped)) return CUSTOM_STEM_DATA_URLS.get(scoped)!;
  }
  // A bare part-name key is only safe without a product: two products can share a part name.
  if (!productId && CUSTOM_STEM_DATA_URLS.has(s)) return CUSTOM_STEM_DATA_URLS.get(s)!;

  const { product, part } = findPartDef(s, productId);
  const folderId = product?.id || productId;
  const stem = part?.imageStem || partStem(s);
  if (folderId) return `${CATALOG_BASE}/${encodeURIComponent(folderId)}/parts/${stem}.png`;
  return `${CATALOG_BASE}/parts/${stem}.png`;
}

/** True for a picture URL (scheme, data: or root-relative) rather than a bare part name. */
export function isPictureUrl(s: string): boolean {
  return s.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(s);
}

/** Layers saved this session (data URLs) win over files that may still be cached stale. */
const SESSION_LAYERS = new Map<string, Array<{ imageStem: string; iconStem: string; name: string; partId?: string; compositeZ: number; file: string }>>();

/** Registers the per-part layers a product save just baked (same camera as product.png). */
export function registerProductLayers(
  productId: string,
  layers: Array<{ imageStem: string; iconStem: string; name: string; partId?: string; compositeZ: number; file: string }>
) {
  const id = (productId || "").trim();
  if (!id) return;
  SESSION_LAYERS.set(id.toLowerCase(), layers);
  LAYERS_JSON_CACHE.delete(id);
  forgetProductPictureFiles(id);
  clearCompositeCacheFor(id);
}

/** Composite layers from the catalog definition, else the folder's `parts/layers.json`. */
async function productLayerPlan(
  productIdOrName: string
): Promise<Array<{ file: string; compositeZ: number; part?: CatalogPartDef; layerName?: string; partId?: string }> | null> {
  await loadCatalogDefinitions();
  const def = findProductDef(productIdOrName);
  const folderId = def?.id || productIdOrName;
  const session = SESSION_LAYERS.get((folderId || "").toLowerCase());
  if (session && session.length) {
    return session
      .map((l) => ({
        file: l.file,
        compositeZ: l.compositeZ,
        part: def?.parts.find((pt) => pt.imageStem === partStem(l.iconStem || l.name)),
        layerName: l.name || l.iconStem,
        partId: l.partId || undefined,
      }))
      .sort((a, b) => a.compositeZ - b.compositeZ);
  }
  if (def && def.parts.some((p) => p.layers.length)) {
    const out: Array<{ file: string; compositeZ: number; part?: CatalogPartDef }> = [];
    for (const part of def.parts) {
      for (const l of part.layers) {
        out.push({ file: `${CATALOG_BASE}/${encodeURIComponent(def.id)}/parts/${l.imageStem}.png`, compositeZ: l.compositeZ, part });
      }
    }
    return out.sort((a, b) => a.compositeZ - b.compositeZ);
  }
  if (!folderId || /\s/.test(folderId)) return null;
  let p = LAYERS_JSON_CACHE.get(folderId);
  if (!p) {
    p = fetch(`${CATALOG_BASE}/${encodeURIComponent(folderId)}/parts/layers.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) =>
        Array.isArray(j?.layers)
          ? (j.layers as any[]).map((l) => ({
              imageStem: String(l.imageStem || ""),
              iconStem: String(l.iconStem || ""),
              name: String(l.name || ""),
              partId: String(l.partId || ""),
              compositeZ: Number(l.compositeZ) || 0,
            }))
          : null
      )
      .catch(() => null);
    LAYERS_JSON_CACHE.set(folderId, p);
  }
  const layers = await p;
  if (!layers || !layers.length) return null;
  return layers
    .filter((l) => l.imageStem)
    .map((l) => ({
      file: `${CATALOG_BASE}/${encodeURIComponent(folderId)}/parts/${l.imageStem}.png`,
      compositeZ: l.compositeZ,
      part: def?.parts.find((pt) => pt.imageStem === partStem(l.iconStem || l.name)),
      layerName: l.name || l.iconStem,
      partId: l.partId || undefined,
    }))
    .sort((a, b) => a.compositeZ - b.compositeZ);
}

function parseHexRgb(hex: string): [number, number, number] {
  const h = (hex || "#888888").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$|^[0-9a-f]{6}$|^[0-9a-f]{8}$/i.test(h)) {
    const n = parseInt(splitHexAlpha(h).rgb.slice(1), 16);
    if (!Number.isNaN(n)) return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }
  return [140, 140, 148];
}

/** Filament opacity from #RRGGBBAA (1 for #RRGGBB or anything unreadable). */
function parseHexAlpha(hex: string): number {
  return splitHexAlpha(hex || "").alpha;
}

/** See-through coverage for a pixel of brightness t (0..1): highlights stay a bit more solid. */
function translucentCoverage(alpha: number, t: number): number {
  if (alpha >= 0.999) return 1;
  return Math.min(1, alpha + (1 - alpha) * 0.4 * t * t * t * t);
}

const DARK_TINT_LUMINANCE = 0.2;

function isDarkTint(r: number, g: number, b: number): boolean {
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
  return l < DARK_TINT_LUMINANCE;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const existing = IMAGE_PROMISE_CACHE.get(url);
  if (existing) return existing;
  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = toCatalogUrl(url);
  });
  remember(IMAGE_PROMISE_CACHE, url, p, CACHE_LIMIT.images);
  // A missing picture (e.g. not written yet) must be retried next time, not cached as failed.
  p.catch(() => { if (IMAGE_PROMISE_CACHE.get(url) === p) IMAGE_PROMISE_CACHE.delete(url); });
  return p;
}

/**
 * Applies `PartThumbTint.thumbnailTint` (for individual part tiles, with dark-filament
 * cubic highlight lift + `#AAAAAA` rim) or `PartThumbTint.tint` (for composite layers).
 */
const TINT_CANVAS_CACHE = new Map<string, HTMLCanvasElement>();
const TINT_CANVAS_PROMISE_CACHE = new Map<string, Promise<HTMLCanvasElement>>();
const TINT_PROMISE_CACHE = new Map<string, Promise<string>>();

export async function getTintedPartCanvas(
  partNameOrUrl: string,
  colorHex: string,
  forCompositeLayer = false,
  productId?: string,
  /** Largest side of the tinted canvas. Default 256; larger only for print-size composites. */
  maxDim = 256
): Promise<HTMLCanvasElement> {
  // Any absolute URL (fpcatalog://, http://fpcatalog.localhost, data:, /catalog) is used as is;
  // only bare part names resolve through the catalog.
  const url = isPictureUrl(partNameOrUrl) ? partNameOrUrl : resolvePartCatalogPngUrl(partNameOrUrl, productId);
  const cacheKey =
    `${url}::${(colorHex || "#888888").toLowerCase()}::${forCompositeLayer ? "layer" : "tile"}::v9` +
    (maxDim === 256 ? "" : `::${maxDim}`);
  const cachedCanvas = TINT_CANVAS_CACHE.get(cacheKey);
  if (cachedCanvas) return cachedCanvas;

  const inflight = TINT_CANVAS_PROMISE_CACHE.get(cacheKey);
  if (inflight) return inflight;

  const p = (async () => {
    const img = await loadImage(url);
    const srcW = img.naturalWidth || img.width || 240;
    const srcH = img.naturalHeight || img.height || 240;
    // Cap working canvas (256x256 by default) so 1024x1024 catalog layers tint 16x faster and never hit WKWebView canvas memory limits
    const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    const width = Math.max(1, Math.round(srcW * scale));
    const height = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;

    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    const imageData = ctx.getImageData(0, 0, width, height);
    const pixels = imageData.data;
    const [cr, cg, cb] = parseHexRgb(colorHex || "#888888");
    const fa = parseHexAlpha(colorHex || "#888888");

    if (isDarkTint(cr, cg, cb)) {
      const l = (0.2126 * cr + 0.7152 * cg + 0.0722 * cb) / 255.0;
      const lift = 78.0 * Math.max(0, Math.min(1, 1 - l / DARK_TINT_LUMINANCE)) + 26.0;
      const baseR = Math.max(22, cr);
      const baseG = Math.max(22, cg);
      const baseB = Math.max(24, cb);

      for (let i = 0; i < pixels.length; i += 4) {
        const a = pixels[i + 3];
        if (a < 8) {
          pixels[i] = 0;
          pixels[i + 1] = 0;
          pixels[i + 2] = 0;
          continue;
        }
        const luma = (pixels[i] * 299.0 + pixels[i + 1] * 587.0 + pixels[i + 2] * 114.0) / 1000.0;
        const t = luma / 255.0;
        const s = Math.max(0, Math.min(1, (t - 0.58) / 0.42));
        const shade = 0.78 + 0.85 * s;
        const spec = lift * (0.26 * s + 0.74 * s * s * s);
        pixels[i] = Math.min(255, Math.round(baseR * shade + spec));
        pixels[i + 1] = Math.min(255, Math.round(baseG * shade + spec));
        pixels[i + 2] = Math.min(255, Math.round(baseB * shade + spec));
      }

      const radius = Math.max(1, Math.floor(Math.min(width, height) / 96));
      const rim = 165.0;
      const strength = forCompositeLayer ? 0.34 : 0.45;
      const source = new Uint8ClampedArray(pixels);
      const alphaAt = (x: number, y: number): number => {
        if (x < 0 || y < 0 || x >= width || y >= height) return 0;
        return source[(y * width + x) * 4 + 3];
      };

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          if (source[idx + 3] < 128) continue;
          let edge = false;
          for (let d = 1; d <= radius && !edge; d++) {
            if (
              alphaAt(x - d, y) < 64 ||
              alphaAt(x + d, y) < 64 ||
              alphaAt(x, y - d) < 64 ||
              alphaAt(x, y + d) < 64
            ) {
              edge = true;
            }
          }
          if (!edge) continue;
          for (let k = 0; k < 3; k++) {
            const v = source[idx + k];
            pixels[idx + k] = Math.min(255, Math.max(0, Math.round(v + (rim - v) * strength)));
          }
        }
      }
      if (fa < 0.999) {
        for (let i = 0; i < pixels.length; i += 4) {
          const a = pixels[i + 3];
          if (a < 8) continue;
          const t = (pixels[i] * 299.0 + pixels[i + 1] * 587.0 + pixels[i + 2] * 114.0) / 255000.0;
          pixels[i + 3] = Math.round(a * translucentCoverage(fa, t));
        }
      }
    } else {
      for (let i = 0; i < pixels.length; i += 4) {
        const a = pixels[i + 3];
        if (a === 0) {
          pixels[i] = 0;
          pixels[i + 1] = 0;
          pixels[i + 2] = 0;
          continue;
        }
        const luma = (pixels[i] * 299.0 + pixels[i + 1] * 587.0 + pixels[i + 2] * 114.0) / 1000.0;
        const t = Math.min(1, luma / 255.0);
        pixels[i] = Math.min(255, Math.round(cr * t));
        pixels[i + 1] = Math.min(255, Math.round(cg * t));
        pixels[i + 2] = Math.min(255, Math.round(cb * t));
        if (fa < 0.999) pixels[i + 3] = Math.round(a * translucentCoverage(fa, t));
      }
    }

    ctx.putImageData(imageData, 0, 0);
    remember(TINT_CANVAS_CACHE, cacheKey, canvas, CACHE_LIMIT.tintCanvases);
    return canvas;
  })();

  TINT_CANVAS_PROMISE_CACHE.set(cacheKey, p);
  // In-flight only: the result lives in TINT_CANVAS_CACHE, and a failure is retried.
  p.finally(() => TINT_CANVAS_PROMISE_CACHE.delete(cacheKey)).catch(() => {});
  return p;
}

export async function getTintedPartPng(
  partNameOrUrl: string,
  colorHex: string,
  forCompositeLayer = false,
  productId?: string
): Promise<string> {
  const url =
    partNameOrUrl.startsWith("/") || partNameOrUrl.startsWith("data:")
      ? partNameOrUrl
      : resolvePartCatalogPngUrl(partNameOrUrl, productId);
  const cacheKey = `${url}::${(colorHex || "#888888").toLowerCase()}::${forCompositeLayer ? "layer" : "tile"}::v9`;
  const cached = TINT_CACHE.get(cacheKey);
  if (cached) return cached;

  const inflight = TINT_PROMISE_CACHE.get(cacheKey);
  if (inflight) return inflight;

  const p = (async () => {
    const canvas = await getTintedPartCanvas(partNameOrUrl, colorHex, forCompositeLayer, productId);
    const dataUrl = canvas.toDataURL("image/png");
    remember(TINT_CACHE, cacheKey, dataUrl, CACHE_LIMIT.tints);
    return dataUrl;
  })();
  TINT_PROMISE_CACHE.set(cacheKey, p);
  p.finally(() => TINT_PROMISE_CACHE.delete(cacheKey)).catch(() => {});
  return p;
}

export const PartThumb: React.FC<{
  partName: string;
  colorHex: string;
  size?: number;
  productId?: string;
  className?: string;
  /** Process color, used when the Settings outline follows part status. */
  statusHex?: string;
  /** Skip the Settings outline (printed paper keeps its own look). */
  noOutline?: boolean;
}> = ({ partName, colorHex, size = 54, productId, className, statusHex, noOutline }) => {
  const [src, setSrc] = useState<string>(() => {
    const url = resolvePartCatalogPngUrl(partName, productId);
    const cacheKey = `${url}::${(colorHex || "#888888").toLowerCase()}::tile`;
    return TINT_CACHE.get(cacheKey) || url;
  });

  useEffect(() => {
    let alive = true;
    getTintedPartPng(partName, colorHex || "#888888", false, productId)
      .then((dataUrl) => {
        if (alive) setSrc(dataUrl);
      })
      .catch(() => {
        if (alive) setSrc(PART_PLACEHOLDER_SRC);
      });
    return () => {
      alive = false;
    };
  }, [partName, colorHex, productId]);
  const shown = useOutlinedSrc(src, size, statusHex, noOutline || src === PART_PLACEHOLDER_SRC);

  return (
    <img
      src={shown}
      onError={swapToPlaceholder}
      alt={partName}
      width={size}
      height={size}
      className={className}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        filter:
          "drop-shadow(0 1px 1px rgba(255,255,255,0.42)) drop-shadow(0 3px 6px rgba(0,0,0,0.55))",
        userSelect: "none",
        pointerEvents: "none",
      }}
    />
  );
};



export interface CompositePartColor {
  /** Product part id; wins over the name so parts sharing a name keep their own color. */
  partId?: string;
  partName: string;
  colorHex: string;
  visible?: boolean;
}


// ---- Colorway packs (port of Swift ThumbnailAssets: mask.png + shading.png + manifest.json) ----

interface ColorwayPack {
  size: number;
  mask: Uint8ClampedArray; // part index per pixel (0 = background)
  shading: Uint8ClampedArray; // RGBA lighting with white albedo, alpha = silhouette
  entries: Array<{ index: number; name: string; slot: string }>;
}

const WORK = 1024;
const COLORWAY_CACHE = new Map<string, Promise<{ pack: ColorwayPack | null; shadingAlpha: Uint8ClampedArray | null; clipped?: boolean }>>();

/** `fit`: keep the picture's aspect (centred, transparent padding) instead of filling the square. */
function pixelsOf(img: HTMLImageElement, size = WORK, fit = false): Uint8ClampedArray | null {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  // Nearest-neighbour so mask indices never blend into a third, meaningless index.
  g.imageSmoothingEnabled = false;
  const at = fit ? containRect(img.naturalWidth, img.naturalHeight, size, size) : { x: 0, y: 0, w: size, h: size };
  g.drawImage(img, at.x, at.y, at.w, at.h);
  return g.getImageData(0, 0, size, size).data;
}

function loadColorwayRaw(folderId: string) {
  let p = COLORWAY_CACHE.get(folderId);
  if (p) return p;
  p = (async () => {
    const base = `${CATALOG_BASE}/${encodeURIComponent(folderId)}/colorway`;
    const manifest = await fetch(`${base}/manifest.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [maskImg, shadeImg] = await Promise.all([
      loadImage(`${base}/mask.png`).catch(() => null),
      loadImage(`${base}/shading.png`).catch(() => null),
    ]);
    if (!shadeImg) return { pack: null, shadingAlpha: null };
    const shading = pixelsOf(shadeImg);
    if (!shading) return { pack: null, shadingAlpha: null };
    const shadingAlpha = new Uint8ClampedArray(WORK * WORK);
    for (let i = 0; i < shadingAlpha.length; i++) shadingAlpha[i] = shading[i * 4 + 3];
    if (!manifest || !Array.isArray(manifest.parts) || !maskImg) return { pack: null, shadingAlpha };
    const maskRgba = pixelsOf(maskImg);
    if (!maskRgba) return { pack: null, shadingAlpha };
    const entries = (manifest.parts as any[]).map((e) => ({
      index: Number(e.index) || 0,
      name: String(e.name || ""),
      slot: String(e.slot || e.name || ""),
    }));
    const known = new Set(entries.map((e) => e.index));
    const mask = new Uint8ClampedArray(WORK * WORK);
    let covered = 0;
    let unknown = 0;
    for (let i = 0; i < mask.length; i++) {
      const v = maskRgba[i * 4];
      mask[i] = v;
      if (shadingAlpha[i] > 20) {
        covered++;
        if (!known.has(v)) unknown++;
      }
    }
    // A pack whose mask has sizeable regions that are not any listed part (stale packs with
    // baked-in labels, wrong ID calibration) can't be recolored faithfully: reject it.
    const ok = covered > 0 && unknown / covered < 0.03;
    // Packs whose stale camera crops the assembly at the canvas edge are a last resort only.
    let edge = 0;
    for (let k = 0; k < WORK; k++) {
      if (shadingAlpha[k] > 20) edge++;
      if (shadingAlpha[(WORK - 1) * WORK + k] > 20) edge++;
      if (shadingAlpha[k * WORK] > 20) edge++;
      if (shadingAlpha[k * WORK + WORK - 1] > 20) edge++;
    }
    const clipped = edge > WORK * 0.04;
    return { pack: ok ? { size: WORK, mask, shading, entries } : null, shadingAlpha, clipped };
  })();
  COLORWAY_CACHE.set(folderId, p);
  return p;
}


/** Parts not at the card's stage: neutral grey at this opacity, so the product keeps its shape. */
const GHOST_HEX = "#8E8E93";
const GHOST_ALPHA = 0.2;

/** `ghost`: draw hidden parts ("" color) as faint grey instead of leaving them out. */
function recolorColorway(pack: ColorwayPack, colorByIndex: Map<number, string>, ghost = false): HTMLCanvasElement {
  const n = pack.size;
  const c = document.createElement("canvas");
  c.width = n;
  c.height = n;
  const g = c.getContext("2d")!;
  const out = g.createImageData(n, n);
  const rgb = new Map<number, [number, number, number] | null>();
  const alphaOf = new Map<number, number>();
  for (const [k, hex] of colorByIndex) {
    rgb.set(k, hex ? parseHexRgb(hex) : null);
    if (hex) alphaOf.set(k, parseHexAlpha(hex));
  }
  const neutral = parseHexRgb("#8E8E93");
  for (let i = 0; i < n * n; i++) {
    const a = pack.shading[i * 4 + 3];
    if (!a) continue;
    const idx = pack.mask[i];
    let col = rgb.has(idx) ? rgb.get(idx) : neutral;
    const ghosted = !col && ghost;
    if (ghosted) col = neutral;
    if (!col) continue; // hidden part
    // color = shading.rgb * albedo (Swift ThumbnailAssets contract).
    out.data[i * 4] = (pack.shading[i * 4] * col[0]) / 255;
    out.data[i * 4 + 1] = (pack.shading[i * 4 + 1] * col[1]) / 255;
    out.data[i * 4 + 2] = (pack.shading[i * 4 + 2] * col[2]) / 255;
    const fa = alphaOf.get(idx) ?? 1;
    const lum = (pack.shading[i * 4] * 0.299 + pack.shading[i * 4 + 1] * 0.587 + pack.shading[i * 4 + 2] * 0.114) / 255;
    out.data[i * 4 + 3] = ghosted
      ? Math.round(a * GHOST_ALPHA)
      : fa < 0.999 ? Math.round(a * translucentCoverage(fa, lum)) : a;
  }
  g.putImageData(out, 0, 0);
  return c;
}

const BAKED_URL_CACHE = new Map<string, Promise<string | null>>();
/** A baked picture in the product folder (`product.png` from Rust import, `thumb.png` from Swift). */
function loadBakedFile(folderId: string, name: string): Promise<string | null> {
  const key = `${folderId}/${name}`;
  let p = BAKED_URL_CACHE.get(key);
  if (p) return p;
  p = (async () => {
    const url = `${CATALOG_BASE}/${encodeURIComponent(folderId)}/${name}`;
    const img = await loadImage(url).catch(() => null);
    return img && img.naturalWidth > 8 ? url : null;
  })();
  BAKED_URL_CACHE.set(key, p);
  // Not found yet: look again next time (the file may be written by a later save).
  p.then((found) => { if (!found && BAKED_URL_CACHE.get(key) === p) BAKED_URL_CACHE.delete(key); });
  return p;
}

async function silhouetteOf(url: string): Promise<Uint8ClampedArray | null> {
  const img = await loadImage(url).catch(() => null);
  // Same framing as the composite draws it, so layer silhouettes compare like for like.
  const px = img ? pixelsOf(img, WORK, true) : null;
  if (!px) return null;
  const a = new Uint8ClampedArray(WORK * WORK);
  for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3];
  return a;
}

function maskIoU(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] > 20;
    const y = b[i] > 20;
    if (x && y) inter++;
    if (x || y) uni++;
  }
  return uni ? inter / uni : 0;
}

/** With nothing to compare against, layers count as one assembly render only if they share a
 *  canvas, none is empty, and none is cropped at the canvas edge (per-part auto-framed icons are). */
async function layersLookAssembled(files: string[]): Promise<boolean> {
  const imgs = await Promise.all(files.map((f) => loadImage(f).catch(() => null)));
  if (!imgs.length || imgs.some((i) => !i)) return false;
  const w = imgs[0]!.naturalWidth;
  const h = imgs[0]!.naturalHeight;
  if (imgs.some((i) => i!.naturalWidth !== w || i!.naturalHeight !== h)) return false;
  for (const img of imgs) {
    const a = pixelsOf(img!, 128);
    if (!a) return false;
    let any = false;
    let edge = false;
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        if (a[(y * 128 + x) * 4 + 3] <= 20) continue;
        any = true;
        if (x === 0 || y === 0 || x === 127 || y === 127) edge = true;
      }
    if (!any || edge) return false;
  }
  return true;
}

function layerUnionIoU(layers: Array<HTMLCanvasElement | null>, ref: Uint8ClampedArray): number {
  const c = document.createElement("canvas");
  c.width = WORK;
  c.height = WORK;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  const first = layers.find((lc) => lc && lc.width > 0);
  const frame = first ? { w: first.width, h: first.height } : null;
  for (const lc of layers) {
    if (!lc || !(lc.width > 0) || !frame) continue;
    const at = frameRect(frame, lc.width, lc.height, WORK, WORK);
    g.drawImage(lc, at.x, at.y, at.w, at.h);
  }
  const u = g.getImageData(0, 0, WORK, WORK).data;
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < ref.length; i++) {
    const a = u[i * 4 + 3] > 20;
    const b = ref[i] > 20;
    if (a && b) inter++;
    if (a || b) uni++;
  }
  return uni ? inter / uni : 0;
}

const COMPOSITE_CACHE = new Map<string, string>();
const COMPOSITE_PROMISE_CACHE = new Map<string, Promise<string>>();

export const ProductCompositeThumb: React.FC<{
  productIdOrName: string;
  parts: CompositePartColor[];
  size?: number;
  inscriptionText?: string | null;
  /** Skip the baked product.png / registered hero and tint parts live with `parts` colors
   *  (needed for randomized preview colors). Picture-only parts always keep their saved color. */
  liveTint?: boolean;
  /** Pixel size the composite is drawn at (default 240). Pass more (e.g. 640) for print. */
  renderPx?: number;
  /** Draw hidden parts (`visible: false`) as a faint grey ghost, so the whole product keeps
   *  its shape, size and position and only the shown parts are in color (ANDON stages). */
  ghostHidden?: boolean;
  /** Process color, used when the Settings outline follows part status. */
  statusHex?: string;
  /** Skip the Settings outline (printed paper keeps its own look). */
  noOutline?: boolean;
  /** Shrink with the parent's width, `size` px at most (narrow board lanes). */
  fluid?: boolean;
}> = ({ productIdOrName, parts, size = 76, inscriptionText, liveTint = false, renderPx = 240, ghostHidden = false, statusHex, noOutline, fluid = false }) => {
  const R = Math.max(16, Math.min(2048, Math.round(renderPx) || 240));
  // Tinted layers are capped at 256 px; a bigger composite needs bigger layers.
  const tintMax = Math.max(256, R);
  const compositeKey =
    `${productIdOrName}::${parts
      .map((p) => `${p.partId || ""}:${p.partName}:${p.colorHex}:${p.visible !== false ? 1 : 0}`)
      .join("|")}::${inscriptionText || ""}::${liveTint ? "live" : "hero"}${ghostHidden ? "::ghost" : ""}::v8` + (R === 240 ? "" : `::${R}px`);

  const [src, setSrc] = useState<string>(() => COMPOSITE_CACHE.get(compositeKey) || "");

  useEffect(() => {
    let alive = true;
    const cached = COMPOSITE_CACHE.get(compositeKey);
    if (cached) {
      setSrc(cached);
      return;
    }

    let promise = COMPOSITE_PROMISE_CACHE.get(compositeKey);
    if (!promise) {
      promise = (async () => {
        const registeredHero = liveTint ? undefined : lookupProductComposite(productIdOrName);
        if (registeredHero) return registeredHero;

        const canvas = document.createElement("canvas");
        canvas.width = R;
        canvas.height = R;
        const ctx = canvas.getContext("2d");
        if (!ctx) return "";
        // Full-frame pictures (product.png, part layers) can be wide, e.g. 3420×1814. Fit them
        // inside R×R with their aspect kept and centred; every layer of one composite shares the
        // first one's frame so they stay aligned. Square pictures fill R×R exactly, as before.
        let frame: { w: number; h: number } | null = null;
        const drawFitted = (src: CanvasImageSource, w: number, h: number) => {
          if (!frame) frame = { w, h };
          const at = frameRect(frame, w, h, R, R);
          ctx.drawImage(src, at.x, at.y, at.w, at.h);
        };
        // Every layer, hidden or not, fixes the frame from the first one, so the product's
        // size and position never change with which parts are shown. Ghosts go underneath,
        // then the shown parts in full color on top.
        const drawLayers = async (
          steps: Array<{ file: string; color: string }>,
          canv: Array<HTMLCanvasElement | null>
        ) => {
          const first = canv.find((lc) => lc && lc.width > 0);
          if (first && !frame) frame = { w: first.width, h: first.height };
          if (ghostHidden) {
            const ghosts = await Promise.all(
              steps.map((l) =>
                l.color ? null : getTintedPartCanvas(l.file, GHOST_HEX, true, undefined, tintMax).catch(() => null)
              )
            );
            ctx.save();
            ctx.globalAlpha = GHOST_ALPHA;
            ghosts.forEach((gc) => {
              if (gc && gc.width > 0) drawFitted(gc, gc.width, gc.height);
            });
            ctx.restore();
          }
          canv.forEach((lc, i) => {
            if (lc && lc.width > 0 && steps[i].color) drawFitted(lc, lc.width, lc.height);
          });
        };

        if (!liveTint && productIdOrName && !productIdOrName.includes(" ")) {
          const hero = await new Promise<HTMLImageElement | null>((resolve) => {
            const img = new Image();
            // fpcatalog:// is a different origin; without CORS the canvas is tainted and toDataURL throws.
            img.crossOrigin = "anonymous";
            img.onload = () => resolve(img.naturalWidth > 8 ? img : null);
            img.onerror = () => resolve(null);
            img.src = `${CATALOG_BASE}/${encodeURIComponent(productIdOrName)}/product.png?v=${encodeURIComponent(compositeKey.slice(0, 24))}`;
          });
          if (hero) {
            drawFitted(hero, hero.naturalWidth, hero.naturalHeight);
            const heroOut = canvas.toDataURL("image/png");
            if (heroOut) remember(COMPOSITE_CACHE, compositeKey, heroOut, CACHE_LIMIT.composites);
            return heroOut;
          }
        }

        const colorFor = (part?: CatalogPartDef, layerName?: string): CompositePartColor | undefined => {
          const keys = new Set<string>();
          if (part) {
            if (part.id) keys.add(part.id.toLowerCase());
            keys.add(part.imageStem);
            for (const n of part.names) keys.add(partStem(n));
          }
          if (layerName) keys.add(partStem(layerName));
          return parts.find(
            (p) => keys.has(p.partName.trim().toLowerCase()) || keys.has(partStem(p.partName))
          );
        };

        // Live recolor must keep the product's assembly and framing. In order of trust:
        //  1. colorway pack (mask.png + shading.png): one depth-tested render of the whole
        //     assembly from the product's shared camera, so occlusion and framing are exact.
        //  2. per-part composite layers, but only if they line up with the assembly silhouette.
        //  3. the baked product picture, untinted.
        // Never stack each part's own icon: those are framed per part and jumble the product.
        const colorForSlot = (part?: CatalogPartDef, layerName?: string): string => {
          if (part?.thumbnailOnly && part.defaultHex) return part.defaultHex;
          const hit = colorFor(part, layerName);
          if (hit && hit.visible === false) return "";
          return hit?.colorHex || part?.defaultHex || "#8E8E93";
        };
        const def = findProductDef(productIdOrName);
        const folderId = def?.id || productIdOrName;
        let drew = false;
        if (liveTint && folderId && !/\s/.test(folderId)) {
          // The saved-mode picture (registered composite or product.png) is the framing to match.
          const strongBaked =
            lookupProductComposite(productIdOrName) || (await loadBakedFile(folderId, "product.png"));
          const strongRef = strongBaked ? await silhouetteOf(strongBaked) : null;
          const raw = await loadColorwayRaw(folderId);
          const pack = raw.pack;
          const drawPack = () => {
            if (!pack) return false;
            const slotColor = new Map<number, string>();
            for (const e of pack.entries) {
              const part =
                def?.parts.find((pt) => pt.id && pt.id.toLowerCase() === e.slot.toLowerCase()) ||
                def?.parts.find((pt) => pt.names.some((n) => partStem(n) === partStem(e.name)));
              slotColor.set(e.index, colorForSlot(part, e.name));
            }
            ctx.drawImage(recolorColorway(pack, slotColor, ghostHidden), 0, 0, R, R);
            return true;
          };
          const tryLayers = async (ref: Uint8ClampedArray | null, selfCheck = false) => {
            if (!ref && !selfCheck) return false;
            const plan = await productLayerPlan(productIdOrName);
            if (!plan || !plan.length) return false;
            if (!ref && !(await layersLookAssembled(plan.map((st) => st.file)))) return false;
            // Match each layer to its own part: by part id first, then by the n-th part
            // with the same name (layers are saved in product part order), so parts
            // sharing a name ("Handle", "Handle") keep their own colors.
            const seenName = new Map<string, number>();
            const steps = plan.map((step) => {
              const byId = step.partId ? parts.find((p) => p.partId === step.partId) : undefined;
              let hit = byId;
              if (!hit && step.layerName) {
                const key = partStem(step.layerName);
                const nth = seenName.get(key) || 0;
                seenName.set(key, nth + 1);
                const same = parts.filter((p) => partStem(p.partName) === key);
                if (same.length > 1) hit = same[Math.min(nth, same.length - 1)];
              }
              if (hit) {
                if (step.part?.thumbnailOnly && step.part.defaultHex) return { file: step.file, color: step.part.defaultHex };
                return { file: step.file, color: hit.visible === false ? "" : hit.colorHex || "#8E8E93" };
              }
              return { file: step.file, color: colorForSlot(step.part, step.layerName) };
            });
            const canv = await Promise.all(
              steps.map((l) => getTintedPartCanvas(l.file, l.color || "#8E8E93", true, undefined, tintMax).catch(() => null))
            );
            if (ref && layerUnionIoU(canv, ref) < 0.8) return false;
            await drawLayers(steps, canv);
            return true;
          };
          // One tintable part and no layers/pack: the picture is that part, so tint its shape.
          const tintables = (def?.parts || []).filter((pt) => !pt.thumbnailOnly);
          const drawSinglePartTint = async (url: string | null) => {
            if (!url || tintables.length !== 1) return false;
            const color = colorForSlot(tintables[0]);
            if (!color) return false;
            const lc = await getTintedPartCanvas(url, color, true, undefined, tintMax).catch(() => null);
            if (!lc || lc.width < 2) return false;
            drawFitted(lc, lc.width, lc.height);
            return true;
          };
          const drawBaked = async (url: string | null) => {
            const img = url ? await loadImage(url).catch(() => null) : null;
            if (!img) return false;
            drawFitted(img, img.naturalWidth, img.naturalHeight);
            return true;
          };
          if (strongRef) {
            drew =
              (await tryLayers(strongRef)) ||
              (!!pack && !!raw.shadingAlpha && maskIoU(raw.shadingAlpha, strongRef) >= 0.8 && drawPack()) ||
              (!pack && (await drawSinglePartTint(strongBaked))) ||
              (await drawBaked(strongBaked!));
          } else {
            drew =
              (!!pack && !raw.clipped && drawPack()) ||
              (await tryLayers(raw.shadingAlpha)) ||
              (!pack && (await drawSinglePartTint(await loadBakedFile(folderId, "thumb.png")))) ||
              (await drawBaked(await loadBakedFile(folderId, "thumb.png"))) ||
              (!pack && (await tryLayers(null, true))) ||
              drawPack();
          }
        } else {
          const plan = await productLayerPlan(productIdOrName);
          if (plan && plan.length) {
            const steps = plan.map((step) => ({ file: step.file, color: colorForSlot(step.part, step.layerName) }));
            const canv = await Promise.all(steps.map((l) => getTintedPartCanvas(l.file, l.color || "#8E8E93", true, undefined, tintMax).catch(() => null)));
            await drawLayers(steps, canv);
            drew = true;
          }
        }
        if (!drew) return "";

        if (inscriptionText && inscriptionText.trim()) {
          ctx.save();
          ctx.scale(R / 240, R / 240); // badge laid out on the 240 px grid
          ctx.fillStyle = "rgba(15, 23, 42, 0.86)";
          ctx.strokeStyle = "rgba(255, 255, 255, 0.78)";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.roundRect(34, 194, 172, 30, 8);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "#ffffff";
          ctx.font = "700 14px -apple-system, BlinkMacSystemFont, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(`“${inscriptionText.trim().slice(0, 16)}”`, 120, 209);
          ctx.restore();
        }

        const out = canvas.toDataURL("image/png");
        if (out) {
          remember(COMPOSITE_CACHE, compositeKey, out, CACHE_LIMIT.composites);
        }
        return out;
      })();
      COMPOSITE_PROMISE_CACHE.set(compositeKey, promise);
      const settled = promise;
      settled.finally(() => { if (COMPOSITE_PROMISE_CACHE.get(compositeKey) === settled) COMPOSITE_PROMISE_CACHE.delete(compositeKey); }).catch(() => {});
    }

    promise.then((out) => {
      if (alive && out) {
        setSrc(out);
      }
    });

    return () => {
      alive = false;
    };
  }, [compositeKey]);

  const shownSrc = useOutlinedSrc(src, size, statusHex, noOutline || !src);

  if (!src) {
    return (
      <div
        style={{
          ...fitBox(size, fluid),
          borderRadius: 10,
          background: "rgba(255,255,255,0.04)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <img src={PART_PLACEHOLDER_SRC} alt="" width={Math.round(size * 0.6)} height={Math.round(size * 0.6)} />
      </div>
    );
  }

  return (
    <img
      src={shownSrc}
      onError={swapToPlaceholder}
      alt={productIdOrName}
      width={size}
      height={size}
      style={{
        ...fitBox(size, fluid),
        objectFit: "contain",
        filter:
          "drop-shadow(0 1px 1px rgba(255,255,255,0.45)) drop-shadow(0 4px 10px rgba(0,0,0,0.55))",
        userSelect: "none",
        pointerEvents: "none",
      }}
    />
  );
};
