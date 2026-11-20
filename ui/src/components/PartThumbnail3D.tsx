import React from "react";
import {
  PART_PLACEHOLDER_SRC,
  PartThumb,
  ProductCompositeThumb,
  resolvePartCatalogPngUrl,
  isKnownCatalogPartId } from "../partThumbnails";
import { renderThumbnailGL } from "../meshRendererGL";
import { useOutlinedSrc } from "../thumbnailOutline";

export interface RenderPartThumbOptions {
  partName: string;
  colorHex: string;
  size?: number;
  lightingPreset?: "Soft" | "Standard" | "Hard";
  cameraPreset?: "Iso" | "Front" | "Top" | "Right";
  meshPositions?: number[] | Float32Array;
  meshIndices?: number[];
  neutralMode?: boolean;
}

/**
 * Rasterizes a real 3D mesh (or resolves its real catalog PNG) into a shaded Data URL
 * for custom imported `.3mf` / `.stl` parts.
 */
const THUMB_ANGLES = {
  Front: { yaw: 0, pitch: 8 },
  Top: { yaw: 0, pitch: 82 },
  Right: { yaw: 90, pitch: 12 },
  Iso: { yaw: -36, pitch: 28 },
} as const;
const thumbGain = (preset?: string) => (preset === "Hard" ? 1.15 : preset === "Soft" ? 0.94 : 1.04);

/** Baked data URLs keyed by mesh array, so React re-renders do not re-bake. */
const PART_THUMB_CACHE = new WeakMap<object, Map<string, string>>();

export function renderPartThumbnailDataUrl(opts: RenderPartThumbOptions): string {
  const pos = opts.meshPositions;
  if (pos && pos.length >= 9) {
    const key = [opts.colorHex, opts.size ?? 96, opts.lightingPreset, opts.cameraPreset, opts.neutralMode ? 1 : 0, opts.meshIndices?.length ?? 0].join("|");
    let inner = PART_THUMB_CACHE.get(pos as object);
    const hit = inner?.get(key);
    if (hit) return hit;
    const angles = THUMB_ANGLES[opts.cameraPreset || "Iso"];
    const url = renderThumbnailGL({
      parts: [{ hex: opts.neutralMode ? "#D8DEE9" : opts.colorHex || "#60A5FA", positions: pos, indices: opts.meshIndices }],
      size: opts.size ?? 96,
      yawDeg: angles.yaw,
      pitchDeg: angles.pitch,
      gain: thumbGain(opts.lightingPreset),
    });
    if (url) {
      if (!inner) { inner = new Map(); PART_THUMB_CACHE.set(pos as object, inner); }
      inner.set(key, url);
      return url;
    }
  }
  return renderPartThumbnailDataUrl2D(opts);
}

