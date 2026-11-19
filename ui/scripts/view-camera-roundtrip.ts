// Round-trip check for website view_camera <-> order camera.
// Run: npx --no-install esbuild scripts/view-camera-roundtrip.ts --bundle --platform=node --log-level=error --outfile=/tmp/vc.cjs && node /tmp/vc.cjs
import {
  OrderModel,
  orderCameraFromViewCameraWithModel,
  viewCameraFromOrderCamera,
  viewCameraProblem,
} from "../src/components/OrderViewport3D";
import { CameraState, THREE_QUARTER, normalize } from "../src/viewportCamera";

let failures = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) { failures++; console.error("FAIL", msg); } else console.log("ok  ", msg); };
const near = (a: number[], b: number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

// Off-center, non-cubic model (mm, Z-up), like a catalog part.
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
  const p: number[] = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) p.push(x, y, z);
  return p;
};
const model: OrderModel = {
  productId: "test",
  parts: [
    { id: "a", name: "A", positions: box(10, 20, 0, 50, 35, 80), indices: [0, 1, 2], visible: true, selectable: true, defaultHex: "#ff0000" },
    { id: "b", name: "B", positions: box(-500, -500, -500, 500, 500, 500), indices: [0, 1, 2], visible: false, selectable: false, defaultHex: "#00ff00" },
  ],
  defaultCamera: { direction: THREE_QUARTER, up: [0, 0, 1], zoom: 1, pan: [0, 0, 0], light: [0.3, -0.4, 0.8] },
  lights: { key: 900, fill: 350, ambient: 280 },
  missingMeshes: [],
};

const cams: CameraState[] = [
  { direction: THREE_QUARTER, up: [0, 0, 1], zoom: 1, pan: [0, 0, 0], light: [0, 0, 1] },
  { direction: normalize([-0.3, 0.8, 0.2]), up: [0, 0, 1], zoom: 1.7, pan: [4, -2, 6], light: [0, 0, 1] },
  { direction: normalize([0.2, -0.1, -0.9]), up: [0, 0, 1], zoom: 0.6, pan: [-3, 0, 1.5], light: [0, 0, 1] },
];
for (const [i, cam] of cams.entries()) {
  for (const fov of [32, 45, 20]) {
    const vc = viewCameraFromOrderCamera(model, cam, fov)!;
    ok(viewCameraProblem(vc) === null, `cam${i} fov${fov}: view_camera valid`);
    const back = orderCameraFromViewCameraWithModel(model, vc)!;
    ok(near(back.direction, cam.direction), `cam${i} fov${fov}: direction round-trips`);
    ok(Math.abs(back.zoom - cam.zoom) < 1e-6, `cam${i} fov${fov}: zoom round-trips (${back.zoom.toFixed(4)})`);
    ok(near(back.pan, cam.pan), `cam${i} fov${fov}: pan round-trips`);
    ok(near(back.light, model.defaultCamera.light), `cam${i} fov${fov}: light = product default`);
    ok(Math.abs(back.up[2]) > 0 && Math.abs(back.up.reduce((s, v, k) => s + v * back.direction[k], 0)) < 1e-9, `cam${i} fov${fov}: up is Z-up, square to direction`);
  }
}
// Hidden part B must not affect centering: target of a zero-pan camera = visible bounds center.
const vc0 = viewCameraFromOrderCamera(model, cams[0])!;
ok(near(vc0.target, [30, 27.5, 40]), "zero pan targets the visible-part center");
// Rejections.
for (const [label, bad] of [
  ["missing", null], ["NaN", { position: [NaN, 0, 0], target: [0, 0, 0], fov: 32 }],
  ["zero-length", { position: [1, 2, 3], target: [1, 2, 3], fov: 32 }], ["bad fov", { position: [0, 0, 100], target: [0, 0, 0], fov: 0 }],
  ["short array", { position: [0, 0], target: [0, 0, 0], fov: 32 }],
] as const) {
  ok(orderCameraFromViewCameraWithModel(model, bad) === null, `rejects ${label}`);
}
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("all view_camera checks passed");
