/**
 * Order 3D builder: the Product Editor's live viewport, colored with one order
 * line's chosen filaments, with click-to-pick parts and a per-order picture capture.
 *
 * Product-agnostic: everything comes from the product's catalog files (editor.json +
 * parts/<meshStem>.stl via loadProductEditorDraft). Only geometry is cached (per product);
 * order pictures are never cached — every capture is rendered fresh from that line's
 * colors and camera, so each order gets its own picture.
 *
 * Exports
 *  - <OrderViewport3D>      live viewport (New Order / Edit Order); ref → capture()/getCamera()/resetView()
 *                           optional `inscription` draws preview-only letters on the model
 *  - renderOrderThumbnail() offscreen render for orders with no hand-turned view
 *                           (website orders, other lines, burst orders); camera defaults to the
 *                           product's picture angle
 *  - <OrderRePoseModal>     order-details "Re-pose picture": starts at the saved camera,
 *                           returns a new picture + camera
 *  - orderCameraFromViewCamera() / viewCameraFromOrderCamera(): website order
 *                           lines[].view_camera <-> order camera (mapping documented below;
 *                           round-trip check: ui/scripts/view-camera-roundtrip.ts)
 */
import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { StudioPartLayer, ThumbnailViewport, ThumbnailViewportHandle } from "./StudioViewport3D";
import { BASE_MARGIN, Bounds, CameraState, FramingPreset, Vec3, boundsOfParts, cameraForPreset, clampedZoom, cloneCamera, defaultCamera, lookAtBasis } from "../viewportCamera";
import { renderViewportGL } from "../meshRendererGL";
import { loadProductEditorDraft } from "../productEditorSource";
import { isPictureOnlyCatalogPart } from "../previewColors";
import type { FilamentSwatch, Product } from "../types";
import { cameraFromJson, isVec3, modelCache, modelGeneration, subscribeModelGeneration } from "./orderModelCache";
import { buildInscriptionPreviewMesh, inscriptionFromSaved } from "../inscriptionPreview";

// ---------------------------------------------------------------------------------------
// Types saved per order line (local app data only)

/** Viewport camera, same shape the Product Editor uses (re-renderable with setCamera /
 *  renderOrderThumbnail). direction = unit vector from the model center toward the eye;
 *  up = screen-up; zoom 1 / pan 0 = fitted framing (what pictures use); light = key light. */
export type OrderThumbnailCamera = CameraState;

export interface OrderThumbnailCapture {
  /** Colored PNG (transparent background), `size` × `size`. */
  pngDataUrl: string;
  /** Neutral white per-part layers from the same camera (back to front), for live
   *  recolor like product layers. Only rendered when asked for with `layers: true` (each
   *  part costs two extra full-size renders and a PNG encode); empty otherwise. */
  layers: Array<{ partId: string; dataUrl: string; compositeZ: number }>;
  /** Camera the PNG was rendered from (zoom 1, pan 0: fitted framing). */
  camera: OrderThumbnailCamera;
  /** part id → hex used for the PNG (#RRGGBB or #RRGGBBAA). */
  partColors: Record<string, string>;
  size: number;
  /** Bump if the camera/render math changes. */
  renderVersion: 1;
}

// ---------------------------------------------------------------------------------------
// Model loading (geometry only; cached per product)

interface OrderModelPart {
  id: string;
  name: string;
  positions: number[];
  indices: number[];
  visible: boolean;
  selectable: boolean;
  defaultHex: string;
}

export interface OrderModel {
  productId: string;
  parts: OrderModelPart[];
  /** Product picture angle: editor.json viewCamera, else its camera preset. */
  defaultCamera: CameraState;
  lights: { key: number; fill: number; ambient: number };
  /** Visible parts without a saved mesh (older imports) — 3D is not usable. */
  missingMeshes: string[];
  /** Saved inscription setup from editor.json (placement, font, size, flips, wrap). */
  inscription: ReturnType<typeof inscriptionFromSaved>;
  supportsCustomText: boolean;
}

const cloneCam = cloneCamera;

