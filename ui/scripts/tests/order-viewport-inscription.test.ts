// Order viewport inscription preview: empty text, setup required, live text updates.
import { defaultCamera } from "../../src/viewportCamera";
import {
  CHAR_ASPECT,
  INSCRIPTION_PREVIEW_ID,
  buildInscriptionPreviewMesh,
  fitRange,
  hasInscriptionSetup,
  inscriptionFromSaved,
  layoutMask,
  letterHeightMm,
  previewInscriptionText,
  wrapStrip,
  inscriptionPreviewHex,
  type PreviewPart,
} from "../../src/inscriptionPreview";
import { check, done } from "./check";

function boxPart(id = "body", name = "Body", size = 40): PreviewPart {
  const h = size / 2;
  // Unit cube centered at origin, 8 verts, 12 tris. +Z is the top, −Y is the front.
  const positions = [
    -h, -h, -h,  h, -h, -h,  h,  h, -h,  -h,  h, -h,
    -h, -h,  h,  h, -h,  h,  h,  h,  h,  -h,  h,  h,
  ];
  const indices = [
    0, 1, 2, 0, 2, 3, // bottom −Z
    4, 6, 5, 4, 7, 6, // top +Z
    0, 4, 5, 0, 5, 1, // front −Y
    3, 2, 6, 3, 6, 7, // back +Y
    0, 3, 7, 0, 7, 4, // left −X
    1, 5, 6, 1, 6, 2, // right +X
  ];
  return { id, name, positions, indices, visible: true };
}

const enabled = {
  enabled: true,
  targetPartName: "Body",
  sampleText: "SAMPLE",
  fontFamily: "Arial",
  areaWidthMm: 20,
  areaHeightMm: 6,
  depthMm: 0.8,
  maxChars: 14,
  rotationDeg: 0,
  mirrorX: false,
  upsideDown: false,
  wrapOnSurface: false,
};

const camera = defaultCamera(); // looks from front-right, slightly above
const parts = [boxPart()];

check(hasInscriptionSetup({ enabled: false, supportsCustomText: false }) === false, "no setup when disabled and product does not support custom text");
check(hasInscriptionSetup({ enabled: true, supportsCustomText: false }) === true, "setup when the saved config is enabled");
check(hasInscriptionSetup({ enabled: false, supportsCustomText: true }) === true, "setup when the product supports custom text");
check(previewInscriptionText("", 14) === "", "empty text is blank");
check(previewInscriptionText("  hello  ", 14) === "hello", "text is trimmed");
check(previewInscriptionText("ABCDEFGHIJKLMNOP", 8) === "ABCDEFGH", "text respects maxChars");
check(Math.abs(letterHeightMm("A", 10) - 10 / CHAR_ASPECT) < 1e-9, "letter height uses the shared character aspect");

check(inscriptionFromSaved(undefined).enabled === false, "missing editor.json inscription is disabled");
check(inscriptionFromSaved({ wrap_on_surface: false, area_width_mm: 12 } as any).areaWidthMm === 12, "snake_case area width is read");
check(inscriptionFromSaved({ placement: { wrapOnSurface: false } } as any).wrapOnSurface === false, "nested placement wrap flag is read");

const none = buildInscriptionPreviewMesh({
  text: "HELLO",
  config: { ...enabled, enabled: false },
  supportsCustomText: false,
  parts,
  camera,
  mask: layoutMask("HELLO"),
});
check(none === null, "product without inscription setup draws nothing, even when text is set");

const empty = buildInscriptionPreviewMesh({
  text: "   ",
  config: enabled,
  supportsCustomText: true,
  parts,
  camera,
  mask: layoutMask("HELLO"),
});
check(empty === null, "empty / whitespace text draws nothing when setup exists");

const hello = buildInscriptionPreviewMesh({
  text: "HELLO",
  config: enabled,
  supportsCustomText: true,
  parts,
  camera,
  mask: layoutMask("HELLO"),
});
check(!!hello, "text set on a product with inscription setup draws a preview mesh");
check(hello!.mesh.id === INSCRIPTION_PREVIEW_ID, "preview mesh uses the reserved preview id");
check(hello!.mesh.indices.length >= 6 && hello!.mesh.positions.length >= 12, "preview mesh has triangles");
check(hello!.wrapped === false, "wrapOff config stays planar on a flat face");

