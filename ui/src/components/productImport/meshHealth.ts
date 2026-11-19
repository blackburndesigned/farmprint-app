import { StudioMeshHealth } from "../StudioViewport3D";

export function analyzeClientMeshHealth(
  positions: number[],
  indices: number[]
): StudioMeshHealth {
  const vertexCount = Math.floor(positions.length / 3);
  const triangleCount = Math.floor(indices.length / 3);
  if (vertexCount === 0 || triangleCount === 0) {
    return {
      vertex_count: 0,
      triangle_count: 0,
      shell_count: 0,
      open_edge_count: 0,
      non_manifold_edge_count: 0,
      is_watertight: true,
      bounding_box_mm: [0, 0, 0],
      volume_mm3: 0,
      estimated_grams: 0,
      severity: "ok",
      user_note: "Empty mesh",
      problem_edge_segments: [],
    };
  }

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  let signedVol6 = 0;
  const edgeCounts = new Map<string, { count: number; a: number; b: number }>();
  const quantKey = (vIdx: number): string => {
    const x = Math.round(positions[vIdx * 3] * 1000);
    const y = Math.round(positions[vIdx * 3 + 1] * 1000);
    const z = Math.round(positions[vIdx * 3 + 2] * 1000);
    return `${x},${y},${z}`;
  };

  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    const x0 = positions[i0 * 3],
      y0 = positions[i0 * 3 + 1],
      z0 = positions[i0 * 3 + 2];
    const x1 = positions[i1 * 3],
      y1 = positions[i1 * 3 + 1],
      z1 = positions[i1 * 3 + 2];
    const x2 = positions[i2 * 3],
      y2 = positions[i2 * 3 + 1],
      z2 = positions[i2 * 3 + 2];

    signedVol6 +=
      x0 * (y1 * z2 - z1 * y2) -
      y0 * (x1 * z2 - z1 * x2) +
      z0 * (x1 * y2 - y1 * x2);

    const pairs: [number, number][] = [
      [i0, i1],
      [i1, i2],
      [i2, i0],
    ];
    for (const [va, vb] of pairs) {
      const ka = quantKey(va);
      const kb = quantKey(vb);
      const undirected = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const existing = edgeCounts.get(undirected);
      if (existing) {
        existing.count += 1;
      } else {
        edgeCounts.set(undirected, { count: 1, a: va, b: vb });
      }
    }
  }

  let openEdgeCount = 0;
  let nonManifoldCount = 0;
  const problemSegments: {
    start: [number, number, number];
    end: [number, number, number];
    kind: "open_boundary" | "non_manifold";
  }[] = [];

  for (const entry of edgeCounts.values()) {
    if (entry.count === 1) {
      openEdgeCount++;
      if (problemSegments.length < 180) {
        problemSegments.push({
          start: [
            positions[entry.a * 3],
            positions[entry.a * 3 + 1],
            positions[entry.a * 3 + 2],
          ],
          end: [
            positions[entry.b * 3],
            positions[entry.b * 3 + 1],
            positions[entry.b * 3 + 2],
          ],
          kind: "open_boundary",
        });
      }
    } else if (entry.count > 2) {
      nonManifoldCount++;
    }
  }

  const volumeMm3 = Math.abs(signedVol6) / 6.0;
  // No guessed weight: real grams come only from a sliced 3MF (Metadata/slice_info.config).
  const estimatedGrams = 0;
  const bbox: [number, number, number] = [
    Math.round((maxX - minX) * 10) / 10,
    Math.round((maxY - minY) * 10) / 10,
    Math.round((maxZ - minZ) * 10) / 10,
  ];
  const isWatertight = openEdgeCount === 0 && nonManifoldCount === 0;

  return {
    vertex_count: vertexCount,
    triangle_count: triangleCount,
    shell_count: 1,
    open_edge_count: openEdgeCount,
    non_manifold_edge_count: nonManifoldCount,
    is_watertight: isWatertight,
    bounding_box_mm: bbox,
    volume_mm3: Math.round(volumeMm3),
    estimated_grams: estimatedGrams,
    severity: isWatertight ? "ok" : openEdgeCount < 24 ? "info" : "reimport",
    user_note: isWatertight
      ? "Watertight manifold mesh — ready for direct slicer plate export."
      : `${openEdgeCount} open boundary edge(s) detected — the model may need repair in the slicer.`,
    problem_edge_segments: problemSegments,
  };
}
