import { splitHexAlpha } from "./platform";
/**
 * Shared WebGL mesh renderer for the Product Editor viewport, part orbit icons
 * and baked thumbnails. Replaces the old Canvas2D per-triangle painter, whose
 * antialiased seams between flat-filled triangles showed up as mesh lines.
 *
 * One offscreen WebGL canvas (MSAA, depth buffer, preserveDrawingBuffer) is shared
 * by every caller. Callers draw it into their own 2D canvas or call toDataURL.
 * GPU buffers are cached per mesh array and rebuilt only after context loss.
 */
import { BASE_MARGIN, Bounds, CameraState, Vec3, lookAtBasis, normalize, sub, vlen } from "./viewportCamera";

export type GLShading = "standard" | "depth" | "cel";

export interface PreparedMesh {
  positions: Float32Array; // expanded, 3 per corner
  normals: Float32Array; // smooth with crease split
  vertexCount: number;
}

const CREASE_DEGREES = 35;
// Swift NormalSolver has no per-corner cone: within a smoothing group every face shares one
// normal per vertex (C0-continuous shading). A per-corner cone broke that continuity and drew
// sawtooth teeth along coarse fillets, so it is disabled (180 = whole group).
const CORNER_CONE_DEGREES = 180;

/** Welds coincident positions, then averages face normals within the crease angle per corner. */
export function prepareMesh(
  positions: ArrayLike<number>,
  indices?: ArrayLike<number> | null,
  creaseDeg = CREASE_DEGREES
): PreparedMesh {
  const vtxCount = Math.floor(positions.length / 3);
  const idx: ArrayLike<number> =
    indices && indices.length >= 3 ? indices : Uint32Array.from({ length: vtxCount }, (_, i) => i);
  const triCount = Math.floor(idx.length / 3);

  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  const span = Math.max(1e-6, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ));
  const q = 1 / (span * 1e-5);

  // Weld: source vertex -> welded id. Numeric hash of the quantized corner (chained on
  // collision, compared exactly), not "x,y,z" string keys: no per-corner string allocations.
  const weldOf = new Int32Array(vtxCount);
  const qx = new Float64Array(vtxCount), qy = new Float64Array(vtxCount), qz = new Float64Array(vtxCount);
  const head = new Map<number, number>(); // hash -> first welded id in its chain
  const next = new Int32Array(vtxCount).fill(-1); // welded id -> next welded id with the same hash
  let welded = 0;
  for (let v = 0; v < vtxCount; v++) {
    const x = Math.round(positions[v * 3] * q), y = Math.round(positions[v * 3 + 1] * q), z = Math.round(positions[v * 3 + 2] * q);
    const h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) | 0;
    let id = head.get(h);
    let found = -1;
    while (id !== undefined && id >= 0) {
      if (qx[id] === x && qy[id] === y && qz[id] === z) { found = id; break; }
      id = next[id];
    }
    if (found < 0) {
      found = welded++;
      qx[found] = x; qy[found] = y; qz[found] = z;
      const first = head.get(h);
      next[found] = first === undefined ? -1 : first;
      head.set(h, found);
    }
    weldOf[v] = found;
  }

  // Face unit normals and corner angles. Degenerate (zero-area / sliver-collapsed) triangles are skipped.
  const fu = new Float32Array(triCount * 3);
  const fa = new Float32Array(triCount);
  const ang = new Float32Array(triCount * 3);
  const valid = new Uint8Array(triCount);
  const minArea2 = span * span * 1e-14;
  for (let t = 0; t < triCount; t++) {
    const ia = idx[t * 3], ib = idx[t * 3 + 1], ic = idx[t * 3 + 2];
    if (ia >= vtxCount || ib >= vtxCount || ic >= vtxCount) continue;
    if (weldOf[ia] === weldOf[ib] || weldOf[ib] === weldOf[ic] || weldOf[ia] === weldOf[ic]) continue;
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const wx = positions[c] - positions[a], wy = positions[c + 1] - positions[a + 1], wz = positions[c + 2] - positions[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > minArea2)) continue;
    valid[t] = 1;
    fu[t * 3] = nx / len; fu[t * 3 + 1] = ny / len; fu[t * 3 + 2] = nz / len;
    fa[t] = len * 0.5;
    // Corner angles (Thürmer–Wüthrich weights: independent of how a surface is triangulated).
    const corner = (p0: number, p1: number, p2: number) => {
      const e1x = positions[p1] - positions[p0], e1y = positions[p1 + 1] - positions[p0 + 1], e1z = positions[p1 + 2] - positions[p0 + 2];
      const e2x = positions[p2] - positions[p0], e2y = positions[p2 + 1] - positions[p0 + 1], e2z = positions[p2 + 2] - positions[p0 + 2];
      const l = Math.hypot(e1x, e1y, e1z) * Math.hypot(e2x, e2y, e2z);
      if (l <= 0) return 0;
      return Math.acos(Math.max(-1, Math.min(1, (e1x * e2x + e1y * e2y + e1z * e2z) / l)));
    };
    ang[t * 3] = corner(a, b, c);
    ang[t * 3 + 1] = corner(b, c, a);
    ang[t * 3 + 2] = corner(c, a, b);
  }

  // Adjacency: welded vertex -> faces (CSR).
  const counts = new Int32Array(welded + 1);
  for (let t = 0; t < triCount; t++) {
    if (!valid[t]) continue;
    for (let k = 0; k < 3; k++) counts[weldOf[idx[t * 3 + k]] + 1]++;
  }
  for (let i = 0; i < welded; i++) counts[i + 1] += counts[i];
  const fill = counts.slice(0, welded);
  const faces = new Int32Array(counts[welded]);
  const slot = new Int8Array(counts[welded]);
  for (let t = 0; t < triCount; t++) {
    if (!valid[t]) continue;
    for (let k = 0; k < 3; k++) { const at = fill[weldOf[idx[t * 3 + k]]]++; faces[at] = t; slot[at] = k; }
  }

  // Smoothing groups per welded vertex: faces around the vertex are joined only through shared
  // edges whose dihedral angle is under the crease limit. Every face in a group gets the SAME
  // corner normal, so shading is continuous across edges. (Testing each face's own cone instead
  // gave neighbouring faces different normals at one vertex: the sawtooth streaks on fillets.)
  const cosLimit = Math.cos((creaseDeg * Math.PI) / 180);
  // Per-face-corner cone, kept for experiments only: CORNER_CONE_DEGREES is 180 (disabled, see
  // the note at its definition), so every face in a smoothing group averages together.
  const cT = Math.cos((CORNER_CONE_DEGREES * Math.PI) / 180);
  const cornerN = new Float32Array(triCount * 9);
  const localParent: number[] = [];
  const lfind = (x: number): number => { while (localParent[x] !== x) { localParent[x] = localParent[localParent[x]]; x = localParent[x]; } return x; };
  for (let w = 0; w < welded; w++) {
    const s0 = counts[w], m = counts[w + 1] - s0;
    if (m === 0) continue;
    localParent.length = m;
    for (let i = 0; i < m; i++) localParent[i] = i;
    for (let i = 0; i < m; i++) {
      const f = faces[s0 + i];
      const f1 = weldOf[idx[f * 3 + ((slot[s0 + i] + 1) % 3)]], f2 = weldOf[idx[f * 3 + ((slot[s0 + i] + 2) % 3)]];
      for (let j = i + 1; j < m; j++) {
        const g = faces[s0 + j];
        const g1 = weldOf[idx[g * 3 + ((slot[s0 + j] + 1) % 3)]], g2 = weldOf[idx[g * 3 + ((slot[s0 + j] + 2) % 3)]];
        if (f1 !== g1 && f1 !== g2 && f2 !== g1 && f2 !== g2) continue; // no shared edge
        if (fu[f * 3] * fu[g * 3] + fu[f * 3 + 1] * fu[g * 3 + 1] + fu[f * 3 + 2] * fu[g * 3 + 2] < cosLimit) continue;
        const ri = lfind(i), rj = lfind(j);
        if (ri !== rj) localParent[ri] = rj;
      }
    }
    // Per corner: area x angle weighted average (as NormalSolver.swift) over faces in this group within the corner cone.
    for (let i = 0; i < m; i++) {
      const f = faces[s0 + i], r = lfind(i);
      let x = 0, y = 0, z = 0;
      for (let j = 0; j < m; j++) {
        if (lfind(j) !== r) continue;
        const g = faces[s0 + j];
        if (fu[f * 3] * fu[g * 3] + fu[f * 3 + 1] * fu[g * 3 + 1] + fu[f * 3 + 2] * fu[g * 3 + 2] < cT) continue;
        const wt = ang[g * 3 + slot[s0 + j]] * fa[g];
        x += fu[g * 3] * wt; y += fu[g * 3 + 1] * wt; z += fu[g * 3 + 2] * wt;
      }
      if (x * fu[f * 3] + y * fu[f * 3 + 1] + z * fu[f * 3 + 2] <= 0) { x = fu[f * 3]; y = fu[f * 3 + 1]; z = fu[f * 3 + 2]; }
      const l = Math.hypot(x, y, z) || 1;
      const o = f * 9 + slot[s0 + i] * 3;
      cornerN[o] = x / l; cornerN[o + 1] = y / l; cornerN[o + 2] = z / l;
    }
  }

  let validCount = 0;
  for (let t = 0; t < triCount; t++) validCount += valid[t];
  const outP = new Float32Array(validCount * 9);
  const outN = new Float32Array(validCount * 9);
  let o = 0;
  for (let t = 0; t < triCount; t++) {
    if (!valid[t]) continue;
    for (let k = 0; k < 3; k++) {
      const src = idx[t * 3 + k];
      outP[o] = positions[src * 3]; outP[o + 1] = positions[src * 3 + 1]; outP[o + 2] = positions[src * 3 + 2];
      outN[o] = cornerN[t * 9 + k * 3]; outN[o + 1] = cornerN[t * 9 + k * 3 + 1]; outN[o + 2] = cornerN[t * 9 + k * 3 + 2];
      o += 3;
    }
  }
  return { positions: outP, normals: outN, vertexCount: validCount * 3 };
}

