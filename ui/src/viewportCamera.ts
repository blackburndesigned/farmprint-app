/** Product Editor camera. Ported from the Swift `ViewportCameraMath` and live viewport gestures. */

export type Vec3 = [number, number, number];

export type FramingPreset = "threeQuarter" | "front" | "top";

export interface CameraState {
  direction: Vec3;
  up: Vec3;
  zoom: number;
  pan: Vec3;
  light: Vec3;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

const WORLD_UP: Vec3 = [0, 0, 1];

export function vlen(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function normalize(v: Vec3): Vec3 {
  const n = vlen(v);
  if (n < 1e-8) return [0, 0, 1];
  return [v[0] / n, v[1] / n, v[2] / n];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export const THREE_QUARTER = normalize([1, -1.25, 0.85]);
export const FRONT = normalize([0, -1, 0.15]);
export const TOP = normalize([0.01, -0.01, 1]);
export const DEFAULT_LIGHT = normalize([0.6, -0.4, 0.7]);

export function presetDirection(preset: FramingPreset): Vec3 {
  if (preset === "front") return FRONT;
  if (preset === "top") return TOP;
  return THREE_QUARTER;
}

/** Deep copy (every vector is its own array), so edits never leak back into the source. */
export function cloneCamera(c: CameraState): CameraState {
  return { direction: [...c.direction] as Vec3, up: [...c.up] as Vec3, zoom: c.zoom, pan: [...c.pan] as Vec3, light: [...c.light] as Vec3 };
}

export function lookAtBasis(forward: Vec3, preferredUp: Vec3 = WORLD_UP): { right: Vec3; up: Vec3 } {
  const length = vlen(forward);
  const fwd = length > 1e-8 ? scale(forward, 1 / length) : THREE_QUARTER;
  let reference = vlen(preferredUp) < 1e-6 ? WORLD_UP : preferredUp;
  const refN = normalize(reference);
  if (Math.abs(dot(refN, fwd)) > 0.99) {
    reference = Math.abs(dot(WORLD_UP, fwd)) > 0.99 ? [0, 1, 0] : WORLD_UP;
  }
  let right = cross(reference, fwd);
  if (dot(right, right) < 1e-12) right = cross([1, 0, 0], fwd);
  right = normalize(right);
  const up = cross(fwd, right);
  return { right, up };
}

export function rotate(vector: Vec3, axis: Vec3, degrees: number): Vec3 {
  const axisLen = vlen(axis);
  if (axisLen < 1e-8) return vector;
  const k = scale(axis, 1 / axisLen);
  const rad = (degrees * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const crossed = cross(k, vector);
  return add(add(scale(vector, c), scale(crossed, s)), scale(k, dot(k, vector) * (1 - c)));
}

export function clampedZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(3.5, Math.max(0.4, zoom));
}

export interface Framing {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  fieldOfView: number;
  distance: number;
}

export function framed(
  bounds: Bounds | null,
  direction: Vec3,
  margin = 1.08,
  fieldOfView = 32,
  preferredUp?: Vec3
): Framing {
  const length = vlen(direction);
  const forward = length > 1e-8 ? scale(direction, 1 / length) : THREE_QUARTER;
  const basis = lookAtBasis(forward, preferredUp);
  if (!bounds) {
    return {
      position: scale(forward, 10),
      target: [0, 0, 0],
      up: basis.up,
      fieldOfView,
      distance: 10,
    };
  }
  const target: Vec3 = [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
  const diagonal = vlen(sub(bounds.max, bounds.min));
  const radius = diagonal * 0.5;
  const halfAngle = (Math.max(fieldOfView, 1) * Math.PI) / 360;
  const tangent = Math.tan(halfAngle);
  const corners: Vec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) corners.push([x, y, z]);
    }
  }
  let distance = 0;
  for (const corner of corners) {
    const offset = sub(corner, target);
    const lateral = Math.max(Math.abs(dot(offset, basis.right)), Math.abs(dot(offset, basis.up)));
    const depth = dot(offset, forward);
    distance = Math.max(distance, (lateral * margin) / tangent + depth);
  }
  distance = Math.max(distance, radius * 1.5, 0.01);
  return {
    position: add(target, scale(forward, distance)),
    target,
    up: basis.up,
    fieldOfView,
    distance,
  };
}

export function defaultCamera(): CameraState {
  const direction = THREE_QUARTER;
  return {
    direction,
    up: lookAtBasis(direction).up,
    zoom: 1,
    pan: [0, 0, 0],
    light: DEFAULT_LIGHT,
  };
}

export function cameraForPreset(preset: FramingPreset, resetPan: boolean, previous: CameraState): CameraState {
  const direction = presetDirection(preset);
  return {
    direction,
    up: lookAtBasis(direction).up,
    zoom: resetPan ? 1 : previous.zoom,
    pan: resetPan ? [0, 0, 0] : previous.pan,
    light: previous.light,
  };
}

/** AppKit-style deltas: +x right, +y up. */
export function orbitTrackball(originDirection: Vec3, originUp: Vec3, deltaX: number, deltaY: number, degreesPerPoint: number): { direction: Vec3; up: Vec3 } {
  const basis = lookAtBasis(originDirection, originUp);
  const yawDegrees = -deltaX * degreesPerPoint;
  const pitchDegrees = -deltaY * degreesPerPoint;
  let direction = rotate(originDirection, basis.up, yawDegrees);
  let up = rotate(originUp, basis.up, yawDegrees);
  const mid = lookAtBasis(direction, up);
  direction = rotate(direction, mid.right, pitchDegrees);
  up = rotate(up, mid.right, pitchDegrees);
  const unit = normalize(direction);
  return { direction: unit, up: lookAtBasis(unit, up).up };
}

export const SCROLL_ZOOM_GAIN = 0.0028;
export const PINCH_ZOOM_GAIN = 1.35;
export const LIGHT_SPOT_FLOOD_GAIN = 1.15;
export const PAN_DISTANCE_FRACTION = 0.0016;

/**
 * Screen deltas in the AppKit frame the Swift viewport uses: +x right, +y up.
 * Browser `clientY` / `deltaY` grow downward, so negate Y before these helpers.
 */
export function appKitDeltas(deltaXRight: number, deltaYDown: number): { dx: number; dy: number } {
  return { dx: deltaXRight, dy: -deltaYDown };
}

/** `deltaYUp` matches `NSEvent.scrollingDeltaY` (positive = scroll up). Scroll up zooms in. */
export function scrollZoomFactor(deltaYUp: number): number {
  return Math.exp(-deltaYUp * SCROLL_ZOOM_GAIN);
}

/** Positive magnification is fingers apart. That zooms in (smaller framing margin). */
export function pinchZoomFactor(magnification: number): number {
  return Math.exp(-magnification * PINCH_ZOOM_GAIN);
}

export function lightSpotFlood(
  key: number,
  fill: number,
  ambient: number,
  magnification: number
): { key: number; fill: number; ambient: number } {
  const t = magnification * LIGHT_SPOT_FLOOD_GAIN;
  return {
    key: Math.min(2000, Math.max(200, key * Math.exp(-t))),
    fill: Math.min(1200, Math.max(0, fill * Math.exp(t * 0.35))),
    ambient: Math.min(800, Math.max(0, ambient * Math.exp(t * 0.85))),
  };
}

export function panWorld(camera: CameraState, deltaX: number, deltaY: number, distance: number): Vec3 {
  const basis = lookAtBasis(camera.direction, camera.up);
  const scaleN = distance * PAN_DISTANCE_FRACTION;
  // Grab-and-drag. AppKit +y is up, so both axes subtract: finger right/up moves the model right/up.
  const delta = add(scale(basis.right, -deltaX * scaleN), scale(basis.up, -deltaY * scaleN));
  return add(camera.pan, delta);
}

export function aimLight(originLight: Vec3, camera: CameraState, deltaX: number, deltaY: number, degreesPerPoint: number): Vec3 {
  const basis = lookAtBasis(camera.direction, camera.up);
  let light = rotate(originLight, basis.up, -deltaX * degreesPerPoint);
  light = rotate(light, basis.right, -deltaY * degreesPerPoint);
  return normalize(light);
}

export function boundsOfParts(parts: { visible: boolean; meshPositions?: number[] }[]): Bounds | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let any = false;
  for (const part of parts) {
    if (!part.visible || !part.meshPositions) continue;
    const pos = part.meshPositions;
    for (let i = 0; i < pos.length; i += 3) {
      any = true;
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!any || minX > maxX) return null;
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

export const TRACKBALL_DEGREES_PER_POINT = 0.42;
export const TRACKPAD_ORBIT_DEGREES_PER_POINT = 0.22;
export const BASE_MARGIN = 1.08;

/** Throws when a gesture sign disagrees with the Swift Mac viewport. */
export function assertViewportGestures(): void {
  const front = FRONT;
  const frontUp = lookAtBasis(front).up;
  const draggedUp = orbitTrackball(front, frontUp, 0, 40, TRACKBALL_DEGREES_PER_POINT);
  if (!(draggedUp.direction[2] > front[2] + 0.02)) {
    throw new Error(`drag-up should raise the camera (z ${front[2]} -> ${draggedUp.direction[2]})`);
  }
  const draggedDown = orbitTrackball(front, frontUp, 0, -40, TRACKBALL_DEGREES_PER_POINT);
  if (!(draggedDown.direction[2] < front[2] - 0.02)) {
    throw new Error(`drag-down should lower the camera (z ${front[2]} -> ${draggedDown.direction[2]})`);
  }
  const cam = defaultCamera();
  const basis = lookAtBasis(cam.direction, cam.up);
  const panned = panWorld(cam, 24, 0, 100);
  const panDelta = sub(panned, cam.pan);
  if (!(dot(panDelta, basis.right) < -0.01)) {
    throw new Error("finger-right pan should move the look-at target to screen-left");
  }
  const pannedUp = panWorld(cam, 0, 24, 100);
  if (!(dot(sub(pannedUp, cam.pan), basis.up) < -0.01)) {
    throw new Error("finger-up pan should move the look-at target to screen-down");
  }
  const browserScrollUp = -12;
  if (!(scrollZoomFactor(appKitDeltas(0, browserScrollUp).dy) < 1)) {
    throw new Error("scroll up should zoom in");
  }
  if (!(pinchZoomFactor(0.25) < 1)) throw new Error("fingers apart should zoom in");
  const flood = lightSpotFlood(900, 350, 280, 0.4);
  if (!(flood.key < 900 && flood.ambient > 280)) throw new Error("pinch-out in light mode should flood");
  if (clampedZoom(0.1) !== 0.4 || clampedZoom(9) !== 3.5) throw new Error("zoom clamp");
  const box = framed({ min: [-1, -1, -1], max: [1, 1, 1] }, THREE_QUARTER, BASE_MARGIN, 32);
  if (!(box.distance > 1)) throw new Error("framing distance");
}
