// Feature flags for controls whose Rust backend isn't ported yet.
// Flip to true once fp-mesh has working, tested code behind them.
export const FEATURES = {
  /** Inscription authoring in the Thumbnail Creator (placement, size, thickness, flips). */
  inscription3d: false,
  /** GLB / 3D preview export for the shop's 3D product page. No UI exists yet. */
  glbExport: false,
} as const;
