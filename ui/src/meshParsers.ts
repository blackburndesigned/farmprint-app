// Browser-side mesh readers: STL (binary or ASCII), 3MF (zip or raw model XML) and the
// slicer's slice_info.config. The Rust reader (fp-mesh, `parse_mesh_file`) is the main path;
// these are the one shared copy used by the product editor (catalog meshes) and by the import
// sheet when the Rust reader is unavailable. Size and number rules mirror fp-mesh.

/** Number in an ASCII STL `vertex` line: accepts "5", "5.", ".5", "-1.5e+3" (as Rust's f32 parse does). */
const STL_NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const STL_VERTEX_RE = new RegExp(String.raw`vertex\s+(${STL_NUM})\s+(${STL_NUM})\s+(${STL_NUM})`, "g");

/** Triangle count when `buf` is a binary STL, else 0. Same size rule as the Rust reader: the
 *  exact size, or up to 512 bytes of trailing padding (some exporters). */
export function binaryStlTriangleCount(buf: ArrayBuffer): number {
  if (buf.byteLength < 84) return 0;
  const tris = new DataView(buf).getUint32(80, true);
  const need = 84 + tris * 50;
  return tris > 0 && need <= buf.byteLength && need + 512 >= buf.byteLength ? tris : 0;
}

/** Calls `corner` for every triangle corner of a binary or ASCII STL, three per triangle.
 *  An incomplete trailing ASCII triangle is dropped. */
function forEachStlCorner(buf: ArrayBuffer, corner: (x: number, y: number, z: number) => void) {
  const tris = binaryStlTriangleCount(buf);
  if (tris > 0) {
    const dv = new DataView(buf);
    for (let t = 0; t < tris; t++) {
      const o = 84 + t * 50 + 12; // skip the normal
      for (let k = 0; k < 3; k++) {
        corner(dv.getFloat32(o + k * 12, true), dv.getFloat32(o + k * 12 + 4, true), dv.getFloat32(o + k * 12 + 8, true));
      }
    }
    return;
  }
  const text = new TextDecoder().decode(new Uint8Array(buf));
  const corners: number[] = [];
  STL_VERTEX_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STL_VERTEX_RE.exec(text))) corners.push(Number(m[1]), Number(m[2]), Number(m[3]));
  const whole = corners.length - (corners.length % 9);
  for (let i = 0; i < whole; i += 3) corner(corners[i], corners[i + 1], corners[i + 2]);
}

/** STL as a triangle soup: every triangle keeps its own three corners (like fp-mesh). */
export function parseStlSoup(buf: ArrayBuffer): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  forEachStlCorner(buf, (x, y, z) => {
    indices.push(positions.length / 3);
    positions.push(x, y, z);
  });
  return { positions, indices };
}

/** STL as indexed triangles with exactly-equal corners welded into one vertex. */
export function parseStl(buf: ArrayBuffer): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  // Exact-match weld keyed by a numeric hash (chained on collision), not "x,y,z" strings.
  const head = new Map<number, number>();
  const chain: number[] = [];
  forEachStlCorner(buf, (x, y, z) => {
    const h = (Math.imul(Math.round(x * 4096) | 0, 73856093) ^ Math.imul(Math.round(y * 4096) | 0, 19349663) ^ Math.imul(Math.round(z * 4096) | 0, 83492791)) | 0;
    let idx = head.get(h);
    while (idx !== undefined && idx >= 0) {
      if (positions[idx * 3] === x && positions[idx * 3 + 1] === y && positions[idx * 3 + 2] === z) break;
      idx = chain[idx];
    }
    if (idx === undefined || idx < 0) {
      idx = positions.length / 3;
      positions.push(x, y, z);
      const first = head.get(h);
      chain[idx] = first === undefined ? -1 : first;
      head.set(h, idx);
    }
    indices.push(idx);
  });
  return { positions, indices };
}

export interface ParsedMeshObject {
  name: string;
  positions: number[];
  indices: number[];
}

