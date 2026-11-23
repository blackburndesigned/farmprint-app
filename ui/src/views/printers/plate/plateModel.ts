// The plate view's data and the small amount of geometry the UI does itself (live drag
// checks, tweens, undo). Every arrange / orient / lay-flat decision is made by the
// backend (fp-mesh `plate`), so Print! and the plate view always agree. Plain TS so
// scripts/tests can run it.

export type V2 = [number, number];
export type V3 = [number, number, number];
/** Quaternion [x, y, z, w]. */
export type Quat = [number, number, number, number];
export const IDENTITY: Quat = [0, 0, 0, 1];

export type Sequence = "by_layer" | "by_object";
export type FaceMode = "convex_hull" | "triangle";

export interface ArrangeSettings {
  spacing_mm: number;
  auto_rotate: boolean;
  align_y: boolean;
  sequence: Sequence;
  clearance_radius_mm: number;
  clearance_height_mm: number;
}

export const DEFAULT_SETTINGS: ArrangeSettings = {
  spacing_mm: 5,
  auto_rotate: true,
  align_y: false,
  sequence: "by_layer",
  clearance_radius_mm: 35,
  clearance_height_mm: 30,
};

export interface BedSize {
  width_mm: number;
  depth_mm: number;
  height_mm?: number | null;
  /** False when the printer has no bed size set (the 220 mm default is used). */
  known?: boolean;
}

export interface Footprint {
  /** Convex outline around the reference point, counter-clockwise. */
  hull: V2[];
  height: number;
  /** Reference point in the oriented model's coordinates (top-down centre, lowest Z). */
  origin: V3;
  area: number;
}

export interface Placement {
  plate: number;
  x: number;
  y: number;
  rot_deg: number;
}

export interface PlateCheck {
  plates: number;
  fits: boolean;
  off_plate: string[];
  collisions: [string, string][];
  clearance_overlaps: [string, string][];
  too_tall: string[];
  taller_than_gantry: string[];
  order: string[][];
  plate1_fill: number;
  tallest_mm: number;
}

export interface PlatePart {
  unit_id: string;
  mesh_key: string;
  name: string;
  product_name: string;
  order_code: string;
  customer_name: string;
  hex: string;
  filament_name: string;
  orientation: Quat;
  footprint: Footprint;
  placement: Placement;
}

export interface PlateMesh {
  positions: number[];
  indices: number[];
}

export interface PreparedPlate {
  parts: PlatePart[];
  meshes: Record<string, PlateMesh>;
  bed: BedSize;
  settings: ArrangeSettings;
  check: PlateCheck;
}

export interface FaceCandidate {
  normal: V3;
  area: number;
  stable: boolean;
  height: number;
  orientation: Quat;
  /** Flat list of triangle corners (x, y, z, ...) in the saved model's coordinates. */
  triangles: number[];
  footprint: Footprint;
}

export interface FitSummary {
  bed: BedSize;
  settings: ArrangeSettings;
  check: PlateCheck;
  outlines: { unit_id: string; hex: string; plate: number; outline: V2[] }[];
}

/** What Print! sends when the plate view was used (`layout` on transition_units). */
export interface PrintLayout {
  parts: { unit_id: string; orientation: Quat; placement: Placement }[];
  order: string[][];
}

export function normalizeSettings(v: unknown): ArrangeSettings {
  const o = (v && typeof v === "object" ? v : {}) as Partial<ArrangeSettings>;
  const num = (x: unknown, d: number, max: number) =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= max ? x : d;
  return {
    spacing_mm: num(o.spacing_mm, DEFAULT_SETTINGS.spacing_mm, 100),
    auto_rotate: typeof o.auto_rotate === "boolean" ? o.auto_rotate : DEFAULT_SETTINGS.auto_rotate,
    align_y: typeof o.align_y === "boolean" ? o.align_y : DEFAULT_SETTINGS.align_y,
    sequence: o.sequence === "by_object" ? "by_object" : "by_layer",
    clearance_radius_mm: num(o.clearance_radius_mm, DEFAULT_SETTINGS.clearance_radius_mm, 500),
    clearance_height_mm: num(o.clearance_height_mm, DEFAULT_SETTINGS.clearance_height_mm, 1000),
  };
}

// ---- 2D geometry ------------------------------------------------------------------------

export function transform2d(h: V2[], deg: number, tx: number, ty: number): V2[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return h.map(([x, y]) => [x * c - y * s + tx, x * s + y * c + ty]);
}

