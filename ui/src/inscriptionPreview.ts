/**
 * Preview-only inscription geometry for the order 3D viewport.
 *
 * Uses the product's saved inscription setup (editor.json): target part, area size,
 * font, rotation, flips, optional wrap-on-surface, and an optional saved pose
 * (origin / normal / tangent). When no pose is stored, the text is placed on the
 * camera-facing region of the target part.
 *
 * The mesh is a preview in the live viewport only. It is never written into a
 * Print! plate or an exported .3mf.
 *
 * Wrap follows the target surface by raycasting along the field normal. Tight
 * curvature, undercuts, or a field that leaves the part fall back to a flat
 * plane at the saved (or inferred) pose.
 */
import type { InscriptionStudioConfig } from "./components/productImport/importTypes";
import type { CameraState, Vec3 } from "./viewportCamera";
import { add, cross, dot, normalize, rotate, scale, sub, vlen } from "./viewportCamera";

/** Reserved part id for the preview mesh. Not a catalog part. */
export const INSCRIPTION_PREVIEW_ID = "__order_inscription_preview";

/** Width/height of a typical cap, matching Store/lib/inscription.ts and the layout contract. */
export const CHAR_ASPECT = 0.62;
export const SPACE_ASPECT = 0.32;

const LIFT_MM = 2;
const MIN_WIDTH_MM = 1;
const MIN_HEIGHT_MM = 0.4;
const WRAP_SAMPLES = 48;
const MASK_MAX_WIDTH = 384;
const MASK_HEIGHT = 80;

export type InscriptionAlign = "left" | "center" | "right";

export interface InscriptionPlacement {
  origin: Vec3;
  normal: Vec3;
  tangent: Vec3;
  partId: string;
  widthMm: number;
  heightMm: number;
  wrapOnSurface: boolean;
  align: InscriptionAlign;
  rotationDeg: number;
  mirrorX: boolean;
  upsideDown: boolean;
  fontFamily: string;
  depthMm: number;
  maxChars: number;
}

export interface InscriptionPreviewMesh {
  id: string;
  name: string;
  positions: number[];
  indices: number[];
  hex: string;
}

export interface InscriptionMask {
  width: number;
  height: number;
  /** 1 = filled, 0 = empty; row-major, length width*height. */
  pixels: Uint8Array;
}

export interface PreviewPart {
  id: string;
  name: string;
  positions: number[];
  indices: number[];
  visible?: boolean;
}

const DEFAULT_FONT = 'Arial Rounded MT Bold, "Avenir Next", "Segoe UI", Arial, sans-serif';

export function hasInscriptionSetup(opts: {
  enabled?: boolean | null;
  supportsCustomText?: boolean | null;
}): boolean {
  return !!(opts.enabled || opts.supportsCustomText);
}

/** Trimmed text shown on the model; empty after trim (or after maxChars) draws nothing. */
export function previewInscriptionText(text: string | null | undefined, maxChars = 0): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "";
  if (maxChars > 0 && trimmed.length > maxChars) return Array.from(trimmed).slice(0, maxChars).join("");
  return trimmed;
}

function finiteVec3(raw: unknown): Vec3 | null {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const v: Vec3 = [Number(raw[0]), Number(raw[1]), Number(raw[2])];
  if (!v.every((n) => Number.isFinite(n))) return null;
  if (vlen(v) < 1e-12) return null;
  return v;
}

