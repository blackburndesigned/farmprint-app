// prepareMesh / parseStl welding (numeric hash keys) behaves like exact corner matching.
import { prepareMesh } from "../../src/meshRendererGL";
import { meshToStlBase64, parseStl } from "../../src/productEditorSource";
import { check, done } from "./check";

// Unwelded cube (every triangle has its own corners, like STL).
const C = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const F = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
const soup: number[] = [];
for (const t of F) for (const v of t) soup.push(...C[v].map((c) => c * 20 + 100));

// Cube edges are 90°, over the crease limit: every corner normal stays axis-aligned.
const cube = prepareMesh(soup);
let axis = true;
for (let i = 0; i < cube.normals.length; i += 3) {
  const n = [Math.abs(cube.normals[i]), Math.abs(cube.normals[i + 1]), Math.abs(cube.normals[i + 2])];
  if (!(Math.max(...n) > 0.999)) axis = false;
}
check(cube.vertexCount === 36 && axis, "cube keeps flat, axis-aligned normals");

// Unwelded UV sphere: smooth normals only come out radial if corners were welded.
const R = 30, seg = 24, ring = 12;
const pt = (i: number, j: number) => {
  const th = (i / ring) * Math.PI, ph = (j / seg) * 2 * Math.PI;
  return [R * Math.sin(th) * Math.cos(ph), R * Math.sin(th) * Math.sin(ph), R * Math.cos(th)];
};
const sphere: number[] = [];
for (let i = 0; i < ring; i++) for (let j = 0; j < seg; j++) {
  const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
  if (i > 0) sphere.push(...a, ...b, ...d);
  if (i < ring - 1) sphere.push(...b, ...c, ...d);
}
const sm = prepareMesh(sphere);
let worst = 1;
for (let i = 0; i < sm.vertexCount; i++) {
  const p = [sm.positions[i * 3], sm.positions[i * 3 + 1], sm.positions[i * 3 + 2]];
  const len = Math.hypot(p[0], p[1], p[2]);
  const n = [sm.normals[i * 3], sm.normals[i * 3 + 1], sm.normals[i * 3 + 2]];
  const dotp = Math.abs((p[0] * n[0] + p[1] * n[1] + p[2] * n[2]) / len);
  worst = Math.min(worst, dotp);
}
check(worst > 0.97, `welded sphere has smooth radial normals (worst ${worst.toFixed(3)})`);

// STL round trip: 12 triangles back as 8 shared corners.
const b64 = meshToStlBase64(soup, Array.from({ length: 36 }, (_, i) => i));
const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
const parsed = parseStl(bin.buffer);
check(parsed.positions.length === 8 * 3 && parsed.indices.length === 36, "parseStl welds an STL cube to 8 corners");
// Trailing padding (some exporters) is accepted, like the Rust reader.
const padded = new Uint8Array(bin.length + 100);
padded.set(bin);
check(parseStl(padded.buffer).indices.length === 36, "parseStl accepts trailing padding");
done();
