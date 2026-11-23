import React, { useMemo, useState } from "react";
import { invoke } from "../tauriInvoke";
import { joinHexAlpha, splitHexAlpha, swatchBackground } from "../platform";
import { FilamentSwatch, ShopSnapshot } from "../types";
import { confirmDeleteFilament, notifyError } from "../uiFeedback";
import { X } from "lucide-react";
import { Icon } from "../icons";
import { displayBrand, displayVendor, suggestionValues } from "../filamentLabels";

function vendorKey(vendor?: string | null): string {
  return (vendor || "").trim();
}

function brandKey(brand?: string | null): string {
  return (brand || "").trim();
}

function sortKeys(a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b);
}

export const FilamentLibrarySheet: React.FC<{
  snapshot: ShopSnapshot;
  onSnapshot: (s: ShopSnapshot) => void;
  onClose: () => void;
}> = ({ snapshot, onSnapshot, onClose }) => {
  const [selectedVendor, setSelectedVendor] = useState<string>("All");
  const [selectedBrand, setSelectedBrand] = useState<string>("All");
  const [selectedMaterial, setSelectedMaterial] = useState<string>("All");
  const [newName, setNewName] = useState("");
  const [newBrand, setNewBrand] = useState("");
  const [newVendor, setNewVendor] = useState("");
  const [newMaterial, setNewMaterial] = useState("");
  const [newHex, setNewHex] = useState("#FF8D28");
  const [newCost, setNewCost] = useState("22.99");
  const [newGrams, setNewGrams] = useState("1000");

  const normalizedFilaments = useMemo(
    () =>
      snapshot.filaments.map((f) => ({
        ...f,
        brand: brandKey(f.brand),
        vendor: vendorKey(f.vendor),
        material: (f.material || "").trim(),
      })),
    [snapshot.filaments]
  );

  const brandSuggestions = useMemo(
    () => suggestionValues(snapshot.filaments.map((f) => f.brand)).sort((a, b) => a.localeCompare(b)),
    [snapshot.filaments]
  );
  const vendorSuggestions = useMemo(
    () => suggestionValues(snapshot.filaments.map((f) => f.vendor)).sort((a, b) => a.localeCompare(b)),
    [snapshot.filaments]
  );

  const vendors = useMemo(() => {
    const set = new Set<string>();
    for (const f of normalizedFilaments) set.add(f.vendor);
    return Array.from(set).sort(sortKeys);
  }, [normalizedFilaments]);

  const vendorFiltered = useMemo(
    () =>
      normalizedFilaments.filter(
        (f) => selectedVendor === "All" || f.vendor === selectedVendor
      ),
    [normalizedFilaments, selectedVendor]
  );

  const brands = useMemo(
    () => Array.from(new Set(vendorFiltered.map((f) => f.brand))).sort(sortKeys),
    [vendorFiltered]
  );

  const brandFiltered = useMemo(
    () =>
      vendorFiltered.filter(
        (f) => selectedBrand === "All" || f.brand === selectedBrand
      ),
    [vendorFiltered, selectedBrand]
  );

  const materials = useMemo(
    () => Array.from(new Set(brandFiltered.map((f) => f.material))),
    [brandFiltered]
  );

  const visibleFilaments = useMemo(
    () =>
      brandFiltered.filter(
        (f) => selectedMaterial === "All" || f.material === selectedMaterial
      ),
    [brandFiltered, selectedMaterial]
  );

  const handleAddSwatch = async () => {
    if (!newName.trim()) return;
    try {
      const next = await invoke<ShopSnapshot>("add_filament_swatch", {
        name: newName.trim(),
        brand: newBrand,
        vendor: newVendor,
        material: newMaterial.trim(),
        hex: newHex.trim() || "#FF8D28",
        cost_per_kg: parseFloat(newCost) || 22.99,
        grams_remaining: parseFloat(newGrams) || 1000,
      });
      onSnapshot(next);
      setNewName("");
    } catch (e) {
      notifyError(`${newName.trim()} was not added`, e);
    }
  };

  const handleDeleteSwatch = async (id: string) => {
    const fil = snapshot.filaments.find((f) => f.id === id);
    if (!fil || !(await confirmDeleteFilament(snapshot, fil))) return;
    try {
      const next = await invoke<ShopSnapshot>("delete_filament_swatch", {
        filamentId: id,
      });
      onSnapshot(next);
    } catch (e) {
      notifyError(`${fil.name} was not deleted`, e);
    }
  };

  return (
    <div className="fp-modal-backdrop" onClick={onClose}>
      <div
        className="fp-modal-window"
        style={{
          width: "min(1080px, 95vw)",
          height: "min(680px, 88vh)",
          display: "flex",
          flexDirection: "column",
          padding: 18,
          gap: 14,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>
              Filament Library ({normalizedFilaments.length} Spools)
            </div>
            <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>
              Vendors › Brands › Materials › Material &amp; Colors
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="fp-btn" onClick={onClose}>
              Done
            </button>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "165px 175px 175px 1fr",
            gap: 10,
          }}
        >
          {/* 1. Vendors Column */}
          <div
            style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 10,
              padding: 10,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(235,235,245,0.5)", marginBottom: 4 }}>
              VENDORS
            </div>
            <button
              type="button"
              className={`fp-btn ${selectedVendor === "All" ? "fp-btn-primary" : ""}`}
              style={{ justifyContent: "space-between" }}
              onClick={() => {
                setSelectedVendor("All");
                setSelectedBrand("All");
                setSelectedMaterial("All");
              }}
            >
              <span>All Vendors</span>
              <span>{normalizedFilaments.length}</span>
            </button>
            {vendors.map((v) => {
              const count = normalizedFilaments.filter((f) => f.vendor === v).length;
              return (
                <button
                  key={v}
                  type="button"
                  className={`fp-btn ${selectedVendor === v ? "fp-btn-primary" : ""}`}
                  style={{ justifyContent: "space-between" }}
                  onClick={() => {
                    setSelectedVendor(v);
                    setSelectedBrand("All");
                    setSelectedMaterial("All");
                  }}
                >
                  <span>{displayVendor(v)}</span>
                  <span>{count}</span>
                </button>
              );
            })}
          </div>

          {/* 2. Brands Column */}
          <div
            style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 10,
              padding: 10,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(235,235,245,0.5)", marginBottom: 4 }}>
              BRANDS
            </div>
            <button
              type="button"
              className={`fp-btn ${selectedBrand === "All" ? "fp-btn-primary" : ""}`}
              style={{ justifyContent: "space-between" }}
              onClick={() => {
                setSelectedBrand("All");
                setSelectedMaterial("All");
              }}
            >
              <span>All Brands</span>
              <span>{vendorFiltered.length}</span>
            </button>
            {brands.map((b) => (
              <button
                key={b}
                type="button"
                className={`fp-btn ${selectedBrand === b ? "fp-btn-primary" : ""}`}
                style={{ justifyContent: "space-between" }}
                onClick={() => {
                  setSelectedBrand(b);
                  setSelectedMaterial("All");
                }}
              >
                <span>{displayBrand(b)}</span>
                <span>{vendorFiltered.filter((f) => f.brand === b).length}</span>
              </button>
            ))}
          </div>

          {/* 3. Materials Column */}
          <div
            style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 10,
              padding: 10,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(235,235,245,0.5)", marginBottom: 4 }}>
              MATERIALS
            </div>
            <button
              type="button"
              className={`fp-btn ${selectedMaterial === "All" ? "fp-btn-primary" : ""}`}
              style={{ justifyContent: "space-between" }}
              onClick={() => setSelectedMaterial("All")}
            >
              <span>All Materials</span>
              <span>{brandFiltered.length}</span>
            </button>
            {materials.map((m) => (
              <button
                key={m}
                type="button"
                className={`fp-btn ${selectedMaterial === m ? "fp-btn-primary" : ""}`}
                style={{ justifyContent: "space-between" }}
                onClick={() => setSelectedMaterial(m)}
              >
                <span>{m || "No material"}</span>
                <span>{brandFiltered.filter((f) => f.material === m).length}</span>
              </button>
            ))}
          </div>

          {/* 4. Material & Colors (Swatches) Column */}
          <div
            style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 10,
              padding: 12,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(235,235,245,0.5)" }}>
              MATERIAL &amp; COLORS ({visibleFilaments.length})
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
                gap: 8,
              }}
            >
              {visibleFilaments.map((sw: FilamentSwatch) => (
                <div
                  key={sw.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 10px",
                    borderRadius: 8,
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        background: swatchBackground(sw.hex),
                        border: "1.5px solid rgba(255,255,255,0.8)",
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#f8fafc" }}>
                        {sw.name}
                      </div>
                      <div style={{ fontSize: 10.5, color: "rgba(235,235,245,0.55)" }}>
                        {displayBrand(sw.brand)}
                        {sw.material ? ` • ${sw.material}` : ""}
                        {` • ${Math.round(sw.grams_remaining)}g`}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="fp-btn fp-btn-sm"
                    onClick={() => handleDeleteSwatch(sw.id)}
                    title="Delete spool"
                  >
                    <Icon icon={X} size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Add Filament Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            paddingTop: 8,
            borderTop: "1px solid rgba(255,255,255,0.08)",
            flexWrap: "wrap",
          }}
        >
          <input
            type="color"
            value={splitHexAlpha(newHex).rgb}
            onChange={(e) => setNewHex(joinHexAlpha(e.target.value, splitHexAlpha(newHex).alpha))}
            style={{ width: 34, height: 32, border: "none", background: "transparent" }}
          />
          <label title="Opacity, for translucent or clear filament" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "rgba(235,235,245,0.7)" }}>
            <span style={{ width: 16, height: 16, borderRadius: "50%", background: swatchBackground(newHex), border: "1px solid rgba(255,255,255,0.6)" }} />
            <input
              type="range"
              min={5}
              max={100}
              value={Math.round(splitHexAlpha(newHex).alpha * 100)}
              onChange={(e) => setNewHex(joinHexAlpha(newHex, Number(e.target.value) / 100))}
              style={{ width: 70 }}
            />
            {Math.round(splitHexAlpha(newHex).alpha * 100)}%
          </label>
          <input
            type="text"
            placeholder="Color name (e.g. Cobalt Blue)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 8, width: 170 }}
          />
          <input
            type="text"
            list="fp-filament-brand-choices"
            placeholder="Brand"
            value={newBrand}
            onChange={(e) => setNewBrand(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 8, width: 130 }}
          />
          <datalist id="fp-filament-brand-choices">
            {brandSuggestions.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
          <input
            type="text"
            list="fp-filament-vendor-choices"
            placeholder="Vendor"
            value={newVendor}
            onChange={(e) => setNewVendor(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 8, width: 130 }}
          />
          <datalist id="fp-filament-vendor-choices">
            {vendorSuggestions.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <input
            type="text"
            placeholder="Material"
            value={newMaterial}
            onChange={(e) => setNewMaterial(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 8, width: 130 }}
          />
          <input
            type="number"
            placeholder="$/kg"
            value={newCost}
            onChange={(e) => setNewCost(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 8, width: 80 }}
          />
          <input
            type="number"
            placeholder="Grams"
            value={newGrams}
            onChange={(e) => setNewGrams(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 8, width: 90 }}
          />
          <button type="button" className="fp-btn fp-btn-primary" onClick={handleAddSwatch}>
            + Add Filament
          </button>
        </div>
      </div>
    </div>
  );
};