function num(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readAlign(raw: unknown): InscriptionAlign {
  const s = String(raw || "").toLowerCase();
  if (s === "left" || s === "right") return s;
  return "center";
}

/**
 * Normalizes a saved editor.json inscription block, including optional pose fields
 * (top-level or under `placement`) so older and newer saves both load.
 */
export function inscriptionFromSaved(raw: InscriptionStudioConfig | Record<string, unknown> | null | undefined): InscriptionStudioConfig {
  const r = (raw || {}) as Record<string, unknown>;
  const placement = (r.placement && typeof r.placement === "object" ? r.placement : r) as Record<string, unknown>;
  const wrapRaw = placement.wrapOnSurface ?? placement.wrap_on_surface ?? r.wrapOnSurface ?? r.wrap_on_surface;
  return {
    enabled: !!(r.enabled),
    targetPartName: String(r.targetPartName ?? r.target_part_name ?? ""),
    sampleText: String(r.sampleText ?? r.sample_text ?? "SAMPLE"),
    fontFamily: String(r.fontFamily ?? r.font_family ?? DEFAULT_FONT) || DEFAULT_FONT,
    areaWidthMm: num(r.areaWidthMm ?? r.area_width_mm, 28),
    areaHeightMm: num(r.areaHeightMm ?? r.area_height_mm, 8),
    depthMm: num(r.depthMm ?? r.depth_mm, 0.8),
    maxChars: Math.max(0, Math.round(num(r.maxChars ?? r.max_chars, 14))),
    rotationDeg: num(r.rotationDeg ?? r.rotation_deg, 0),
    mirrorX: !!(r.mirrorX ?? r.mirror_x),
    upsideDown: !!(r.upsideDown ?? r.upside_down),
    wrapOnSurface: wrapRaw == null ? true : !!wrapRaw,
    align: readAlign(placement.align ?? r.align),
    origin: finiteVec3(placement.origin) ?? undefined,
    normal: finiteVec3(placement.normal) ?? undefined,
    tangent: finiteVec3(placement.tangent) ?? undefined,
  };
}

export function letterHeightMm(text: string, areaWidthMm: number): number {
  const chars = Array.from(text);
  const span = chars.length === 0
    ? CHAR_ASPECT
    : chars.reduce((sum, ch) => sum + (ch === " " ? SPACE_ASPECT : CHAR_ASPECT), 0);
  if (span <= 0 || areaWidthMm <= 0) return 0;
  return areaWidthMm / span;
}

function facingNormal(normal: Vec3, viewDirection: Vec3): Vec3 {
  const n = normalize(normal);
  return dot(n, viewDirection) < 0 ? scale(n, -1) : n;
}

export function tangentFacingCamera(normal: Vec3, viewDirection: Vec3, viewUp: Vec3): Vec3 {
  const n = normalize(normal);
  // right ≈ up × direction (direction is model → eye)
  let right = cross(viewUp, viewDirection);
  if (vlen(right) < 1e-8) right = cross([0, 0, 1], viewDirection);
  right = normalize(right);
  let t = sub(right, scale(n, dot(right, n)));
  if (vlen(t) < 1e-8) {
    const up = normalize(viewUp);
    t = sub(up, scale(n, dot(up, n)));
  }
  if (vlen(t) < 1e-8) t = cross(n, Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
  return normalize(t);
}

function applyFieldBasis(normal: Vec3, tangent: Vec3, rotationDeg: number): { normal: Vec3; tangent: Vec3 } {
  let n = normalize(normal);
  let t = normalize(tangent);
  t = sub(t, scale(n, dot(t, n)));
  if (vlen(t) < 1e-8) t = tangentFacingCamera(n, n, [0, 0, 1]);
  t = normalize(t);
  if (rotationDeg) t = normalize(rotate(t, n, rotationDeg));
  return { normal: n, tangent: t };
}

function findTargetPart(parts: PreviewPart[], targetPartName: string): PreviewPart | null {
  const usable = parts.filter((p) => (p.visible !== false) && (p.indices?.length || 0) >= 3 && (p.positions?.length || 0) >= 9);
  if (!usable.length) return null;
  const want = targetPartName.trim().toLowerCase();
  if (want) {
    const hit = usable.find((p) => p.id.toLowerCase() === want || p.name.toLowerCase() === want);
    if (hit) return hit;
  }
  return usable[0];
}

function triNormalArea(pos: ArrayLike<number>, i0: number, i1: number, i2: number): { n: Vec3; area: number; c: Vec3 } | null {
  const ax = pos[i0], ay = pos[i0 + 1], az = pos[i0 + 2];
  const bx = pos[i1], by = pos[i1 + 1], bz = pos[i1 + 2];
  const cx = pos[i2], cy = pos[i2 + 1], cz = pos[i2 + 2];
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const twice = Math.hypot(nx, ny, nz);
  if (twice < 1e-12) return null;
  return {
    n: [nx / twice, ny / twice, nz / twice],
    area: twice * 0.5,
    c: [(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3],
  };
}

/** Area-weighted camera-facing region of a triangle mesh (fallback when no pose is saved). */
export function dominantFacingPlacement(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  viewDirection: Vec3,
  viewUp: Vec3,
): { origin: Vec3; normal: Vec3; tangent: Vec3 } | null {
  const nTri = Math.floor(indices.length / 3);
  let area = 0;
  let cx = 0, cy = 0, cz = 0;
  let nx = 0, ny = 0, nz = 0;
  let fallbackArea = 0;
  let fcx = 0, fcy = 0, fcz = 0;
  let fnx = 0, fny = 0, fnz = 0;
  const view = normalize(viewDirection);
  for (let t = 0; t < nTri; t++) {
    const i0 = indices[t * 3] * 3, i1 = indices[t * 3 + 1] * 3, i2 = indices[t * 3 + 2] * 3;
    if (Math.max(i0, i1, i2) + 2 >= positions.length) continue;
    const tri = triNormalArea(positions, i0, i1, i2);
    if (!tri) continue;
    fcx += tri.c[0] * tri.area; fcy += tri.c[1] * tri.area; fcz += tri.c[2] * tri.area;
    fnx += tri.n[0] * tri.area; fny += tri.n[1] * tri.area; fnz += tri.n[2] * tri.area;
    fallbackArea += tri.area;
    if (dot(tri.n, view) <= 0.05) continue;
    cx += tri.c[0] * tri.area; cy += tri.c[1] * tri.area; cz += tri.c[2] * tri.area;
    nx += tri.n[0] * tri.area; ny += tri.n[1] * tri.area; nz += tri.n[2] * tri.area;
    area += tri.area;
  }
  const useFallback = area < 1e-8;
  const a = useFallback ? fallbackArea : area;
  if (a < 1e-8) return null;
  const origin: Vec3 = useFallback ? [fcx / a, fcy / a, fcz / a] : [cx / a, cy / a, cz / a];
  const rawN: Vec3 = useFallback ? [fnx / a, fny / a, fnz / a] : [nx / a, ny / a, nz / a];
  if (vlen(rawN) < 1e-8) return null;
  const normal = facingNormal(rawN, view);
  const tangent = tangentFacingCamera(normal, view, viewUp);
  const snapped = closestPointOnMesh(positions, indices, origin, normal) ?? origin;
  return { origin: snapped, normal, tangent };
}

function closestPointOnMesh(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  point: Vec3,
  normalHint?: Vec3,
): Vec3 | null {
  const nTri = Math.floor(indices.length / 3);
  let best = Infinity;
  let hit: Vec3 | null = null;
  for (let t = 0; t < nTri; t++) {
    const i0 = indices[t * 3] * 3, i1 = indices[t * 3 + 1] * 3, i2 = indices[t * 3 + 2] * 3;
    if (Math.max(i0, i1, i2) + 2 >= positions.length) continue;
    const a: Vec3 = [positions[i0], positions[i0 + 1], positions[i0 + 2]];
    const b: Vec3 = [positions[i1], positions[i1 + 1], positions[i1 + 2]];
    const c: Vec3 = [positions[i2], positions[i2 + 1], positions[i2 + 2]];
    const p = closestPointOnTriangle(point, a, b, c);
    const d = vlen(sub(p, point));
    let score = d;
    if (normalHint) {
      const tri = triNormalArea(positions, i0, i1, i2);
      if (tri) score -= 0.15 * Math.max(0, dot(tri.n, normalize(normalHint)));
    }
    if (score < best) {
      best = score;
      hit = p;
    }
  }
  return hit;
}

function closestPointOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return add(a, scale(ab, v));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return add(a, scale(ac, w));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return add(b, scale(sub(c, b), w));
  }
  const denom = 1 / (va + vb + vc);
  return add(add(scale(a, 1 - vb * denom - vc * denom), scale(b, vb * denom)), scale(c, vc * denom));
}

export function resolveInscriptionPlacement(opts: {
  config: InscriptionStudioConfig;
  parts: PreviewPart[];
  camera: CameraState;
}): InscriptionPlacement | null {
  const cfg = inscriptionFromSaved(opts.config);
  const part = findTargetPart(opts.parts, cfg.targetPartName);
  if (!part) return null;
  const view = normalize(opts.camera.direction);
  const up = normalize(opts.camera.up);
  const widthMm = Math.max(MIN_WIDTH_MM, cfg.areaWidthMm || 28);
  let heightMm = cfg.areaHeightMm || 0;
  if (heightMm < MIN_HEIGHT_MM) heightMm = Math.max(MIN_HEIGHT_MM, letterHeightMm(cfg.sampleText || "SAMPLE", widthMm) || 8);
  let origin = cfg.origin ?? null;
  let normal = cfg.normal ?? null;
  let tangent = cfg.tangent ?? null;
  if (!origin || !normal) {
    const inferred = dominantFacingPlacement(part.positions, part.indices, view, up);
    if (!inferred) return null;
    origin = origin ?? inferred.origin;
    normal = normal ?? inferred.normal;
    tangent = tangent ?? inferred.tangent;
  }
  normal = facingNormal(normal, view);
  if (!tangent) tangent = tangentFacingCamera(normal, view, up);
  const basis = applyFieldBasis(normal, tangent, cfg.rotationDeg);
  // When no pose was saved, keep letters reading left-to-right and right-way-up in the product picture.
  if (!cfg.origin || !cfg.normal) {
    const right = tangentFacingCamera(basis.normal, view, up);
    if (dot(basis.tangent, right) < 0) basis.tangent = scale(basis.tangent, -1);
  }
  return {
    origin,
    normal: basis.normal,
    tangent: basis.tangent,
    partId: part.id,
    widthMm,
    heightMm: Math.max(MIN_HEIGHT_MM, heightMm),
    wrapOnSurface: cfg.wrapOnSurface !== false,
    align: cfg.align || "center",
    rotationDeg: cfg.rotationDeg,
    mirrorX: !!cfg.mirrorX,
    upsideDown: !!cfg.upsideDown,
    fontFamily: cfg.fontFamily || DEFAULT_FONT,
    depthMm: Math.max(0, cfg.depthMm || 0),
    maxChars: cfg.maxChars || 0,
  };
}

export interface StripSample {
  u: number;
  position: Vec3;
  normal: Vec3;
  top: Vec3;
  bottom: Vec3;
}

export function planarStrip(placement: InscriptionPlacement, sampleCount = WRAP_SAMPLES): StripSample[] {
  const count = Math.max(8, sampleCount);
  const halfW = placement.widthMm * 0.5;
  const halfH = placement.heightMm * 0.5;
  const n = normalize(placement.normal);
  let t = normalize(placement.tangent);
  if (placement.mirrorX) t = scale(t, -1);
  let b = cross(n, t);
  if (vlen(b) < 1e-8) b = [0, 0, 1];
  b = normalize(b);
  if (placement.upsideDown) b = scale(b, -1);
  const out: StripSample[] = [];
  for (let i = 0; i < count; i++) {
    const u = count === 1 ? 0.5 : i / (count - 1);
    const pos = add(placement.origin, scale(t, (u - 0.5) * 2 * halfW));
    const lift = scale(n, LIFT_MM);
    out.push({
      u,
      position: add(pos, lift),
      normal: n,
      top: add(add(pos, scale(b, halfH)), lift),
      bottom: add(add(pos, scale(b, -halfH)), lift),
    });
  }
  return out;
}

function rayTriangle(
  origin: Vec3,
  dir: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): number | null {
  const e1 = sub(b, a), e2 = sub(c, a);
  const p = cross(dir, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tv = sub(origin, a);
  const u = dot(tv, p) * inv;
  if (u < 0 || u > 1) return null;
  const q = cross(tv, e1);
  const v = dot(dir, q) * inv;
  if (v < 0 || u + v > 1) return null;
  const dist = dot(e2, q) * inv;
  return dist > 1e-6 ? dist : null;
}

function raycastMesh(
  origin: Vec3,
  dir: Vec3,
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  maxDist: number,
): { point: Vec3; normal: Vec3; dist: number } | null {
  const nTri = Math.floor(indices.length / 3);
  let best = maxDist;
  let hit: { point: Vec3; normal: Vec3; dist: number } | null = null;
  const d = normalize(dir);
  for (let t = 0; t < nTri; t++) {
    const i0 = indices[t * 3] * 3, i1 = indices[t * 3 + 1] * 3, i2 = indices[t * 3 + 2] * 3;
    if (Math.max(i0, i1, i2) + 2 >= positions.length) continue;
    const a: Vec3 = [positions[i0], positions[i0 + 1], positions[i0 + 2]];
    const b: Vec3 = [positions[i1], positions[i1 + 1], positions[i1 + 2]];
    const c: Vec3 = [positions[i2], positions[i2 + 1], positions[i2 + 2]];
    const dist = rayTriangle(origin, d, a, b, c);
    if (dist == null || dist >= best) continue;
    const tri = triNormalArea(positions, i0, i1, i2);
    if (!tri) continue;
    best = dist;
    const n = dot(tri.n, d) > 0 ? scale(tri.n, -1) : tri.n;
    hit = { point: add(origin, scale(d, dist)), normal: n, dist };
  }
  return hit;
}

/**
 * Walk the field across the target mesh. Returns a planar strip when too few
 * samples land on the surface (sharp edges, undercuts, or the field leaving the part).
 */
export function wrapStrip(
  placement: InscriptionPlacement,
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  sampleCount = WRAP_SAMPLES,
): { samples: StripSample[]; wrapped: boolean } {
  const planar = planarStrip(placement, sampleCount);
  if (!placement.wrapOnSurface) return { samples: planar, wrapped: false };
  const n = normalize(placement.normal);
  const probe = Math.max(placement.widthMm, placement.heightMm, 16) * 2;
  const halfH = placement.heightMm * 0.5;
  const hits: StripSample[] = [];
  for (const sample of planar) {
    const start = add(sample.position, scale(n, probe * 0.5));
    const hit = raycastMesh(start, scale(n, -1), positions, indices, probe);
    if (!hit) continue;
    let bit = cross(hit.normal, normalize(placement.tangent));
    if (vlen(bit) < 1e-8) bit = sub(sample.top, sample.bottom);
    bit = normalize(bit);
    if (dot(bit, sub(sample.top, sample.bottom)) < 0) bit = scale(bit, -1);
    const lift = scale(hit.normal, LIFT_MM);
    const pos = add(hit.point, lift);
    hits.push({
      u: sample.u,
      position: pos,
      normal: hit.normal,
      top: add(pos, scale(bit, halfH)),
      bottom: add(pos, scale(bit, -halfH)),
    });
  }
  if (hits.length < Math.max(4, Math.floor(planar.length * 0.5))) {
    return { samples: planar, wrapped: false };
  }
  return { samples: hits, wrapped: true };
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function sampleStrip(samples: StripSample[], u: number, v: number): { point: Vec3; normal: Vec3 } {
  if (samples.length === 1) {
    return { point: lerp3(samples[0].top, samples[0].bottom, v), normal: samples[0].normal };
  }
  const max = samples.length - 1;
  const x = Math.min(max, Math.max(0, u * max));
  const i = Math.min(max - 1, Math.floor(x));
  const t = x - i;
  const a = samples[i], b = samples[i + 1];
  const top = lerp3(a.top, b.top, t);
  const bot = lerp3(a.bottom, b.bottom, t);
  const n = normalize(lerp3(a.normal, b.normal, t));
  return { point: lerp3(top, bot, v), normal: n };
}

/** Fit the raster into the field the same way the shop fits a strip into its quad. */
export function fitRange(textAspect: number, boxAspect: number): { u0: number; u1: number; v0: number; v1: number } {
  if (!(textAspect > 0) || !(boxAspect > 0)) return { u0: 0, u1: 1, v0: 0, v1: 1 };
  if (textAspect >= boxAspect) {
    const used = boxAspect / textAspect;
    const pad = (1 - used) / 2;
    return { u0: 0, u1: 1, v0: pad, v1: 1 - pad };
  }
  const used = textAspect / boxAspect;
  const pad = (1 - used) / 2;
  return { u0: pad, u1: 1 - pad, v0: 0, v1: 1 };
}

export function applyAlign(fit: { u0: number; u1: number; v0: number; v1: number }, align: InscriptionAlign): { u0: number; u1: number; v0: number; v1: number } {
  if (align === "center" || fit.u0 === 0) return fit;
  const span = fit.u1 - fit.u0;
  if (align === "left") return { ...fit, u0: 0, u1: span };
  return { ...fit, u0: 1 - span, u1: 1 };
}

export function rasterizeTextMask(text: string, fontFamily: string, opts?: { width?: number; height?: number }): InscriptionMask | null {
  if (typeof document === "undefined") return null;
  const height = Math.max(16, Math.round(opts?.height ?? MASK_HEIGHT));
  const width = Math.max(16, Math.round(opts?.width ?? MASK_MAX_WIDTH));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const family = fontFamily && fontFamily.trim() ? fontFamily : DEFAULT_FONT;
  let size = Math.floor(height * 0.82);
  ctx.font = `600 ${size}px ${family}`;
  const maxW = width * 0.96;
  while (size > 8 && ctx.measureText(text).width > maxW) {
    size -= 1;
    ctx.font = `600 ${size}px ${family}`;
  }
  ctx.fillText(text, width / 2, height / 2);
  const img = ctx.getImageData(0, 0, width, height).data;
  const pixels = new Uint8Array(width * height);
  let filled = 0;
  for (let i = 0; i < pixels.length; i++) {
    if (img[i * 4 + 3] > 40) {
      pixels[i] = 1;
      filled++;
    }
  }
  return filled ? { width, height, pixels } : null;
}

/** Solid block the size of the laid-out text, used when no canvas is available (tests). */
export function layoutMask(text: string, width = 80, height = 16): InscriptionMask {
  const chars = Array.from(text);
  const span = chars.reduce((sum, ch) => sum + (ch === " " ? SPACE_ASPECT : CHAR_ASPECT), 0) || CHAR_ASPECT;
  const used = Math.max(1, Math.round(width * Math.min(1, span / (span + 0.01))));
  const pixels = new Uint8Array(width * height);
  const x0 = Math.floor((width - used) / 2);
  const y0 = Math.floor(height * 0.15);
  const y1 = Math.ceil(height * 0.85);
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < used; x++) pixels[y * width + (x0 + x)] = 1;
  }
  return { width, height, pixels };
}

export function meshFromMask(
  mask: InscriptionMask,
  placement: InscriptionPlacement,
  samples: StripSample[],
  hex: string,
): InscriptionPreviewMesh | null {
  const { width, height, pixels } = mask;
  if (width < 1 || height < 1) return null;
  let minX = width, maxX = -1, minY = height, maxY = -1, filled = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!pixels[y * width + x]) continue;
      filled++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!filled) return null;
  const textAspect = (maxX - minX + 1) / Math.max(1, maxY - minY + 1);
  const boxAspect = placement.widthMm / Math.max(1e-6, placement.heightMm);
  const fit = applyAlign(fitRange(textAspect, boxAspect), placement.align);
  const positions: number[] = [];
  const indices: number[] = [];
  // Thickness grows outward from the already-lifted strip, never back into the part.
  const depth = Math.min(2, Math.max(0, placement.depthMm));
  const push = (p: Vec3) => {
    positions.push(p[0], p[1], p[2]);
    return (positions.length / 3) - 1;
  };
  const along = (s: { point: Vec3; normal: Vec3 }, t: number): Vec3 => add(s.point, scale(normalize(s.normal), t));
  // Step by 1 texel; skip empty. Neighbour-joined quads keep the letter shape.
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!pixels[y * width + x]) continue;
      const su0 = (x - minX) / Math.max(1, maxX - minX + 1);
      const su1 = (x + 1 - minX) / Math.max(1, maxX - minX + 1);
      const sv0 = (y - minY) / Math.max(1, maxY - minY + 1);
      const sv1 = (y + 1 - minY) / Math.max(1, maxY - minY + 1);
      const u0 = fit.u0 + (fit.u1 - fit.u0) * su0;
      const u1 = fit.u0 + (fit.u1 - fit.u0) * su1;
      // Bitmap y grows down; field v=0 is the top edge.
      const v0 = fit.v0 + (fit.v1 - fit.v0) * sv0;
      const v1 = fit.v0 + (fit.v1 - fit.v0) * sv1;
      const p00 = sampleStrip(samples, u0, v0);
      const p10 = sampleStrip(samples, u1, v0);
      const p11 = sampleStrip(samples, u1, v1);
      const p01 = sampleStrip(samples, u0, v1);
      const i00 = push(along(p00, depth)), i10 = push(along(p10, depth)), i11 = push(along(p11, depth)), i01 = push(along(p01, depth));
      indices.push(i00, i10, i11, i00, i11, i01);
      if (depth > 1e-3) {
        const b00 = push(p00.point), b10 = push(p10.point), b11 = push(p11.point), b01 = push(p01.point);
        indices.push(b00, b11, b10, b00, b01, b11);
      }
    }
  }
  if (indices.length < 3) return null;
  return { id: INSCRIPTION_PREVIEW_ID, name: "Inscription preview", positions, indices, hex };
}

