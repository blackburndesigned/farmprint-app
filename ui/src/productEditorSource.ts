// Saves and reloads the editor source for a product (part meshes + editor settings)
// under catalog/<productId>/, so an existing product can be reopened in the editor.
import { analyzeClientMeshHealth } from "./components/productImport/meshHealth";
import {
  CreatedCatalogProductPayload,
  ImportedStudioPart,
  InscriptionStudioConfig,
  partIconCameraFromJson,
} from "./components/productImport/importTypes";
import { CATALOG_BASE } from "./partThumbnails";
import { parseStl } from "./meshParsers";

/** Shared STL reader; kept exported here for existing importers. */
export { parseStl };
import { FilamentSwatch, Product } from "./types";

/** Same rule as safe_part_stem in src-tauri (file names under parts/). */
export function editorPartStem(raw: string): string {
  let stem = "";
  for (const c of raw) {
    if (/[A-Za-z0-9]/.test(c) && c.charCodeAt(0) < 128) stem += c.toLowerCase();
    else if (!stem.endsWith("_")) stem += "_";
  }
  stem = stem.replace(/^_+|_+$/g, "");
  return stem || "part";
}

/** Unique file stem per part id: the first part with a name keeps the plain stem
 *  (same file older saves used), later same-named parts get `<stem>_2`, `<stem>_3`, … */
export function assignPartStems(parts: Array<{ id: string; partName: string }>): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const p of parts) {
    const base = editorPartStem(p.partName);
    let stem = base;
    for (let n = 2; used.has(stem); n++) stem = `${base}_${n}`;
    used.add(stem);
    out.set(p.id, stem);
  }
  return out;
}

/** Binary STL (base64) from indexed triangles. */
export function meshToStlBase64(positions: number[], indices: number[]): string {
  const tris = Math.floor(indices.length / 3);
  if (!tris || !positions.length) return "";
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris, true);
  let o = 84;
  for (let t = 0; t < tris; t++) {
    const v = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]].map((i) => [
      positions[i * 3] ?? 0,
      positions[i * 3 + 1] ?? 0,
      positions[i * 3 + 2] ?? 0,
    ]);
    const ux = v[1][0] - v[0][0], uy = v[1][1] - v[0][1], uz = v[1][2] - v[0][2];
    const wx = v[2][0] - v[0][0], wy = v[2][1] - v[0][1], wz = v[2][2] - v[0][2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const n of [nx, ny, nz]) { dv.setFloat32(o, n, true); o += 4; }
    for (const p of v) for (const c of p) { dv.setFloat32(o, c, true); o += 4; }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** editor.json: everything the editor needs except meshes and pictures. */
