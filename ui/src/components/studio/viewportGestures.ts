import { BASE_MARGIN, Bounds, CameraState, TRACKBALL_DEGREES_PER_POINT, TRACKPAD_ORBIT_DEGREES_PER_POINT, Vec3, aimLight, appKitDeltas, clampedZoom, cloneCamera, framed, lightSpotFlood, lookAtBasis, normalize, orbitTrackball, panWorld, pinchZoomFactor, rotate, scrollZoomFactor } from "../../viewportCamera";
import { type ManipulateTarget } from "./viewportTypes";

interface GestureHost {
  camera: () => CameraState;
  bounds: () => Bounds | null;
  manipulate: () => ManipulateTarget;
  intensities: () => { key: number; fill: number; ambient: number };
  setIntensities: (next: { key: number; fill: number; ambient: number }) => void;
  setInteracting: (active: boolean) => void;
  onSettled: () => void;
  redraw: () => void;
  onTap?: (event?: PointerEvent) => void;
  /** Keyboard "0" / overlay reset. */
  onReset?: () => void;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** ⌘ on Mac, Ctrl elsewhere — for platform-neutral hints. */
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";
export const VIEWPORT_HINT =
  "Drag to rotate · right/middle or Shift-drag to pan · wheel or pinch to zoom · two fingers pan/pinch on touch · hold arrows to rotate, [ ] to spin, +/− to zoom, 0 resets (when focused)";

/** Button/keyboard step: rotate the model camera by `degrees` (screen-space, like a drag). */
export function nudgeOrbit(camera: CameraState, dxDeg: number, dyDeg: number) {
  const next = orbitTrackball(camera.direction, camera.up, dxDeg / TRACKBALL_DEGREES_PER_POINT, dyDeg / TRACKBALL_DEGREES_PER_POINT, TRACKBALL_DEGREES_PER_POINT);
  camera.direction = next.direction;
  camera.up = next.up;
}
/** Roll the camera around its view axis (the model spins in the screen plane). Positive = clockwise on screen. */
export function nudgeRoll(camera: CameraState, degrees: number) {
  camera.up = lookAtBasis(camera.direction, rotate(camera.up, camera.direction, degrees)).up;
}
/** Jog speeds (per second at full speed). Hold ramps from ~40% to 100% over ~0.6 s, then to 150% by ~2 s. */
export const JOG_DEG_PER_SEC = 90;
export const JOG_ZOOM_PER_SEC = 0.9; // log-zoom units per second
export const JOG_PAN_PX_PER_SEC = 320;
export function jogRamp(heldSec: number): number {
  return heldSec < 0.6 ? 0.4 + heldSec : Math.min(1.5, 1 + (heldSec - 0.6) * 0.36);
}
/**
 * Continuous press-and-hold motion driven by requestAnimationFrame. `apply(dtSec * speed)` gets
 * called every frame. A first small nudge happens immediately so a quick click still moves a bit.
 * Returns stop().
 */
export function startJog(apply: (scaledSec: number) => void, onStop?: () => void): () => void {
  const start = performance.now();
  let last = start;
  let raf = 0;
  let stopped = false;
  apply(0.05); // tap nudge (≈4.5° rotate)
  const tick = (now: number) => {
    if (stopped) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    apply(dt * jogRamp((now - start) / 1000));
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    onStop?.();
  };
}
export function nudgeZoom(camera: CameraState, factor: number) {
  camera.zoom = clampedZoom(camera.zoom * factor);
}
export function nudgePan(camera: CameraState, bounds: Bounds | null, dx: number, dy: number) {
  camera.pan = panWorld(camera, dx, dy, framingDistance(camera, bounds));
}

/** Key light as azimuth/elevation (degrees) ⇄ unit vector, in the viewport's Z-up world.
 *  Elevation is the angle above the bed plane (+90° = straight overhead); azimuth 0° is the
 *  front (−Y), positive toward +X. */
export function lightToAngles(light: Vec3): { azimuth: number; elevation: number } {
  const l = normalize(light);
  return {
    azimuth: Math.round((Math.atan2(l[0], -l[1]) * 180) / Math.PI),
    elevation: Math.round((Math.asin(Math.max(-1, Math.min(1, l[2]))) * 180) / Math.PI),
  };
}
export function anglesToLight(azimuth: number, elevation: number): Vec3 {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return normalize([Math.sin(a) * Math.cos(e), -Math.cos(a) * Math.cos(e), Math.sin(e)]);
}

function framingDistance(camera: CameraState, bounds: Bounds | null): number {
  return framed(bounds, camera.direction, BASE_MARGIN * camera.zoom, 32, camera.up).distance;
}

/** Mac LiveExportSCNView gestures. Deltas are converted to AppKit +y-up before the Swift formulas. */
export function bindViewportGestures(canvas: HTMLCanvasElement, host: GestureHost): () => void {
  let drag: {
    mode: "orbit" | "pan";
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    origin: CameraState;
    moved: boolean;
    button: number;
  } | null = null;
  let settleTimer = 0;
  let gesturing = false;
  let gestureBase: { zoom: number; up: Vec3; key: number; fill: number; ambient: number } | null = null;
  // Touch: every active touch pointer. Two fingers = pan (centroid) + pinch (spread).
  const touches = new Map<number, { x: number; y: number }>();
  let twoFinger: { cx: number; cy: number; spread: number } | null = null;
  const touchPair = () => {
    const pts = [...touches.values()];
    const [a, b] = pts;
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, spread: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  };

  const armSettle = () => {
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      host.setInteracting(false);
      host.onSettled();
      host.redraw();
    }, 120);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button > 2) return;
    event.preventDefault();
    try { canvas.focus({ preventScroll: true }); } catch { /* ignore */ }
    if (event.pointerType === "touch") {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      try { canvas.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      if (touches.size >= 2) {
        drag = null; // second finger turns the orbit into pan/pinch
        twoFinger = touchPair();
        host.setInteracting(true);
        return;
      }
    }
    const pan = event.button === 1 || event.button === 2 || event.shiftKey;
    drag = {
      mode: pan ? "pan" : "orbit",
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      origin: cloneCamera(host.camera()),
      moved: false,
      button: event.button,
    };
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic probes and some trackpad paths have no active pointer. The drag still tracks.
    }
    host.setInteracting(true);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch" && touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size >= 2 && twoFinger) {
        const now = touchPair();
        const camera = host.camera();
        const ratio = now.spread / twoFinger.spread;
        if (host.manipulate() === "light") {
          const l = host.intensities();
          host.setIntensities(lightSpotFlood(l.key, l.fill, l.ambient, Math.log(ratio)));
        } else {
          const step = appKitDeltas(now.cx - twoFinger.cx, now.cy - twoFinger.cy);
          camera.pan = panWorld(camera, step.dx, step.dy, framingDistance(camera, host.bounds()));
          camera.zoom = clampedZoom(camera.zoom * ratio);
        }
        twoFinger = now;
        host.redraw();
        return;
      }
    }
    if (!drag) return;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 3) drag.moved = true;
    const camera = host.camera();
    if (drag.mode === "pan") {
      if (host.manipulate() === "light") return;
      const step = appKitDeltas(event.clientX - drag.lastX, event.clientY - drag.lastY);
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      camera.pan = panWorld(camera, step.dx, step.dy, framingDistance(camera, host.bounds()));
    } else {
      const total = appKitDeltas(event.clientX - drag.x, event.clientY - drag.y);
      if (host.manipulate() === "light") {
        camera.light = aimLight(drag.origin.light, drag.origin, total.dx, total.dy, TRACKBALL_DEGREES_PER_POINT);
      } else {
        const next = orbitTrackball(drag.origin.direction, drag.origin.up, total.dx, total.dy, TRACKBALL_DEGREES_PER_POINT);
        camera.direction = next.direction;
        camera.up = next.up;
      }
    }
    host.redraw();
  };

  const finish = (event?: PointerEvent) => {
    if (event && event.pointerType === "touch") {
      touches.delete(event.pointerId);
      if (twoFinger) {
        if (touches.size < 2) {
          twoFinger = null;
          host.setInteracting(false);
          host.onSettled();
          host.redraw();
        }
        return;
      }
    }
    if (!drag) return;
    const tapped = !drag.moved && drag.button === 0;
    drag = null;
    host.setInteracting(false);
    host.onSettled();
    host.redraw();
    if (tapped) host.onTap?.(event);
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const camera = host.camera();
    // A notched mouse wheel reports wheelDelta in multiples of 120 with no X; that always zooms.
    const legacy = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
    const notched = event.deltaX === 0 && typeof legacy === "number" && legacy !== 0 && legacy % 120 === 0;
    const precise = !notched && event.deltaMode === 0 && Math.abs(event.deltaY) < 50 && Math.abs(event.deltaX) < 50;
    const delta = appKitDeltas(event.deltaX, event.deltaY);
    if (event.ctrlKey && !gesturing) {
      const magnification = -event.deltaY * 0.01;
      if (host.manipulate() === "light") {
        host.setIntensities(lightSpotFlood(host.intensities().key, host.intensities().fill, host.intensities().ambient, magnification));
      } else {
        camera.zoom = clampedZoom(camera.zoom * pinchZoomFactor(magnification));
      }
    } else if (event.shiftKey) {
      if (host.manipulate() === "model") {
        camera.pan = panWorld(camera, delta.dx, delta.dy, framingDistance(camera, host.bounds()));
      }
    } else if (event.altKey || !precise) {
      camera.zoom = clampedZoom(camera.zoom * scrollZoomFactor(delta.dy));
    } else if (host.manipulate() === "light") {
      camera.light = aimLight(camera.light, camera, delta.dx, delta.dy, TRACKPAD_ORBIT_DEGREES_PER_POINT);
    } else {
      const next = orbitTrackball(camera.direction, camera.up, delta.dx, delta.dy, TRACKPAD_ORBIT_DEGREES_PER_POINT);
      camera.direction = next.direction;
      camera.up = next.up;
    }
    host.setInteracting(true);
    host.redraw();
    armSettle();
  };

  const rememberGesture = () => {
    if (gestureBase) return;
    const camera = host.camera();
    const lights = host.intensities();
    gestureBase = { zoom: camera.zoom, up: [...camera.up] as Vec3, key: lights.key, fill: lights.fill, ambient: lights.ambient };
  };

  const onGestureStart = (event: Event) => {
    event.preventDefault();
    gesturing = true;
    gestureBase = null;
    rememberGesture();
    host.setInteracting(true);
  };

  const onGesture = (event: Event) => {
    const gesture = event as Event & { scale?: number; rotation?: number };
    event.preventDefault();
    gesturing = true;
    rememberGesture();
    if (!gestureBase) return;
    const camera = host.camera();
    const scale = typeof gesture.scale === "number" && gesture.scale > 0 ? gesture.scale : 1;
    const rotation = typeof gesture.rotation === "number" ? gesture.rotation : 0;
    const magnification = Math.log(scale);
    if (host.manipulate() === "light") {
      host.setIntensities(lightSpotFlood(gestureBase.key, gestureBase.fill, gestureBase.ambient, magnification));
    } else {
      if (rotation !== 0) {
        // WebKit gesture rotation: degrees, positive = clockwise twist. Turning the camera's
        // up counterclockwise (+deg about the toward-viewer axis) spins the model clockwise on
        // screen, matching nudgeRoll's "positive = clockwise".
        camera.up = lookAtBasis(camera.direction, rotate(gestureBase.up, camera.direction, rotation)).up;
      }
      camera.zoom = clampedZoom(gestureBase.zoom * pinchZoomFactor(magnification));
    }
    host.redraw();
  };

  const onGestureEnd = (event: Event) => {
    event.preventDefault();
    gesturing = false;
    gestureBase = null;
    host.setInteracting(false);
    host.onSettled();
    host.redraw();
  };

  const blockMenu = (event: Event) => event.preventDefault();
  // Keyboard only while the canvas itself has focus, so typing in fields is never stolen.
  const held = new Map<string, number>(); // key -> held-since ms
  let keyRaf = 0;
  let keyLast = 0;
  let keySlow = false;
  const keyTick = (now: number) => {
    if (held.size === 0) { keyRaf = 0; return; }
    const dt = Math.min(0.05, (now - keyLast) / 1000);
    keyLast = now;
    const camera = host.camera();
    const light = host.manipulate() === "light";
    for (const [key, since] of held) {
      const k = dt * jogRamp((now - since) / 1000) * (keySlow ? 0.35 : 1);
      const deg = JOG_DEG_PER_SEC * k;
      const turn = (dx: number, dy: number) => {
        if (light) camera.light = aimLight(camera.light, camera, dx / TRACKBALL_DEGREES_PER_POINT, dy / TRACKBALL_DEGREES_PER_POINT, TRACKBALL_DEGREES_PER_POINT);
        else nudgeOrbit(camera, dx, dy);
      };
      if (key === "ArrowLeft") turn(-deg, 0);
      else if (key === "ArrowRight") turn(deg, 0);
      else if (key === "ArrowUp") turn(0, deg);
      else if (key === "ArrowDown") turn(0, -deg);
      else if (key === "+") nudgeZoom(camera, Math.exp(-JOG_ZOOM_PER_SEC * k));
      else if (key === "-") nudgeZoom(camera, Math.exp(JOG_ZOOM_PER_SEC * k));
      else if (key === "[") nudgeRoll(camera, -deg);
      else if (key === "]") nudgeRoll(camera, deg);
    }
    host.redraw();
    keyRaf = requestAnimationFrame(keyTick);
  };
  const stopKeys = () => {
    if (held.size === 0) return;
    held.clear();
    host.setInteracting(false);
    host.onSettled();
    host.redraw();
  };
  const jogKey = (key: string): string | null =>
    key.startsWith("Arrow") ? key : key === "+" || key === "=" ? "+" : key === "-" || key === "_" ? "-" : key === "[" || key === "]" ? key : null;
  // Keyboard only while the canvas itself has focus, so typing in fields is never stolen.
  const onKey = (event: KeyboardEvent) => {
    if (document.activeElement !== canvas || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "0") {
      host.onReset?.();
      event.preventDefault();
      host.onSettled();
      host.redraw();
      return;
    }
    const key = jogKey(event.key);
    if (!key) return;
    event.preventDefault();
    keySlow = event.shiftKey;
    if (held.has(key)) return; // OS key-repeat: already jogging
    held.set(key, performance.now());
    host.setInteracting(true);
    if (!keyRaf) {
      keyLast = performance.now();
      keyRaf = requestAnimationFrame(keyTick);
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    const key = jogKey(event.key);
    keySlow = event.shiftKey;
    if (!key || !held.has(key)) return;
    held.delete(key);
    if (held.size === 0) { held.set("_", 0); stopKeys(); }
  };
  if (!canvas.hasAttribute("tabindex")) canvas.tabIndex = 0;
  canvas.addEventListener("keydown", onKey);
  canvas.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("blur", stopKeys);
  window.addEventListener("blur", stopKeys);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("gesturestart", onGestureStart);
  canvas.addEventListener("gesturechange", onGesture);
  canvas.addEventListener("gestureend", onGestureEnd);
  canvas.addEventListener("contextmenu", blockMenu);
  return () => {
    window.clearTimeout(settleTimer);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", finish);
    canvas.removeEventListener("pointercancel", finish);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("gesturestart", onGestureStart);
    canvas.removeEventListener("gesturechange", onGesture);
    canvas.removeEventListener("gestureend", onGestureEnd);
    canvas.removeEventListener("contextmenu", blockMenu);
    canvas.removeEventListener("keydown", onKey);
    canvas.removeEventListener("keyup", onKeyUp);
    canvas.removeEventListener("blur", stopKeys);
    window.removeEventListener("blur", stopKeys);
    if (keyRaf) cancelAnimationFrame(keyRaf);
    held.clear();
  };
}
