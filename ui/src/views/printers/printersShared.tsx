import React from "react";
import { Order, PartUnit, Printer, ShopSnapshot, TransitionRequest } from "../../types";
import { PartThumbnail3D } from "../../components/PartThumbnail3D";
import { statusStepFor } from "../OrdersAndonViews";
import { useShopSettings } from "../../settingsStore";
import { outlineReplacesRing } from "../../thumbnailOutline";
import { Check, X } from "lucide-react";
import { Icon } from "../../icons";
import type { TransitionOptions } from "./markPrinting";

export interface SuggestedPrintGroup {
  key: string; productId: string; productName: string; filamentName: string; filamentHex: string; material: string;
  units: PartUnit[]; customerNames: string[]; orderCodes: string[]; suggestedPrinter?: Printer;
}

export interface PrintersQueueCommonProps {
  snapshot: ShopSnapshot;
  /** Runs a transition; `markPrinting` opens the printer picker for Mark Printing (no slicer). */
  onTransition: (req: TransitionRequest, opts?: TransitionOptions) => void;
  onSelectUnit?: (unit: PartUnit, e: React.MouseEvent) => void;
  showSuggestedGroups?: boolean;
  onToggleSuggestedGroups?: (open: boolean) => void;
  wallMode?: boolean;
  onToggleWallMode?: (wall: boolean) => void;
  onSnapshotUpdated?: (next: ShopSnapshot) => void;
  onOpenFilamentLibrary?: () => void;
  onOpenSettingsPrinters?: () => void;
}

export const LANE_COLORS = ["#2563eb", "#0d9488", "#7c3aed", "#d97706", "#db2777", "#16a34a"];

export function isPrinterReadyFirst(p: Printer, allUnits: PartUnit[]): number {
  const assigned = allUnits.filter((u) => u.printer_id === p.id);
  const printing = assigned.some((u) => u.state === "Printing");
  const staged = assigned.some((u) => u.state === "Staged" || u.state === "Queued");
  const s = (p.status || "").toLowerCase();
  if (!printing && (s.includes("idle") || s.includes("ready"))) return staged ? 0 : 1;
  return printing ? 2 : 3;
}