function relativeLuminance(hex: string): number {
  const raw = (hex || "#888888").replace("#", "");
  const n = parseInt(raw.slice(0, 6).padEnd(6, "0"), 16);
  if (!Number.isFinite(n)) return 0.5;
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

function contrastRatio(a: number, b: number): number {
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** Pick black or white, whichever reads more clearly on `hex`. */
export function contrastHex(hex: string): string {
  const L = relativeLuminance(hex);
  return contrastRatio(L, relativeLuminance("#1a1a1a")) >= contrastRatio(L, relativeLuminance("#f4f4f4"))
    ? "#1a1a1a"
    : "#f4f4f4";
}

/** Preview letters sit on the target part, so they contrast with that surface. */
export function inscriptionPreviewHex(opts: { surfaceHex?: string | null; letterHex?: string | null }): string {
  const surface = opts.surfaceHex || "#888888";
  const letter = opts.letterHex || "";
  if (letter && letter.toLowerCase().slice(0, 7) !== surface.toLowerCase().slice(0, 7)) {
    // Only keep an explicit letter color when it actually reads against the surface.
    if (contrastRatio(relativeLuminance(letter), relativeLuminance(surface)) >= 2) return letter;
  }
  return contrastHex(surface);
}

export function buildInscriptionPreviewMesh(opts: {
  text: string | null | undefined;
  config: InscriptionStudioConfig | Record<string, unknown> | null | undefined;
  supportsCustomText?: boolean;
  parts: PreviewPart[];
  camera: CameraState;
  partColors?: Record<string, string>;
  defaultHexes?: Record<string, string>;
  mask?: InscriptionMask | null;
}): { mesh: InscriptionPreviewMesh; placement: InscriptionPlacement; wrapped: boolean } | null {
  const cfg = inscriptionFromSaved(opts.config);
  if (!hasInscriptionSetup({ enabled: cfg.enabled, supportsCustomText: opts.supportsCustomText })) return null;
  const text = previewInscriptionText(opts.text, cfg.maxChars);
  if (!text) return null;
  const placement = resolveInscriptionPlacement({ config: cfg, parts: opts.parts, camera: opts.camera });
  if (!placement) return null;
  const target = opts.parts.find((p) => p.id === placement.partId);
  if (!target) return null;
  const { samples, wrapped } = wrapStrip(placement, target.positions, target.indices);
  const mask = opts.mask === undefined ? rasterizeTextMask(text, placement.fontFamily) : opts.mask;
  const used = mask ?? layoutMask(text);
  const surfaceHex = opts.partColors?.[placement.partId] || opts.defaultHexes?.[placement.partId] || "#888888";
  const hex = inscriptionPreviewHex({ surfaceHex });
  const mesh = meshFromMask(used, placement, samples, hex);
  if (!mesh) return null;
  return { mesh, placement, wrapped };
}
