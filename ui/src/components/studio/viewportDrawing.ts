import { BASE_MARGIN, Bounds, CameraState, Vec3, dot, framed, lookAtBasis, normalize, sub } from "../../viewportCamera";
import { renderViewportGL } from "../../meshRendererGL";
import { splitHexAlpha } from "../../platform";
import { type MeshShading, type ViewportBackdrop } from "./viewportTypes";

function shadeHex(hex: string, factor: number, alpha = 1): string {
  const { rgb, alpha: fa } = splitHexAlpha(hex || "#888888");
  const n = parseInt(rgb.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `rgba(${clamp(r * factor)}, ${clamp(g * factor)}, ${clamp(b * factor)}, ${(alpha * fa).toFixed(3)})`;
}

export function paintBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number, backdrop: ViewportBackdrop) {
  if (backdrop === "default") {
    // Neutral viewport gray that follows the app's light/dark appearance (the CSS "canvas"
    // keyword resolves to plain white inside a 2D context, which read as a white panel).
    const dark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    ctx.fillStyle = dark ? "rgb(58,58,60)" : "rgb(222,222,224)";
    ctx.fillRect(0, 0, width, height);
    return;
  }
  if (backdrop === "dark") {
    ctx.fillStyle = "rgb(20,20,20)";
    ctx.fillRect(0, 0, width, height);
    return;
  }
  if (backdrop === "midGray") {
    ctx.fillStyle = "rgb(107,107,107)";
    ctx.fillRect(0, 0, width, height);
    return;
  }
  if (backdrop === "light") {
    ctx.fillStyle = "rgb(235,235,235)";
    ctx.fillRect(0, 0, width, height);
    return;
  }
  const cell = Math.min(width, height) / 8;
  for (let row = 0; row * cell < height; row++) {
    for (let col = 0; col * cell < width; col++) {
      ctx.fillStyle = (row + col) % 2 === 0 ? "rgb(184,184,184)" : "rgb(122,122,122)";
      ctx.fillRect(col * cell, row * cell, cell + 0.5, cell + 0.5);
    }
  }
}

export interface DrawPart {
  id: string;
  hex: string;
  positions: number[];
  indices: number[];
  selected: boolean;
}

export function projectScene(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  camera: CameraState,
  parts: DrawPart[],
  shading: MeshShading,
  keyIntensity: number,
  fillIntensity: number,
  ambientIntensity: number,
  bounds: Bounds | null,
  pixelScale = 1
) {
  const glCanvas = renderViewportGL({
    width: Math.max(1, Math.round(width * pixelScale)),
    height: Math.max(1, Math.round(height * pixelScale)),
    camera,
    bounds,
    parts: parts.map((p) => ({ hex: p.hex, positions: p.positions, indices: p.indices, selected: p.selected })),
    shading,
    keyIntensity,
    fillIntensity,
    ambientIntensity,
  });
  if (glCanvas) {
    ctx.drawImage(glCanvas, 0, 0, width, height);
    return;
  }
  projectScene2D(ctx, width, height, camera, parts, shading, keyIntensity, fillIntensity, ambientIntensity, bounds);
}

/** Legacy Canvas2D painter, used only when WebGL is unavailable. */
function projectScene2D(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  camera: CameraState,
  parts: DrawPart[],
  shading: MeshShading,
  keyIntensity: number,
  fillIntensity: number,
  ambientIntensity: number,
  bounds: Bounds | null
) {
  const view = framed(bounds, camera.direction, BASE_MARGIN * camera.zoom, 32, camera.up);
  const target = [
    view.target[0] + camera.pan[0],
    view.target[1] + camera.pan[1],
    view.target[2] + camera.pan[2],
  ] as Vec3;
  const position = [
    view.position[0] + camera.pan[0],
    view.position[1] + camera.pan[1],
    view.position[2] + camera.pan[2],
  ] as Vec3;
  const forward = normalize(sub(position, target));
  const basis = lookAtBasis(forward, camera.up);
  const half = (32 * Math.PI) / 360;
  const focal = height / 2 / Math.tan(half);
  const light = normalize(camera.light);
  const key = keyIntensity / 900;
  const fill = fillIntensity / 350;
  const ambient = ambientIntensity / 280;

  interface Tri {
    x0: number; y0: number; x1: number; y1: number; x2: number; y2: number;
    depth: number; fill: string; selected: boolean;
  }
  const tris: Tri[] = [];
  for (const part of parts) {
    const pos = part.positions;
    const ind = part.indices;
    const count = Math.floor(ind.length / 3);
    for (let t = 0; t < count; t++) {
      const i0 = ind[t * 3] * 3;
      const i1 = ind[t * 3 + 1] * 3;
      const i2 = ind[t * 3 + 2] * 3;
      if (i2 + 2 >= pos.length) continue;
      const p0: Vec3 = [pos[i0], pos[i0 + 1], pos[i0 + 2]];
      const p1: Vec3 = [pos[i1], pos[i1 + 1], pos[i1 + 2]];
      const p2: Vec3 = [pos[i2], pos[i2 + 1], pos[i2 + 2]];
      const e1 = sub(p1, p0);
      const e2 = sub(p2, p0);
      const n = normalize([
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ]);
      const ndot = Math.max(0, dot(n, light));
      const viewDot = Math.abs(dot(n, forward));
      let shade = ambient * 0.34 + fill * 0.22 + key * (0.18 + 0.85 * ndot);
      if (shading === "depth") shade = shade * 0.72 + (1 - viewDot) * 0.45;
      if (shading === "cel") {
        const band = ndot > 0.72 ? 1 : ndot > 0.38 ? 0.72 : 0.42;
        shade = ambient * 0.2 + band * key;
        if (viewDot < 0.18) shade += 0.35;
      }
      const proj = (p: Vec3): [number, number, number] => {
        const rel = sub(p, target);
        const cx = dot(rel, basis.right);
        const cy = dot(rel, basis.up);
        const cz = Math.max(0.05, dot(sub(position, p), forward));
        return [width / 2 + (cx * focal) / cz, height / 2 - (cy * focal) / cz, cz];
      };
      const a = proj(p0);
      const b = proj(p1);
      const c = proj(p2);
      tris.push({
        x0: a[0], y0: a[1], x1: b[0], y1: b[1], x2: c[0], y2: c[1],
        depth: (a[2] + b[2] + c[2]) / 3,
        fill: shadeHex(part.hex, shade),
        selected: part.selected,
      });
    }
  }
  tris.sort((a, b) => b.depth - a.depth);
  for (const tri of tris) {
    ctx.beginPath();
    ctx.moveTo(tri.x0, tri.y0);
    ctx.lineTo(tri.x1, tri.y1);
    ctx.lineTo(tri.x2, tri.y2);
    ctx.closePath();
    ctx.fillStyle = tri.fill;
    ctx.fill();
    ctx.strokeStyle = tri.fill;
    ctx.lineWidth = 0.6;
    ctx.stroke();
    if (tri.selected) {
      ctx.strokeStyle = "rgba(0, 122, 255, 0.9)";
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }
  }
  return { distance: view.distance, bounds };
}