export function parse3mfXmlModels(xml: string, fallbackName: string): ParsedMeshObject[] {
  const out: ParsedMeshObject[] = [];
  const objRegex = /<object\b([^>]*)>([\s\S]*?)<\/object>/gi;
  let objMatch: RegExpExecArray | null;
  let idx = 0;
  while ((objMatch = objRegex.exec(xml)) !== null) {
    idx++;
    const attrs = objMatch[1] || "";
    const body = objMatch[2] || "";
    if (!body.includes("<mesh")) continue;
    const nameMatch = attrs.match(/\bname=["']([^"']+)["']/i);
    const idMatch = attrs.match(/\bid=["']([^"']+)["']/i);
    const objName = nameMatch?.[1]?.trim() || (idMatch?.[1] ? `${fallbackName} #${idMatch[1]}` : `${fallbackName} Part ${idx}`);

    const positions: number[] = [];
    const vertRegex = /<vertex\b[^>]*\bx=["']([^"']+)["'][^>]*\by=["']([^"']+)["'][^>]*\bz=["']([^"']+)["']/gi;
    let vm: RegExpExecArray | null;
    while ((vm = vertRegex.exec(body)) !== null) {
      positions.push(parseFloat(vm[1]) || 0, parseFloat(vm[2]) || 0, parseFloat(vm[3]) || 0);
    }

    const indices: number[] = [];
    const triRegex = /<triangle\b[^>]*\bv1=["'](\d+)["'][^>]*\bv2=["'](\d+)["'][^>]*\bv3=["'](\d+)["']/gi;
    let tm: RegExpExecArray | null;
    const vCount = Math.floor(positions.length / 3);
    while ((tm = triRegex.exec(body)) !== null) {
      const a = parseInt(tm[1], 10);
      const b = parseInt(tm[2], 10);
      const c = parseInt(tm[3], 10);
      if (a < vCount && b < vCount && c < vCount) {
        indices.push(a, b, c);
      }
    }

    if (positions.length >= 9 && indices.length >= 3) {
      out.push({ name: objName, positions, indices });
    }
  }
  return out;
}

/** Parts with real triangles and only finite coordinates (NaN/Inf corners are rejected, as
 *  in the Rust reader, so the browser fallback can't sneak them back in). */
export function usableMeshes(parts: ParsedMeshObject[]): ParsedMeshObject[] {
  return parts.filter((part) => {
    if (part.positions.length < 9 || part.indices.length < 3) return false;
    for (let i = 0; i < part.positions.length; i++) if (!Number.isFinite(part.positions[i])) return false;
    return true;
  });
}

async function inflateZipEntry(slice: Uint8Array, compression: number): Promise<Uint8Array> {
  if (compression === 0) return slice;
  if (compression === 8 && typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(slice));
    writer.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }
  return new Uint8Array(0);
}

/** Text entries of a ZIP (3MF) whose lowercased name passes `want`. Uses the central directory
 *  (handles Bambu's data-descriptor archives), falling back to a local-header scan. */
export async function readZipTextEntries(buffer: ArrayBuffer, want: (lowerName: string) => boolean): Promise<Map<string, string>> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  const add = async (name: string, compression: number, dataStart: number, compSize: number) => {
    if (!want(name.toLowerCase()) || compSize <= 0 || dataStart + compSize > bytes.byteLength) return;
    try {
      const raw = await inflateZipEntry(bytes.subarray(dataStart, dataStart + compSize), compression);
      if (raw.length > 0) out.set(name, dec.decode(raw));
    } catch {
      // skip unreadable entry
    }
  };
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd >= 0) {
    const count = view.getUint16(eocd + 10, true);
    let cd = view.getUint32(eocd + 16, true);
    if (cd !== 0xffffffff && cd < bytes.byteLength) {
      for (let n = 0; n < count && cd + 46 <= bytes.byteLength; n++) {
        if (view.getUint32(cd, true) !== 0x02014b50) break;
        const compression = view.getUint16(cd + 10, true);
        const compSize = view.getUint32(cd + 20, true);
        const nameLen = view.getUint16(cd + 28, true);
        const extraLen = view.getUint16(cd + 30, true);
        const commentLen = view.getUint16(cd + 32, true);
        const local = view.getUint32(cd + 42, true);
        const name = dec.decode(bytes.subarray(cd + 46, cd + 46 + nameLen)).replace(/^\/+/, "");
        if (local + 30 <= bytes.byteLength && view.getUint32(local, true) === 0x04034b50) {
          const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
          await add(name, compression, start, compSize);
        }
        cd += 46 + nameLen + extraLen + commentLen;
      }
      if (out.size > 0) return out;
    }
  }
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const compression = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const name = dec.decode(bytes.subarray(offset + 30, offset + 30 + nameLen)).replace(/^\/+/, "");
    const dataStart = offset + 30 + nameLen + extraLen;
    if (compSize === 0) break;
    await add(name, compression, dataStart, compSize);
    offset = dataStart + compSize;
  }
  return out;
}