// ---- Cache --------------------------------------------------------------------

interface CacheEntry {
  prepared: PreparedMesh;
  gen: number;
  pos: WebGLBuffer | null;
  nrm: WebGLBuffer | null;
}
const NO_INDICES = {};
const meshCache = new WeakMap<object, WeakMap<object, CacheEntry>>();

function entryFor(positions: ArrayLike<number>, indices?: ArrayLike<number> | null): CacheEntry {
  const pKey = positions as unknown as object;
  const iKey = (indices && indices.length >= 3 ? indices : NO_INDICES) as object;
  let inner = meshCache.get(pKey);
  if (!inner) { inner = new WeakMap(); meshCache.set(pKey, inner); }
  let e = inner.get(iKey);
  if (!e) {
    e = { prepared: prepareMesh(positions, indices), gen: -1, pos: null, nrm: null };
    inner.set(iKey, e);
  }
  return e;
}

// ---- GL context -----------------------------------------------------------------

const VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
uniform mat4 uMVP;
varying vec3 vN;
varying vec3 vP;
void main() {
  vN = aNrm;
  vP = aPos;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const FS = `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#define FP_DERIV 1
#endif
precision highp float;
varying vec3 vN;
varying vec3 vP;
uniform vec3 uColor;
uniform vec3 uLight;
uniform vec3 uEye;
uniform vec3 uViewDir;
uniform float uOrtho;
uniform float uStyle;   // 0 standard, 1 depth, 2 cel, 3 thumbnail
uniform vec3 uKFA;      // key, fill, ambient (already scaled)
uniform float uGain;
uniform float uDark;
uniform float uSelected;
uniform float uAlpha;   // filament opacity (1 = solid)
void main() {
  vec3 n = normalize(vN);
  vec3 V = uOrtho > 0.5 ? normalize(uViewDir) : normalize(uEye - vP);
#ifdef FP_DERIV
  // Two-sided lighting decided per face from the true geometric normal, not the interpolated
  // smooth normal (which flips mid-triangle near grazing angles and draws jagged dark streaks).
  vec3 ng = cross(dFdx(vP), dFdy(vP));
  float ngl = length(ng);
  if (ngl > 0.0) {
    ng /= ngl;
    if (dot(ng, V) < 0.0) ng = -ng;
    if (dot(n, ng) < 0.0) n = -n;
  } else if (dot(n, V) < 0.0) n = -n;
#else
  if (dot(n, V) < 0.0) n = -n;
#endif
  vec3 L = normalize(uLight);
  float ndot = max(0.0, dot(n, L));
  float viewDot = abs(dot(n, V));
  vec3 H = normalize(L + V);
  float shade;
  vec3 spec = vec3(0.0);
  if (uStyle > 2.5) {
    float nd = abs(dot(n, L));
    shade = (0.38 + 0.64 * nd) * uGain;
    spec = vec3(uDark * (56.0 / 255.0) * pow(nd, 2.6) + 0.05 * pow(max(dot(n, H), 0.0), 48.0));
  } else {
    float key = uKFA.x, fill = uKFA.y, amb = uKFA.z;
    if (uStyle < 0.5) {
      // Port of the Swift viewport material (AssemblyDocument: SceneKit .blinn, diffuse = ambient
      // = part color, specular white 0.22, shininess 0.25, double-sided) lit by the Thumbnail
      // Creator rig: key 900 + fill 350 directional, ambient 280 (SceneKit 1000 = 1.0), with the
      // fill aimed at normalize(-0.55*L + (0.2,0.3,0.4)). SceneKit shades in linear space and
      // outputs sRGB, so the part color is linearized first and encoded at the end.
      vec3 albedo = pow(uColor, vec3(2.2));
      vec3 Lf = normalize(L * -0.55 + vec3(0.2, 0.3, 0.4));
      float kI = 0.9 * key, fI = 0.35 * fill, aI = 0.28 * amb;
      float dK = max(dot(n, L), 0.0), dF = max(dot(n, Lf), 0.0);
      vec3 Hf = normalize(Lf + V);
      float sK = dK > 0.0 ? pow(max(dot(n, H), 0.0), 32.0) : 0.0;
      float sF = dF > 0.0 ? pow(max(dot(n, Hf), 0.0), 32.0) : 0.0;
      vec3 linC = albedo * (aI + kI * dK + fI * dF) + vec3(0.22) * (kI * sK + fI * sF);
      vec3 srgb = pow(clamp(linC, 0.0, 1.0), vec3(1.0 / 2.2));
      if (uSelected > 0.5) {
        float rim = pow(1.0 - viewDot, 2.0);
        srgb = mix(srgb, vec3(0.0, 0.48, 1.0), clamp(rim * 0.85, 0.0, 0.75));
      }
      if (uAlpha < 0.999) {
        // Translucent filament: fresnel keeps silhouettes readable, highlights stay bright.
        float fres = pow(1.0 - viewDot, 3.0);
        float hl = clamp(0.22 * (kI * sK + fI * sF), 0.0, 1.0);
        srgb = clamp(srgb + vec3(fres * 0.18), 0.0, 1.0);
        float a = clamp(mix(uAlpha, 1.0, fres * 0.55) + hl * 0.6, uAlpha, 1.0);
        gl_FragColor = vec4(srgb * a, a);
        return;
      }
      gl_FragColor = vec4(srgb, 1.0);
      return;
    }
    shade = amb * 0.34 + fill * 0.22 + key * (0.18 + 0.85 * ndot);
    if (uStyle > 0.5 && uStyle < 1.5) shade = shade * 0.72 + (1.0 - viewDot) * 0.45;
    if (uStyle > 1.5) {
      float band = ndot > 0.72 ? 1.0 : (ndot > 0.38 ? 0.72 : 0.42);
      shade = amb * 0.2 + band * key;
      if (viewDot < 0.18) shade += 0.35;
    }
  }
  // Soft-knee tone map instead of a hard clamp.
  vec3 lin = max(uColor * shade + spec, vec3(0.0));
  vec3 over = max(lin - vec3(0.7), vec3(0.0));
  vec3 c = min(lin, vec3(0.7)) + 0.3 * (vec3(1.0) - exp(-over / 0.3));
  if (uSelected > 0.5) {
    float rim = pow(1.0 - viewDot, 2.0);
    c = mix(c, vec3(0.0, 0.48, 1.0), clamp(rim * 0.85, 0.0, 0.75));
  }
  if (uAlpha < 0.999) {
    float fres = pow(1.0 - viewDot, 3.0);
    float hl = clamp(0.6 * pow(max(dot(n, H), 0.0), 48.0), 0.0, 1.0);
    c = clamp(c + vec3(fres * 0.18 + hl * 0.25), 0.0, 1.0);
    float a = clamp(mix(uAlpha, 1.0, fres * 0.55) + hl * 0.5, uAlpha, 1.0);
    gl_FragColor = vec4(c * a, a); // premultiplied; un-premultiplied on readback
    return;
  }
  gl_FragColor = vec4(c, 1.0);
}`;

interface GLState {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  prog: WebGLProgram;
  aPos: number;
  aNrm: number;
  u: Record<string, WebGLUniformLocation | null>;
  gen: number;
  lost: boolean;
}

let state: GLState | null = null;
let unavailable = false;
let generation = 0;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn("meshRendererGL shader:", gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}

function initProgram(st: Omit<GLState, "prog" | "aPos" | "aNrm" | "u" | "gen"> & Partial<GLState>): boolean {
  const gl = st.gl as WebGLRenderingContext;
  const isGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  let vsSrc = VS, fsSrc = FS;
  if (isGL2) {
    // GLSL ES 3.00: derivatives are core.
    vsSrc = "#version 300 es\n" + VS.replace(/attribute /g, "in ").replace(/varying /g, "out ");
    fsSrc = "#version 300 es\n#define FP_DERIV 1\n" +
      FS.replace(/#ifdef GL_OES_standard_derivatives\n[\s\S]*?#endif\n/, "")
        .replace(/varying /g, "in ")
        .replace("void main() {", "out vec4 fpColor;\nvoid main() {")
        .replace(/gl_FragColor/g, "fpColor");
  } else {
    gl.getExtension("OES_standard_derivatives");
  }
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc.trim().startsWith("#version") ? vsSrc.trim() : vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc.trim().startsWith("#version") ? fsSrc.trim() : fsSrc);
  if (!vs || !fs) return false;
  const prog = gl.createProgram();
  if (!prog) return false;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
  st.prog = prog;
  st.aPos = gl.getAttribLocation(prog, "aPos");
  st.aNrm = gl.getAttribLocation(prog, "aNrm");
  st.u = {};
  for (const name of ["uMVP", "uColor", "uLight", "uEye", "uViewDir", "uOrtho", "uStyle", "uKFA", "uGain", "uDark", "uSelected", "uAlpha"]) {
    st.u[name] = gl.getUniformLocation(prog, name);
  }
  st.gen = ++generation;
  return true;
}

function getState(): GLState | null {
  if (unavailable) return null;
  if (state && !state.lost) return state;
  if (state && state.lost) return null; // wait for restore
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  // WebGL2 guarantees a 24-bit depth buffer; WebGL1 may give 16-bit, so it is only a fallback.
  const attrs: WebGLContextAttributes = { antialias: true, depth: true, stencil: false, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: "high-performance" };
  const gl = (canvas.getContext("webgl2", attrs) || canvas.getContext("webgl", attrs)) as WebGLRenderingContext | null;
  if (!gl) { unavailable = true; return null; }
  const st = { canvas, gl, lost: false } as GLState;
  if (!initProgram(st)) { unavailable = true; return null; }
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); st.lost = true; }, false);
  canvas.addEventListener("webglcontextrestored", () => {
    st.lost = !initProgram(st);
    for (const l of restoreListeners) l();
  }, false);
  state = st;
  return st;
}