export function placedOutline(p: Pick<PlatePart, "footprint" | "placement">): V2[] {
  return transform2d(p.footprint.hull, p.placement.rot_deg, p.placement.x, p.placement.y);
}

export function bbox(h: V2[]): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of h) {
    b[0] = Math.min(b[0], x);
    b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x);
    b[3] = Math.max(b[3], y);
  }
  return b;
}

/** True when two convex outlines overlap by more than `eps` (touching is fine). */
export function convexOverlap(a: V2[], b: V2[], eps = 0.05): boolean {
  if (a.length < 3 || b.length < 3) return false;
  for (const P of [a, b]) {
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      const q = P[(i + 1) % P.length];
      let nx = q[1] - p[1];
      let ny = p[0] - q[0];
      const l = Math.hypot(nx, ny) || 1;
      nx /= l;
      ny /= l;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const v of a) { const d = v[0] * nx + v[1] * ny; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (const v of b) { const d = v[0] * nx + v[1] * ny; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      if (a1 <= b0 + eps || b1 <= a0 + eps) return false;
    }
  }
  return true;
}

/** Hull grown by `r` (round corners), for by-object clearance capsules. */
export function offsetOutline(h: V2[], r: number, seg = 10): V2[] {
  if (r <= 0) return h.slice();
  const pts: V2[] = [];
  const n = h.length;
  for (let i = 0; i < n; i++) {
    const prev = h[(i + n - 1) % n];
    const cur = h[i];
    const next = h[(i + 1) % n];
    const a0 = Math.atan2(-(cur[0] - prev[0]), cur[1] - prev[1]);
    let a1 = Math.atan2(-(next[0] - cur[0]), next[1] - cur[1]);
    while (a1 < a0) a1 += Math.PI * 2;
    const steps = Math.max(1, Math.ceil(((a1 - a0) / (Math.PI * 2)) * seg * 4));
    for (let k = 0; k <= steps; k++) {
      const t = a0 + ((a1 - a0) * k) / steps;
      // Outward normal of a CCW polygon edge (dx, dy) is (dy, -dx).
      pts.push([cur[0] + r * Math.cos(t), cur[1] + r * Math.sin(t)]);
    }
  }
  return pts;
}

/** Live checks while dragging: ids that leave the bed or overlap another part. */
export function liveProblems(parts: PlatePart[], plate: number, bed: BedSize): { off: Set<string>; hit: Set<string> } {
  const on = parts.filter((p) => p.placement.plate === plate);
  const polys = on.map(placedOutline);
  const off = new Set<string>();
  const hit = new Set<string>();
  on.forEach((p, i) => {
    const b = bbox(polys[i]);
    if (b[0] < -0.01 || b[1] < -0.01 || b[2] > bed.width_mm + 0.01 || b[3] > bed.depth_mm + 0.01) off.add(p.unit_id);
  });
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      if (convexOverlap(polys[i], polys[j])) {
        hit.add(on[i].unit_id);
        hit.add(on[j].unit_id);
      }
    }
  }
  return { off, hit };
}