/** Picture framing: same angle and light, fitted (zoom 1, pan 0) — what capture() renders. */
const fitted = (c: CameraState): CameraState => ({ ...cloneCam(c), zoom: 1, pan: [0, 0, 0] });

/** The product's parts as they affect order geometry; part of the cache key. */
function partsKey(product: Product): string {
  return product.parts.map((p) => `${p.id}:${p.mesh_file}:${p.is_tracked ? 1 : 0}${p.is_color_only ? 1 : 0}`).join(",");
}

export function loadOrderModel(product: Product, filaments: FilamentSwatch[]): Promise<OrderModel> {
  // modelGeneration changes whenever the cache is cleared (a product was re-saved), so a
  // re-import with the same part names can never keep serving the old meshes.
  const key = `${product.id}|${modelGeneration}|${partsKey(product)}`;
  const hit = modelCache.get(key);
  if (hit) return hit;
  const job = (async (): Promise<OrderModel> => {
    const { draft } = await loadProductEditorDraft(product, filaments);
    const byId = new Map(product.parts.map((p) => [p.id, p]));
    const parts: OrderModelPart[] = draft.parts.map((p) => {
      const cp = byId.get(p.id);
      const visible = p.showInPicture !== false;
      return {
        id: p.id,
        name: p.partName,
        positions: p.meshPositions || [],
        indices: p.meshIndices || [],
        visible,
        selectable: visible && !!cp && !isPictureOnlyCatalogPart(cp),
        defaultHex: p.defaultColorHex || "#888888",
      };
    });
    const sl = draft.studioLighting;
    const light: Vec3 = sl?.light && isVec3(sl.light) ? ([...sl.light] as Vec3) : defaultCamera().light;
    const saved = cameraFromJson((draft as any).viewCamera);
    const preset: FramingPreset = draft.cameraPreset === "Front" ? "front" : draft.cameraPreset === "Top" ? "top" : "threeQuarter";
    const base = saved ? { ...saved, light: saved.light || light } : cameraForPreset(preset, true, { ...defaultCamera(), light });
    const inscription = inscriptionFromSaved(draft.inscription);
    return {
      productId: product.id,
      parts,
      defaultCamera: fitted(base),
      lights: { key: sl?.key ?? 900, fill: sl?.fill ?? 350, ambient: sl?.ambient ?? 280 },
      missingMeshes: parts.filter((p) => p.visible && p.indices.length < 3).map((p) => p.name),
      inscription,
      supportsCustomText: !!(product.supports_custom_text || inscription.enabled),
    };
  })();
  modelCache.set(key, job);
  job.catch(() => modelCache.delete(key));
  return job;
}

// ---------------------------------------------------------------------------------------
// Website orders: store_orders.lines[].view_camera, the angle the customer chose in the shop
//
// Space: the shop 3D page loads the preview GLB unrotated and frames it with
// a fixed camera rig (WORLD_UP = +Z, units = mm, model NOT re-centered). The GLB
// carries the catalog STL coordinates as-is, so view_camera {position, target} is already in
// this viewport's model space: no axis swap, no scale, no re-centering offset.
//   direction = normalize(position - target)   (our/shop direction points model → eye)
//   up        = world up (+Z) projected square to direction (view_camera carries no roll)
//   zoom      = |position - target| · tan(fov/2) / tan(16°) · sin(16°) / (radius · 1.08)
//               (same apparent size under our fixed 32° lens and bounding-sphere fit)
//   pan       = target - model bounds center (world vector, like ours)
//   light     = product default (editor.json studioLighting.light)
// Missing view_camera → product default angle. Present but invalid → console.warn + default.