const restoreListeners = new Set<() => void>();
/** Called after a lost WebGL context comes back, so live views can redraw. */
export function onGLRestored(cb: () => void): () => void {
  restoreListeners.add(cb);
  return () => restoreListeners.delete(cb);
}

// ---- Math -------------------------------------------------------------------------

type Mat4 = Float32Array; // column-major

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

// ---- Drawing ---------------------------------------------------------------------

export interface GLPart {
  hex: string;
  positions: ArrayLike<number>;
  indices?: ArrayLike<number> | null;
  selected?: boolean;
}

function hexRGB(hex: string): [number, number, number] {
  const { rgb } = splitHexAlpha(hex || "#888888");
  const n = parseInt(rgb.slice(1), 16);
  if (!hex || isNaN(n)) return [136, 136, 136];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hexAlpha(hex: string): number {
  return splitHexAlpha(hex || "").alpha;
}

/** True when any part uses a see-through (#RRGGBBAA, AA<FF) filament. */
export function partsHaveTranslucency(parts: GLPart[]): boolean {
  return parts.some((p) => hexAlpha(p.hex) < 0.999);
}

interface DrawParams {
  width: number;
  height: number;
  mvp: Mat4;
  light: Vec3;
  eye: Vec3;
  viewDir: Vec3;
  ortho: boolean;
  style: number;
  kfa: [number, number, number];
  gain: number;
  thumbColors: boolean;
}

/**
 * The GL buffer holds premultiplied color once translucent parts are blended in, but the
 * context is non-premultiplied. Copy it out un-premultiplied so edges don't go dark.
 */
let unpremulCanvas: HTMLCanvasElement | null = null;
// Reused between frames (live orbiting with a see-through filament reads back every frame).
let readbackPx: Uint8Array | null = null;
let readbackImg: ImageData | null = null;
function outputCanvas(st: GLState, translucent: boolean): HTMLCanvasElement {
  if (!translucent) return st.canvas;
  const gl = st.gl as WebGLRenderingContext;
  const w = st.canvas.width, h = st.canvas.height;
  if (!readbackPx || readbackPx.length !== w * h * 4) readbackPx = new Uint8Array(w * h * 4);
  const px = readbackPx;
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = unpremulCanvas || (unpremulCanvas = document.createElement("canvas"));
  if (out.width !== w) out.width = w;
  if (out.height !== h) out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) return st.canvas;
  if (!readbackImg || readbackImg.width !== w || readbackImg.height !== h) readbackImg = ctx.createImageData(w, h);
  const img = readbackImg;
  const d = img.data;
  d.fill(0); // fully transparent pixels are skipped below, so clear last frame's
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * row, dst = y * row;
    for (let i = 0; i < row; i += 4) {
      const a = px[src + i + 3];
      if (a === 0) continue;
      if (a === 255) { d[dst + i] = px[src + i]; d[dst + i + 1] = px[src + i + 1]; d[dst + i + 2] = px[src + i + 2]; d[dst + i + 3] = 255; continue; }
      const k = 255 / a;
      d[dst + i] = Math.min(255, px[src + i] * k);
      d[dst + i + 1] = Math.min(255, px[src + i + 1] * k);
      d[dst + i + 2] = Math.min(255, px[src + i + 2] * k);
      d[dst + i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function drawParts(st: GLState, parts: GLPart[], p: DrawParams): boolean {
  const gl = st.gl as WebGLRenderingContext;
  if (gl.isContextLost()) { st.lost = true; return false; }
  const w = Math.max(1, Math.round(p.width));
  const h = Math.max(1, Math.round(p.height));
  if (st.canvas.width !== w) st.canvas.width = w;
  if (st.canvas.height !== h) st.canvas.height = h;
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clearDepth(1);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.CULL_FACE);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(st.prog);
  const u = st.u;
  gl.uniformMatrix4fv(u.uMVP, false, p.mvp);
  gl.uniform3fv(u.uLight, p.light);
  gl.uniform3fv(u.uEye, p.eye);
  gl.uniform3fv(u.uViewDir, p.viewDir);
  gl.uniform1f(u.uOrtho, p.ortho ? 1 : 0);
  gl.uniform1f(u.uStyle, p.style);
  gl.uniform3fv(u.uKFA, p.kfa);
  gl.uniform1f(u.uGain, p.gain);
  const drawOne = (part: GLPart) => {
    if (!part.positions || part.positions.length < 9) return;
    const e = entryFor(part.positions, part.indices);
    if (e.prepared.vertexCount === 0) return;
    if (e.gen !== st.gen) {
      e.pos = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, e.pos);
      gl.bufferData(gl.ARRAY_BUFFER, e.prepared.positions, gl.STATIC_DRAW);
      e.nrm = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, e.nrm);
      gl.bufferData(gl.ARRAY_BUFFER, e.prepared.normals, gl.STATIC_DRAW);
      e.gen = st.gen;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, e.pos);
    gl.enableVertexAttribArray(st.aPos);
    gl.vertexAttribPointer(st.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, e.nrm);
    gl.enableVertexAttribArray(st.aNrm);
    gl.vertexAttribPointer(st.aNrm, 3, gl.FLOAT, false, 0, 0);
    let [r, g, b] = hexRGB(part.hex);
    let dark = 0;
    if (p.thumbColors) {
      dark = Math.max(r, g, b) < 76 ? 1 : 0;
      if (dark) { r = Math.max(42, r); g = Math.max(42, g); b = Math.max(46, b); }
    }
    gl.uniform3f(u.uColor, r / 255, g / 255, b / 255);
    gl.uniform1f(u.uDark, dark);
    gl.uniform1f(u.uSelected, part.selected ? 1 : 0);
    const alpha = hexAlpha(part.hex);
    gl.uniform1f(u.uAlpha, alpha);
    if (alpha < 0.999) {
      // Back faces first, then front faces, so a single translucent shell reads correctly.
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.FRONT);
      gl.drawArrays(gl.TRIANGLES, 0, e.prepared.vertexCount);
      gl.cullFace(gl.BACK);
      gl.drawArrays(gl.TRIANGLES, 0, e.prepared.vertexCount);
      gl.disable(gl.CULL_FACE);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, e.prepared.vertexCount);
    }
  };
  // Opaque first (depth write on), then translucent back-to-front with blending, depth write off.
  const opaque = parts.filter((pt) => hexAlpha(pt.hex) >= 0.999);
  const clear = parts.filter((pt) => hexAlpha(pt.hex) < 0.999);
  gl.disable(gl.BLEND);
  gl.depthMask(true);
  for (const part of opaque) drawOne(part);
  if (clear.length) {
    const m = p.mvp;
    const depthOf = (pt: GLPart): number => {
      const pos = pt.positions;
      let x = 0, y = 0, z = 0, n = 0;
      const step = Math.max(3, Math.floor(pos.length / 3 / 2000) * 3);
      for (let i = 0; i + 2 < pos.length; i += step) { x += pos[i]; y += pos[i + 1]; z += pos[i + 2]; n++; }
      if (!n) return 0;
      x /= n; y /= n; z /= n;
      const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      return Math.abs(cw) > 1e-9 ? cz / cw : cz;
    };
    const sorted = clear.map((pt) => ({ pt, d: depthOf(pt) })).sort((a, b) => b.d - a.d);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    for (const { pt } of sorted) drawOne(pt);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
  return true;
}

