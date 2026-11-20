import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./printersTab.css";
import { appsFolderHint } from "../../platform";
import { invoke } from "../../tauriInvoke";
import { getShopSettings, saveShopSettingsPatch } from "../../settingsStore";
import { BedSizeFields } from "../BedSizeFields";
import { confirmRemovePrinter, notifyError } from "../../uiFeedback";
import { FilamentSwatch, Printer, PrinterSlot, ShopSettings, ShopSnapshot } from "../../types";
import { Check, ColorInput, PathRow, Row, Section, type Setter, caption, choosePath, inputStyle } from "./settingsUi";
import { SLICERS, type SlicerKey, chooseSlicerAppPatch, pickSlicerPatch, savedSlicer } from "../../slicerChoice";

// --- Printers -------------------------------------------------------------------

const MAX_FILAMENT_SLOTS = 4;
const DEFAULT_ACCENT = "#8e8e93";

const STATUS_CHIP: Record<string, { label: string; bg: string; fg: string }> = {
  Printing: { label: "Printing", bg: "rgba(37, 99, 235, 0.18)", fg: "#4c8dff" },
  Staged: { label: "Staged", bg: "rgba(217, 119, 6, 0.18)", fg: "#e8930c" },
  Idle: { label: "Idle", bg: "rgba(142, 142, 147, 0.18)", fg: "#8e8e93" },
};

const Swatch: React.FC<{ slot: PrinterSlot; size?: number }> = ({ slot, size = 18 }) => (
  <span
    title={`${slot.filament_name}${slot.material ? ` · ${slot.material}` : ""}`}
    style={{
      width: size,
      height: size,
      borderRadius: 999,
      background: slot.filament_hex || DEFAULT_ACCENT,
      boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.25), 0 0 0 1.5px rgba(127,127,127,0.35)",
      flexShrink: 0,
      display: "inline-block",
    }}
  />
);

/** macOS-style field inside the edit sheet. */
const sheetInput: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 7,
  border: "1px solid var(--border-strong)",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  fontSize: 12.5,
  outline: "none",
};

const bedLabel = (p: Printer) =>
  p.bed_x_mm && p.bed_y_mm ? `${p.bed_x_mm} × ${p.bed_y_mm} mm` : "Bed size not set";

const PrinterCard: React.FC<{ printer: Printer; accent: string; onOpen: () => void }> = ({ printer: p, accent, onOpen }) => {
  const chip = STATUS_CHIP[p.status] || STATUS_CHIP.Idle;
  const slots = p.loaded_slots ?? [];
  const jobs = p.active_units.length + p.staged_units.length;
  return (
    <button type="button" className="fp-printer-tile" onClick={onOpen} aria-label={`Edit ${p.name}`}>
      <div className="fp-printer-tile-art" style={{ background: `linear-gradient(160deg, ${accent}2e, ${accent}0a)` }}>
        <span className="fp-printer-tile-chip" style={{ background: chip.bg, color: chip.fg }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: chip.fg }} />
          {chip.label}
          {jobs > 0 ? ` · ${jobs}` : ""}
        </span>
      </div>
      <div className="fp-printer-tile-body">
        <div className="fp-printer-tile-name">{p.name}</div>
        <div className="fp-printer-tile-sub">{p.model || "No model"}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, minHeight: 18, marginTop: 4 }}>
          {slots.length === 0 ? (
            <span className="fp-printer-tile-sub">No filament loaded</span>
          ) : (
            slots.map((s) => <Swatch key={`${s.slot_index}-${s.filament_id}`} slot={s} />)
          )}
        </div>
        <div className="fp-printer-tile-sub" style={{ marginTop: 2 }}>▭ {bedLabel(p)}</div>
      </div>
    </button>
  );
};

