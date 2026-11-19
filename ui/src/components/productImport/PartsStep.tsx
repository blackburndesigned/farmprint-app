import React from "react";
import { PartOrbitThumb } from "../StudioViewport3D";
import { type ImportedStudioPart, type StudioPartRole } from "./importTypes";
import { FormSection, fieldStyle, iconChip, menuItem, menuPop, plainButton } from "./importFormUi";

/** Step 2 (Parts): part list, roles, colors, groups and add-ons. */
export const PartsStep: React.FC<{
  selectedIds: string[];
  setPartGroups: React.Dispatch<React.SetStateAction<{ id: string; title: string; memberPartIds: string[]; }[]>>;
  parts: ImportedStudioPart[];
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
  setSetAllOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setAllOpen: boolean;
  setParts: React.Dispatch<React.SetStateAction<ImportedStudioPart[]>>;
  colorChoices: { id: string; name: string; hex: string; label: string; }[];
  togglePart: (id: string) => void;
  setRemovedPart: React.Dispatch<React.SetStateAction<ImportedStudioPart | null>>;
  removedPart: ImportedStudioPart | null;
  partGroups: { id: string; title: string; memberPartIds: string[]; }[];
  removedGroup: { group: { id: string; title: string; memberPartIds: string[]; }; index: number; } | null;
  setRemovedGroup: React.Dispatch<React.SetStateAction<{ group: { id: string; title: string; memberPartIds: string[]; }; index: number; } | null>>;
  productHasAddOns: boolean;
  setProductHasAddOns: React.Dispatch<React.SetStateAction<boolean>>;
}> = ({ selectedIds, setPartGroups, parts, setSelectedIds, setSetAllOpen, setAllOpen, setParts, colorChoices, togglePart, setRemovedPart, removedPart, partGroups, removedGroup, setRemovedGroup, productHasAddOns, setProductHasAddOns }) => (
  <div style={{ padding: "8px 12px 16px" }}>
    <FormSection
      title="Parts"
      footer="Prints: tracked and printed. Color only: shown and colored on orders, not printed. Picture only: in the product picture only. The eye on a tile hides that part in the product picture (the part is still saved). Drag a part tile to turn it; that angle is saved as the part’s picture. The product picture comes from the big viewport. Click to multi-select; double-click a tile to reset its view. Group 2+ parts like Photoshop layers; edit names under tiles for image and .stl stems."
      headerExtra={
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {selectedIds.length >= 2 && (
            <button
              type="button"
              title="Group selected parts for display/coloring (reversible per order)"
              onClick={() => {
                const ids = [...selectedIds];
                setPartGroups((prev) => {
                  const kept = prev
                    .map((group) => ({ ...group, memberPartIds: group.memberPartIds.filter((id) => !ids.includes(id)) }))
                    .filter((group) => group.memberPartIds.length >= 2);
                  const names = parts.filter((part) => ids.includes(part.id)).map((part) => part.partName);
                  const title = names.slice(0, 2).join(" + ") + (names.length > 2 ? ` +${names.length - 2}` : "");
                  kept.push({ id: `group-${crypto.randomUUID().slice(0, 8)}`, title, memberPartIds: ids });
                  return kept;
                });
                setSelectedIds([]);
              }}
              style={{ ...plainButton, fontWeight: 650 }}
            >
              Group ({selectedIds.length})
            </button>
          )}
          <div style={{ position: "relative" }}>
            <button type="button" onClick={() => setSetAllOpen((openMenu) => !openMenu)} style={plainButton}>
              Set all…
            </button>
            {setAllOpen && (
              <div style={menuPop}>
                <button type="button" style={menuItem} onClick={() => { setSelectedIds(parts.map((part) => part.id)); setSetAllOpen(false); }}>Select all parts</button>
                <button type="button" style={menuItem} onClick={() => { setSelectedIds([]); setSetAllOpen(false); }}>Select none</button>
                <button type="button" style={menuItem} onClick={() => { setParts((prev) => prev.map((part) => ({ ...part, role: "Color only" }))); setSetAllOpen(false); }}>Mark all Color only</button>
                <button type="button" style={menuItem} onClick={() => { setParts((prev) => prev.map((part) => (part.role === "Color only" ? { ...part, role: "Prints" } : part))); setSetAllOpen(false); }}>Clear all Color only</button>
                <button type="button" style={menuItem} onClick={() => {
                  setParts((prev) => prev.map((part) => {
                    const swatch = colorChoices[Math.floor(Math.random() * colorChoices.length)] || colorChoices[0];
                    return { ...part, defaultColorName: swatch.name, defaultColorHex: swatch.hex };
                  }));
                  setSetAllOpen(false);
                }}>Shuffle picture colors</button>
              </div>
            )}
          </div>
        </div>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, minWidth: 0 }}>
        {parts.map((part) => {
          const selected = selectedIds.includes(part.id);
          return (
            <div key={part.id} style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, opacity: part.showInPicture ? 1 : 0.45 }}>
              <div style={{ position: "relative", aspectRatio: "1", borderRadius: 8, overflow: "hidden", border: selected ? "2.5px solid #0a84ff" : "1px solid color-mix(in srgb, canvastext 22%, transparent)", background: selected ? "color-mix(in srgb, #0a84ff 12%, transparent)" : "color-mix(in srgb, canvastext 4%, transparent)" }}>
                <PartOrbitThumb
                  partName={part.partName}
                  positions={part.meshPositions}
                  indices={part.meshIndices}
                  color={part.defaultColorHex}
                  camera={part.thumbnailCamera}
                  onCameraChange={(cam) => setParts((prev) => prev.map((item) => item.id === part.id ? { ...item, thumbnailCamera: cam } : item))}
                  onTap={() => togglePart(part.id)}
                />
                <div style={{ position: "absolute", top: 4, left: 4, right: 4, display: "flex", justifyContent: "space-between", pointerEvents: "none" }}>
                  <button
                    type="button"
                    title={part.showInPicture ? "Hide in the picture" : "Show in the picture"}
                    aria-label={`${part.showInPicture ? "Hide" : "Show"} ${part.partName} in the picture`}
                    aria-pressed={part.showInPicture}
                    onClick={() => setParts((prev) => prev.map((item) => item.id === part.id ? { ...item, showInPicture: !item.showInPicture } : item))}
                    style={{ ...iconChip, pointerEvents: "auto", color: part.showInPicture ? "#0a84ff" : "inherit" }}
                  >
                    {part.showInPicture ? "◉" : "◌"}
                  </button>
                  <button
                    type="button"
                    title={parts.length <= 1 ? "A product needs at least one part" : "Exclude this part"}
                    disabled={parts.length <= 1}
                    onClick={() => {
                      setRemovedPart(part);
                      setParts((prev) => prev.filter((item) => item.id !== part.id));
                      setSelectedIds((prev) => prev.filter((id) => id !== part.id));
                    }}
                    style={{ ...iconChip, pointerEvents: "auto", color: "#ff3b30" }}
                  >
                    🗑
                  </button>
                </div>
              </div>
              <input
                value={part.partName}
                onChange={(event) => {
                  const val = event.target.value;
                  setParts((prev) => prev.map((item) => item.id === part.id ? { ...item, partName: val } : item));
                }}
                style={fieldStyle}
              />
              <select
                aria-label="Part role"
                value={part.role}
                onChange={(event) => {
                  const role = event.target.value as StudioPartRole;
                  setParts((prev) => prev.map((item) => item.id === part.id ? { ...item, role } : item));
                }}
                style={fieldStyle}
              >
                <option value="Prints">Prints</option>
                <option value="Color only">Color only</option>
                <option value="Picture only">Picture only</option>
              </select>
              {(() => {
                const selected = colorChoices.find((item) => item.name === part.defaultColorName && item.hex.toLowerCase() === part.defaultColorHex.toLowerCase())
                  || colorChoices.find((item) => item.hex.toLowerCase() === part.defaultColorHex.toLowerCase());
                return (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span title={part.defaultColorName} style={{ width: 16, height: 16, borderRadius: 4, flex: "0 0 auto", background: part.defaultColorHex, border: "1px solid color-mix(in srgb, canvastext 25%, transparent)" }} />
                    <select
                      aria-label="Filament"
                      value={selected?.id || part.defaultColorHex}
                      onChange={(event) => {
                        const swatch = colorChoices.find((item) => item.id === event.target.value) || colorChoices[0];
                        setParts((prev) => prev.map((item) => item.id === part.id ? { ...item, defaultColorName: swatch.name, defaultColorHex: swatch.hex } : item));
                      }}
                      style={{ ...fieldStyle, flex: 1, minWidth: 0 }}
                    >
                      {!selected && (
                        <option value={part.defaultColorHex}>{part.defaultColorName}</option>
                      )}
                      {colorChoices.map((swatch) => (
                        <option key={swatch.id} value={swatch.id}>{swatch.label}</option>
                      ))}
                    </select>
                  </div>
                );
              })()}
              <div style={{ fontSize: 9, opacity: 0.45, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{part.sourceFileName}</div>
            </div>
          );
        })}
      </div>
      {removedPart && (
        <button
          type="button"
          onClick={() => {
            setParts((prev) => [...prev, removedPart]);
            setRemovedPart(null);
          }}
          style={{ ...plainButton, marginTop: 8 }}
        >
          Undo remove {removedPart.partName}
        </button>
      )}
    </FormSection>
    {(partGroups.length > 0 || removedGroup) && (
      <FormSection title="Part groups">
        {partGroups.map((group) => (
          <div key={group.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <span style={{ flex: 1 }}>{group.title} ({group.memberPartIds.length})</span>
            <button
              type="button"
              onClick={() => {
                const index = partGroups.findIndex((item) => item.id === group.id);
                if (index < 0) return;
                setRemovedGroup({ group, index });
                setPartGroups((prev) => prev.filter((item) => item.id !== group.id));
              }}
              style={plainButton}
            >
              🗑
            </button>
          </div>
        ))}
        {removedGroup && (
          <button
            type="button"
            onClick={() => {
              setPartGroups((prev) => {
                const next = [...prev];
                next.splice(Math.min(removedGroup.index, next.length), 0, removedGroup.group);
                return next;
              });
              setRemovedGroup(null);
            }}
            style={plainButton}
          >
            Undo remove {removedGroup.group.title}
          </button>
        )}
      </FormSection>
    )}
    <FormSection title="Add-ons">
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
        <input type="checkbox" checked={productHasAddOns} onChange={(event) => setProductHasAddOns(event.target.checked)} />
        This product has add-ons
      </label>
      {productHasAddOns && (
        <div style={{ fontSize: 12, opacity: 0.65 }}>
          Tag extra parts onto an add-on. Untagged parts print with the main assembly. Each selected add-on becomes its own line on the order.
        </div>
      )}
    </FormSection>
  </div>
);