/**
 * Renders the viewport camera (same framed()/lookAtBasis/32° math as the old painter).
 * Returns the shared GL canvas (valid until the next render call) or null if WebGL is unavailable.
 */
export function renderViewportGL(opts: {
  width: number;
  height: number;
  camera: CameraState;
  bounds: Bounds | null;
  parts: GLPart[];
  shading: GLShading;
  keyIntensity: number;
  fillIntensity: number;
  ambientIntensity: number;
}): HTMLCanvasElement | null {
  const st = getState();
  if (!st) return null;
  const { width, height, camera, bounds } = opts;
  // Fit the bounding sphere into the smaller of the two field-of-view angles (the square
  // thumbnail crop when the viewport is wide), then apply the user's zoom.
  const aspect = width / Math.max(1, height);
  const halfV = (32 * Math.PI) / 360;
  const halfMin = aspect >= 1 ? halfV : Math.atan(Math.tan(halfV) * aspect);
  const center: Vec3 = bounds
    ? [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2]
    : [0, 0, 0];
  const radius = bounds ? Math.max(1e-3, vlen(sub(bounds.max, bounds.min)) * 0.5) : 5;
  const fitDist = (radius * BASE_MARGIN * camera.zoom) / Math.sin(halfMin);
  const fwd = normalize(camera.direction);
  const target: Vec3 = [center[0] + camera.pan[0], center[1] + camera.pan[1], center[2] + camera.pan[2]];
  const eye: Vec3 = [target[0] + fwd[0] * fitDist, target[1] + fwd[1] * fitDist, target[2] + fwd[2] * fitDist];
  const f = normalize(sub(eye, target));
  const basis = lookAtBasis(f, camera.up);
  const r = basis.right, up = basis.up;
  const viewM = new Float32Array([
    r[0], up[0], f[0], 0,
    r[1], up[1], f[1], 0,
    r[2], up[2], f[2], 0,
    -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]),
    -(up[0] * eye[0] + up[1] * eye[1] + up[2] * eye[2]),
    -(f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]),
    1,
  ]);
  // Tight clip planes around the bounding sphere keep depth precision high (no z-fighting).
  const dist = vlen(sub(eye, center));
  const near = Math.max(dist - radius * 1.02, radius * 0.01);
  const far = dist + radius * 1.02;
  const t = 1 / Math.tan(halfV);
  const proj = new Float32Array([
    t / aspect, 0, 0, 0,
    0, t, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);
  const style = opts.shading === "depth" ? 1 : opts.shading === "cel" ? 2 : 0;
  const ok = drawParts(st, opts.parts, {
    width, height, mvp: mul(proj, viewM), light: normalize(camera.light), eye, viewDir: f, ortho: false, style,
    kfa: [opts.keyIntensity / 900, opts.fillIntensity / 350, opts.ambientIntensity / 280], gain: 1, thumbColors: false,
  });
  return ok ? outputCanvas(st, partsHaveTranslucency(opts.parts)) : null;
}