/** Legacy Canvas2D painter; only used when WebGL is unavailable. */
export function renderPartThumbnailDataUrl2D(opts: RenderPartThumbOptions): string {
  const {
    partName,
    colorHex,
    size = 96,
    lightingPreset = "Standard",
    cameraPreset = "Iso",
    meshPositions,
    meshIndices,
    neutralMode = false,
  } = opts;

  const posArr = meshPositions ? Array.from(meshPositions) : [];
  if (posArr.length < 9) {
    return resolvePartCatalogPngUrl(partName);
  }

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return resolvePartCatalogPngUrl(partName);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < posArr.length; i += 3) {
    const x = posArr[i], y = posArr[i + 1], z = posArr[i + 2];
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const span = Math.max(1e-3, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ));
  const scale = (size * 0.72) / span;

  const angles =
    cameraPreset === "Front"
      ? { yaw: 0, pitch: 8 }
      : cameraPreset === "Top"
        ? { yaw: 0, pitch: 82 }
        : cameraPreset === "Right"
          ? { yaw: 90, pitch: 12 }
          : { yaw: -36, pitch: 28 };
  const yaw = (angles.yaw * Math.PI) / 180;
  const pitch = (angles.pitch * Math.PI) / 180;

  const project = (x: number, y: number, z: number): [number, number, number] => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const rx = dx * Math.cos(yaw) - dy * Math.sin(yaw);
    const ry = dx * Math.sin(yaw) + dy * Math.cos(yaw);
    const sy = ry * Math.sin(pitch) - dz * Math.cos(pitch);
    const sz = ry * Math.cos(pitch) + dz * Math.sin(pitch);
    return [size * 0.5 + rx * scale, size * 0.52 + sy * scale, sz];
  };

  const hex = neutralMode ? "#D8DEE9" : colorHex || "#60A5FA";
  const clean = hex.replace("#", "").trim().slice(0, 6); // #RRGGBBAA: alpha ignored here
  const num = parseInt(clean.length === 6 ? clean : "60A5FA", 16) || 0x60a5fa;
  const rawR = (num >> 16) & 0xff;
  const rawG = (num >> 8) & 0xff;
  const rawB = num & 0xff;
  const isDark = Math.max(rawR, rawG, rawB) < 76;
  const baseR = isDark ? Math.max(42, rawR) : rawR;
  const baseG = isDark ? Math.max(42, rawG) : rawG;
  const baseB = isDark ? Math.max(46, rawB) : rawB;
  const gain = lightingPreset === "Hard" ? 1.15 : lightingPreset === "Soft" ? 0.94 : 1.04;

  const indices: number[] =
    meshIndices && meshIndices.length >= 3
      ? meshIndices
      : Array.from({ length: Math.floor(posArr.length / 3) }, (_, i) => i);

  const triCount = Math.floor(indices.length / 3);
  const stride = triCount > 1400 ? Math.ceil(triCount / 1400) : 1;
  const tris: { p0: [number, number, number]; p1: [number, number, number]; p2: [number, number, number]; z: number; fill: string }[] = [];

  for (let t = 0; t < triCount; t += stride) {
    const i0 = indices[t * 3] * 3;
    const i1 = indices[t * 3 + 1] * 3;
    const i2 = indices[t * 3 + 2] * 3;
    if (i0 + 2 >= posArr.length || i1 + 2 >= posArr.length || i2 + 2 >= posArr.length) continue;

    const x0 = posArr[i0], y0 = posArr[i0 + 1], z0 = posArr[i0 + 2];
    const x1 = posArr[i1], y1 = posArr[i1 + 1], z1 = posArr[i1 + 2];
    const x2 = posArr[i2], y2 = posArr[i2 + 1], z2 = posArr[i2 + 2];

    const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
    const wx = x2 - x0, wy = y2 - y0, wz = z2 - z0;
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;
    const nz = ux * wy - uy * wx;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    const ndotl = Math.abs((nx / nLen) * 0.52 - (ny / nLen) * 0.44 + (nz / nLen) * 0.73);
    const shade = (0.38 + 0.64 * ndotl) * gain;

    const spec = isDark ? Math.round(56 * Math.pow(ndotl, 2.6)) : 0;
    const r = Math.min(255, Math.round(baseR * shade + spec));
    const g = Math.min(255, Math.round(baseG * shade + spec));
    const b = Math.min(255, Math.round(baseB * shade + spec));

    const p0 = project(x0, y0, z0);
    const p1 = project(x1, y1, z1);
    const p2 = project(x2, y2, z2);
    tris.push({
      p0,
      p1,
      p2,
      z: (p0[2] + p1[2] + p2[2]) / 3,
      fill: `rgb(${r},${g},${b})`,
    });
  }

  tris.sort((a, b) => a.z - b.z);
  for (const tri of tris) {
    ctx.beginPath();
    ctx.moveTo(tri.p0[0], tri.p0[1]);
    ctx.lineTo(tri.p1[0], tri.p1[1]);
    ctx.lineTo(tri.p2[0], tri.p2[1]);
    ctx.closePath();
    ctx.fillStyle = tri.fill;
    ctx.fill();
    ctx.strokeStyle = tri.fill;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  return canvas.toDataURL("image/png");
}

export interface AssemblyThumbPart {
  colorHex: string;
  meshPositions?: number[] | Float32Array;
  meshIndices?: number[];
  visible?: boolean;
}

/**
 * One picture of the whole assembly in CAD coordinates, fit to a shared box.
 * Each part keeps its own filament color. This is the catalog hero, not a copy
 * of the first part and not another product's layer stack.
 */
export function renderAssemblyThumbnailDataUrl(opts: {
  parts: AssemblyThumbPart[];
  size?: number;
  lightingPreset?: "Soft" | "Standard" | "Hard";
  cameraPreset?: "Iso" | "Front" | "Top" | "Right";
}): string {
  const glParts = opts.parts.filter(
    (p) => p.visible !== false && p.meshPositions && p.meshPositions.length >= 9
  );
  if (glParts.length > 0) {
    const angles = THUMB_ANGLES[opts.cameraPreset || "Iso"];
    const url = renderThumbnailGL({
      parts: glParts.map((p) => ({ hex: p.colorHex || "#60A5FA", positions: p.meshPositions!, indices: p.meshIndices })),
      size: opts.size ?? 512,
      yawDeg: angles.yaw,
      pitchDeg: angles.pitch,
      gain: thumbGain(opts.lightingPreset),
    });
    if (url) return url;
  }
  return renderAssemblyThumbnailDataUrl2D(opts);
}