/** Shape the shop writes on each order line (three.js camera position + orbit target, fov in degrees). */
export interface ViewCamera {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

/** World up shared by this viewport and the shop 3D page (frozenCamera.ts WORLD_UP). */
export const VIEW_CAMERA_WORLD_UP: Vec3 = [0, 0, 1];
const LENS_FOV = 32; // renderViewportGL / framed() vertical FOV
const HALF_LENS = (LENS_FOV * Math.PI) / 360;

function boundsCenterRadius(b: Bounds) {
  const center: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const radius = Math.max(1e-3, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 0.5);
  return { center, radius };
}

/** True when `raw` looks like a view_camera (has position/target), valid or not. */
export function looksLikeViewCamera(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && ("position" in raw || "target" in raw || "fov" in raw) && !("direction" in raw);
}

/** Why a view_camera is unusable, or null when it is fine. */
export function viewCameraProblem(input: unknown): string | null {
  if (!input || typeof input !== "object") return "not an object";
  const raw = input as Record<string, unknown>;
  if (!isVec3(raw.position)) return "position is not 3 finite numbers";
  if (!isVec3(raw.target)) return "target is not 3 finite numbers";
  if (typeof raw.fov !== "number" || !isFinite(raw.fov) || raw.fov <= 1 || raw.fov >= 179) return "fov is not a number between 1 and 179 degrees";
  const [p, t] = [raw.position, raw.target];
  const d = Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
  if (!(d > 1e-6)) return "position equals target";
  return null;
}

/** Sync converter once the product's model is loaded. Null for invalid input. */
export function orderCameraFromViewCameraWithModel(model: OrderModel, viewCamera: unknown): CameraState | null {
  if (viewCameraProblem(viewCamera)) return null;
  const vc = viewCamera as ViewCamera;
  const bounds = modelBounds(model);
  if (!bounds) return null;
  const { center, radius } = boundsCenterRadius(bounds);
  const rel: Vec3 = [vc.position[0] - vc.target[0], vc.position[1] - vc.target[1], vc.position[2] - vc.target[2]];
  const dist = Math.hypot(rel[0], rel[1], rel[2]);
  const direction: Vec3 = [rel[0] / dist, rel[1] / dist, rel[2] / dist];
  const halfFov = (vc.fov * Math.PI) / 360;
  // Distance our 32° lens needs for the same apparent size, then our zoom for that distance.
  const ourDist = (dist * Math.tan(halfFov)) / Math.tan(HALF_LENS);
  const zoom = clampedZoom((ourDist * Math.sin(HALF_LENS)) / (radius * BASE_MARGIN));
  return {
    direction,
    up: lookAtBasis(direction, VIEW_CAMERA_WORLD_UP).up,
    zoom,
    pan: [vc.target[0] - center[0], vc.target[1] - center[1], vc.target[2] - center[2]],
    light: [...model.defaultCamera.light] as Vec3,
  };
}

/** Inverse (tests, or if the shop ever needs it): our camera → view_camera at `fov` degrees.
 *  Roll is not representable (view_camera has no up); a square viewport is assumed. */
export function viewCameraFromOrderCamera(model: OrderModel, camera: CameraState, fov = LENS_FOV): ViewCamera | null {
  const bounds = modelBounds(model);
  if (!bounds) return null;
  const { center, radius } = boundsCenterRadius(bounds);
  const dl = Math.hypot(...camera.direction);
  if (!(dl > 1e-8)) return null;
  const dir = camera.direction.map((v) => v / dl);
  const ourDist = (radius * BASE_MARGIN * camera.zoom) / Math.sin(HALF_LENS);
  const dist = (ourDist * Math.tan(HALF_LENS)) / Math.tan((fov * Math.PI) / 360);
  const target: [number, number, number] = [center[0] + camera.pan[0], center[1] + camera.pan[1], center[2] + camera.pan[2]];
  return { position: [target[0] + dir[0] * dist, target[1] + dir[1] * dist, target[2] + dir[2] * dist], target, fov };
}

/** Converts a website order line's view_camera for `product`. Null when missing or invalid
 *  (logs a warning when one was present but rejected) — callers then use the default angle. */
export async function orderCameraFromViewCamera(product: Product, viewCamera: unknown, filaments: FilamentSwatch[] = []): Promise<CameraState | null> {
  if (viewCamera == null) return null;
  const model = await loadOrderModel(product, filaments);
  return resolveCamera(model, viewCamera, product.id);
}

/** CameraState | view_camera | null → CameraState (or null = product default). */
function resolveCamera(model: OrderModel, raw: unknown, label: string): CameraState | null {
  if (raw == null) return null;
  if (!looksLikeViewCamera(raw)) {
    const cam = cameraFromJson(raw);
    if (!cam) console.warn(`[order picture] ${label}: saved camera is malformed; using the product's default angle.`, raw);
    return cam;
  }
  const problem = viewCameraProblem(raw);
  const cam = problem ? null : orderCameraFromViewCameraWithModel(model, raw);
  if (!cam) console.warn(`[order picture] ${label}: view_camera rejected (${problem ?? "model has no bounds"}); using the product's default angle.`, raw);
  return cam;
}

// ---------------------------------------------------------------------------------------
// Offscreen rendering (same camera math as the live viewport's capture())

function drawable(model: OrderModel) {
  return model.parts.filter((p) => p.visible && p.indices.length >= 3);
}

function modelBounds(model: OrderModel): Bounds | null {
  return boundsOfParts(model.parts.map((p) => ({ visible: p.visible, meshPositions: p.positions })));
}

function renderSquare(
  model: OrderModel, camera: CameraState, size: number, hexFor: (id: string) => string, onlyId?: string,
  opts: { supersample?: number } = {}
): HTMLCanvasElement | null {
  // The GL context is multisampled; extra supersampling only pays off for large pictures.
  const ss = opts.supersample ?? (size <= 1024 ? 2 : 1);
  const px = Math.round(size * ss);
  const parts = drawable(model)
    .filter((p) => !onlyId || p.id === onlyId)
    .map((p) => ({ hex: hexFor(p.id), positions: p.positions, indices: p.indices, selected: false }));
  const gl = renderViewportGL({
    width: px, height: px, camera: fitted(camera), bounds: modelBounds(model), parts,
    shading: "standard", keyIntensity: model.lights.key, fillIntensity: model.lights.fill, ambientIntensity: model.lights.ambient,
  });
  if (!gl) return null;
  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(gl, 0, 0, size, size); // copy now: the GL canvas is shared
  return out;
}

/** Same occlusion-masked layers as ThumbnailViewport.captureLayers. */
function renderLayers(model: OrderModel, camera: CameraState, size: number) {
  const black = renderSquare(model, camera, size, () => "#000000");
  const allBlack = black?.getContext("2d")?.getImageData(0, 0, size, size) || null;
  const out: Array<{ partId: string; dataUrl: string; compositeZ: number }> = [];
  for (const p of drawable(model)) {
    const solo = renderSquare(model, camera, size, () => "#FFFFFF", p.id);
    if (!solo) continue;
    let url = "";
    const sctx = solo.getContext("2d");
    const lit = allBlack ? renderSquare(model, camera, size, (id) => (id === p.id ? "#FFFFFF" : "#000000")) : null;
    const lctx = lit?.getContext("2d");
    if (allBlack && sctx && lctx) {
      const a = lctx.getImageData(0, 0, size, size).data;
      const b = allBlack.data;
      const img = sctx.getImageData(0, 0, size, size);
      const d = img.data;
      let any = false;
      for (let i = 0; i < d.length; i += 4) {
        const diff = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        d[i + 3] = Math.round(d[i + 3] * Math.min(1, diff / 24));
        if (d[i + 3] > 0) any = true;
      }
      if (any) { sctx.putImageData(img, 0, 0); url = solo.toDataURL("image/png"); }
    } else {
      url = solo.toDataURL("image/png");
    }
    if (url) out.push({ partId: p.id, dataUrl: url, compositeZ: out.length });
  }
  return out;
}

function colorsWithDefaults(model: OrderModel, partColors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of model.parts) out[p.id] = partColors[p.id] || p.defaultHex;
  return out;
}

