import React, { useState } from "react";
import { appsFolderHint } from "../../platform";
import { invoke } from "../../tauriInvoke";
import { BedSizeFields } from "../BedSizeFields";
import { confirmRemovePrinter, notifyError } from "../../uiFeedback";
import { ShopSettings, ShopSnapshot } from "../../types";
import { Check, ColorInput, PathRow, Section, type Setter, caption, choosePath, inputStyle } from "./settingsUi";

// --- Printers -------------------------------------------------------------------

const MAX_FILAMENT_SLOTS = 4;

export const PrintersTab: React.FC<{
  settings: ShopSettings;
  patch: Setter;
  snapshot?: ShopSnapshot;
  onSnapshotUpdated?: (s: ShopSnapshot) => void;
}> = ({ settings, patch, snapshot, onSnapshotUpdated }) => {
  const printers = snapshot?.printers ?? [];
  const filaments = snapshot?.filaments ?? [];
  const [names, setNames] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const run = async (cmd: string, args: Record<string, unknown>) => {
    try {
      const snap = await invoke<ShopSnapshot>(cmd, args);
      if (snap?.printers) onSnapshotUpdated?.(snap);
    } catch (e) {
      notifyError("Printer change not saved", e);
    }
  };
  const commitName = (id: string, current: string) => {
    const n = (names[id] ?? current).trim();
    if (n && n !== current) run("rename_printer", { printer_id: id, name: n });
  };
  const setSlots = (id: string, ids: string[]) =>
    run("set_printer_filament_slots", { printer_id: id, filament_ids: ids });

  return (
    <>
      <Section
        title={`Fleet (${printers.length})`}
        footer="Changes on this tab apply immediately (no Save needed). These machines appear as columns on the Printers board. Print! on Parts to Print asks which printer (or Unassigned) gets the job."
      >
        {printers.length === 0 && <div style={caption}>No printers yet. Add your first printer to start queueing parts.</div>}
        {printers.map((p) => {
          const slotIds = (p.loaded_slots ?? []).map((s) => s.filament_id);
          return (
            <div
              key={p.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: 8,
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <ColorInput
                  title="Accent"
                  value={settings.printer_accents[p.id] || ""}
                  onChange={(hex) => patch({ printer_accents: { ...settings.printer_accents, [p.id]: hex } })}
                />
                <input
                  type="text"
                  value={names[p.id] ?? p.name}
                  onChange={(e) => setNames({ ...names, [p.id]: e.target.value })}
                  onBlur={() => commitName(p.id, p.name)}
                  onKeyDown={(e) => e.key === "Enter" && commitName(p.id, p.name)}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <span style={caption}>{p.model}</span>
                <button
                  type="button"
                  className="fp-btn fp-btn-sm"
                  onClick={async () => {
                    if (snapshot && (await confirmRemovePrinter(snapshot, p))) void run("delete_printer", { printer_id: p.id });
                  }}
                >
                  Remove
                </button>
              </div>
              <BedSizeFields
                bedX={p.bed_x_mm}
                bedY={p.bed_y_mm}
                inputStyle={inputStyle}
                onCommit={(size) => void run("set_printer_bed_size", { printer_id: p.id, ...size })}
              />
              <div style={{ fontSize: 12 }}>Filament slots (max {MAX_FILAMENT_SLOTS})</div>
              {slotIds.length === 0 && <div style={caption}>No filament loaded yet. Pick the colors on this printer so FarmPrint can match parts to it.</div>}
              {slotIds.map((fid, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ ...caption, width: 18 }}>{i + 1}</span>
                  <select
                    value={fid}
                    onChange={(e) => setSlots(p.id, slotIds.map((x, k) => (k === i ? e.target.value : x)))}
                    style={{ ...inputStyle, flex: 1 }}
                  >
                    {filaments.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.brand} {f.material} — {f.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="fp-btn fp-btn-sm"
                    onClick={() => setSlots(p.id, slotIds.filter((_, k) => k !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {slotIds.length < MAX_FILAMENT_SLOTS && filaments.length > 0 && (
                <div>
                  <button
                    type="button"
                    className="fp-btn fp-btn-sm"
                    onClick={() => setSlots(p.id, [...slotIds, filaments[0].id])}
                  >
                    Add slot
                  </button>
                </div>
              )}
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            value={newName}
            placeholder="New printer name"
            onChange={(e) => setNewName(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            type="button"
            className="fp-btn fp-btn-sm"
            disabled={!newName.trim()}
            onClick={() => {
              run("add_printer", { name: newName.trim(), model: "", nozzle_mm: 0 });
              setNewName("");
            }}
          >
            Add printer
          </button>
        </div>
      </Section>
    </>
  );
};

// --- Print library ----------------------------------------------------------------

export const PrintLibraryTab: React.FC<{ settings: ShopSettings; patch: Setter }> = ({ settings, patch }) => (
  <>
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
      <PathRow
        label="Slicer"
        path={settings.slicer_app_path}
        empty="Not chosen"
        onChoose={async () => {
          const p = await choosePath(true, `Choose your slicer app (e.g. in ${appsFolderHint()})`);
          if (p) patch({ slicer_app_path: p, slicer_app_name: p.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.(app|exe|AppImage)$/i, "") || "" });
        }}
        onClear={() => patch({ slicer_app_path: "", slicer_app_name: "" })}
      />
      <Check
        label="Open staged kits in this slicer"
        checked={settings.open_staged_in_slicer}
        onChange={(v) => patch({ open_staged_in_slicer: v })}
      />
    </Section>
  </>
);
