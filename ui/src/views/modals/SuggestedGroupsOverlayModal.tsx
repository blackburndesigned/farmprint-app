import React from "react";
import { actorDevice } from "../../deviceLabel";
import { isThumbnailOnlyUnit } from "../../partThumbnails";
import { Order, PartUnit, TransitionRequest } from "../../types";
import { CreatedCatalogProductPayload } from "../../components/ProductImportModal3D";
import { PartTileCard, SuggestedPrintGroup } from "../shared";

export const SuggestedGroupsOverlayModal: React.FC<{
  open: boolean;
  suggestedPrintGroups: SuggestedPrintGroup[];
  orderById: Map<string, Order>;
  customProducts: Record<string, CreatedCatalogProductPayload>;
  onClose: () => void;
  onSelectUnit: (unit: PartUnit, e: React.MouseEvent<HTMLElement>) => void;
  onRunTransition: (req: TransitionRequest) => void;
}> = ({
  open,
  suggestedPrintGroups,
  orderById,
  onClose,
  onSelectUnit,
  onRunTransition,
}) => {
  if (!open) return null;
  return (
    <div className="fp-modal-backdrop" onClick={onClose}>
      <div
        className="fp-modal-window" role="dialog" aria-modal="true"
        style={{ width: "min(960px, 92vw)", maxHeight: "86vh", padding: 18 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 14,
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>
              Print — Suggested Groups ({suggestedPrintGroups.length})
            </div>
            <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>
              Grouped by product + filament color; printers with waiting/staged
              parts sorted first
            </div>
          </div>
          <button className="fp-btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div style={{ overflowY: "auto", display: "grid", gap: 12 }}>
          {suggestedPrintGroups.map((grp) => (
            <div key={grp.key} className="fp-card">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    className="fp-swatch-dot"
                    style={{
                      background: grp.filamentHex,
                      width: 14,
                      height: 14,
                    }}
                  />
                  <strong>
                    {(grp.units[0]?.product_name || "Product")} — {grp.filamentName} ({(grp.units[0]?.filament_material || "PLA")})
                  </strong>
                  <span className="fp-badge fp-badge-blue">
                    {grp.units.length} parts • ~{(grp.units.reduce((s, u) => s + (u.print_minutes || 0), 0))}m
                  </span>
                </div>
                {grp.suggestedPrinter && (
                  <button
                    className="fp-btn fp-btn-primary"
                    onClick={() => {
                      onRunTransition({
                        unit_ids: grp.units.map((u) => u.id),
                        to_state: "Printing",
                        actor_device: actorDevice(),
                        source_surface: "Suggested Groups Overlay Modal",
                        printer_id: grp.suggestedPrinter!.id,
                        action_label: `Print! Batch (${grp.units.length} ${grp.filamentName}) → ${grp.suggestedPrinter!.name}`,
                        failure_reason: null,
                        failure_note: null,
                      });
                      onClose();
                    }}
                  >
                    Print! on {grp.suggestedPrinter.name}
                  </button>
                )}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {grp.units
                  .filter((u) => !isThumbnailOnlyUnit(u))
                  .map((u) => (
                    <PartTileCard
                      key={u.id}
                      unit={u}
                      order={orderById.get(u.order_id)}
                      onSelectUnit={onSelectUnit}
                    />
                  ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