export function prefersLightOnHex(hex: string): boolean {
  const c = (hex || "#1e293b").replace("#", "");
  if (c.length !== 6) return true;
  const r = parseInt(c.slice(0, 2), 16) / 255, g = parseInt(c.slice(2, 4), 16) / 255, b = parseInt(c.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.62;
}

export const PartTile64: React.FC<{
  unit: PartUnit; order?: Order; onTransition: (req: TransitionRequest) => void;
  onSelectUnit?: (unit: PartUnit, e: React.MouseEvent) => void; sourceSurface: string; showOutcomeButtons?: boolean;
  onRequestFailureReason?: (unitIds: string[], label: string) => void;
  /** Thumbnail edge in px. Default 52 inside a 64 tile; Parts to Print passes 76 (PrintGroupsPanel.swift `tile`). */
  thumbSize?: number;
  /** Multi-select (Parts to Print): shows a checkbox on hover, and always while selected. */
  selected?: boolean;
  /** Checkbox clicked (Shift held = range). Set to make the tile selectable. */
  onCheckClick?: (e: React.MouseEvent) => void;
  /** Runs before the tile's own click; return true when it handled the click
   *  (Cmd/Ctrl- or Shift-click selecting), so the part menu doesn't open. */
  onSelectClick?: (e: React.MouseEvent) => boolean;
}> = ({ unit, order, onTransition, onSelectUnit, sourceSurface, showOutcomeButtons = true, onRequestFailureReason, thumbSize, selected = false, onCheckClick, onSelectClick }) => {
  const thumb = thumbSize ?? 52;
  const box = (thumbSize ?? 59) + 10; // border-box: 2.5px border + padding room; default = old 64px content + border
  const customerLabel = order?.customer_name || unit.customer_name || unit.order_code;
  const orderCodeLabel = order?.order_code || unit.order_code;
  const step = statusStepFor(unit.state);
  const hideRing = outlineReplacesRing(useShopSettings().appearance_studio);
  const move = (to_state: string, action_label: string, failure_reason: string | null = null) =>
    onTransition({
      unit_ids: [unit.id], to_state, printer_id: to_state === "Queued" ? null : unit.printer_id,
      actor_device: "Mac Studio (FarmPrint)", source_surface: sourceSurface, action_label,
      failure_reason, failure_note: failure_reason ? `Failed on ${sourceSurface}` : null,
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: thumbSize ? box + 4 : 68 }}>
      <div
        className={onCheckClick ? `fp-selectable-tile${selected ? " is-selected" : ""}` : undefined}
        onClick={(e) => {
          if (onSelectClick?.(e)) { e.stopPropagation(); return; }
          if (onSelectUnit) { e.stopPropagation(); onSelectUnit(unit, e); }
        }}
        title={`${unit.part_name} · ${unit.filament_name} · ${customerLabel} (${orderCodeLabel})`}
        style={{ position: "relative", width: box, height: box, boxSizing: "border-box", borderRadius: 10, cursor: "pointer", background: "rgba(255,255,255,0.04)", border: hideRing ? "2.5px solid transparent" : `2.5px solid ${step.bg}`, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", boxShadow: selected ? "0 0 0 3px #0a84ff" : undefined }}
      >
        <PartThumbnail3D partName={unit.part_name} partId={unit.part_id} productId={unit.product_id} colorHex={unit.filament_hex} size={thumb} statusHex={step.bg} />
        <span style={{ position: "absolute", top: 4, left: 4, width: 9, height: 9, borderRadius: "50%", background: unit.filament_hex, border: "1px solid rgba(255,255,255,0.65)" }} />
        <span style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "8px 3px 2px", background: "linear-gradient(transparent, rgba(0,0,0,0.72))", fontSize: 9.5, fontWeight: 700, color: "#fff", textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {unit.part_name}
        </span>
        {onCheckClick && (
          <span
            role="checkbox"
            aria-checked={selected}
            aria-label={`Select ${unit.part_name} for ${customerLabel}`}
            tabIndex={0}
            className="fp-select-check"
            onClick={(e) => { e.stopPropagation(); onCheckClick(e); }}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                onCheckClick(e as unknown as React.MouseEvent);
              }
            }}
          >
            {selected ? <Icon icon={Check} size={12} strokeWidth={3} /> : null}
          </span>
        )}
      </div>
      <div style={{ fontSize: 9.5, fontWeight: 600, color: "rgba(235,235,245,0.78)", maxWidth: 68, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>
        {customerLabel}
      </div>
      {showOutcomeButtons && (
        <div style={{ display: "flex", gap: 3, marginTop: 3 }} onClick={(e) => e.stopPropagation()}>
          <button type="button" title={`Mark ${unit.part_name} done`} onClick={() => move(unit.state === "Printing" ? "Printed" : "Ready", `Done: ${unit.part_name} (${customerLabel})`)} style={{ width: 28, height: 18, borderRadius: 5, border: "1px solid rgba(48,209,88,0.55)", background: "rgba(48,209,88,0.18)", color: "#30d158", fontSize: 10, fontWeight: 800, cursor: "pointer", padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Icon icon={Check} size={12} strokeWidth={3} /></button>
          <button type="button" title={`Mark ${unit.part_name} failed`} onClick={() => onRequestFailureReason ? onRequestFailureReason([unit.id], `${unit.part_name} (${customerLabel})`) : move("Queued", `Failed: ${unit.part_name}`, "Bed Adhesion")} style={{ width: 28, height: 18, borderRadius: 5, border: "1px solid rgba(255,69,58,0.55)", background: "rgba(255,69,58,0.18)", color: "#ff6961", fontSize: 10, fontWeight: 800, cursor: "pointer", padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Icon icon={X} size={12} strokeWidth={3} /></button>
        </div>
      )}
    </div>
  );
};
