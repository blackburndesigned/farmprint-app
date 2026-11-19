import { ThumbnailViewport } from "./studio/ThumbnailViewport";

export default ThumbnailViewport;

// Moved to smaller modules; re-exported so existing importers keep working.
export { framingPresetName, FRAMING_PRESETS } from "./studio/viewportTypes";
export type { EdgeSegment3D, StudioMeshHealth, StudioPartLayer, ViewportBackdrop, MeshShading, ManipulateTarget, ThumbnailViewportHandle, ThumbnailViewportProps } from "./studio/viewportTypes";
export { MOD_KEY, VIEWPORT_HINT, nudgeOrbit, nudgeRoll, JOG_DEG_PER_SEC, JOG_ZOOM_PER_SEC, JOG_PAN_PX_PER_SEC, jogRamp, startJog, nudgeZoom, nudgePan, lightToAngles, anglesToLight } from "./studio/viewportGestures";
export { pickPartAt, nextFrame } from "./studio/viewportDrawing";
export { ThumbnailViewport } from "./studio/ThumbnailViewport";
export { renderPartTileCamera, PartOrbitThumb } from "./studio/PartOrbitThumb";