const hi = buildInscriptionPreviewMesh({
  text: "HI",
  config: enabled,
  supportsCustomText: true,
  parts,
  camera,
  mask: layoutMask("HI"),
});
check(!!hi, "shorter text still draws");
check(hi!.mesh.indices.length !== hello!.mesh.indices.length || hi!.mesh.positions.length !== hello!.mesh.positions.length, "changing the text rebuilds the preview mesh");

// Same text again is identical (stable).
const hello2 = buildInscriptionPreviewMesh({
  text: "HELLO",
  config: enabled,
  supportsCustomText: true,
  parts,
  camera,
  mask: layoutMask("HELLO"),
});
check(
  hello2!.mesh.positions.length === hello!.mesh.positions.length && hello2!.mesh.indices.length === hello!.mesh.indices.length,
  "the same text produces the same mesh size",
);

// Saved pose is honored.
const posed = buildInscriptionPreviewMesh({
  text: "HELLO",
  config: {
    ...enabled,
    origin: [0, -20, 0],
    normal: [0, -1, 0],
    tangent: [1, 0, 0],
  },
  supportsCustomText: true,
  parts,
  camera,
  mask: layoutMask("HELLO"),
});
check(!!posed, "a saved origin / normal / tangent is accepted");
const ys = posed!.mesh.positions.filter((_, i) => i % 3 === 1);
const midY = ys.reduce((a, b) => a + b, 0) / ys.length;
check(midY < -10, "saved pose puts the letters on the front face");

// Wrap on a cylinder-like prism: a coarse 16-sided tube along Z.
function tubePart(): PreviewPart {
  const r = 15, h = 20, n = 16;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    positions.push(Math.cos(a) * r, Math.sin(a) * r, -h, Math.cos(a) * r, Math.sin(a) * r, h);
  }
  for (let i = 0; i < n; i++) {
    const i0 = i * 2, i1 = i * 2 + 1, i2 = ((i + 1) % n) * 2, i3 = ((i + 1) % n) * 2 + 1;
    indices.push(i0, i2, i3, i0, i3, i1);
  }
  return { id: "tube", name: "Tube", positions, indices, visible: true };
}
const tube = tubePart();
const wrapPlacement = {
  origin: [15, 0, 0] as [number, number, number],
  normal: [1, 0, 0] as [number, number, number],
  tangent: [0, 1, 0] as [number, number, number],
  partId: "tube",
  widthMm: 20,
  heightMm: 6,
  wrapOnSurface: true,
  align: "center" as const,
  rotationDeg: 0,
  mirrorX: false,
  upsideDown: false,
  fontFamily: "Arial",
  depthMm: 0,
  maxChars: 14,
};
const wrapped = wrapStrip(wrapPlacement, tube.positions, tube.indices, 24);
check(wrapped.wrapped === true, "a curved tube wraps the inscription strip onto the surface");
const radii = wrapped.samples.map((s) => Math.hypot(s.position[0], s.position[1]));
const lift = radii.reduce((a, b) => a + b, 0) / radii.length - 15;
check(lift > 0 && lift < 4, "wrapped samples are lifted off the tube surface");
check(radii.every((r) => Math.abs(r - (15 + lift)) < 1.5), "wrapped samples follow the tube surface");

const fitWide = fitRange(4, 2);
check(fitWide.u0 === 0 && fitWide.u1 === 1 && fitWide.v0 > 0 && fitWide.v1 < 1, "a wide string is letterboxed vertically in the field");
const fitTall = fitRange(1, 2);
check(fitTall.v0 === 0 && fitTall.v1 === 1 && fitTall.u0 > 0 && fitTall.u1 < 1, "a tall string is pillarboxed horizontally in the field");

check(inscriptionPreviewHex({ surfaceHex: "#FF7A00" }) === "#1a1a1a", "letters on a light/saturated surface are dark");
check(inscriptionPreviewHex({ surfaceHex: "#1a1a1a" }) === "#f4f4f4", "letters on a dark surface are light");
check(inscriptionPreviewHex({ surfaceHex: "#FF7A00", letterHex: "#FF7A00" }) === "#1a1a1a", "a letter color that matches the surface is replaced with a contrast color");
done();