export function drawGuides(ctx: CanvasRenderingContext2D, width: number, height: number, showGrid: boolean, darkLines: boolean) {
  const side = Math.min(width, height);
  const x0 = (width - side) / 2;
  const y0 = (height - side) / 2;
  ctx.save();
  if (showGrid) {
    ctx.beginPath();
    for (let i = 1; i < 8; i++) {
      const t = i / 8;
      ctx.moveTo(x0 + t * side, y0);
      ctx.lineTo(x0 + t * side, y0 + side);
      ctx.moveTo(x0, y0 + t * side);
      ctx.lineTo(x0 + side, y0 + t * side);
    }
    ctx.strokeStyle = darkLines ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.35)";
    ctx.stroke();
  }
  ctx.restore();
}

/** Ray-picks the nearest visible part under a canvas point, using the same camera math as
 *  renderViewportGL (bounding-sphere fit, 32° vertical FOV). Returns the part id or null. */
export function pickPartAt(opts: {
  x: number;
  y: number;
  width: number;
  height: number;
  camera: CameraState;
  bounds: Bounds | null;
  parts: Array<{ id: string; positions: ArrayLike<number>; indices: ArrayLike<number> }>;
}): string | null {
  const { x, y, width, height, camera, bounds } = opts;
  if (!bounds || width < 1 || height < 1) return null;
  const aspect = width / Math.max(1, height);
  const halfV = (32 * Math.PI) / 360;
  const halfMin = aspect >= 1 ? halfV : Math.atan(Math.tan(halfV) * aspect);
  const center: Vec3 = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
  const ext = sub(bounds.max, bounds.min);
  const radius = Math.max(1e-3, Math.hypot(ext[0], ext[1], ext[2]) * 0.5);
  const fitDist = (radius * BASE_MARGIN * camera.zoom) / Math.sin(halfMin);
  const f = normalize(camera.direction);
  const target: Vec3 = [center[0] + camera.pan[0], center[1] + camera.pan[1], center[2] + camera.pan[2]];
  const eye: Vec3 = [target[0] + f[0] * fitDist, target[1] + f[1] * fitDist, target[2] + f[2] * fitDist];
  const basis = lookAtBasis(f, camera.up);
  const t = Math.tan(halfV);
  const nx = ((2 * x) / width - 1) * aspect * t;
  const ny = (1 - (2 * y) / height) * t;
  const dir = normalize([
    basis.right[0] * nx + basis.up[0] * ny - f[0],
    basis.right[1] * nx + basis.up[1] * ny - f[1],
    basis.right[2] * nx + basis.up[2] * ny - f[2],
  ]);
  let best = Infinity;
  let bestId: string | null = null;
  for (const part of opts.parts) {
    const pos = part.positions;
    const ind = part.indices;
    const n = Math.floor(ind.length / 3);
    for (let k = 0; k < n; k++) {
      const a = ind[k * 3] * 3, b = ind[k * 3 + 1] * 3, c = ind[k * 3 + 2] * 3;
      if (c + 2 >= pos.length || a + 2 >= pos.length || b + 2 >= pos.length) continue;
      // Möller–Trumbore, double-sided.
      const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      const px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const tx = eye[0] - pos[a], ty = eye[1] - pos[a + 1], tz = eye[2] - pos[a + 2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (dist > 1e-6 && dist < best) {
        best = dist;
        bestId = part.id;
      }
    }
  }
  return bestId;
}

/** Resolves after the next paint, so long work split across awaits lets the window update. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "undefined") { setTimeout(resolve, 0); return; }
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}
