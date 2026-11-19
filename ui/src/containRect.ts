/** Where a `srcW`×`srcH` picture goes inside a `boxW`×`boxH` box: as large as fits with its
 *  aspect kept, centred, the rest left transparent. A square picture in a square box (or any
 *  size it can't read) fills the box exactly, so square inputs draw as before. */
export function containRect(
  srcW: number,
  srcH: number,
  boxW: number,
  boxH: number
): { x: number; y: number; w: number; h: number } {
  if (!(srcW > 0) || !(srcH > 0) || !isFinite(srcW) || !isFinite(srcH)) return { x: 0, y: 0, w: boxW, h: boxH };
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/** Same as `containRect`, but pictures within `tolerance` of `frame`'s aspect (one composite's
 *  layers, some downscaled with rounding) all get the frame's exact rect, so they stay aligned. */
export function frameRect(
  frame: { w: number; h: number },
  srcW: number,
  srcH: number,
  boxW: number,
  boxH: number,
  tolerance = 0.01
): { x: number; y: number; w: number; h: number } {
  const fa = frame.w / frame.h;
  const sa = srcW / srcH;
  const same = isFinite(fa) && isFinite(sa) && Math.abs(sa - fa) <= tolerance * fa;
  return same ? containRect(frame.w, frame.h, boxW, boxH) : containRect(srcW, srcH, boxW, boxH);
}
