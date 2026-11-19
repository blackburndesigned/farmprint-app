// Shared browser mesh readers (meshParsers.ts): STL soup + welded, ASCII numbers, size rule,
// 3MF model XML, a stored-zip 3MF with Bambu part names, and slice_info.config.
import { meshToStlBase64 } from "../../src/productEditorSource";
import { binaryStlTriangleCount, parse3mfBuffer, parse3mfXmlModels, parseSliceInfoConfig, parseStl, parseStlSoup, usableMeshes } from "../../src/meshParsers";
import { check, done } from "./check";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

// Binary STL: two triangles sharing an edge.
const soup = [0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0];
const bin = Uint8Array.from(atob(meshToStlBase64(soup, [0, 1, 2, 3, 4, 5])), (c) => c.charCodeAt(0)).buffer;
check(binaryStlTriangleCount(bin) === 2, "binary STL detected with 2 triangles");
const s1 = parseStlSoup(bin);
check(s1.positions.length === 18 && s1.indices.join() === "0,1,2,3,4,5", "soup keeps every corner (like fp-mesh)");
const w1 = parseStl(bin);
check(w1.positions.length === 4 * 3 && w1.indices.length === 6, "welded form shares the edge corners");
check(w1.indices[3] === w1.indices[1] && w1.indices[5] === w1.indices[2], "welded indices point at shared corners");

// Size rule (same as Rust): up to 512 bytes of padding is still binary; more is not.
const pad = (n: number) => { const b = new Uint8Array(bin.byteLength + n); b.set(new Uint8Array(bin)); return b.buffer; };
check(binaryStlTriangleCount(pad(512)) === 2, "512 bytes of trailing padding accepted");
check(binaryStlTriangleCount(pad(513)) === 0, "513 bytes of padding is not a binary STL");
check(binaryStlTriangleCount(bin.slice(0, bin.byteLength - 1)) === 0, "truncated binary STL is not binary");

// ASCII STL: number forms Rust accepts, incomplete last triangle dropped.
const ascii = `solid t
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 5. 0 0
  vertex .5 -1.5e+1 +2
 endloop
endfacet
facet normal 0 0 1
 outer loop
  vertex 1 1 1
  vertex 2 2 2
endsolid t`;
const a1 = parseStlSoup(enc(ascii));
check(a1.positions.length === 9 && a1.indices.length === 3, "ASCII: one whole triangle, trailing partial dropped");
check(a1.positions[3] === 5 && a1.positions[6] === 0.5 && a1.positions[7] === -15 && a1.positions[8] === 2, "ASCII: 5. .5 -1.5e+1 +2 parse");
check(parseStl(enc(ascii)).indices.length === 3, "welded ASCII has the same triangle count");
check(parseStlSoup(enc("not an stl")).positions.length === 0, "garbage gives no triangles (caller reports the error)");

// usableMeshes rejects NaN/Inf corners, as the Rust reader does.
check(usableMeshes([{ name: "x", positions: [0, 0, 0, 1, 0, 0, NaN, 1, 0], indices: [0, 1, 2] }]).length === 0, "NaN corner rejected");
check(usableMeshes([{ name: "x", ...a1 }]).length === 1, "finite mesh kept");

// 3MF model XML.
const model = `<model><resources>
<object id="3" name="Lid" type="model"><mesh><vertices>
<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
</vertices><triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="1" v3="9"/></triangles></mesh></object>
<object id="4" type="model"><mesh><vertices>
<vertex x="0" y="0" z="0"/><vertex x="2" y="0" z="0"/><vertex x="0" y="2" z="0"/>
</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
<object id="5" type="model"><components><component objectid="3"/></components></object>
</resources></model>`;
const objs = parse3mfXmlModels(model, "Box");
check(objs.length === 2, "3MF: two mesh objects, component-only object skipped");
check(objs[0].name === "Lid" && objs[0].indices.length === 3, "3MF: named object, out-of-range triangle dropped");
check(objs[1].name === "Box #4", "3MF: unnamed object gets file name + id");

// Stored (uncompressed) zip 3MF with Bambu model_settings names.
function storedZip(files: Record<string, string>): ArrayBuffer {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nb = new TextEncoder().encode(name);
    const data = new TextEncoder().encode(text);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(8, 0, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(lh.buffer), nb, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(10, 0, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nb.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nb);
    offset += 30 + nb.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, Object.keys(files).length, true); eocd.setUint16(10, Object.keys(files).length, true); eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out.buffer;
}
const settings = `<config><object id="5"><part id="3" subtype="normal_part"><metadata key="name" value="Lid_Top.stl"/></part><part id="4" subtype="normal_part"><metadata key="name" value="Main_Body.stl"/></part></object></config>`;
async function zipChecks() {
  const zip = storedZip({ "3D/3dmodel.model": model, "Metadata/model_settings.config": settings });
  const zipped = await parse3mfBuffer(zip, "Box");
  check(zipped.length === 2, "zip 3MF: both meshes read through the central directory");
  check(zipped[1].name === "Main Body", "zip 3MF: Bambu part name from model_settings (extension and _ cleaned)");
  check(zipped[0].name === "Lid Top", "zip 3MF: an object without #id takes the settings names in order");
}

// slice_info.config (mirrors fp-mesh slice_info).
const plates = parseSliceInfoConfig(`<config><plate><metadata key="index" value="2"/><metadata key="prediction" value="3600"/><metadata key="weight" value="12.5"/>
<object identify_id="1" name="A &amp; B" skipped="false"/><object name="Skip me" skipped="true"/></plate></config>`);
check(plates.length === 1 && plates[0].index === 2 && plates[0].predictionSeconds === 3600 && plates[0].weightGrams === 12.5, "slice_info: plate numbers");
check(plates[0].objectNames.join("|") === "A & B", "slice_info: names unescaped, skipped objects left out");
zipChecks().then(done, (e) => { console.error(e); process.exit(1); });