export function buildEditorJson(payload: CreatedCatalogProductPayload): string {
  const stems = assignPartStems(payload.parts);
  return JSON.stringify({
    version: 1,
    id: payload.id,
    name: payload.name,
    sku: payload.sku,
    category: payload.category,
    basePriceUsd: payload.basePriceUsd,
    shippingBox: payload.shippingBox,
    lightingPreset: payload.lightingPreset,
    cameraPreset: payload.cameraPreset,
    inscription: payload.inscription,
    studioLighting: payload.studioLighting,
    viewCamera: payload.viewCamera,
    parts: payload.parts.map((p) => ({
      id: p.id,
      partName: p.partName,
      sourceFileName: p.sourceFileName,
      role: p.role,
      showInPicture: p.showInPicture,
      defaultColorName: p.defaultColorName,
      defaultColorHex: p.defaultColorHex,
      grams: p.grams,
      printMinutes: p.printMinutes,
      printerType: p.printerType,
      meshStem: stems.get(p.id) || editorPartStem(p.partName),
    })),
  });
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function fetchMesh(productId: string, stems: string[]) {
  const base = `${CATALOG_BASE}/${encodeURIComponent(productId)}`;
  for (const stem of stems) {
    for (const rel of [`parts/${stem}.stl`, `meshes/${stem}.stl`]) {
      try {
        const res = await fetch(`${base}/${rel}`);
        if (!res.ok) continue;
        const mesh = parseStl(await res.arrayBuffer());
        if (mesh.indices.length) return mesh;
      } catch {
        // try the next stem
      }
    }
  }
  return null;
}

const DEFAULT_INSCRIPTION: InscriptionStudioConfig = {
  enabled: false,
  targetPartName: "",
  sampleText: "SAMPLE",
  fontFamily: "Arial Rounded MT Bold",
  areaWidthMm: 28,
  areaHeightMm: 8,
  depthMm: 0.8,
  maxChars: 14,
  rotationDeg: 0,
  mirrorX: false,
  upsideDown: false,
};

/** Builds an editor draft for an existing product from its saved files and catalog row.
 *  `missingMeshes` lists parts whose 3D model was never saved (older imports). */
export async function loadProductEditorDraft(
  product: Product,
  filaments: FilamentSwatch[]
): Promise<{ draft: CreatedCatalogProductPayload; missingMeshes: string[] }> {
  const id = product.id;
  const saved = await fetchJson(`${CATALOG_BASE}/${encodeURIComponent(id)}/editor.json`);
  const camsFile = await fetchJson(`${CATALOG_BASE}/${encodeURIComponent(id)}/parts/part_icon_cameras.json`);
  const cams: Record<string, any> = camsFile?.part_icon_cameras ?? camsFile ?? {};
  const savedParts: any[] = Array.isArray(saved?.parts) ? saved.parts : [];
  const box = (product.default_box_name || "").split(" ")[0];
  const missingMeshes: string[] = [];

  const sources = product.parts.length
    ? [...product.parts].sort((a, b) => a.sort_order - b.sort_order).map((cp) => {
        const sp = savedParts.find((s) => s.id === cp.id) ?? savedParts.find((s) => s.partName === cp.name);
        return { cp, sp };
      })
    : savedParts.map((sp) => ({ cp: null as any, sp }));

  const parts: ImportedStudioPart[] = [];
  for (const { cp, sp } of sources) {
    const partName: string = cp?.name ?? sp?.partName ?? "Part";
    const fil = cp ? filaments.find((f) => f.id === cp.default_filament_id) : undefined;
    const fileStem = cp?.mesh_file ? cp.mesh_file.replace(/\.[^.]+$/, "") : "";
    // Saved stems (editor.json meshStem, catalog mesh_file) are per part; the name stem is
    // the fallback for products saved before same-named parts got their own files.
    const stems = Array.from(new Set([sp?.meshStem, fileStem, editorPartStem(partName)].filter(Boolean) as string[]));
    const mesh = await fetchMesh(id, stems);
    if (!mesh) missingMeshes.push(partName);
    const positions = mesh?.positions ?? [];
    const indices = mesh?.indices ?? [];
    const partId: string = cp?.id ?? sp?.id ?? `${id}-${parts.length}`;
    const neutral = `${CATALOG_BASE}/${encodeURIComponent(id)}/parts/${stems[0]}.png`;
    parts.push({
      id: partId,
      partName,
      sourceFileName: sp?.sourceFileName ?? cp?.mesh_file ?? "",
      role: cp ? (cp.is_tracked ? "Prints" : cp.is_color_only ? "Color only" : "Picture only") : sp?.role ?? "Prints",
      showInPicture: sp?.showInPicture ?? true,
      defaultColorName: fil?.name ?? sp?.defaultColorName ?? "",
      defaultColorHex: fil?.hex ?? sp?.defaultColorHex ?? "#888888",
      grams: cp?.grams ?? sp?.grams ?? 0,
      printMinutes: cp?.print_minutes ?? sp?.printMinutes ?? 0,
      printerType: sp?.printerType ?? "",
      meshPositions: positions,
      meshIndices: indices,
      meshHealth: analyzeClientMeshHealth(positions, indices),
      bakedThumbnailDataUrl: neutral,
      neutralThumbnailDataUrl: undefined,
      thumbnailCamera: partIconCameraFromJson(cams[partId] ?? cams[partName]),
    });
  }

  const draft: CreatedCatalogProductPayload = {
    id,
    name: product.name || saved?.name || "",
    sku: product.sku || saved?.sku || "",
    category: saved?.category ?? "",
    basePriceUsd: product.price_cents ? product.price_cents / 100 : saved?.basePriceUsd ?? 0,
    shippingBox: (["Small", "Medium", "Large"].includes(box) ? box : saved?.shippingBox ?? "Small") as any,
    lightingPreset: saved?.lightingPreset ?? "Standard",
    cameraPreset: saved?.cameraPreset ?? "Iso",
    parts,
    studioLighting: saved?.studioLighting,
    viewCamera: saved?.viewCamera ?? undefined,
    inscription: { ...DEFAULT_INSCRIPTION, ...(saved?.inscription || {}), enabled: product.supports_custom_text || !!saved?.inscription?.enabled },
  };
  return { draft, missingMeshes };
}
