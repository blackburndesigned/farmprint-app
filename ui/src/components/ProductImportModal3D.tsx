import { FEATURES } from "../features";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { renderAssemblyThumbnailDataUrl, renderPartThumbnailDataUrl } from "./PartThumbnail3D";
import { FRAMING_PRESETS, MeshShading, renderPartTileCamera, StudioPartLayer, ThumbnailViewport, ThumbnailViewportHandle, ViewportBackdrop, framingPresetName, ManipulateTarget, nextFrame, VIEWPORT_HINT } from "./StudioViewport3D";
import { CameraState, FramingPreset } from "../viewportCamera";
import { registerCustomNeutralPartPng } from "../partThumbnails";
import { askConfirm } from "../uiFeedback";
import { type CreatedCatalogProductPayload, type ImportedProductCatalogDraft, type ImportedStudioPart, type InscriptionStudioConfig, type ProductImportModal3DProps, loadPartIconCameras, partIconCameraFromJson } from "./productImport/importTypes";
import { FILAMENT_SWATCHES, chipButton, plainButton, prominentButton, segmentButton } from "./productImport/importFormUi";
import { LARGE_MESH_TRIANGLES, meshesFromFile, normalizeSlicedName, readSliceInfoFromBuffer, slicedEstimatesByName } from "./productImport/meshImport";
import { analyzeClientMeshHealth } from "./productImport/meshHealth";
import { DetailsStep } from "./productImport/DetailsStep";
import { PartsStep } from "./productImport/PartsStep";
import { ViewsStep } from "./productImport/ViewsStep";