/**
 * Bakes the yaw/pitch thumbnail projection used by renderPart/AssemblyThumbnailDataUrl.
 * Supersampled 2x then downscaled; transparent background. Returns "" if WebGL is unavailable.
 */
export function renderThumbnailGL(opts: {
  parts: GLPart[];
  size: number;
  yawDeg: number;
  pitchDeg: number;
  gain: number;
}): string {
  const st = getState();
  if (!st) return "";
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const part of opts.parts) {
    const pos = part.positions;
    for (let i = 0; i + 2 < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
  }
  if (!isFinite(minX)) return "";
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const span = Math.max(1e-3, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ));
  const size = opts.size;
  const scale = (size * 0.72) / span;
  const yaw = (opts.yawDeg * Math.PI) / 180, pitch = (opts.pitchDeg * Math.PI) / 180;
  const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  // rx = dx*cyw - dy*syw ; ry = dx*syw + dy*cyw ; sy = ry*sp - dz*cp ; sz = ry*cp + dz*sp
  const k = (2 * scale) / size;
  // rows: clipX = k*rx ; clipY = -(0.04 + k*sy) ; clipZ = -sz/span (nearer = larger sz)
  const rowX = [k * cyw, -k * syw, 0];
  const rowY = [-k * syw * sp, -k * cyw * sp, k * cp];
  const rowZ = [-(syw * cp) / span, -(cyw * cp) / span, -sp / span];
  const tr = (row: number[]) => -(row[0] * cx + row[1] * cy + row[2] * cz);
  const mvp = new Float32Array([
    rowX[0], rowY[0], rowZ[0], 0,
    rowX[1], rowY[1], rowZ[1], 0,
    rowX[2], rowY[2], rowZ[2], 0,
    tr(rowX), tr(rowY) - 0.04, tr(rowZ), 1,
  ]);
  // View direction (toward the viewer) in model space: gradient of sz.
  const viewDir: Vec3 = [syw * cp, cyw * cp, sp];
  const ss = size <= 1024 ? 2 : 1;
  const ok = drawParts(st, opts.parts, {
    width: size * ss, height: size * ss, mvp, light: normalize([0.52, -0.44, 0.73]), eye: [0, 0, 0], viewDir, ortho: true,
    style: 3, kfa: [1, 1, 1], gain: opts.gain, thumbColors: true,
  });
  if (!ok) return "";
  const src = outputCanvas(st, partsHaveTranslucency(opts.parts));
  if (ss === 1) return src.toDataURL("image/png");
  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const ctx = out.getContext("2d");
  if (!ctx) return src.toDataURL("image/png");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, size, size);
  return out.toDataURL("image/png");
}