/** Legacy Canvas2D painter; only used when WebGL is unavailable. */
export function renderAssemblyThumbnailDataUrl2D(opts: {
  parts: AssemblyThumbPart[];
  size?: number;
  lightingPreset?: "Soft" | "Standard" | "Hard";
  cameraPreset?: "Iso" | "Front" | "Top" | "Right";
}): string {
  const {
    parts,
    size = 512,
    lightingPreset = "Standard",
    cameraPreset = "Iso",
  } = opts;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const meshes = parts.filter(
    (p) => p.visible !== false && p.meshPositions && p.meshPositions.length >= 9
  );
  if (meshes.length === 0) return "";

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const part of meshes) {
    const pos = part.meshPositions!;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const span = Math.max(1e-3, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ));
  const scale = (size * 0.72) / span;
  const angles =
    cameraPreset === "Front"
      ? { yaw: 0, pitch: 8 }
      : cameraPreset === "Top"
        ? { yaw: 0, pitch: 82 }
        : cameraPreset === "Right"
          ? { yaw: 90, pitch: 12 }
          : { yaw: -36, pitch: 28 };
  const yaw = (angles.yaw * Math.PI) / 180;
  const pitch = (angles.pitch * Math.PI) / 180;
  const project = (x: number, y: number, z: number): [number, number, number] => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const rx = dx * Math.cos(yaw) - dy * Math.sin(yaw);
    const ry = dx * Math.sin(yaw) + dy * Math.cos(yaw);
    const sy = ry * Math.sin(pitch) - dz * Math.cos(pitch);
    const sz = ry * Math.cos(pitch) + dz * Math.sin(pitch);
    return [size * 0.5 + rx * scale, size * 0.52 + sy * scale, sz];
  };
  const gain = lightingPreset === "Hard" ? 1.15 : lightingPreset === "Soft" ? 0.94 : 1.04;

  const tris: { p0: [number, number, number]; p1: [number, number, number]; p2: [number, number, number]; z: number; fill: string }[] = [];
  for (const part of meshes) {
    const posArr = Array.from(part.meshPositions!);
    const hex = (part.colorHex || "#60A5FA").replace("#", "").trim().slice(0, 6);
    const num = parseInt(hex.length === 6 ? hex : "60A5FA", 16) || 0x60a5fa;
    const rawR = (num >> 16) & 0xff;
    const rawG = (num >> 8) & 0xff;
    const rawB = num & 0xff;
    const isDark = Math.max(rawR, rawG, rawB) < 76;
    const baseR = isDark ? Math.max(42, rawR) : rawR;
    const baseG = isDark ? Math.max(42, rawG) : rawG;
    const baseB = isDark ? Math.max(46, rawB) : rawB;
    const indices: number[] =
      part.meshIndices && part.meshIndices.length >= 3
        ? part.meshIndices
        : Array.from({ length: Math.floor(posArr.length / 3) }, (_, i) => i);
    const triCount = Math.floor(indices.length / 3);
    const stride = triCount > 1800 ? Math.ceil(triCount / 1800) : 1;
    for (let t = 0; t < triCount; t += stride) {
      const i0 = indices[t * 3] * 3;
      const i1 = indices[t * 3 + 1] * 3;
      const i2 = indices[t * 3 + 2] * 3;
      if (i0 + 2 >= posArr.length || i1 + 2 >= posArr.length || i2 + 2 >= posArr.length) continue;
      const x0 = posArr[i0], y0 = posArr[i0 + 1], z0 = posArr[i0 + 2];
      const x1 = posArr[i1], y1 = posArr[i1 + 1], z1 = posArr[i1 + 2];
      const x2 = posArr[i2], y2 = posArr[i2 + 1], z2 = posArr[i2 + 2];
      const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
      const wx = x2 - x0, wy = y2 - y0, wz = z2 - z0;
      const nx = uy * wz - uz * wy;
      const ny = uz * wx - ux * wz;
      const nz = ux * wy - uy * wx;
      const nLen = Math.hypot(nx, ny, nz) || 1;
      const ndotl = Math.abs((nx / nLen) * 0.52 - (ny / nLen) * 0.44 + (nz / nLen) * 0.73);
      const shade = (0.38 + 0.64 * ndotl) * gain;
      const spec = isDark ? Math.round(56 * Math.pow(ndotl, 2.6)) : 0;
      const r = Math.min(255, Math.round(baseR * shade + spec));
      const g = Math.min(255, Math.round(baseG * shade + spec));
      const b = Math.min(255, Math.round(baseB * shade + spec));
      const p0 = project(x0, y0, z0);
      const p1 = project(x1, y1, z1);
      const p2 = project(x2, y2, z2);
      tris.push({ p0, p1, p2, z: (p0[2] + p1[2] + p2[2]) / 3, fill: `rgb(${r},${g},${b})` });
    }
  }
  tris.sort((a, b) => a.z - b.z);
  for (const tri of tris) {
    ctx.beginPath();
    ctx.moveTo(tri.p0[0], tri.p0[1]);
    ctx.lineTo(tri.p1[0], tri.p1[1]);
    ctx.lineTo(tri.p2[0], tri.p2[1]);
    ctx.closePath();
    ctx.fillStyle = tri.fill;
    ctx.fill();
    ctx.strokeStyle = tri.fill;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }
  return canvas.toDataURL("image/png");
}