// ---- quaternions -----------------------------------------------------------------------

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; d = -d; }
  if (d > 0.9995) {
    return quatNormalize([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
  }
  const th = Math.acos(Math.min(1, d));
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}

// ---- tweens -----------------------------------------------------------------------------

/** Plate view animations: 250–400 ms, ease-out. */
export const TWEEN_MS = 320;
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** Shortest turn from `a` to `b` in degrees, for tweening rotations. */
export function angleDelta(a: number, b: number): number {
  let d = (((b - a) % 360) + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** A part's shown pose: tweens blend between two of these. */
export interface Pose {
  x: number;
  y: number;
  rot_deg: number;
  q: Quat;
  origin: V3;
}

export function poseOf(p: PlatePart): Pose {
  return { x: p.placement.x, y: p.placement.y, rot_deg: p.placement.rot_deg, q: p.orientation, origin: p.footprint.origin };
}

export function blendPose(a: Pose, b: Pose, t: number): Pose {
  const k = easeOutCubic(t);
  const lerp = (u: number, v: number) => u + (v - u) * k;
  return {
    x: lerp(a.x, b.x),
    y: lerp(a.y, b.y),
    rot_deg: a.rot_deg + angleDelta(a.rot_deg, b.rot_deg) * k,
    q: quatSlerp(a.q, b.q, k),
    origin: [lerp(a.origin[0], b.origin[0]), lerp(a.origin[1], b.origin[1]), lerp(a.origin[2], b.origin[2])],
  };
}

// ---- job state, undo --------------------------------------------------------------------

export interface PlateState {
  parts: PlatePart[];
  /** Plates shown, at least one more than the highest plate in use when one was added. */
  plateCount: number;
  /** By-object print order per plate (unit ids), when the user reordered it. */
  order: string[][] | null;
}

export function platesInUse(parts: PlatePart[]): number {
  return parts.reduce((m, p) => Math.max(m, p.placement.plate + 1), 0);
}

/** Undo history: past states, newest last. Capped so long sessions stay small. */
export class History {
  private past: PlateState[] = [];
  constructor(private readonly cap = 60) {}
  push(s: PlateState) {
    this.past.push(s);
    if (this.past.length > this.cap) this.past.shift();
  }
  pop(): PlateState | undefined {
    return this.past.pop();
  }
  get size() {
    return this.past.length;
  }
}

/** Drops parts from this job only (they stay in Parts to Print). Never leaves the plate empty. */
export function removeFromJob(parts: PlatePart[], ids: Set<string>): PlatePart[] {
  const left = parts.filter((p) => !ids.has(p.unit_id));
  return left.length === 0 ? parts : left;
}

/** Moves `id` to position `to` within its plate's print order. */
export function reorder(order: string[][], plate: number, id: string, to: number): string[][] {
  const next = order.map((o) => o.slice());
  const list = next[plate];
  if (!list) return order;
  const from = list.indexOf(id);
  if (from < 0) return order;
  list.splice(from, 1);
  list.splice(Math.max(0, Math.min(list.length, to)), 0, id);
  return next;
}

/** Print order per plate: the user's order when it still matches the parts, else the check's. */
export function effectiveOrder(parts: PlatePart[], user: string[][] | null, fromCheck: string[][]): string[][] {
  const plates = platesInUse(parts);
  const out: string[][] = [];
  for (let pl = 0; pl < plates; pl++) {
    const ids = parts.filter((p) => p.placement.plate === pl).map((p) => p.unit_id);
    const set = new Set(ids);
    const pick = (o: string[] | undefined) => (o && o.length === ids.length && o.every((id) => set.has(id)) ? o : null);
    out.push(pick(user?.[pl]) ?? pick(fromCheck[pl]) ?? ids);
  }
  return out;
}

export function layoutFor(parts: PlatePart[], order: string[][]): PrintLayout {
  return {
    parts: parts.map((p) => ({ unit_id: p.unit_id, orientation: p.orientation, placement: p.placement })),
    order,
  };
}

/** Status line headline for a check. */
export function fitHeadline(c: Pick<PlateCheck, "fits" | "plates" | "off_plate" | "collisions" | "too_tall">, bigger?: number): {
  tone: "ok" | "warn" | "bad";
  text: string;
} {
  if (c.too_tall.length) return { tone: "bad", text: `${c.too_tall.length} too tall for this printer` };
  if (bigger) return { tone: "bad", text: `${bigger} bigger than the bed` };
  if (c.off_plate.length) return { tone: "bad", text: `${c.off_plate.length} off the plate` };
  if (c.collisions.length) return { tone: "bad", text: `${new Set(c.collisions.flat()).size} parts overlap` };
  if (c.plates > 1) return { tone: "warn", text: `Needs ${c.plates} plates` };
  return { tone: "ok", text: "Fits on one plate" };
}

/** Parts whose outline is larger than the bed in every direction (no arrangement helps). */
export function biggerThanBed(parts: PlatePart[], bed: BedSize): string[] {
  return parts
    .filter((p) => {
      const b = bbox(p.footprint.hull);
      const w = b[2] - b[0];
      const d = b[3] - b[1];
      const fitsAsIs = w <= bed.width_mm && d <= bed.depth_mm;
      const fitsTurned = d <= bed.width_mm && w <= bed.depth_mm;
      return !fitsAsIs && !fitsTurned && Math.min(w, d) > Math.min(bed.width_mm, bed.depth_mm);
    })
    .map((p) => p.unit_id);
}

export function sizeLabel(f: Footprint): string {
  const b = bbox(f.hull);
  return `${Math.round(b[2] - b[0])} × ${Math.round(b[3] - b[1])} × ${Math.round(f.height)} mm`;
}