const PrinterEditSheet: React.FC<{
  printer: Printer;
  filaments: FilamentSwatch[];
  accent: string;
  onAccent: (hex: string) => void;
  run: (cmd: string, args: Record<string, unknown>) => Promise<void>;
  onRemove: () => void;
  onClose: () => void;
}> = ({ printer: p, filaments, accent, onAccent, run, onRemove, onClose }) => {
  const [name, setName] = useState(p.name);
  useEffect(() => setName(p.name), [p.name]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const slotIds = (p.loaded_slots ?? []).map((s) => s.filament_id);
  const filamentById = new Map(filaments.map((f) => [f.id, f]));
  const setSlots = (ids: string[]) => void run("set_printer_filament_slots", { printer_id: p.id, filament_ids: ids });
  const commitName = () => {
    const n = name.trim();
    if (n && n !== p.name) void run("rename_printer", { printer_id: p.id, name: n });
    else setName(p.name);
  };
  const chip = STATUS_CHIP[p.status] || STATUS_CHIP.Idle;

  return createPortal(
    <div className="fp-modal-backdrop" style={{ zIndex: 260 }} onClick={onClose}>
      <div
        className="fp-modal-window fp-printer-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${p.name}`}
        style={{ width: "min(520px, 94vw)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fp-printer-sheet-head" style={{ background: `linear-gradient(160deg, ${accent}33, ${accent}08)` }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
            <div className="fp-printer-tile-sub">{[p.model || "No model", p.nozzle_mm ? `${p.nozzle_mm} mm nozzle` : ""].filter(Boolean).join(" · ")}</div>
            <span className="fp-printer-tile-chip" style={{ position: "static", marginTop: 6, background: chip.bg, color: chip.fg }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: chip.fg }} />
              {chip.label}
            </span>
          </div>
          <button type="button" className="fp-btn fp-btn-sm fp-btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
        <div className="fp-modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="fp-form-group">
            <label className="fp-form-row">
              <span>Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
                style={{ ...sheetInput, flex: 1, maxWidth: 280 }}
              />
            </label>
            <div className="fp-form-row">
              <span>Accent</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <ColorInput title="Accent" value={accent === DEFAULT_ACCENT ? "" : accent} onChange={onAccent} />
              </div>
            </div>
            <div className="fp-form-row" style={{ justifyContent: "flex-start" }}>
              <BedSizeFields
                bedX={p.bed_x_mm}
                bedY={p.bed_y_mm}
                inputStyle={{ ...sheetInput, width: 72 }}
                onCommit={(size) => void run("set_printer_bed_size", { printer_id: p.id, ...size })}
              />
            </div>
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700 }}>Loaded filament</div>
              <span style={caption}>
                {slotIds.length} of {MAX_FILAMENT_SLOTS} slots
              </span>
            </div>
            <div className="fp-form-group">
              {slotIds.length === 0 && (
                <div style={{ ...caption, padding: "8px 10px" }}>No filament loaded yet. Pick the colors on this printer so FarmPrint can match parts to it.</div>
              )}
              {slotIds.map((fid, i) => {
                const f = filamentById.get(fid);
                return (
                  <div key={i} className="fp-form-row">
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Swatch
                        slot={{ slot_index: i, filament_id: fid, filament_name: f?.name || fid, filament_hex: f?.hex || "", material: f?.material || "" }}
                        size={20}
                      />
                      Slot {i + 1}
                    </span>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flex: 1, justifyContent: "flex-end" }}>
                      <select
                        aria-label={`Slot ${i + 1} filament`}
                        value={fid}
                        onChange={(e) => setSlots(slotIds.map((x, k) => (k === i ? e.target.value : x)))}
                        style={{ ...sheetInput, flex: 1, maxWidth: 280 }}
                      >
                        {filaments.map((fl) => (
                          <option key={fl.id} value={fl.id}>
                            {fl.brand} {fl.material} — {fl.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="fp-btn fp-btn-sm fp-btn-ghost"
                        aria-label={`Unload slot ${i + 1}`}
                        title="Unload"
                        onClick={() => setSlots(slotIds.filter((_, k) => k !== i))}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {slotIds.length < MAX_FILAMENT_SLOTS && filaments.length > 0 && (
              <button type="button" className="fp-btn fp-btn-sm" style={{ marginTop: 8 }} onClick={() => setSlots([...slotIds, filaments[0].id])}>
                + Add slot
              </button>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border-subtle)", paddingTop: 12 }}>
            <span style={caption}>Changes save as soon as you make them.</span>
            <button type="button" className="fp-btn fp-btn-sm fp-btn-danger" onClick={onRemove}>
              Remove printer…
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export const PrintersTab: React.FC<{
  settings: ShopSettings;
  patch: Setter;
  snapshot?: ShopSnapshot;
  onSnapshotUpdated?: (s: ShopSnapshot) => void;
  /** Settings saved right away outside Save Settings (printer accents): the window keeps them as saved. */
  onSavedNow?: (saved: Partial<ShopSettings>) => void;
}> = ({ settings, patch, snapshot, onSnapshotUpdated, onSavedNow }) => {
  const printers = snapshot?.printers ?? [];
  const filaments = snapshot?.filaments ?? [];
  // Accent picks show at once and save shortly after the color picker settles.
  const [accentDraft, setAccentDraft] = useState<Record<string, string>>({});
  const accentTimer = useRef<number | undefined>(undefined);
  const saveAccent = (id: string, hex: string) => {
    setAccentDraft((d) => ({ ...d, [id]: hex }));
    window.clearTimeout(accentTimer.current);
    accentTimer.current = window.setTimeout(async () => {
      try {
        const saved = await saveShopSettingsPatch({ printer_accents: { ...getShopSettings().printer_accents, [id]: hex } });
        onSavedNow?.({ printer_accents: saved.printer_accents });
      } catch (e) {
        notifyError("Accent color not saved", e);
      } finally {
        setAccentDraft((d) => {
          const { [id]: _done, ...rest } = d;
          return rest;
        });
      }
    }, 250);
  };
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const run = async (cmd: string, args: Record<string, unknown>) => {
    try {
      const snap = await invoke<ShopSnapshot>(cmd, args);
      if (snap?.printers) onSnapshotUpdated?.(snap);
    } catch (e) {
      notifyError("Printer change not saved", e);
    }
  };
  const accentOf = (id: string) => {
    const hex = accentDraft[id] ?? settings.printer_accents[id] ?? "";
    return /^#[0-9a-f]{6}$/i.test(hex) ? hex : DEFAULT_ACCENT;
  };
  const editing = printers.find((p) => p.id === editingId) || null;
  const addPrinter = () => {
    if (!newName.trim()) return;
    void run("add_printer", { name: newName.trim(), model: "", nozzle_mm: 0 });
    setNewName("");
    setAdding(false);
  };

  return (
    <>
      <Section
        title={`Fleet (${printers.length})`}
        footer="Click a printer to edit it. Changes apply immediately. These machines appear as columns on the Printers board."
      >
        {printers.length === 0 && <div style={caption}>No printers yet. Add your first printer to start queueing parts.</div>}
        <div className="fp-printer-grid">
          {printers.map((p) => (
            <PrinterCard key={p.id} printer={p} accent={accentOf(p.id)} onOpen={() => setEditingId(p.id)} />
          ))}
          {adding ? (
            <div className="fp-printer-tile fp-printer-tile-add" style={{ cursor: "default", padding: 14, gap: 8, justifyContent: "center" }}>
              <input
                type="text"
                autoFocus
                value={newName}
                placeholder="New printer name"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addPrinter();
                  if (e.key === "Escape") setAdding(false);
                }}
                style={{ ...inputStyle, width: "100%" }}
              />
              <div style={{ display: "flex", gap: 6, width: "100%" }}>
                <button type="button" className="fp-btn fp-btn-sm" style={{ flex: 1 }} onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button type="button" className="fp-btn fp-btn-sm fp-btn-primary" style={{ flex: 1 }} disabled={!newName.trim()} onClick={addPrinter}>
                  Add printer
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="fp-printer-tile fp-printer-tile-add" onClick={() => setAdding(true)}>
              <span style={{ fontSize: 28, lineHeight: 1, fontWeight: 300 }}>+</span>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>Add printer</span>
            </button>
          )}
        </div>
      </Section>
      <Section
        title="Printer suggestions"
        footer="Off (the default): Suggested Groups groups parts by color and you pick the printer each time. On: each group also shows a small grey hint naming a printer that already has that filament loaded, and the printer picker starts on it. Nothing is ever sent without you choosing. Click Save to apply."
      >
        <Check
          label="Suggest a printer"
          checked={!!settings.suggest_printer}
          onChange={(v) => patch({ suggest_printer: v })}
        />
      </Section>
      {editing && (
        <PrinterEditSheet
          printer={editing}
          filaments={filaments}
          accent={accentOf(editing.id)}
          onAccent={(hex) => saveAccent(editing.id, hex)}
          run={run}
          onRemove={async () => {
            if (snapshot && (await confirmRemovePrinter(snapshot, editing))) {
              setEditingId(null);
              void run("delete_printer", { printer_id: editing.id });
            }
          }}
          onClose={() => setEditingId(null)}
        />
      )}
    </>
  );
};

// --- Print library ----------------------------------------------------------------

/** Which slicer Print! opens plates in (see `slicerChoice.ts` and the app's `slicer.rs`). */
const SlicerSection: React.FC<{ settings: ShopSettings; patch: Setter }> = ({ settings, patch }) => {
  const slicer = savedSlicer(settings);
  return (
    <Section
      title="Slicer"
      footer="Print! builds the plate and opens it in this slicer. If it isn't installed, the plate opens in the app your computer uses for .3mf files. Set the app location only if the slicer is installed somewhere unusual."
    >
      <Row label="Open plates in">
        <select
          aria-label="Slicer for Print!"
          value={slicer}
          onChange={(e) => {
            const key = e.target.value;
            if (key !== "other") patch(pickSlicerPatch(key as SlicerKey, settings));
          }}
          style={{ ...inputStyle, maxWidth: 220 }}
        >
          {SLICERS.map((x) => (
            <option key={x.key} value={x.key}>
              {x.name}
            </option>
          ))}
          {slicer === "other" && <option value="other">{settings.slicer_app_name || "Other app"}</option>}
        </select>
      </Row>
      <PathRow
        label="App location"
        path={settings.slicer_app_path}
        empty="Found automatically"
        onChoose={async () => {
          const p = await choosePath(true, `Choose your slicer app (e.g. in ${appsFolderHint()})`);
          if (p) patch(chooseSlicerAppPatch(p));
        }}
        onClear={() =>
          patch(slicer === "other" ? { slicer_app_path: "", slicer_app_name: "", slicer_bundle_id: "" } : { slicer_app_path: "" })
        }
      />
    </Section>
  );
};

export const PrintLibraryTab: React.FC<{ settings: ShopSettings; patch: Setter }> = ({ settings, patch }) => (
  <>
    <SlicerSection settings={settings} patch={patch} />
    <Section
      title="Product library folder"
      footer="Drop .3mf / .stl files (or folders of meshes) here. FarmPrint shows a placeholder card on Products until you generate thumbnails and set a price."
    >
      <PathRow
        label="Folder"
        path={settings.product_library_path}
        empty="No Product Library folder selected."
        onChoose={async () => {
          const p = await choosePath(true, "Choose your Product Library folder");
          if (p) patch({ product_library_path: p });
        }}
        onClear={() => patch({ product_library_path: "" })}
      />
    </Section>
    <Section
      title="Print all destination"
      footer="Print all copies mesh files from the Print library folder above (not the original import file). Missing library files are skipped and listed in the status message."
    >
      <PathRow
        label="Folder"
        path={settings.print_queue_folder}
        empty="Not chosen"
        onChoose={async () => {
          const p = await choosePath(true, "Choose where Print all stages kits");
          if (p) patch({ print_queue_folder: p });
        }}
        onClear={() => patch({ print_queue_folder: "" })}
      />
      <Check
        label="Group each kit into one .3mf"
        checked={settings.group_print_queue_as_3mf}
        onChange={(v) => patch({ group_print_queue_as_3mf: v })}
      />
      <Check
        label="Open staged kits in the slicer above"
        checked={settings.open_staged_in_slicer}
        onChange={(v) => patch({ open_staged_in_slicer: v })}
      />
    </Section>
  </>
);
