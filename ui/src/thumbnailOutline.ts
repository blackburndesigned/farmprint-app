// Silhouette outlines for part thumbnails (Settings › Appearance › Thumbnail outline).
// Each stroke traces the part's own shape, not the tile: the first stroke sits against
// the part and later strokes stack outward. Rendered once per picture into a cached PNG.
import { useEffect, useState } from "react";
import { useShopSettings } from "./settingsStore";
import type { AppearanceStudio, OutlineStroke } from "./types";

/** What a new stroke starts as, so turning the setting on shows an outline right away. */
export const DEFAULT_OUTLINE_STROKE: OutlineStroke = { color: "", weight: 1.5, opacity: 0.55 };
export const MAX_OUTLINE_STROKES = 5;

interface ResolvedStroke {
  /** Display pixels. */
  width: number;
  opacity: number;
  /** Any CSS color, or a "gradient:<axis>:<angle>:#A,#B" token. */
  fill: string;
}

function systemPrimary(): string {
  if (typeof document === "undefined") return "#ffffff";
  const v = getComputedStyle(document.documentElement).getPropertyValue("--text-primary").trim();
  return v || "#ffffff";
}

/** The strokes to draw, or null when outlines are off or every stroke is invisible. */
export function resolveOutlineStrokes(st: AppearanceStudio, statusHex?: string): ResolvedStroke[] | null {
  if (!st.tile_outline_enabled) return null;
  const list = st.tile_outline_strokes.length ? st.tile_outline_strokes : [DEFAULT_OUTLINE_STROKE];
  const primary = systemPrimary();
  const out: ResolvedStroke[] = [];
  for (const s of list.slice(0, MAX_OUTLINE_STROKES)) {
    const width = Math.min(12, Math.max(0, Number(s.weight) || 0));
    const opacity = Math.min(1, Math.max(0, Number(s.opacity) || 0));
    if (width <= 0 || opacity <= 0) continue;
    const fill = st.tile_outline_follows_status ? statusHex || primary : s.color || primary;
    out.push({ width, opacity, fill });
  }
  return out.length ? out : null;
}

/** True when outlines follow status, so the colored tile ring is hidden (the outline replaces it). */
export function outlineReplacesRing(st: AppearanceStudio): boolean {
  return !!resolveOutlineStrokes(st) && st.tile_outline_follows_status;
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = src;
  });
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) throw new Error("no 2d context");
  return { c, g };
}

/** The silhouette grown by r pixels (alpha only matters). */
function dilate(sil: HTMLCanvasElement, r: number): HTMLCanvasElement {
  const { c, g } = makeCanvas(sil.width, sil.height);
  g.drawImage(sil, 0, 0);
  if (r <= 0) return c;
  // Concentric rings of stamps fill the disc, so thin features never leave gaps.
  const step = Math.max(1, r / 4);
  for (let rr = step; rr < r + step * 0.5; rr += step) {
    const rad = Math.min(rr, r);
    const n = Math.max(8, Math.ceil(2 * Math.PI * rad));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      g.drawImage(sil, Math.cos(a) * rad, Math.sin(a) * rad);
    }
  }
  return c;
}

function fillStyleFor(g: CanvasRenderingContext2D, fill: string, w: number, h: number): string | CanvasGradient {
  const m = /^gradient:([a-z]+):(\d+(?:\.\d+)?):(#[0-9a-f]{6}),(#[0-9a-f]{6})$/i.exec(fill);
  if (!m) return fill;
  const [, axis, angle, a, b] = m;
  if (axis === "radial") {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) / 2);
    gr.addColorStop(0, a);
    gr.addColorStop(1, b);
    return gr;
  }
  const deg = ({ horizontal: 90, vertical: 180, diagonal: 135 } as Record<string, number>)[axis] ?? parseFloat(angle);
  // CSS angles: 0deg points up, 90deg points right.
  const rad = (deg * Math.PI) / 180;
  const dx = Math.sin(rad) * (w / 2);
  const dy = -Math.cos(rad) * (h / 2);
  const gr = g.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
  gr.addColorStop(0, a);
  gr.addColorStop(1, b);
  return gr;
}

async function renderOutlined(src: string, strokes: ResolvedStroke[], displaySize: number): Promise<string> {
  const img = await loadImg(src);
  const nw = img.naturalWidth || displaySize;
  const nh = img.naturalHeight || displaySize;
  // Work at least at 2x the display size so thin strokes stay crisp on Retina.
  const side = Math.max(nw, nh, displaySize * 2);
  const scale = side / Math.max(1, displaySize);
  const total = strokes.reduce((s, k) => s + k.width, 0) * scale;
  // Shrink the part just enough that the outermost stroke isn't clipped by the picture's edge.
  const room = Math.max(1, side - 2 * Math.ceil(total));
  const fit = Math.min(room / nw, room / nh);
  const dw = nw * fit;
  const dh = nh * fit;
  const dx = (side - dw) / 2;
  const dy = (side - dh) / 2;

  const { c: sil, g: sg } = makeCanvas(side, side);
  sg.drawImage(img, dx, dy, dw, dh);

  const { c: out, g: og } = makeCanvas(side, side);
  let inner = sil;
  let reach = 0;
  for (const s of strokes) {
    reach += s.width * scale;
    const grown = dilate(sil, reach);
    const { c: ring, g: rg } = makeCanvas(side, side);
    rg.drawImage(grown, 0, 0);
    rg.globalCompositeOperation = "source-in";
    rg.fillStyle = fillStyleFor(rg, s.fill, side, side);
    rg.fillRect(0, 0, side, side);
    rg.globalCompositeOperation = "destination-out";
    rg.drawImage(inner, 0, 0);
    og.globalAlpha = s.opacity;
    og.drawImage(ring, 0, 0);
    inner = grown;
  }
  og.globalAlpha = 1;
  og.drawImage(sil, 0, 0);
  return out.toDataURL("image/png");
}

const CACHE = new Map<string, string>();
const INFLIGHT = new Map<string, Promise<string>>();
const CACHE_LIMIT = 400;

function outlined(key: string, src: string, strokes: ResolvedStroke[], size: number): Promise<string> {
  const hit = CACHE.get(key);
  if (hit) return Promise.resolve(hit);
  let p = INFLIGHT.get(key);
  if (p) return p;
  p = renderOutlined(src, strokes, size).then((url) => {
    CACHE.set(key, url);
    if (CACHE.size > CACHE_LIMIT) CACHE.delete(CACHE.keys().next().value as string);
    return url;
  });
  INFLIGHT.set(key, p);
  p.finally(() => INFLIGHT.delete(key)).catch(() => {});
  return p;
}

/**
 * The part picture with the Settings outline applied, or `src` unchanged when outlines
 * are off. Re-renders live when the outline settings change.
 */
export function useOutlinedSrc(src: string, size: number, statusHex?: string, disabled = false): string {
  const settings = useShopSettings();
  const strokes = disabled || !src ? null : resolveOutlineStrokes(settings.appearance_studio, statusHex);
  const key = strokes ? `${Math.round(size)}|${JSON.stringify(strokes)}|${src}` : "";
  const [done, setDone] = useState<{ key: string; url: string } | null>(null);

  useEffect(() => {
    if (!key || !strokes) return;
    let alive = true;
    outlined(key, src, strokes, size)
      .then((url) => {
        if (alive) setDone({ key, url });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // `key` covers src, size and every stroke value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return src;
  if (done && done.key === key) return done.url;
  return CACHE.get(key) || src;
}
