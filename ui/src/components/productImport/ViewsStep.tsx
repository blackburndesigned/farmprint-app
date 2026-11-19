import { FEATURES } from "../../features";
import React from "react";
import { ThumbnailViewportHandle, ManipulateTarget } from "../StudioViewport3D";
import { CameraState, FramingPreset } from "../../viewportCamera";
import { type InscriptionStudioConfig } from "./importTypes";
import { Field, FormSection, chipButton, fieldStyle, plainButton } from "./importFormUi";

/** Step 3 (Views): saved camera views, inscription placement and studio lights. */
export const ViewsStep: React.FC<{
  frameTo: (preset: FramingPreset, resetView: boolean) => void;
  selectedViewId: string;
  extraViews: { id: string; name: string; inscription: boolean; camera: CameraState; }[];
  setSelectedViewId: React.Dispatch<React.SetStateAction<string>>;
  setActivePreset: React.Dispatch<React.SetStateAction<FramingPreset | null>>;
  viewportRef: React.MutableRefObject<ThumbnailViewportHandle | null>;
  setExtraViews: React.Dispatch<React.SetStateAction<{ id: string; name: string; inscription: boolean; camera: CameraState; }[]>>;
  setInscription: React.Dispatch<React.SetStateAction<InscriptionStudioConfig>>;
  newViewName: string;
  setNewViewName: React.Dispatch<React.SetStateAction<string>>;
  saveCurrentView: (asNew: boolean) => void;
  inscription: InscriptionStudioConfig;
  keyIntensity: number;
  setKeyIntensity: React.Dispatch<React.SetStateAction<number>>;
  fillIntensity: number;
  setFillIntensity: React.Dispatch<React.SetStateAction<number>>;
  ambientIntensity: number;
  setAmbientIntensity: React.Dispatch<React.SetStateAction<number>>;
  manipulate: ManipulateTarget;
}> = ({ frameTo, selectedViewId, extraViews, setSelectedViewId, setActivePreset, viewportRef, setExtraViews, setInscription, newViewName, setNewViewName, saveCurrentView, inscription, keyIntensity, setKeyIntensity, fillIntensity, setFillIntensity, ambientIntensity, setAmbientIntensity, manipulate }) => (
  <div style={{ padding: "8px 12px 16px" }}>
    <FormSection
      title="Camera views"
      footer={`Front is the catalog hero (¾ camera on Create Product). Save extra cameras (back, side, a tight nameplate crop) as new views; select one to reframe and update it. ${FEATURES.inscription3d ? "Mark one view Inscription to set up the name. " : ""}Create Product saves everything.`}
    >
      <button type="button" onClick={() => frameTo("threeQuarter", true)} style={chipButton(selectedViewId === "")}>
        Front (hero)
      </button>
      {extraViews.map((view) => (
        <div key={view.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            onClick={() => {
              setSelectedViewId(view.id);
              setActivePreset(null);
              viewportRef.current?.setCamera(view.camera);
            }}
            style={chipButton(selectedViewId === view.id)}
          >
            {view.name}
          </button>
          {FEATURES.inscription3d && (
          <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={view.inscription}
              onChange={(event) => {
                const on = event.target.checked;
                setExtraViews((prev) => prev.map((item) => ({
                  ...item,
                  inscription: item.id === view.id ? on : on ? false : item.inscription,
                })));
                setInscription((prev) => ({ ...prev, enabled: on }));
              }}
            />
            Inscription
          </label>
          )}
          <button
            type="button"
            onClick={() => {
              setExtraViews((prev) => prev.filter((item) => item.id !== view.id));
              if (selectedViewId === view.id) setSelectedViewId("");
            }}
            style={plainButton}
          >
            🗑
          </button>
        </div>
      ))}
      <input value={newViewName} placeholder="Back, Side, Nameplate…" onChange={(event) => setNewViewName(event.target.value)} style={fieldStyle} />
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" disabled={!newViewName.trim()} onClick={() => saveCurrentView(true)} style={plainButton}>Save as new view</button>
        <button type="button" disabled={!selectedViewId} onClick={() => saveCurrentView(false)} style={plainButton}>Update selected view</button>
      </div>
    </FormSection>
    {!FEATURES.inscription3d && (
      <FormSection title="Inscription">
        <div style={{ fontSize: 12, opacity: 0.6 }}>
          Coming soon. Inscription setup isn't available in this build yet; any existing inscription settings on this product are kept as they are.
        </div>
      </FormSection>
    )}
    {FEATURES.inscription3d && extraViews.some((view) => view.inscription) && (
      <FormSection title="Inscription">
        <Field label="Sample">
          <input value={inscription.sampleText} onChange={(event) => setInscription((prev) => ({ ...prev, sampleText: event.target.value }))} style={fieldStyle} />
        </Field>
        <Field label="Width mm">
          <input type="number" value={inscription.areaWidthMm} onChange={(event) => setInscription((prev) => ({ ...prev, areaWidthMm: parseFloat(event.target.value) || 0 }))} style={fieldStyle} />
        </Field>
        <Field label="Height mm">
          <input type="number" value={inscription.areaHeightMm} onChange={(event) => setInscription((prev) => ({ ...prev, areaHeightMm: parseFloat(event.target.value) || 0 }))} style={fieldStyle} />
        </Field>
        <Field label="Thickness mm">
          <input type="number" step="0.1" value={inscription.depthMm} onChange={(event) => setInscription((prev) => ({ ...prev, depthMm: parseFloat(event.target.value) || 0 }))} style={fieldStyle} />
        </Field>
        <Field label="Rotation">
          <input type="number" value={inscription.rotationDeg} onChange={(event) => setInscription((prev) => ({ ...prev, rotationDeg: parseFloat(event.target.value) || 0 }))} style={fieldStyle} />
        </Field>
        <label style={{ fontSize: 13, display: "flex", gap: 8 }}>
          <input type="checkbox" checked={inscription.mirrorX} onChange={(event) => setInscription((prev) => ({ ...prev, mirrorX: event.target.checked }))} />
          Flip horizontal
        </label>
        <label style={{ fontSize: 13, display: "flex", gap: 8 }}>
          <input type="checkbox" checked={inscription.upsideDown} onChange={(event) => setInscription((prev) => ({ ...prev, upsideDown: event.target.checked }))} />
          Flip vertical
        </label>
      </FormSection>
    )}
    <FormSection title="Lighting">
      <Field label="Key">
        <input type="range" min={200} max={2000} value={keyIntensity} onChange={(event) => setKeyIntensity(parseFloat(event.target.value))} />
      </Field>
      <Field label="Fill">
        <input type="range" min={0} max={1200} value={fillIntensity} onChange={(event) => setFillIntensity(parseFloat(event.target.value))} />
      </Field>
      <Field label="Ambient">
        <input type="range" min={0} max={800} value={ambientIntensity} onChange={(event) => setAmbientIntensity(parseFloat(event.target.value))} />
      </Field>
      <div style={{ fontSize: 11, opacity: 0.55 }}>
        {manipulate === "light" ? "Light mode: drag to aim · pinch spot↔flood" : "Drag with Light mode to aim key"}
      </div>
    </FormSection>
  </div>
);
