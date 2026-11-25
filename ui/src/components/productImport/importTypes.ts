import { StudioMeshHealth } from "../StudioViewport3D";
import { CameraState, clampedZoom, defaultCamera } from "../../viewportCamera";
import { CATALOG_BASE } from "../../partThumbnails";
import { FilamentSwatch } from "../../types";
export type ImportedProductCatalogDraft = any;

export type StudioPartRole = "Prints" | "Color only" | "Picture only";

export interface ImportedStudioPart {
  id: string;
  partName: string;
  sourceFileName: string;
  role: StudioPartRole;
  showInPicture: boolean;
  defaultColorName: string;
  defaultColorHex: string;
  grams: number;
  printMinutes: number;
  printerType: string;
  meshPositions: number[];
  meshIndices: number[];
  meshHealth: StudioMeshHealth;
  bakedThumbnailDataUrl: string;
  /** Untinted render saved as the part picture under catalog/<productId>/parts/. */
  neutralThumbnailDataUrl?: string;
  /** Camera the user left in this part's tile (angle, zoom, pan). The saved part picture
   *  uses it. Null/absent = default ¾ tile view. Saved as part_icon_cameras. */
  thumbnailCamera?: CameraState | null;
}

/** part_icon_cameras row (Swift: direction/up/zoom; plus pan/light). Reads camelCase or snake_case. */
export function partIconCameraFromJson(input: unknown): CameraState | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const nums = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : []);
  const direction = nums(raw.direction);
  const up = nums(raw.up);
  if (direction.length < 3 || up.length < 3) return null;
  let pan = nums(raw.pan);
  if (pan.length < 3) pan = [0, 0, 0];
  let light = nums(raw.light);
  if (light.length < 3) light = [...defaultCamera().light];
  const zoom = Number(raw.zoom);
  return {
    direction: [direction[0], direction[1], direction[2]],
    up: [up[0], up[1], up[2]],
    zoom: Number.isFinite(zoom) && zoom > 0 ? clampedZoom(zoom) : 1,
    pan: [pan[0], pan[1], pan[2]],
    light: [light[0], light[1], light[2]],
  };
}

export function partIconCameraToJson(c: CameraState): Record<string, unknown> {
  const row: Record<string, unknown> = { direction: [...c.direction], up: [...c.up] };
  if (c.zoom !== 1) row.zoom = c.zoom;
  if (c.pan.some((v) => v !== 0)) row.pan = [...c.pan];
  row.light = [...c.light]; // read back by partIconCameraFromJson, so a tile keeps its light
  return row;
}

/** Saved tile cameras for a product: catalog.json part_icon_cameras/partIconCameras,
 *  else parts/part_icon_cameras.json written by save_product_thumbnail. Keyed by part id or name. */
export async function loadPartIconCameras(productId: string): Promise<Record<string, unknown>> {
  const pick = (obj: unknown) => {
    const o = obj as { part_icon_cameras?: unknown; partIconCameras?: unknown } | null | undefined;
    return o?.part_icon_cameras ?? o?.partIconCameras;
  };
  try {
    const res = await fetch(`${CATALOG_BASE}/catalog.json`);
    if (res.ok) {
      const data = await res.json();
      const prod = ((data?.products || []) as Array<{ id?: unknown } | null>).find((p) => String(p?.id) === productId);
      const cams = pick(prod);
      if (cams && typeof cams === "object") return cams as Record<string, unknown>;
    }
  } catch {
    // no catalog.json entry; try the per-product file
  }
  try {
    const res = await fetch(`${CATALOG_BASE}/${encodeURIComponent(productId)}/parts/part_icon_cameras.json`);
    if (res.ok) {
      const data = await res.json();
      const cams = pick(data) ?? data;
      if (cams && typeof cams === "object") return cams as Record<string, unknown>;
    }
  } catch {
    // no saved part cameras
  }
  return {};
}

export interface InscriptionStudioConfig {
  enabled: boolean;
  targetPartName: string;
  sampleText: string;
  fontFamily: string;
  areaWidthMm: number;
  areaHeightMm: number;
  depthMm: number;
  maxChars: number;
  rotationDeg: number;
  mirrorX: boolean;
  upsideDown: boolean;
  /** When true (the default), preview letters follow the target part's surface. */
  wrapOnSurface?: boolean;
  align?: "left" | "center" | "right";
  /** Optional saved pose in model millimetres. Inferred from the target part when omitted. */
  origin?: [number, number, number];
  normal?: [number, number, number];
  tangent?: [number, number, number];
  placement?: {
    origin?: [number, number, number];
    normal?: [number, number, number];
    tangent?: [number, number, number];
    wrapOnSurface?: boolean;
    align?: "left" | "center" | "right";
  };
}

export interface CreatedCatalogProductPayload {
  id: string;
  name: string;
  sku: string;
  category: string;
  basePriceUsd: number;
  shippingBox: "Small" | "Medium" | "Large";
  lightingPreset: "Soft" | "Standard" | "Hard";
  cameraPreset: "Iso" | "Front" | "Top" | "Right";
  parts: ImportedStudioPart[];
  inscription: InscriptionStudioConfig;
  compositeThumbnailDataUrl?: string;
  /** Per-part neutral layers rendered with the same camera as compositeThumbnailDataUrl
   *  (back to front), so order thumbnails can be recolored live. */
  compositeLayers?: Array<{ partId?: string; partName: string; dataUrl: string; compositeZ: number }>;
  /** Main-viewport lighting chosen in the editor (persisted in editor.json). */
  studioLighting?: { key: number; fill: number; ambient: number; light?: [number, number, number] };
  /** Viewport camera the product picture was captured from (persisted in editor.json as
   *  viewCamera) so New Order's 3D builder opens at the same angle. */
  viewCamera?: CameraState;
}

export interface ProductImportModal3DProps {
  open: boolean;
  onClose: () => void;
  /** May return a promise; resolving `false` (save failed or cancelled) keeps the editor open. */
  onCreateProduct: (product: CreatedCatalogProductPayload) => void | boolean | Promise<boolean | void>;
  onSaveProduct?: (payload: any) => void;
  /** When set, the sheet edits this product instead of creating a new one. */
  editingDraft?: CreatedCatalogProductPayload | null;
  /** Shop filament library. The part color menu lists these spools. */
  filaments?: FilamentSwatch[];
}