export const ProductImportModal3D: React.FC<ProductImportModal3DProps> = ({
  open = true,
  onClose,
  onCreateProduct,
  onSaveProduct,
  editingDraft = null,
  filaments = [],
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [productName, setProductName] = useState("");
  const [sku, setSku] = useState("");
  const [category, setCategory] = useState("");
  const [basePriceUsd, setBasePriceUsd] = useState<number>(0);
  const [shippingBox, setShippingBox] = useState<"Small" | "Medium" | "Large">("Small");

  const [lightingPreset, setLightingPreset] = useState<"Soft" | "Standard" | "Hard">("Standard");
  const [cameraPreset, setCameraPreset] = useState<"Iso" | "Front" | "Top" | "Right">("Iso");
  const [parts, setParts] = useState<ImportedStudioPart[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [categoryDraft, setCategoryDraft] = useState("");
  const [costText, setCostText] = useState("");
  const [sourceFileName, setSourceFileName] = useState("");
  const [activePreset, setActivePreset] = useState<FramingPreset | null>("threeQuarter");
  const [framingPreset, setFramingPreset] = useState<FramingPreset>("threeQuarter");
  const [framingToken, setFramingToken] = useState(0);
  const [resetOnFrame, setResetOnFrame] = useState(true);
  const [manipulate, setManipulate] = useState<ManipulateTarget>("model");
  const [showGrid, setShowGrid] = useState(false);
  const [backdrop, setBackdrop] = useState<ViewportBackdrop>("default");
  const [shading, setShading] = useState<MeshShading>("standard");
  const [keyIntensity, setKeyIntensity] = useState(900);
  const [fillIntensity, setFillIntensity] = useState(350);
  const [ambientIntensity, setAmbientIntensity] = useState(280);
  const [lightDirection, setLightDirection] = useState<[number, number, number] | null>(null);
  const [extraViews, setExtraViews] = useState<{ id: string; name: string; inscription: boolean; camera: CameraState }[]>([]);
  const [selectedViewId, setSelectedViewId] = useState("");
  const [newViewName, setNewViewName] = useState("");
  const [productHasAddOns, setProductHasAddOns] = useState(false);
  const [setAllOpen, setSetAllOpen] = useState(false);
  const [removedPart, setRemovedPart] = useState<ImportedStudioPart | null>(null);
  const [partGroups, setPartGroups] = useState<{ id: string; title: string; memberPartIds: string[] }[]>([]);
  const [removedGroup, setRemovedGroup] = useState<{ group: { id: string; title: string; memberPartIds: string[] }; index: number } | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [workStatus, setWorkStatus] = useState("");
  const viewportRef = useRef<ThumbnailViewportHandle | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  // True while the app saves the product; the Save button is disabled so it can't run twice.
  const [committing, setCommitting] = useState(false);
  const [saveProgress, setSaveProgress] = useState<string | null>(null);
  const [importStatusBanner, setImportStatusBanner] = useState<string | null>(null);

  const [inscription, setInscription] = useState<InscriptionStudioConfig>({
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
  });

  useEffect(() => {
    if (!open) return;
    if (editingDraft) {
      setProductName(editingDraft.name || "");
      setSku(editingDraft.sku || "");
      setCategory(editingDraft.category || "");
      setBasePriceUsd(editingDraft.basePriceUsd || 0);
      setShippingBox(editingDraft.shippingBox || "Small");
      setLightingPreset(editingDraft.lightingPreset || "Standard");
      {
        const sl = (editingDraft as CreatedCatalogProductPayload).studioLighting;
        setKeyIntensity(sl?.key ?? 900);
        setFillIntensity(sl?.fill ?? 350);
        setAmbientIntensity(sl?.ambient ?? 280);
        setLightDirection(sl?.light && sl.light.length === 3 ? [sl.light[0], sl.light[1], sl.light[2]] : null);
      }
      setCameraPreset(editingDraft.cameraPreset || "Iso");
      setParts(editingDraft.parts || []);
      // Restore each part tile's saved camera when the draft doesn't carry it.
      if (editingDraft.id && (editingDraft.parts || []).some((p: ImportedStudioPart) => !p.thumbnailCamera)) {
        const draftId = String(editingDraft.id);
        void loadPartIconCameras(draftId).then((cams) => {
          if (!cams || !Object.keys(cams).length) return;
          setParts((prev) =>
            prev.map((p) => {
              if (p.thumbnailCamera) return p;
              const cam = partIconCameraFromJson(cams[p.id] ?? cams[p.partName]);
              return cam ? { ...p, thumbnailCamera: cam } : p;
            })
          );
        });
      }
      setSelectedIds([]);
      setCategories(
        (editingDraft.category || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      );
      setInscription(editingDraft.inscription);
      setStep(1);
      setImportStatusBanner(null);
      setSourceFileName("");
      setPartGroups([]);
      setRemovedGroup(null);
      setIsWorking(false);
      setWorkStatus("");
      return;
    }
    setProductName("");
    setSku("");
    setCategory("");
    setBasePriceUsd(0);
    setShippingBox("Small");
    setParts([]);
    setSelectedIds([]);
    setCategories([]);
    setCategoryDraft("");
    setCostText("");
    setSourceFileName("");
    setExtraViews([]);
    setSelectedViewId("");
    setNewViewName("");
    setProductHasAddOns(false);
    setRemovedPart(null);
    setPartGroups([]);
    setRemovedGroup(null);
    setIsWorking(false);
    setWorkStatus("");
    setActivePreset("threeQuarter");
    setStep(1);
    setInscription({
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
    });
    setImportStatusBanner(null);
  }, [open, editingDraft]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Start empty on + Add Product; user drops/selects .3mf/.stl or clicks Load Catalog Assembly

  const rebakeParts = (
    list: ImportedStudioPart[],
    nextLighting = lightingPreset,
    nextCamera = cameraPreset
  ): ImportedStudioPart[] =>
    list.map((p) => {
      // The part picture is the part's own tile: its camera (angle, zoom, pan) and lights,
      // white albedo like the composite layers, transparent background.
      const neutralUrl =
        renderPartTileCamera({ positions: p.meshPositions, indices: p.meshIndices, camera: p.thumbnailCamera, size: 256, hex: "#FFFFFF" }) ||
        renderPartThumbnailDataUrl({
          partName: p.partName,
          colorHex: "#FFFFFF",
          size: 128,
          lightingPreset: nextLighting,
          cameraPreset: nextCamera,
          meshPositions: p.meshPositions,
          meshIndices: p.meshIndices,
          neutralMode: true,
        });
      if (neutralUrl) {
        registerCustomNeutralPartPng(p.partName, neutralUrl);
      }
      return {
        ...p,
        neutralThumbnailDataUrl: neutralUrl || p.neutralThumbnailDataUrl,
        bakedThumbnailDataUrl:
          renderPartTileCamera({ positions: p.meshPositions, indices: p.meshIndices, camera: p.thumbnailCamera, size: 96, hex: p.defaultColorHex }) ||
          renderPartThumbnailDataUrl({
          partName: p.partName,
          colorHex: p.defaultColorHex,
          size: 96,
          lightingPreset: nextLighting,
          cameraPreset: nextCamera,
          meshPositions: p.meshPositions,
          meshIndices: p.meshIndices,
        }),
      };
    });

  const colorChoices = filaments.length > 0
    ? filaments.map((swatch) => ({
        id: swatch.id,
        name: swatch.name,
        hex: swatch.hex,
        label: swatch.material ? `${swatch.name} · ${swatch.material}` : swatch.name,
      }))
    : FILAMENT_SWATCHES.map((swatch) => ({
        id: swatch.hex,
        name: swatch.name,
        hex: swatch.hex,
        label: swatch.name,
      }));

  const handleFilesSelected = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (arr.length === 0) return;

    setIsWorking(true);
    setWorkStatus("Loading model…");
    setImportStatusBanner(null);
    const imported: ImportedStudioPart[] = [];
    const failures: string[] = [];
    for (let i = 0; i < arr.length; i++) {
      const file = arr[i];
      const stem = file.name
        .replace(/\.(stl|3mf)$/i, "")
        .replace(/[_-]+/g, " ")
        .trim();

      try {
        const buf = await file.arrayBuffer();
        const defaultLabel = stem ? stem.charAt(0).toUpperCase() + stem.slice(1) : `Part ${i + 1}`;
        const parsedObjects = await meshesFromFile(file.name, buf);
        const slicedByName = /\.3mf$/i.test(file.name)
          ? slicedEstimatesByName(await readSliceInfoFromBuffer(buf), parsedObjects)
          : new Map<string, { grams: number; minutes: number }>();

        for (let objIdx = 0; objIdx < parsedObjects.length; objIdx++) {
          const obj = parsedObjects[objIdx];
          if (obj.positions.length < 9 || obj.indices.length < 3) continue;
          // Default to readable shop colors: near-black/near-white spools render as a featureless
          // silhouette in the viewport, so cycle the mid-tone ones (fall back to all when none).
          const lum = (hex: string) => { const v = parseInt(hex.replace("#", "").slice(0, 6), 16) || 0; return (0.2126 * (v >> 16) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255; };
          const readable = colorChoices.filter((c) => { const l = lum(c.hex); return l > 0.18 && l < 0.92; });
          const pool = readable.length > 0 ? readable : colorChoices;
          const objSwatch = pool[(parts.length + imported.length) % pool.length];
          const health = analyzeClientMeshHealth(obj.positions, obj.indices);
          const partName = obj.name || defaultLabel;
          const sliced = slicedByName.get(normalizeSlicedName(obj.name));
          const thumb = renderPartThumbnailDataUrl({
            partName,
            colorHex: objSwatch.hex,
            size: 96,
            lightingPreset,
            cameraPreset,
            meshPositions: obj.positions,
            meshIndices: obj.indices,
          });
          imported.push({
            id: `imported-${Date.now()}-${i}-${objIdx}`,
            partName,
            sourceFileName: file.name,
            role: "Prints",
            showInPicture: true,
            defaultColorName: objSwatch.name,
            defaultColorHex: objSwatch.hex,
            grams: sliced?.grams ?? 0,
            printMinutes: sliced?.minutes ?? 0,
            printerType: "", // no built-in printer model; Print! uses the shop's own printers
            meshPositions: obj.positions,
            meshIndices: obj.indices,
            meshHealth: health,
            bakedThumbnailDataUrl: thumb,
          });
        }
      } catch (err) {
        failures.push(
          `${file.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (imported.length > 0) {
      setParts((prev) => [...prev, ...imported]);
      if (!productName.trim() && arr[0]) {
        const cleanName = arr[0].name.replace(/\.(3mf|stl)$/i, "").replace(/[_-]+/g, " ").trim();
        setProductName(cleanName || "New Product");
        if (!sku.trim()) {
          setSku("FP-" + (cleanName.slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, "") || "PROD") + "-100");
        }
      }
      setSourceFileName(arr[0]?.name || "");
      const notes: string[] = [];
      if (failures.length) notes.push(`Couldn't import ${failures.join("; ")}`);
      const heavy = imported.filter((p) => p.meshIndices.length / 3 > LARGE_MESH_TRIANGLES);
      if (heavy.length) {
        notes.push(
          `${heavy.map((p) => p.partName).join(", ")} ${heavy.length === 1 ? "has" : "have"} over ${(LARGE_MESH_TRIANGLES / 1e6).toFixed(0)} million triangles, so the editor may be slow. A lighter export from your CAD app will be faster.`
        );
      }
      setImportStatusBanner(notes.length ? notes.join(" ") : null);
      setActivePreset("threeQuarter");
      setFramingPreset("threeQuarter");
      setResetOnFrame(true);
      setFramingToken((token) => token + 1);
    } else {
      setImportStatusBanner(failures[0] || "No triangles found in that file.");
    }
    setIsWorking(false);
    setWorkStatus("");
  };

  const studioLayers: StudioPartLayer[] = useMemo(
    () =>
      parts.map((p) => ({
        id: p.id,
        name: p.partName,
        filamentName: p.defaultColorName,
        filamentHex: p.defaultColorHex,
        visible: p.showInPicture,
        offsetMm: [0, 0, 0] as [number, number, number],
        health: p.meshHealth,
        meshPositions: p.meshPositions,
        meshIndices: p.meshIndices,
      })),
    [parts]
  );

  if (!open) return null;

  const hasMesh = parts.length > 0;
  const frameTo = (preset: FramingPreset, resetView: boolean) => {
    setActivePreset(preset);
    setFramingPreset(preset);
    setResetOnFrame(resetView);
    setSelectedViewId("");
    setFramingToken((token) => token + 1);
  };
  const togglePart = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };
  const commitProduct = async () => {
    if (committing) return;
    // The bakes below are heavy; show progress and let the window paint between them.
    setCommitting(true);
    setSaveProgress("Saving pictures…");
    let handedOff = false;
    try {
      await nextFrame();
      const bakedParts = rebakeParts(parts, lightingPreset, cameraPreset);
      await nextFrame();
      const viewportShot = viewportRef.current?.capture(1024) || "";
      // Layers only when the picture came from the viewport, so they share its camera. Parts
      // hidden in the picture are skipped instead of rendered and thrown away.
      const shownIds = bakedParts.filter((p) => p.showInPicture).map((p) => p.id);
      const compositeLayers = viewportShot && viewportRef.current
        ? (await viewportRef.current.captureLayersAsync(1024, {
            ids: shownIds,
            onProgress: (done, total) => setSaveProgress(`Saving pictures… ${done}/${total}`),
          })).flatMap((l, i) => {
            const part = bakedParts.find((p) => p.id === l.id);
            return part ? [{ partId: part.id, partName: part.partName, dataUrl: l.dataUrl, compositeZ: i }] : [];
          })
        : [];
      const compositeThumbnailDataUrl =
        viewportShot ||
        renderAssemblyThumbnailDataUrl({
          parts: bakedParts
            .filter((part) => part.showInPicture)
            .map((part) => ({
              colorHex: part.defaultColorHex,
              meshPositions: part.meshPositions,
              meshIndices: part.meshIndices,
              visible: part.showInPicture,
            })),
          size: 1024,
          lightingPreset,
          cameraPreset,
        });
      const id =
        editingDraft?.id ||
        `product-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
      const draft: ImportedProductCatalogDraft = {
        id,
        name: productName.trim() || "Custom 3D Product",
        sku: sku.trim() || "FP-CUSTOM",
        category: categories.join(", ") || category.trim() || "Custom 3D Prints",
        basePriceUsd,
        shippingBox,
        lightingPreset,
        cameraPreset: activePreset === "front" ? "Front" : activePreset === "top" ? "Top" : "Iso",
        parts: bakedParts,
        inscription,
        studioLighting: {
          key: keyIntensity,
          fill: fillIntensity,
          ambient: ambientIntensity,
          light: (viewportRef.current?.getCamera().light as [number, number, number] | undefined) ?? lightDirection ?? undefined,
        },
        compositeThumbnailDataUrl,
        compositeLayers,
        viewCamera: viewportShot ? viewportRef.current?.getCamera() : undefined,
      };
      const result = onCreateProduct?.(draft);
      onSaveProduct?.(draft);
      if (result && typeof (result as Promise<boolean | void>).then === "function") {
        handedOff = true;
        setSaveProgress("Saving…");
        void (result as Promise<boolean | void>)
          .then((ok) => {
            if (ok !== false) onClose();
          })
          .finally(() => { setCommitting(false); setSaveProgress(null); });
      } else if (result !== false) {
        onClose();
      }
    } finally {
      if (!handedOff) { setCommitting(false); setSaveProgress(null); }
    }
  };
  const saveCurrentView = (asNew: boolean) => {
    const camera = viewportRef.current?.getCamera();
    if (!camera) return;
    if (!asNew && selectedViewId) {
      setExtraViews((prev) => prev.map((view) => (view.id === selectedViewId ? { ...view, camera } : view)));
      return;
    }
    const name = newViewName.trim();
    if (!name) return;
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "view"}-${crypto.randomUUID().slice(0, 4)}`;
    setExtraViews((prev) => [...prev, { id, name, inscription: false, camera }]);
    setSelectedViewId(id);
    setNewViewName("");
    setActivePreset(null);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(0,0,0,0.28)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onMouseDown={(event) => {
        // A stray click outside must not throw away an editing session.
        if (event.target !== event.currentTarget) return;
        void askConfirm({
          title: "Discard this product's changes?",
          message: "Anything not saved in the Product Editor will be lost.",
          confirmLabel: "Discard",
          cancelLabel: "Keep editing",
          danger: true,
        }).then((discard) => {
          if (discard) onClose();
        });
      }}
    >
      <div
        onMouseDown={(event) => event.stopPropagation()}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDraggingOver(true);
        }}
        onDragLeave={() => setIsDraggingOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsDraggingOver(false);
          if (event.dataTransfer.files?.length) handleFilesSelected(event.dataTransfer.files);
        }}
        style={{
          width: "min(1480px, 96vw)",
          height: "min(900px, 92vh)",
          minWidth: "min(1100px, 96vw)",
          minHeight: "min(760px, 92vh)",
          background: "canvas",
          color: "canvastext",
          colorScheme: "light dark",
          borderRadius: 12,
          boxShadow: "0 24px 80px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".3mf,.stl,model/stl,model/3mf"
          multiple
          style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
          onChange={(event) => {
            if (event.target.files) handleFilesSelected(event.target.files);
            event.target.value = "";
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 20px" }}>
          <span style={{ fontSize: 18 }} aria-hidden>⌖</span>
          <span style={{ fontSize: 17, fontWeight: 600 }}>
            {editingDraft ? `Product Editor — ${editingDraft.name}` : "Product Editor"}
          </span>
          <span style={{ flex: 1 }} />
          {hasMesh && (
            <button type="button" onClick={() => fileInputRef.current?.click()} style={plainButton}>
              Import Model(s)…
            </button>
          )}
        </div>
        <div style={{ height: 1, background: "color-mix(in srgb, canvastext 12%, transparent)" }} />

        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {!hasMesh ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 14,
                background: isDraggingOver ? "color-mix(in srgb, #0a84ff 8%, transparent)" : "transparent",
              }}
            >
              <div style={{ fontSize: 48, opacity: isDraggingOver ? 1 : 0.55 }}>📦</div>
              <div style={{ fontSize: 17, fontWeight: 650 }}>Import a .3mf or .stl</div>
              <div style={{ fontSize: 12, opacity: 0.6, maxWidth: 640, textAlign: "center" }}>{VIEWPORT_HINT}</div>
              <button type="button" onClick={() => fileInputRef.current?.click()} style={prominentButton}>
                Import Model(s)…
              </button>
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(440px, 600px)" }}>
              <div style={{ minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 16px 0" }}>
                  {FRAMING_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => frameTo(preset, false)}
                      style={chipButton(activePreset === preset)}
                    >
                      {framingPresetName(preset)}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => frameTo("threeQuarter", true)}
                    style={chipButton(false)}
                  >
                    Reset view
                  </button>
                  <span style={{ fontSize: 11.5, opacity: 0.55 }} title="The product picture keeps this angle and light, and always fits the whole product.">
                    Zoom and pan are for looking; the picture always fits the whole product.
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {sourceFileName}
                  </span>
                </div>
                <div style={{ flex: 1, minHeight: 0, padding: 12, display: "flex" }}>
                  <ThumbnailViewport
                    ref={viewportRef}
                    parts={studioLayers}
                    selectedIds={selectedIds}
                    backdrop={backdrop}
                    showGrid={showGrid}
                    shading={shading}
                    manipulate={manipulate}
                    onManipulate={setManipulate}
                    onShowGrid={setShowGrid}
                    onBackdrop={setBackdrop}
                    onShading={setShading}
                    keyIntensity={keyIntensity}
                    fillIntensity={fillIntensity}
                    ambientIntensity={ambientIntensity}
                    onLightIntensities={(key, fill, ambient) => {
                      setKeyIntensity(key);
                      setFillIntensity(fill);
                      setAmbientIntensity(ambient);
                    }}
                    onPresetCleared={() => setActivePreset(null)}
                    lightDirection={lightDirection}
                    onLightDirection={(l) => setLightDirection([l[0], l[1], l[2]])}
                    onFrame={(preset, reset) => frameTo(preset, reset)}
                    framingToken={framingToken}
                    framingPreset={framingPreset}
                    resetOnFrame={resetOnFrame}
                  />
                </div>
              </div>

              <div style={{ minHeight: 0, overflow: "auto", borderLeft: "1px solid color-mix(in srgb, canvastext 12%, transparent)" }}>
                <div style={{ display: "flex", margin: "10px 12px 4px", borderRadius: 8, overflow: "hidden", border: "1px solid color-mix(in srgb, canvastext 16%, transparent)" }}>
                  {([
                    [1, "Product"],
                    [2, "Parts & add-ons"],
                    [3, FEATURES.inscription3d ? "Picture & inscription" : "Picture"],
                  ] as const).map(([n, label]) => (
                    <button key={n} type="button" onClick={() => setStep(n)} style={segmentButton(step === n)}>
                      {label}
                    </button>
                  ))}
                </div>

                {step === 1 && (
                  <DetailsStep
                    productName={productName}
                    setProductName={setProductName}
                    costText={costText}
                    setCostText={setCostText}
                    basePriceUsd={basePriceUsd}
                    setBasePriceUsd={setBasePriceUsd}
                    categories={categories}
                    setCategories={setCategories}
                    categoryDraft={categoryDraft}
                    setCategoryDraft={setCategoryDraft}
                  />
                )}

                {step === 2 && (
                  <PartsStep
                    selectedIds={selectedIds}
                    setPartGroups={setPartGroups}
                    parts={parts}
                    setSelectedIds={setSelectedIds}
                    setSetAllOpen={setSetAllOpen}
                    setAllOpen={setAllOpen}
                    setParts={setParts}
                    colorChoices={colorChoices}
                    togglePart={togglePart}
                    setRemovedPart={setRemovedPart}
                    removedPart={removedPart}
                    partGroups={partGroups}
                    removedGroup={removedGroup}
                    setRemovedGroup={setRemovedGroup}
                    productHasAddOns={productHasAddOns}
                    setProductHasAddOns={setProductHasAddOns}
                  />
                )}

                {step === 3 && (
                  <ViewsStep
                    frameTo={frameTo}
                    selectedViewId={selectedViewId}
                    extraViews={extraViews}
                    setSelectedViewId={setSelectedViewId}
                    setActivePreset={setActivePreset}
                    viewportRef={viewportRef}
                    setExtraViews={setExtraViews}
                    setInscription={setInscription}
                    newViewName={newViewName}
                    setNewViewName={setNewViewName}
                    saveCurrentView={saveCurrentView}
                    inscription={inscription}
                    keyIntensity={keyIntensity}
                    setKeyIntensity={setKeyIntensity}
                    fillIntensity={fillIntensity}
                    setFillIntensity={setFillIntensity}
                    ambientIntensity={ambientIntensity}
                    setAmbientIntensity={setAmbientIntensity}
                    manipulate={manipulate}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        {importStatusBanner && (
          <div style={{ color: "#ff3b30", fontSize: 12, padding: "6px 20px" }}>{importStatusBanner}</div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 20 }}>
          {isWorking && (
            <span style={{ fontSize: 12, opacity: 0.65 }}>{workStatus || "Working…"}</span>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} style={plainButton}>Cancel</button>
          {hasMesh && (
            <button type="button" disabled={step === 1} onClick={() => setStep((current) => (current === 3 ? 2 : 1))} style={plainButton}>
              Back
            </button>
          )}
          {hasMesh && (
            <button type="button" disabled={step === 3} onClick={() => setStep((current) => (current === 1 ? 2 : 3))} style={plainButton}>
              Next
            </button>
          )}
          <button type="button" disabled={!hasMesh || isWorking || committing} onClick={() => void commitProduct()} style={{ ...prominentButton, opacity: !hasMesh || isWorking || committing ? 0.45 : 1 }}>
            {saveProgress ?? (editingDraft ? "Save Product" : "Create Product")}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProductImportModal3D;

// Moved to smaller modules; re-exported so existing importers keep working.
export { partIconCameraFromJson, partIconCameraToJson } from "./productImport/importTypes";
export type { ImportedProductCatalogDraft, StudioPartRole, ImportedStudioPart, InscriptionStudioConfig, CreatedCatalogProductPayload, ProductImportModal3DProps } from "./productImport/importTypes";
export { analyzeClientMeshHealth } from "./productImport/meshHealth";
export { parseSliceInfoConfig } from "../meshParsers";
export type { SlicedPlateInfo } from "../meshParsers";
