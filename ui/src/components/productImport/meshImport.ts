import { parseMeshFile } from "../../tauriInvoke";
import { analyzeClientMeshHealth } from "./meshHealth";
import { type ParsedMeshObject, type SlicedPlateInfo, parse3mfBuffer, parseSliceInfoConfig, parseStlSoup, readZipTextEntries, usableMeshes } from "../../meshParsers";

/** Above this a part still loads, but the editor warns that it will be slow. */
export const LARGE_MESH_TRIANGLES = 1_000_000;

export async function meshesFromFile(filename: string, buffer: ArrayBuffer): Promise<ParsedMeshObject[]> {
  let serverError = "";
  try {
    const serverParts = usableMeshes(await parseMeshFile(filename, buffer));
    if (serverParts.length > 0) return serverParts;
    serverError = `No triangles found in ${filename}.`;
  } catch (err) {
    serverError = err instanceof Error ? err.message : String(err);
  }

  const ext = filename.toLowerCase().split(".").pop() || "";
  const stem = filename.replace(/\.(stl|3mf)$/i, "").trim() || "Part";
  const local = usableMeshes(
    ext === "3mf"
      ? await parse3mfBuffer(buffer, stem)
      : [{ name: stem, ...parseStlSoup(buffer) }]
  );
  if (local.length > 0) return local;
  throw new Error(serverError || `No triangles found in ${filename}.`);
}

export async function readSliceInfoFromBuffer(buffer: ArrayBuffer): Promise<SlicedPlateInfo[]> {
  try {
    const entries = await readZipTextEntries(buffer, (n) => n.endsWith("slice_info.config"));
    for (const xml of entries.values()) return parseSliceInfoConfig(xml);
  } catch {
    // not sliced
  }
  return [];
}

export function normalizeSlicedName(name: string): string {
  return (name || "").replace(/\.(stl|3mf|step|stp|obj)$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Map real sliced grams/minutes onto imported part names. A plate holding several parts is
 *  split by each part's mesh volume. Unmatched parts get nothing (stay blank). */
export function slicedEstimatesByName(
  plates: SlicedPlateInfo[],
  parts: { name: string; positions: number[]; indices: number[] }[]
): Map<string, { grams: number; minutes: number }> {
  const out = new Map<string, { grams: number; minutes: number }>();
  if (plates.length === 0) return out;
  const vol = new Map<string, number>();
  for (const p of parts) {
    const v = analyzeClientMeshHealth(p.positions, p.indices).volume_mm3 || 0;
    const k = normalizeSlicedName(p.name);
    vol.set(k, (vol.get(k) || 0) + v);
  }
  for (const plate of plates) {
    let names = plate.objectNames.map(normalizeSlicedName).filter((n) => vol.has(n));
    // One sliced plate whose object names don't match part names (parts of one object):
    // split the plate across every imported part.
    if (names.length === 0 && plates.length === 1) names = Array.from(vol.keys());
    if (names.length === 0 || (plate.weightGrams <= 0 && plate.predictionSeconds <= 0)) continue;
    const total = names.reduce((acc, n) => acc + (vol.get(n) || 0), 0);
    for (const n of names) {
      const share = total > 0 ? (vol.get(n) || 0) / total : 1 / names.length;
      out.set(n, {
        grams: Math.round(plate.weightGrams * share * 100) / 100,
        minutes: Math.round((plate.predictionSeconds / 60) * share),
      });
    }
  }
  return out;
}
