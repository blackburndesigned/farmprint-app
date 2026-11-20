import React, { useEffect, useState } from "react";
import { applyTheme, getShopSettings, normalizeSettings, setShopSettings } from "../../settingsStore";
import { invoke } from "../../tauriInvoke";
import { DockTab } from "../DockAndHeader";
import { askConfirm } from "../../uiFeedback";
import { EMPTY_APPEARANCE_STUDIO, EMPTY_SHOP_SETTINGS, ShopSettings, ShopSnapshot } from "../../types";
import { type Setter } from "./settingsUi";
import { GeneralTab } from "./GeneralTab";
import { ProcessTab } from "./ProcessTab";
import { AppearanceTab } from "./AppearanceTab";
import { PrintLibraryTab, PrintersTab } from "./PrintersTab";
import { StoreTab } from "./StoreTab";

// ---------------------------------------------------------------------------
// Settings — ported from FarmPrint/Features/Settings/SettingsRootView.swift.
// Tabs match Swift: General, Process, Appearance, Printers, Print library, Store.
// Every field lives in fp-core `ShopSettings` (get/save_shop_settings).
// ---------------------------------------------------------------------------

type SettingsTab = "general" | "process" | "appearance" | "printers" | "library" | "store";

const SETTINGS_TABS: Array<[SettingsTab, string]> = [
  ["general", "General"],
  ["process", "Process"],
  ["appearance", "Appearance"],
  ["printers", "Printers"],
  ["library", "Print library"],
  ["store", "Store"],
];

export const SettingsModal: React.FC<{
  open: boolean;
  onClose: () => void;
  snapshot?: ShopSnapshot;
  onSnapshotUpdated?: (s: ShopSnapshot) => void;
  onNavigateTab?: (tab: DockTab) => void;
  onFlashBanner?: (msg: string) => void;
  onRunSetup?: () => void;
}> = ({ open, onClose, snapshot, onSnapshotUpdated, onNavigateTab, onFlashBanner, onRunSetup }) => {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [settings, setSettings] = useState<ShopSettings>(EMPTY_SHOP_SETTINGS);
  // Save stays off until the real settings loaded, so blank defaults never overwrite them.
  const [loadState, setLoadState] = useState<"loading" | "ok" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [loadedJson, setLoadedJson] = useState("");

  useEffect(() => {
    if (!open) return;
    setLoadState("loading");
    invoke<Partial<ShopSettings>>("get_shop_settings")
      .then((s) => {
        if (!s) throw new Error("FarmPrint returned no settings");
        const next = {
          ...EMPTY_SHOP_SETTINGS,
          ...s,
          appearance_studio: { ...EMPTY_APPEARANCE_STUDIO, ...(s.appearance_studio || {}) },
        };
        setSettings(next);
        setLoadedJson(JSON.stringify(next));
        setLoadState("ok");
      })
      .catch((e) => {
        setLoadError(e instanceof Error ? e.message : String(e));
        setLoadState("error");
      });
  }, [open]);

  // Light / Dark previews while Settings is open; closing without saving puts the saved mode back.
  const previewMode = settings.appearance_mode;
  useEffect(() => {
    applyTheme(open && loadState === "ok" ? { appearance_mode: previewMode } : getShopSettings());
  }, [open, loadState, previewMode]);

  if (!open) return null;

  const patch: Setter = (p) => setSettings((prev) => ({ ...prev, ...p }));

  // Saves what's on screen without closing (Store tab saves before Sign in / Preview / Publish,
  // which read the saved settings in Rust).
  const persist = async () => {
    // Never save before the real settings loaded, so blank defaults can't overwrite them.
    if (loadState !== "ok") throw new Error("Settings haven't loaded yet");
    const saved = await invoke<ShopSettings>("save_shop_settings", { settings });
    const next = normalizeSettings(saved);
    setSettings(next);
    setLoadedJson(JSON.stringify(next)); // saved now, so a click outside doesn't ask to discard
    setShopSettings(next); // apply live across the app
  };

  const handleSave = async () => {
    try {
      await persist();
      onFlashBanner?.("Settings saved");
      onClose();
    } catch (e) {
      onFlashBanner?.(`Settings not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div
      className="fp-modal-backdrop"
      onClick={() => {
        // A click outside never throws away unsaved changes.
        if (loadState !== "ok" || JSON.stringify(settings) === loadedJson) {
          onClose();
          return;
        }
        void askConfirm({
          title: "Discard unsaved settings?",
          message: "Your changes in Settings have not been saved.",
          confirmLabel: "Discard",
          cancelLabel: "Keep editing",
          danger: true,
        }).then((discard) => {
          if (discard) onClose();
        });
      }}
    >
      <div
        className="fp-modal-window"
        style={{
          width: "min(860px, 94vw)",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          padding: 18,
          gap: 14,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>FarmPrint Settings</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="fp-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="fp-btn fp-btn-primary"
              onClick={handleSave}
              disabled={loadState !== "ok"}
              title={loadState === "ok" ? undefined : "Settings haven't loaded yet"}
            >
              Save Settings
            </button>
          </div>
        </div>
        {loadState === "error" && (
          <div role="alert" style={{ fontSize: 12.5, color: "#fca5a5" }}>
            Settings could not be loaded, so saving is turned off to protect your current settings: {loadError}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, borderBottom: "1px solid rgba(255,255,255,0.1)", paddingBottom: 10 }}>
          {SETTINGS_TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`fp-btn ${tab === id ? "fp-btn-primary" : ""}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, paddingRight: 4 }}>
          {tab === "general" && <GeneralTab open={open} settings={settings} patch={patch} snapshot={snapshot} onSnapshotUpdated={onSnapshotUpdated} onRunSetup={onRunSetup ? () => { onClose(); onRunSetup(); } : undefined} />}
          {tab === "process" && <ProcessTab settings={settings} patch={patch} />}
          {tab === "appearance" && <AppearanceTab settings={settings} patch={patch} />}
          {tab === "printers" && (
            <PrintersTab
              settings={settings}
              patch={patch}
              snapshot={snapshot}
              onSnapshotUpdated={onSnapshotUpdated}
            />
          )}
          {tab === "library" && <PrintLibraryTab settings={settings} patch={patch} />}
          {tab === "store" && (
            <StoreTab
              settings={settings}
              patch={patch}
              persist={persist}
              snapshot={snapshot}
              onManageCatalog={() => {
                onNavigateTab?.("products");
                onClose();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};