export interface PartThumbnail3DProps {
  partName: string;
  colorHex: string;
  meshPositions?: Float32Array | number[];
  size?: number;
  selected?: boolean;
  onClick?: () => void;
  yawDeg?: number;
  pitchDeg?: number;
  customThumbnailDataUrl?: string | null;
  productId?: string;
  /** Catalog part id; picks the right picture when parts share a name. */
  partId?: string;
  /** Process color, used when the Settings outline follows part status. */
  statusHex?: string;
}

export const PartThumbnail3D: React.FC<PartThumbnail3DProps> = ({
  partName,
  colorHex,
  meshPositions,
  size = 54,
  selected = false,
  onClick,
  customThumbnailDataUrl,
  productId,
  partId,
  statusHex,
}) => {
  const lookupKey = partId && isKnownCatalogPartId(partId) ? partId : partName;
  const bakedFromMesh =
    !customThumbnailDataUrl && meshPositions && meshPositions.length >= 9
      ? renderPartThumbnailDataUrl({
          partName,
          colorHex,
          size: Math.max(96, size * 2),
          meshPositions,
        })
      : null;

  const customUrl = customThumbnailDataUrl || bakedFromMesh;
  const outlinedCustom = useOutlinedSrc(customUrl || "", size, statusHex);

  return (
    <div
      onClick={onClick}
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: selected ? "2px solid #0a84ff" : "none",
        cursor: onClick ? "pointer" : "default",
        flexShrink: 0,
      }}
    >
      {customUrl ? (
        <img
          src={outlinedCustom}
          onError={(e) => {
            if (e.currentTarget.src !== PART_PLACEHOLDER_SRC) e.currentTarget.src = PART_PLACEHOLDER_SRC;
          }}
          alt={partName}
          width={size}
          height={size}
          style={{
            width: size,
            height: size,
            objectFit: "contain",
            filter:
              "drop-shadow(0 1px 1px rgba(255,255,255,0.42)) drop-shadow(0 3px 6px rgba(0,0,0,0.55))",
            userSelect: "none",
            pointerEvents: "none",
          }}
        />
      ) : (
        <PartThumb
          partName={lookupKey}
          colorHex={colorHex}
          size={size}
          productId={productId}
          statusHex={statusHex}
        />
      )}
    </div>
  );
};

export interface ProductCompositeThumbnail3DProps {
  productName: string;
  size?: number;
  inscriptionText?: string | null;
  /** See ProductCompositeThumb.liveTint. */
  liveTint?: boolean;
  parts: Array<{
    partName: string;
    colorHex: string;
    visible?: boolean;
    customThumbnailDataUrl?: string | null;
  }>;
}

export const ProductCompositeThumbnail3D: React.FC<ProductCompositeThumbnail3DProps> = ({
  productName,
  size = 76,
  inscriptionText,
  liveTint,
  parts,
}) => {
  const visibleParts = parts.filter((p) => p.visible !== false);
  return (
    <ProductCompositeThumb
      productIdOrName={productName}
      size={size}
      inscriptionText={inscriptionText}
      liveTint={liveTint}
      parts={visibleParts.map((p) => ({
        partName: p.partName,
        colorHex: p.colorHex,
      }))}
    />
  );
};