/**
 * Renders one order line's picture offscreen: the product in `partColors` (part id → hex;
 * missing parts use their saved default) from `camera`, or from the product's picture angle
 * when no camera is given (website orders). Returns null when the product has no saved 3D
 * meshes or WebGL is unavailable — keep the existing composite picture then.
 * Per-part layers are opt-in (`layers: true`); order pictures only keep the PNG.
 */
export async function renderOrderThumbnail(
  product: Product,
  partColors: Record<string, string>,
  camera?: CameraState | ViewCamera | null,
  opts: { filaments?: FilamentSwatch[]; size?: number; layers?: boolean; supersample?: number } = {}
): Promise<OrderThumbnailCapture | null> {
  const model = await loadOrderModel(product, opts.filaments || []);
  if (model.missingMeshes.length || !drawable(model).length) return null;
  const size = opts.size ?? 1024;
  const resolved = resolveCamera(model, camera, product.id);
  const cam = fitted(resolved ? cloneCam(resolved) : model.defaultCamera);
  const colors = colorsWithDefaults(model, partColors);
  const pic = renderSquare(model, cam, size, (id) => colors[id], undefined, { supersample: opts.supersample });
  if (!pic) return null;
  return {
    pngDataUrl: pic.toDataURL("image/png"),
    layers: opts.layers === true ? renderLayers(model, cam, size) : [],
    camera: cam,
    partColors: colors,
    size,
    renderVersion: 1,
  };
}