export interface SlicedPlateInfo {
  index: number;
  predictionSeconds: number;
  weightGrams: number;
  objectNames: string[];
}

/** Parse Bambu Studio / OrcaSlicer `Metadata/slice_info.config` (mirrors fp-mesh `slice_info`). */
export function parseSliceInfoConfig(xml: string): SlicedPlateInfo[] {
  const unesc = (v: string) => v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const attr = (tag: string, key: string) => tag.match(new RegExp(`\\b${key}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  const plates: SlicedPlateInfo[] = [];
  const plateRe = /<plate\b[^>]*>([\s\S]*?)<\/plate>/gi;
  let pm: RegExpExecArray | null;
  while ((pm = plateRe.exec(xml)) !== null) {
    const plate: SlicedPlateInfo = { index: plates.length + 1, predictionSeconds: 0, weightGrams: 0, objectNames: [] };
    const tagRe = /<(metadata|object)\b([^>]*)\/?>/gi;
    let tm: RegExpExecArray | null;
    while ((tm = tagRe.exec(pm[1])) !== null) {
      const tag = tm[2];
      if (tm[1].toLowerCase() === "metadata") {
        const k = attr(tag, "key");
        const v = parseFloat(attr(tag, "value") || "") || 0;
        if (k === "index") plate.index = v;
        else if (k === "prediction") plate.predictionSeconds = v;
        else if (k === "weight") plate.weightGrams = v;
      } else if (attr(tag, "skipped") !== "true") {
        const n = attr(tag, "name");
        if (n) plate.objectNames.push(unesc(n));
      }
    }
    plates.push(plate);
  }
  return plates;
}

export async function parse3mfBuffer(buffer: ArrayBuffer, fallbackName: string): Promise<ParsedMeshObject[]> {
  const bytes = new Uint8Array(buffer);

  // Check if raw XML
  if (bytes.length > 4 && (bytes[0] !== 0x50 || bytes[1] !== 0x4b)) {
    const xml = new TextDecoder().decode(bytes);
    return parse3mfXmlModels(xml, fallbackName);
  }

  const textEntries = await readZipTextEntries(buffer, (n) => n.endsWith(".model") || n.endsWith(".config"));

  const partNameById = new Map<string, string>();
  const orderedConfigNames: string[] = [];
  for (const [k, xml] of textEntries.entries()) {
    if (k.toLowerCase().endsWith("model_settings.config")) {
      const partRegex = /<part\b([^>]*)>([\s\S]*?)<\/part>/gi;
      let pm: RegExpExecArray | null;
      while ((pm = partRegex.exec(xml)) !== null) {
        const pid = pm[1]?.match(/\bid=["']([^"']+)["']/i)?.[1] || "";
        const mname =
          pm[2]?.match(/<metadata\b[^>]*\bkey=["']name["'][^>]*\bvalue=["']([^"']+)["']/i)?.[1] ||
          pm[2]?.match(/<metadata\b[^>]*\bvalue=["']([^"']+)["'][^>]*\bkey=["']name["']/i)?.[1];
        if (mname && mname.trim()) {
          const clean = mname.trim().replace(/\.(stl|3mf)$/i, "").replace(/_/g, " ").trim();
          if (pid) partNameById.set(pid, clean);
          orderedConfigNames.push(clean);
        }
      }
    }
  }

  const results: ParsedMeshObject[] = [];
  for (const [k, xml] of textEntries.entries()) {
    if (!k.toLowerCase().endsWith(".model")) continue;
    const parsed = parse3mfXmlModels(xml, fallbackName);
    for (const obj of parsed) {
      const idMatch = obj.name.match(/#(\d+)$/);
      const pid = idMatch?.[1] || "";
      const mapped = (pid && partNameById.get(pid)) || orderedConfigNames[results.length];
      results.push({
        ...obj,
        name: mapped || obj.name.replace(/\.(3mf|stl)/gi, "").replace(/_/g, " ").trim(),
      });
    }
  }
  return results;
}
