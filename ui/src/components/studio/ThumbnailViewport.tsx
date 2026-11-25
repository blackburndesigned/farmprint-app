import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Bounds, CameraState, FramingPreset, Vec3, boundsOfParts, cameraForPreset, clampedZoom, cloneCamera, defaultCamera, dot, normalize, presetDirection } from "../../viewportCamera";
import { onGLRestored } from "../../meshRendererGL";
import { type ManipulateTarget, type MeshShading, type ThumbnailViewportHandle, type ThumbnailViewportProps, type ViewportBackdrop } from "./viewportTypes";
import { JOG_DEG_PER_SEC, JOG_PAN_PX_PER_SEC, JOG_ZOOM_PER_SEC, VIEWPORT_HINT, anglesToLight, bindViewportGestures, lightToAngles, nudgeOrbit, nudgePan, nudgeRoll, nudgeZoom, startJog } from "./viewportGestures";
import { sizeCanvas } from "./PartOrbitThumb";
import { type DrawPart, drawGuides, nextFrame, paintBackdrop, pickPartAt, projectScene } from "./viewportDrawing";
import { ViewControls, hudButton, iconButton, menuStyle } from "./ViewControls";
import { Grid3x3 } from "lucide-react";
import { Icon } from "../../icons";

export const ThumbnailViewport = forwardRef<ThumbnailViewportHandle, ThumbnailViewportProps>(
  function ThumbnailViewport(props, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const camRef = useRef<CameraState>(defaultCamera());
    const interactingRef = useRef(false);
    const presetRef = useRef<FramingPreset | null>(props.framingPreset);
    const propsRef = useRef(props);
    propsRef.current = props;
    const tokenRef = useRef(props.framingToken);
    const boundsKeyRef = useRef("");
    const boundsRef = useRef<Bounds | null>(null);
    const intensityRef = useRef({ key: props.keyIntensity, fill: props.fillIntensity, ambient: props.ambientIntensity });
    if (!interactingRef.current) {
      intensityRef.current = { key: props.keyIntensity, fill: props.fillIntensity, ambient: props.ambientIntensity };
    }
    const lightKeyRef = useRef("");
    const lightKey = props.lightDirection ? props.lightDirection.join(",") : "";
    if (lightKey !== lightKeyRef.current) {
      lightKeyRef.current = lightKey;
      if (props.lightDirection) camRef.current = { ...camRef.current, light: normalize([...props.lightDirection] as Vec3) };
    }
    const [lightAngles, setLightAngles] = useState(() => lightToAngles(camRef.current.light));
    const [panMode, setPanMode] = useState(false);
    const [controlsOpen, setControlsOpen] = useState(!props.controlsCollapsed);
    const hoveredRef = useRef<string | null>(null);
    const reportLight = () => {
      const l = [...camRef.current.light] as Vec3;
      lightKeyRef.current = l.join(",");
      setLightAngles(lightToAngles(l));
      propsRef.current.onLightDirection?.(l);
    };
    const frame = (preset: FramingPreset, resetView: boolean) => {
      if (propsRef.current.onFrame) propsRef.current.onFrame(preset, resetView);
      else applyFraming(preset, resetView);
    };
    const step = (fn: (camera: CameraState) => void) => {
      fn(camRef.current);
      if (presetRef.current) {
        presetRef.current = null;
        propsRef.current.onPresetCleared();
      }
      redraw();
    };
    const partIdsRef = useRef("");
    const visibleBounds = () => {
      const parts = propsRef.current.parts;
      const key = parts.map((part) => `${part.id}:${part.visible ? 1 : 0}:${part.meshPositions?.length || 0}`).join("|");
      if (key !== boundsKeyRef.current) {
        const ids = parts.map((part) => `${part.id}:${part.meshPositions?.length || 0}`).join("|");
        if (ids !== partIdsRef.current) {
          // New model loaded: frame it fresh (fit the bounding sphere, no leftover zoom/pan).
          partIdsRef.current = ids;
          camRef.current = { ...camRef.current, zoom: 1, pan: [0, 0, 0] };
        }
        boundsKeyRef.current = key;
        boundsRef.current = boundsOfParts(parts);
      }
      return boundsRef.current;
    };

    const frameRef = useRef(0);
    const redraw = () => {
      if (frameRef.current) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = 0;
        paintFrame();
      });
    };
    const paintFrame = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 640;
      const height = canvas.clientHeight || 480;
      // Assigning width/height reallocates the backing store, so only do it on a real resize.
      sizeCanvas(canvas, Math.floor(width * dpr), Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const live = propsRef.current;
      paintBackdrop(ctx, width, height, live.backdrop);
      const drawParts: DrawPart[] = live.parts
        .filter((part) => part.visible && part.meshPositions && part.meshIndices && part.meshIndices.length >= 3)
        .map((part) => ({
          id: part.id,
          hex: part.filamentHex,
          positions: part.meshPositions || [],
          indices: part.meshIndices || [],
          selected: live.selectedIds.includes(part.id) || (!!live.onPartClick && hoveredRef.current === part.id),
        }));
      if (drawParts.length === 0) {
        ctx.fillStyle = "rgba(80,80,80,0.8)";
        ctx.font = "13px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(live.emptyMessage ?? "Import a .3mf or .stl", width / 2, height / 2);
        return;
      }
      const lights = intensityRef.current;
      projectScene(
        ctx, width, height, camRef.current, drawParts, live.shading,
        lights.key, lights.fill, lights.ambient, visibleBounds(), dpr
      );
      const darkLines = (live.backdrop === "default" && !window.matchMedia?.("(prefers-color-scheme: dark)").matches) || live.backdrop === "light" || live.backdrop === "checker";
      drawGuides(ctx, width, height, live.showGrid, darkLines);
    };

    const applyFraming = (preset: FramingPreset, resetView: boolean) => {
      camRef.current = cameraForPreset(preset, resetView, camRef.current);
      presetRef.current = preset;
      redraw();
    };

    const renderSquareCanvas = (
      size: number,
      onlyId?: string,
      hexOverride?: string,
      hexFor?: (id: string) => string
    ): HTMLCanvasElement | null => {
        const liveCanvas = canvasRef.current;
        const width = liveCanvas?.clientWidth || size;
        const height = liveCanvas?.clientHeight || size;
        const cw = Math.max(2, Math.floor(width));
        const ch = Math.max(2, Math.floor(height));
        // Render the square at (about) `size`: the GL context is already multisampled, so a
        // 4× supersample only cost memory (a ~21 MB canvas per bake on a 900×700 view).
        const ps = Math.max(1, Math.min(2, size / Math.min(cw, ch)));
        const off = document.createElement("canvas");
        off.width = Math.round(cw * ps);
        off.height = Math.round(ch * ps);
        const ctx = off.getContext("2d");
        if (!ctx) return null;
        ctx.setTransform(ps, 0, 0, ps, 0, 0);
        const live = propsRef.current;
        // Backdrop is authoring-only; baked thumbnails stay transparent.
        const drawParts: DrawPart[] = live.parts
          .filter((part) => part.visible && part.meshPositions && part.meshIndices)
          .filter((part) => !onlyId || part.id === onlyId)
          .map((part) => ({
            id: part.id,
            hex: hexFor ? hexFor(part.id) : hexOverride || part.filamentHex,
            positions: part.meshPositions || [],
            indices: part.meshIndices || [],
            selected: false,
          }));
        const lights = intensityRef.current;
        projectScene(
          ctx, cw, ch, { ...camRef.current, zoom: 1, pan: [0, 0, 0] as Vec3 }, drawParts, live.shading,
          lights.key, lights.fill, lights.ambient, visibleBounds(), ps
        );
        const side = Math.min(off.width, off.height);
        const square = document.createElement("canvas");
        square.width = size;
        square.height = size;
        const sctx = square.getContext("2d");
        if (!sctx) return null;
        sctx.imageSmoothingQuality = "high";
        sctx.drawImage(off, (off.width - side) / 2, (off.height - side) / 2, side, side, 0, 0, size, size);
        return square;
      };
    const renderSquare = (size: number, onlyId?: string, hexOverride?: string): string =>
      renderSquareCanvas(size, onlyId, hexOverride)?.toDataURL("image/png") || "";

    /** Layer for one part holding only the pixels of it that are visible in the full
     *  assembly. The whole scene is rendered all-black once, then again with this part
     *  white: pixels that change are where this part wins the depth test. The part's own
     *  white render is then masked to those pixels, so hidden parts never paint over
     *  the parts in front of them. */
    const renderOccludedLayer = (size: number, partId: string, allBlack: ImageData | null): string => {
      const solo = renderSquareCanvas(size, partId, "#FFFFFF");
      if (!solo) return "";
      if (!allBlack) return solo.toDataURL("image/png");
      const lit = renderSquareCanvas(size, undefined, undefined, (id) => (id === partId ? "#FFFFFF" : "#000000"));
      const lctx = lit?.getContext("2d");
      const sctx = solo.getContext("2d");
      if (!lit || !lctx || !sctx) return solo.toDataURL("image/png");
      const a = lctx.getImageData(0, 0, size, size).data;
      const b = allBlack.data;
      const img = sctx.getImageData(0, 0, size, size);
      const d = img.data;
      let any = false;
      for (let i = 0; i < d.length; i += 4) {
        const diff = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        // Soft edge: antialiased boundary pixels keep partial coverage.
        const vis = Math.min(1, diff / 24);
        d[i + 3] = Math.round(d[i + 3] * vis);
        if (d[i + 3] > 0) any = true;
      }
      if (!any) return "";
      sctx.putImageData(img, 0, 0);
      return solo.toDataURL("image/png");
    };

    const layerBase = (size: number): ImageData | null =>
      renderSquareCanvas(size, undefined, undefined, () => "#000000")?.getContext("2d")?.getImageData(0, 0, size, size) || null;
    const layerParts = (ids?: string[]) =>
      propsRef.current.parts.filter(
        (part) => part.visible && !part.pickIgnore && part.meshPositions && part.meshIndices && part.meshIndices.length >= 3 && (!ids || ids.includes(part.id))
      );

    useImperativeHandle(ref, () => ({
      applyFraming,
      getCamera: () => cloneCamera(camRef.current),
      setCamera: (camera: CameraState) => {
        camRef.current = { ...cloneCamera(camera), zoom: clampedZoom(camera.zoom) };
        presetRef.current = null;
        redraw();
      },
      capture(size: number) {
        return renderSquare(size);
      },
      captureLayers(size: number, opts?: { ids?: string[] }) {
        const allBlack = layerBase(size);
        return layerParts(opts?.ids)
          .map((part) => ({ id: part.id, dataUrl: renderOccludedLayer(size, part.id, allBlack) }))
          .filter((l) => !!l.dataUrl);
      },
      async captureLayersAsync(size: number, opts?: { ids?: string[]; onProgress?: (done: number, total: number) => void }) {
        const allBlack = layerBase(size);
        const list = layerParts(opts?.ids);
        const out: Array<{ id: string; dataUrl: string }> = [];
        for (let i = 0; i < list.length; i++) {
          opts?.onProgress?.(i, list.length);
          await nextFrame();
          const dataUrl = renderOccludedLayer(size, list[i].id, allBlack);
          if (dataUrl) out.push({ id: list[i].id, dataUrl });
        }
        opts?.onProgress?.(list.length, list.length);
        return out;
      },
    }));

    useEffect(() => {
      if (tokenRef.current !== props.framingToken && props.framingPreset) {
        tokenRef.current = props.framingToken;
        applyFraming(props.framingPreset, props.resetOnFrame);
      } else {
        redraw();
      }
    }, [props.framingToken, props.parts, props.selectedIds, props.backdrop, props.showGrid, props.shading, props.keyIntensity, props.fillIntensity, props.ambientIntensity]);

    /** Part id under a client point (pickable parts only), or null. */
    const pickAt = (clientX: number, clientY: number): string | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const live = propsRef.current;
      const visible = live.parts.filter((part) => part.visible && !part.pickIgnore && part.meshPositions && part.meshIndices && part.meshIndices.length >= 3);
      const hit = pickPartAt({
        x: clientX - rect.left,
        y: clientY - rect.top,
        width: rect.width,
        height: rect.height,
        camera: camRef.current,
        bounds: visibleBounds(),
        parts: visible.map((part) => ({ id: part.id, positions: part.meshPositions || [], indices: part.meshIndices || [] })),
      });
      if (!hit) return null;
      return !live.pickableIds || live.pickableIds.includes(hit) ? hit : null;
    };
    const pickAtRef = useRef(pickAt);
    pickAtRef.current = pickAt;

    const redrawRef = useRef(redraw);
    redrawRef.current = redraw;
    const frameRef2 = useRef(frame);
    frameRef2.current = frame;
    const reportLight2 = useRef(reportLight);
    reportLight2.current = reportLight;

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const stop = bindViewportGestures(canvas, {
        camera: () => camRef.current,
        bounds: () => visibleBounds(),
        manipulate: () => propsRef.current.manipulate,
        intensities: () => intensityRef.current,
        setIntensities: (next) => {
          intensityRef.current = next;
        },
        setInteracting: (active) => {
          interactingRef.current = active;
        },
        onReset: () => frameRef2.current("threeQuarter", true),
        onSettled: () => {
          const lk = camRef.current.light.join(",");
          if (lk !== lightKeyRef.current) reportLight2.current();
          const preset = presetRef.current;
          if (preset && propsRef.current.manipulate === "model") {
            const expected = presetDirection(preset);
            if (Math.abs(dot(normalize(camRef.current.direction), expected) - 1) > 0.02) {
              presetRef.current = null;
              propsRef.current.onPresetCleared();
            }
          }
          const live = intensityRef.current;
          const current = propsRef.current;
          if (
            live.key !== current.keyIntensity ||
            live.fill !== current.fillIntensity ||
            live.ambient !== current.ambientIntensity
          ) {
            current.onLightIntensities(live.key, live.fill, live.ambient);
          }
        },
        redraw: () => redrawRef.current(),
        onTap: (event) => {
          const cb = propsRef.current.onPartClick;
          if (!cb || !event) return;
          cb(pickAtRef.current(event.clientX, event.clientY), { metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey });
        },
      });
      // Hover highlight + pointer cursor over pickable parts (only when click-to-pick is on).
      let hoverFrame = 0;
      let hoverPt: { x: number; y: number } | null = null;
      const setHover = (id: string | null) => {
        if (hoveredRef.current === id) return;
        hoveredRef.current = id;
        canvas.style.cursor = id ? "pointer" : "grab";
        redrawRef.current();
      };
      const onHoverMove = (event: PointerEvent) => {
        if (!propsRef.current.onPartClick || event.pointerType === "touch") return;
        if (event.buttons !== 0) { setHover(null); return; }
        hoverPt = { x: event.clientX, y: event.clientY };
        if (hoverFrame) return;
        hoverFrame = window.requestAnimationFrame(() => {
          hoverFrame = 0;
          if (hoverPt) setHover(pickAtRef.current(hoverPt.x, hoverPt.y));
        });
      };
      const onHoverLeave = () => { hoverPt = null; setHover(null); };
      canvas.addEventListener("pointermove", onHoverMove);
      canvas.addEventListener("pointerleave", onHoverLeave);
      const observer = new ResizeObserver(() => redrawRef.current());
      observer.observe(canvas);
      const stopRestore = onGLRestored(() => redrawRef.current());
      redrawRef.current();
      return () => {
        stop();
        stopRestore();
        canvas.removeEventListener("pointermove", onHoverMove);
        canvas.removeEventListener("pointerleave", onHoverLeave);
        if (hoverFrame) window.cancelAnimationFrame(hoverFrame);
        observer.disconnect();
        if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
        frameRef.current = 0; // else a cancelled frame id blocks every later redraw (StrictMode remount)
      };
    }, []);

    return (
      <div style={{ position: "relative", flex: 1, minHeight: 0, borderRadius: 10, overflow: "hidden" }}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="application"
          aria-roledescription="3D viewer"
          aria-label={`3D product viewport. ${VIEWPORT_HINT}`}
          title={VIEWPORT_HINT}
          style={{ width: "100%", height: "100%", display: "block", touchAction: "none", cursor: "grab", outline: "none" }}
        />
        <ViewControls
          open={controlsOpen}
          onToggle={() => setControlsOpen((v) => !v)}
          panMode={panMode}
          onPanMode={setPanMode}
          onJog={(kind, sx, sy) => {
            interactingRef.current = true;
            return startJog(
              (k) =>
                step((c) => {
                  if (kind === "zoom") nudgeZoom(c, Math.exp(-sx * JOG_ZOOM_PER_SEC * k));
                  else if (kind === "roll") nudgeRoll(c, sx * JOG_DEG_PER_SEC * k);
                  else if (panMode) nudgePan(c, visibleBounds(), sx * JOG_PAN_PX_PER_SEC * k, sy * JOG_PAN_PX_PER_SEC * k);
                  else nudgeOrbit(c, sx * JOG_DEG_PER_SEC * k, sy * JOG_DEG_PER_SEC * k);
                }),
              () => {
                interactingRef.current = false;
                redraw();
              }
            );
          }}
          onReset={() => frame("threeQuarter", true)}
          onPreset={(p) => frame(p, false)}
          azimuth={lightAngles.azimuth}
          elevation={lightAngles.elevation}
          onLightAngles={(az, el) => {
            camRef.current.light = anglesToLight(az, el);
            reportLight();
            redraw();
          }}
          showLight={!props.hideAuthoringHud}
          keyIntensity={props.keyIntensity}
          onKeyIntensity={(k) => props.onLightIntensities(k, props.fillIntensity, props.ambientIntensity)}
        />
        {!props.hideAuthoringHud && (
        <div
          style={{
            position: "absolute",
            left: 10,
            bottom: 10,
            display: "flex",
            gap: 8,
            alignItems: "center",
            padding: "5px 6px",
            borderRadius: 8,
            background: "color-mix(in srgb, canvas 72%, transparent)",
            boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
          }}
        >
          <div style={{ display: "flex", width: 148, borderRadius: 6, overflow: "hidden", border: "1px solid color-mix(in srgb, canvastext 18%, transparent)" }}>
            {(["model", "light"] as ManipulateTarget[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => props.onManipulate(item)}
                style={hudButton(props.manipulate === item)}
              >
                {item === "model" ? "Model" : "Light"}
              </button>
            ))}
          </div>
          <button type="button" title={props.showGrid ? "Hide alignment grid" : "Show alignment grid"} onClick={() => props.onShowGrid(!props.showGrid)} style={iconButton(props.showGrid)}>
            <Icon icon={Grid3x3} />
          </button>
          <select
            aria-label="Viewport backdrop"
            title="Viewport backdrop (authoring only — not exported)"
            value={props.backdrop}
            onChange={(event) => props.onBackdrop(event.target.value as ViewportBackdrop)}
            style={menuStyle}
          >
            <option value="default">Default</option>
            <option value="checker">Checker</option>
            <option value="dark">Dark</option>
            <option value="midGray">Mid gray</option>
            <option value="light">Light</option>
          </select>
          <select
            aria-label="Mesh shading"
            value={props.shading}
            onChange={(event) => props.onShading(event.target.value as MeshShading)}
            style={menuStyle}
          >
            <option value="standard">Standard</option>
            <option value="depth">Depth</option>
            <option value="cel">Cel</option>
          </select>
        </div>
        )}
      </div>
    );
  }
);
