import { useEffect, useRef } from "react";
import { Bounds, CameraState, boundsOfParts, cloneCamera, defaultCamera } from "../../viewportCamera";
import { projectScene } from "./viewportDrawing";
import { VIEWPORT_HINT, bindViewportGestures } from "./viewportGestures";

/** Lights the part tiles use; the saved part picture uses the same ones. */
const PART_TILE_LIGHTS = { key: 900, fill: 350, ambient: 280 } as const;

/**
 * Renders one part exactly as its tile shows it: the tile's camera (angle, zoom and pan),
 * the tile's lights, on a transparent square. This is the saved parts/<stem>.png.
 * The tile is square, so the picture matches the tile framing pixel for pixel.
 */
export function renderPartTileCamera(opts: {
  positions: number[];
  indices: number[];
  camera?: CameraState | null;
  size: number;
  hex?: string;
}): string {
  const { positions, indices, size } = opts;
  if (!positions || positions.length < 9 || !indices || indices.length < 3) return "";
  const ss = 2;
  const off = document.createElement("canvas");
  off.width = size * ss;
  off.height = size * ss;
  const ctx = off.getContext("2d");
  if (!ctx) return "";
  ctx.setTransform(ss, 0, 0, ss, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const bounds = boundsOfParts([{ visible: true, meshPositions: positions }]);
  projectScene(
    ctx, size, size, cloneCamera(opts.camera || defaultCamera()),
    [{ id: "part", hex: opts.hex || "#FFFFFF", positions, indices, selected: false }],
    "standard", PART_TILE_LIGHTS.key, PART_TILE_LIGHTS.fill, PART_TILE_LIGHTS.ambient, bounds, ss
  );
  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const octx = out.getContext("2d");
  if (!octx) return off.toDataURL("image/png");
  octx.imageSmoothingQuality = "high";
  octx.drawImage(off, 0, 0, size, size);
  return out.toDataURL("image/png");
}

export function sizeCanvas(canvas: HTMLCanvasElement, w: number, h: number) {
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

export function PartOrbitThumb({
  positions,
  indices,
  color,
  onTap,
  camera,
  onCameraChange,
  partName,
}: {
  /** Used in the tile's accessible label. */
  partName?: string;
  positions: number[];
  indices: number[];
  color: string;
  onTap?: () => void;
  /** Saved tile camera to start from (restored when the editor reopens). */
  camera?: CameraState | null;
  /** Called after each drag, zoom or reset with the tile's camera. */
  onCameraChange?: (camera: CameraState | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const camRef = useRef<CameraState>(camera ? cloneCamera(camera) : defaultCamera());
  const boundsRef = useRef<Bounds | null>(null);
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;
  const onCamRef = useRef(onCameraChange);
  onCamRef.current = onCameraChange;
  const cameraKey = camera ? JSON.stringify(camera) : "";
  const lastReported = useRef<string>(cameraKey);
  if (cameraKey !== lastReported.current) {
    // Camera changed from outside (restore after reopen), not from this tile's own drag.
    lastReported.current = cameraKey;
    camRef.current = camera ? cloneCamera(camera) : defaultCamera();
  }
  const report = (cam: CameraState | null) => {
    lastReported.current = cam ? JSON.stringify(cam) : "";
    onCamRef.current?.(cam);
  };
  const schedulePaintRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    boundsRef.current = boundsOfParts([{ visible: true, meshPositions: positions }]);
    const paintNow = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 120;
      const height = canvas.clientHeight || 120;
      sizeCanvas(canvas, Math.floor(width * dpr), Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (positions.length < 9 || indices.length < 3) return;
      projectScene(
        ctx,
        width,
        height,
        camRef.current,
        [{ id: "part", hex: color, positions, indices, selected: false }],
        "standard",
        900,
        350,
        280,
        boundsRef.current,
        dpr
      );
    };
    // Coalesce gesture redraws to one paint per frame, like the main viewport.
    let raf = 0;
    const paint = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => { raf = 0; paintNow(); });
    };
    schedulePaintRef.current = paint;
    paintNow();
    const stop = bindViewportGestures(canvas, {
      camera: () => camRef.current,
      bounds: () => boundsRef.current,
      manipulate: () => "model",
      intensities: () => ({ key: 900, fill: 350, ambient: 280 }),
      setIntensities: () => {},
      setInteracting: () => {},
      onSettled: () => report(cloneCamera(camRef.current)),
      redraw: paint,
      onTap: () => onTapRef.current?.(),
      onReset: () => {
        camRef.current = defaultCamera();
        paint();
        report(null);
      },
    });
    const reset = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      camRef.current = defaultCamera();
      paint();
      report(null);
    };
    canvas.addEventListener("dblclick", reset);
    return () => {
      stop();
      if (raf) window.cancelAnimationFrame(raf);
      schedulePaintRef.current = () => {};
      canvas.removeEventListener("dblclick", reset);
    };
  }, [positions, indices, color]);
  // A camera restored from outside only needs a repaint (camRef was updated above), not a
  // rebind of every listener, so this stays out of the effect above.
  useEffect(() => { schedulePaintRef.current(); }, [cameraKey]);

  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      role="application"
      aria-roledescription="3D viewer"
      aria-label={partName ? `${partName}: part picture view` : "Part picture view"}
      title={`${VIEWPORT_HINT} · double-click to reset`}
      style={{ width: "100%", height: "100%", display: "block", touchAction: "none", cursor: "grab", outline: "none" }}
    />
  );
}
