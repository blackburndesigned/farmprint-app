import { CameraState, FramingPreset, Vec3 } from "../../viewportCamera";

export interface EdgeSegment3D {
  start: [number, number, number];
  end: [number, number, number];
  kind: "open_boundary" | "non_manifold";
}

export interface StudioMeshHealth {
  vertex_count: number;
  triangle_count: number;
  shell_count: number;
  open_edge_count: number;
  non_manifold_edge_count: number;
  is_watertight: boolean;
  bounding_box_mm: [number, number, number];
  surface_area_mm2?: number;
  volume_mm3?: number;
  estimated_grams?: number;
  severity?: "ok" | "info" | "reimport";
  user_note?: string;
  problem_edge_segments?: EdgeSegment3D[];
}

export interface StudioPartLayer {
  id: string;
  name: string;
  filamentName: string;
  filamentHex: string;
  visible: boolean;
  health?: StudioMeshHealth;
  offsetMm?: [number, number, number];
  meshPositions?: number[];
  meshIndices?: number[];
}

export type ViewportBackdrop = "default" | "checker" | "dark" | "midGray" | "light";
export type MeshShading = "standard" | "depth" | "cel";
export type ManipulateTarget = "model" | "light";

export interface ThumbnailViewportHandle {
  capture: (size: number) => string;
  /** Each visible part rendered alone, neutral white with alpha, with the exact camera and
   *  framing of capture(), so the layers stack back into the product picture. */
  captureLayers: (size: number, opts?: { ids?: string[] }) => Array<{ id: string; dataUrl: string }>;
  /** captureLayers, yielding a frame between parts so the window stays responsive.
   *  `ids` limits it to those parts (e.g. only parts shown in the picture). */
  captureLayersAsync: (size: number, opts?: { ids?: string[]; onProgress?: (done: number, total: number) => void }) => Promise<Array<{ id: string; dataUrl: string }>>;
  applyFraming: (preset: FramingPreset, resetView: boolean) => void;
  getCamera: () => CameraState;
  setCamera: (camera: CameraState) => void;
}

export interface ThumbnailViewportProps {
  parts: StudioPartLayer[];
  selectedIds: string[];
  backdrop: ViewportBackdrop;
  showGrid: boolean;
  shading: MeshShading;
  manipulate: ManipulateTarget;
  onManipulate: (next: ManipulateTarget) => void;
  onShowGrid: (next: boolean) => void;
  onBackdrop: (next: ViewportBackdrop) => void;
  onShading: (next: MeshShading) => void;
  keyIntensity: number;
  fillIntensity: number;
  ambientIntensity: number;
  onLightIntensities: (key: number, fill: number, ambient: number) => void;
  onPresetCleared: () => void;
  framingToken: number;
  /** Key-light direction (world). Restored from editor.json; reported when changed. */
  lightDirection?: Vec3 | null;
  onLightDirection?: (light: Vec3) => void;
  /** Overlay preset/reset buttons route here so the editor's chips stay in sync. */
  onFrame?: (preset: FramingPreset, resetView: boolean) => void;
  framingPreset: FramingPreset | null;
  resetOnFrame: boolean;
  /** Optional click-to-pick (New Order builder). Called on a tap (no drag) with the part
   *  under the pointer — nearest visible part, by part id — or null for empty space.
   *  Parts not in `pickableIds` block the ray but report null. */
  onPartClick?: (partId: string | null, mods: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
  /** Part ids that can be picked/hovered. Default: every visible part. */
  pickableIds?: string[];
  /** Hide the authoring HUD (Model/Light, grid, backdrop, shading) and the Key-light sliders. */
  hideAuthoringHud?: boolean;
  /** Start with the View controls panel collapsed. */
  controlsCollapsed?: boolean;
  /** Text shown when there is nothing to draw. */
  emptyMessage?: string;
}

export const PRESETS: FramingPreset[] = ["threeQuarter", "front", "top"];

export function framingPresetName(preset: FramingPreset): string {
  return preset === "threeQuarter" ? "¾" : preset === "front" ? "Front" : "Top";
}

export const FRAMING_PRESETS = PRESETS;
