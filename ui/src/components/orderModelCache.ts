// Order 3D geometry cache and saved-camera parsing, split out of OrderViewport3D so the app
// can clear the cache (after a product is re-saved) and read saved cameras without loading
// the 3D viewport code. OrderViewport3D re-exports both.
import { CameraState, Vec3, clampedZoom, defaultCamera } from "../viewportCamera";
import type { OrderModel } from "./OrderViewport3D";

export const modelCache = new Map<string, Promise<OrderModel>>();

export const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && isFinite(n));

export function cameraFromJson(input: unknown): CameraState | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (!isVec3(raw.direction) || !isVec3(raw.up)) return null;
  return {
    direction: [...raw.direction] as Vec3,
    up: [...raw.up] as Vec3,
    zoom: typeof raw.zoom === "number" ? clampedZoom(raw.zoom) : 1,
    pan: isVec3(raw.pan) ? ([...raw.pan] as Vec3) : [0, 0, 0],
    light: isVec3(raw.light) ? ([...raw.light] as Vec3) : defaultCamera().light,
  };
}

export let modelGeneration = 0;
const generationListeners = new Set<() => void>();
export function subscribeModelGeneration(cb: () => void) {
  generationListeners.add(cb);
  return () => { generationListeners.delete(cb); };
}

/** Drop cached geometry after a product is re-saved in the editor (or deleted). Open order
 *  viewers reload their model. */
export function clearOrderModelCache(productId?: string) {
  if (!productId) modelCache.clear();
  else for (const k of [...modelCache.keys()]) if (k.startsWith(`${productId}|`)) modelCache.delete(k);
  modelGeneration++;
  for (const l of generationListeners) l();
}