// ---------------------------------------------------------------------------------------
// Live viewport

export interface OrderViewport3DHandle {
  /** Picture of the current view in this line's colors, plus camera (and per-part layers
   *  only with `{ layers: true }`). Null when the 3D model is not available (fallback is showing). */
  capture: (size?: number, opts?: { layers?: boolean }) => OrderThumbnailCapture | null;
  getCamera: () => CameraState | null;
  /** Back to the product's picture angle. */
  resetView: () => void;
}

export interface OrderViewport3DProps {
  product: Product;
  filaments: FilamentSwatch[];
  /** part id → hex (the line's chosen filament colors; #RRGGBBAA = see-through). */
  partColors: Record<string, string>;
  selectedPartIds?: string[];
  /** Tap (not drag) on a color-selectable part. Picture-only / hidden parts never report. */
  onPartClick?: (partId: string, mods: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
  /** Camera to start from (this line's own view, or a saved order camera). Default: product picture angle. */
  initialCamera?: CameraState | ViewCamera | null;
  /** Where "Reset view" (button, ⌂, key 0) returns to. Default: product picture angle. */
  resetCamera?: CameraState | ViewCamera | null;
  /** Reported after each drag / zoom / jog settles, and on unmount. */
  onCameraChange?: (camera: CameraState) => void;
  /** Shown while loading and when the product has no saved 3D meshes. */
  fallback?: React.ReactNode;
  /** Told whether the live 3D view is showing (false = fallback). */
  onAvailableChange?: (available: boolean) => void;
  /**
   * Preview-only inscription text for this order line (`activeLine.customText`).
   * Empty or omitted draws nothing. Letters use the product's saved placement
   * (editor.json) and are never included in Print! or exported .3mf files.
   */
  inscription?: string | null;
}

export const OrderViewport3D = forwardRef<OrderViewport3DHandle, OrderViewport3DProps>(function OrderViewport3D(props, ref) {
  const { product, filaments } = props;
  const [model, setModel] = useState<OrderModel | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const generation = useSyncExternalStore(subscribeModelGeneration, () => modelGeneration);
  const vpRef = useRef<ThumbnailViewportHandle | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [lights, setLights] = useState({ key: 900, fill: 350, ambient: 280 });

  useEffect(() => {
    let alive = true;
    setModel(null);
    setFailed(null);
    loadOrderModel(product, filaments)
      .then((m) => {
        if (!alive) return;
        setLights(m.lights);
        setModel(m);
      })
      .catch((e) => {
        console.error("Order 3D view: could not load the model", e);
        if (alive) setFailed(e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id, partsKey(product), generation]);

  const usable = !!model && !model.missingMeshes.length && drawable(model).length > 0;
  useEffect(() => { propsRef.current.onAvailableChange?.(usable); }, [usable]);
  const resetTarget = (m: OrderModel) =>
    cloneCam(resolveCamera(m, propsRef.current.resetCamera, propsRef.current.product.id) ?? m.defaultCamera);
  const startCamera = useMemo(
    () => (model ? cloneCam(resolveCamera(model, props.initialCamera, props.product.id) ?? model.defaultCamera) : null),
    // Only when the model (re)loads: later prop changes must not yank the user's view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model]
  );

  // Place the camera once the viewport has mounted with this model.
  useLayoutEffect(() => {
    if (usable && startCamera) vpRef.current?.setCamera(cloneCam(startCamera));
  }, [usable, startCamera]);

  const colorKey = model ? model.parts.map((p) => props.partColors[p.id] || p.defaultHex).join(",") : "";
  const inscriptionText = props.inscription ?? "";
  const preview = useMemo(() => {
    if (!model) return null;
    return buildInscriptionPreviewMesh({
      text: inscriptionText,
      config: model.inscription,
      supportsCustomText: model.supportsCustomText,
      parts: model.parts,
      camera: model.defaultCamera,
      partColors: props.partColors,
      defaultHexes: Object.fromEntries(model.parts.map((p) => [p.id, p.defaultHex])),
    });
    // Colors and text are the only live inputs; placement is from the product default angle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, inscriptionText, colorKey]);
  const layers: StudioPartLayer[] = useMemo(() => {
    const list: StudioPartLayer[] = (model?.parts || []).map((p) => ({
      id: p.id,
      name: p.name,
      filamentName: "",
      filamentHex: props.partColors[p.id] || p.defaultHex,
      visible: p.visible,
      meshPositions: p.positions,
      meshIndices: p.indices,
    }));
    if (preview?.mesh) {
      list.push({
        id: preview.mesh.id,
        name: preview.mesh.name,
        filamentName: "",
        filamentHex: preview.mesh.hex,
        visible: true,
        meshPositions: preview.mesh.positions,
        meshIndices: preview.mesh.indices,
        pickIgnore: true,
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, colorKey, preview]);
  const pickableIds = useMemo(() => (model?.parts || []).filter((p) => p.selectable).map((p) => p.id), [model]);
  const selectedIds = useMemo(() => props.selectedPartIds || [], [(props.selectedPartIds || []).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Camera reporting: after interactions settle, and once more on unmount.
  const settleTimer = useRef(0);
  const report = () => {
    const cam = vpRef.current?.getCamera();
    if (cam) propsRef.current.onCameraChange?.(cam);
  };
  const scheduleReport = () => {
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(report, 220);
  };
  useLayoutEffect(() => () => { window.clearTimeout(settleTimer.current); report(); }, []);

  useImperativeHandle(ref, () => ({
    capture(size = 1024, opts = {}) {
      const vp = vpRef.current;
      if (!vp || !model || !usable) return null;
      const pngDataUrl = vp.capture(size);
      if (!pngDataUrl) return null;
      const cam = fitted(vp.getCamera());
      return {
        pngDataUrl,
        layers: opts.layers === true
          ? vp.captureLayers(size).map((l, i) => ({ partId: l.id, dataUrl: l.dataUrl, compositeZ: i }))
          : [],
        camera: cam,
        partColors: colorsWithDefaults(model, propsRef.current.partColors),
        size,
        renderVersion: 1,
      };
    },
    getCamera: () => vpRef.current?.getCamera() ?? null,
    resetView: () => {
      if (model) vpRef.current?.setCamera(resetTarget(model));
      scheduleReport();
    },
  }), [model, usable]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!usable) {
    return (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
        {props.fallback}
        {(() => {
          const note = failed
            ? `Couldn't load the 3D model: ${failed}`
            : !model
              ? "Loading 3D view…"
              : "This product has no 3D model yet. Re-import it in the Product Editor to view it in 3D.";
          return (
            <div role="status" style={{ position: "absolute", bottom: 8, left: 8, right: 8, textAlign: "center", fontSize: 11, color: "color-mix(in srgb, canvastext 60%, transparent)" }}>
              {note}
            </div>
          );
        })()}
      </div>
    );
  }

  return (
    <div
      style={{ width: "100%", height: "100%", display: "flex", minHeight: 0 }}
      onPointerUpCapture={scheduleReport}
      onWheelCapture={scheduleReport}
      onKeyUpCapture={scheduleReport}
    >
      <ThumbnailViewport
        ref={vpRef}
        parts={layers}
        selectedIds={selectedIds}
        backdrop="light"
        showGrid={false}
        shading="standard"
        manipulate="model"
        onManipulate={() => {}}
        onShowGrid={() => {}}
        onBackdrop={() => {}}
        onShading={() => {}}
        keyIntensity={lights.key}
        fillIntensity={lights.fill}
        ambientIntensity={lights.ambient}
        onLightIntensities={(key, fill, ambient) => setLights({ key, fill, ambient })}
        onPresetCleared={() => {}}
        lightDirection={startCamera?.light ?? null}
        onFrame={(preset, reset) => {
          if (reset) vpRef.current?.setCamera(resetTarget(model!));
          else vpRef.current?.applyFraming(preset, false);
          scheduleReport();
        }}
        framingToken={0}
        framingPreset={null}
        resetOnFrame={false}
        onPartClick={props.onPartClick ? (id, mods) => { if (id) propsRef.current.onPartClick?.(id, mods); } : undefined}
        pickableIds={pickableIds}
        hideAuthoringHud
        controlsCollapsed
        emptyMessage="This product has no 3D model yet. Re-import it in the Product Editor to view it in 3D."
      />
    </div>
  );
});

// ---------------------------------------------------------------------------------------
// Re-pose (order details)

export interface OrderRePoseModalProps {
  product: Product;
  filaments: FilamentSwatch[];
  /** The order line's part colors (part id → hex). */
  partColors: Record<string, string>;
  /** The line's saved order camera, or a website line's raw view_camera; null = product angle. */
  savedCamera?: CameraState | ViewCamera | null;
  title?: string;
  onClose: () => void;
  /** New picture + camera for this order line. */
  onSave: (capture: OrderThumbnailCapture) => void | Promise<void>;
}

export const OrderRePoseModal: React.FC<OrderRePoseModalProps> = (props) => {
  const vpRef = useRef<OrderViewport3DHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const shot = vpRef.current?.capture(1024);
    if (!shot) { setError("This product has no 3D model yet, so the picture can't be re-posed. Re-import its model in the Product Editor."); return; }
    setBusy(true);
    try { await props.onSave(shot); props.onClose(); }
    catch (e) {
      console.error("Re-pose: could not save the picture", e);
      setError("Couldn't save this picture. Try again, or close and re-open the order.");
    }
    finally { setBusy(false); }
  };
  // Escape cancels (like the Cancel button). A stray click on the backdrop does nothing, so a
  // turned model isn't thrown away by accident.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) { e.preventDefault(); closeRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="fp-modal-backdrop">
      <div className="fp-modal-window" style={{ width: "min(760px, 94vw)", height: "min(820px, 92vh)" }}
        onClick={(e) => e.stopPropagation()} role="dialog" aria-label={props.title || "Re-pose picture"}>
        <div className="fp-modal-header">
          <button className="fp-btn" onClick={props.onClose}>Cancel</button>
          <div className="fp-modal-title">{props.title || `Re-pose picture — ${props.product.name}`}</div>
          <button className="fp-btn fp-btn-primary" disabled={busy} onClick={() => void save()}>Save Picture</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ flex: 1, minHeight: 0, borderRadius: 12, overflow: "hidden", display: "flex" }}>
            <OrderViewport3D ref={vpRef} product={props.product} filaments={props.filaments} partColors={props.partColors}
              initialCamera={props.savedCamera ?? null} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "color-mix(in srgb, canvastext 60%, transparent)" }}>
            <span style={{ flex: 1 }}>Drag to turn the model. The picture is saved from this angle.</span>
            <button className="fp-btn fp-btn-sm" onClick={() => vpRef.current?.resetView()}>Product angle</button>
          </div>
          {error && <div style={{ color: "#ff453a", fontSize: 13 }}>{error}</div>}
        </div>
      </div>
    </div>
  );
};

export default OrderViewport3D;

// Moved to smaller modules; re-exported so existing importers keep working.
export { cameraFromJson, clearOrderModelCache } from "./orderModelCache";
