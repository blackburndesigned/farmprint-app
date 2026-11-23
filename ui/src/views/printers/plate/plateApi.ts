import { invoke } from "../../../tauriInvoke";
import type {
  ArrangeSettings,
  BedSize,
  FaceCandidate,
  FaceMode,
  FitSummary,
  Footprint,
  Placement,
  PlateCheck,
  PlatePart,
  PreparedPlate,
  Quat,
} from "./plateModel";

type PartArg = { unit_id: string; orientation: Quat; placement?: Placement; pinned?: boolean };
const partArgs = (parts: PlatePart[], pinned?: Set<string>): PartArg[] =>
  parts.map((p) => ({ unit_id: p.unit_id, orientation: p.orientation, placement: p.placement, pinned: pinned?.has(p.unit_id) ?? false }));

export const platePrepare = (unitIds: string[], printerId: string) =>
  invoke<PreparedPlate>("plate_prepare", { unit_ids: unitIds, printer_id: printerId });

export const plateFitSummary = (unitIds: string[], printerIds: string[]) =>
  invoke<Record<string, FitSummary>>("plate_fit_summary", { unit_ids: unitIds, printer_ids: printerIds });

export const plateArrange = (parts: PlatePart[], bed: BedSize, settings: ArrangeSettings, pinned?: Set<string>) =>
  invoke<{ placements: Record<string, Placement>; footprints: Record<string, Footprint>; check: PlateCheck }>("plate_arrange", {
    parts: partArgs(parts, pinned),
    bed,
    settings,
  });

export const plateCheck = (parts: PlatePart[], bed: BedSize, settings: ArrangeSettings) =>
  invoke<PlateCheck>("plate_check", { parts: partArgs(parts), bed, settings });

export const plateAutoOrient = (unitIds: string[]) =>
  invoke<Record<string, { orientation: Quat; footprint: Footprint }>>("plate_auto_orient", { unit_ids: unitIds });

export const plateFaceCandidates = (unitId: string, mode: FaceMode) =>
  invoke<FaceCandidate[]>("plate_face_candidates", { unit_id: unitId, mode });
