import React, { useEffect, useRef, useState } from "react";
import { actorDevice } from "../../deviceLabel";
import { getProcessSteps, stepLabel } from "../../settingsStore";
import { invoke } from "../../tauriInvoke";
import { notifyError, pickFailureReason } from "../../uiFeedback";
import { FilamentSwatch, PartUnit, Printer, ShopSnapshot, TransitionRequest } from "../../types";
import { Check, Palette, X } from "lucide-react";
import { Icon } from "../../icons";
import { unitStatusRows } from "./unitStatusRows";

export const UnitStatePopover: React.FC<{
  activeUnitMenu: { unit: PartUnit; x: number; y: number } | null;
  sortedPrinters: Printer[];
  filaments?: FilamentSwatch[];
  onSnapshotUpdated?: (s: ShopSnapshot) => void;
  onRunTransition: (req: TransitionRequest) => void;
  /** Close the popover (outside click / Escape). */
  onClose?: () => void;
}> = ({
  activeUnitMenu,
  sortedPrinters,
  filaments = [],
  onSnapshotUpdated,
  onRunTransition,
  onClose,
}) => {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setShowColorPicker(false);
  }, [activeUnitMenu?.unit.id]);

  // Modals (e.g. Order Details) stop click propagation, so the shell's click-to-close never
  // fires there. Listen on the document in the capture phase instead.
  const isOpen = !!activeUnitMenu;
  useEffect(() => {
    if (!isOpen || !onClose) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = popoverRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // Defer so the click that opened the popover doesn't immediately close it.
    const t = window.setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown, true);
    }, 0);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [isOpen, onClose]);

  if (!activeUnitMenu) return null;
  const { unit, x, y } = activeUnitMenu;

  return (
    <div
      ref={popoverRef}
      style={{
        position: "fixed",
        left: Math.min(x, window.innerWidth - 270),
        top: Math.min(y, window.innerHeight - 360),
        width: 256,
        background: "rgba(28,28,34,0.98)",
        border: "1px solid rgba(255,255,255,0.18)",
        borderRadius: 12,
        boxShadow: "0 16px 40px rgba(0,0,0,0.65)",
        padding: 10,
        zIndex: 400,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ fontSize: 12, fontWeight: 700 }}>
          {unit.part_name} ({unit.filament_name})
        </div>
        {filaments.length > 0 && (
          <button
            type="button"
            className="fp-btn fp-btn-sm"
            style={{ height: 20, padding: "0 6px", fontSize: 10 }}
            onClick={() => setShowColorPicker((v) => !v)}
          >
            <Icon icon={Palette} size={12} /> Color
          </button>
        )}
      </div>

      {showColorPicker ? (
        <div style={{ maxHeight: 210, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
          <div style={{ fontSize: 10.5, color: "rgba(235,235,245,0.6)", marginBottom: 2 }}>
            Pick filament color for {unit.part_name}:
          </div>
          {filaments.map((sw) => (
            <button
              key={sw.id}
              type="button"
              className="fp-btn fp-btn-sm"
              style={{
                justifyContent: "flex-start",
                gap: 8,
                background: sw.id === unit.filament_id ? "rgba(10,132,255,0.22)" : undefined,
              }}
              onClick={async () => {
                try {
                  const updated = await invoke<ShopSnapshot>("update_part_filament", {
                    unitId: unit.id,
                    filamentId: sw.id,
                    actorDevice: "Mac Studio (FarmPrint)",
                  });
                  onSnapshotUpdated?.(updated);
                } catch (e) {
                  notifyError(`Couldn't change the color of ${unit.part_name}`, e);
                }
                setShowColorPicker(false);
                // The popover holds a copy of the unit; close so it never shows the old color.
                onClose?.();
              }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: sw.hex,
                  border: "1px solid rgba(255,255,255,0.75)",
                  flexShrink: 0,
                }}
              />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {sw.name} ({sw.material})
              </span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 8 }}>
            {unitStatusRows(getProcessSteps(), unit.state, stepLabel(unit.state)).map(({ id: st, name: stName, current, label }) =>
              current ? (
                // Where the part is now: a marker, not an action.
                <div
                  key={st}
                  className="fp-status-current"
                  role="status"
                  aria-current="step"
                  aria-label={label}
                  title={`${unit.part_name} is ${stName}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    width: "100%",
                    padding: "5px 10px",
                    borderRadius: 8,
                    border: "1px dashed var(--border-strong, rgba(255,255,255,0.22))",
                    color: "var(--text-secondary, rgba(235,235,245,0.6))",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "default",
                    userSelect: "none",
                    boxSizing: "border-box",
                  }}
                >
                  <Icon icon={Check} size={14} />
                  <span>{label}</span>
                </div>
              ) : (
                <button
                  key={st}
                  type="button"
                  className="fp-btn"
                  style={{ justifyContent: "space-between", width: "100%" }}
                  onClick={() =>
                    onRunTransition({
                      unit_ids: [unit.id],
                      to_state: st,
                      actor_device: actorDevice(),
                      source_surface: "Part Tile Popover",
                      printer_id:
                        st === "Staged" || st === "Printing"
                          ? unit.printer_id || sortedPrinters[0]?.id || null
                          : unit.printer_id,
                      action_label: `${unit.part_name} → ${stName}`,
                      failure_reason: null,
                      failure_note: null,
                    })
                  }
                >
                  <span>{label}</span>
                  <span>→</span>
                </button>
              )
            )}
            <button
              className="fp-btn fp-btn-danger"
              style={{ width: "100%" }}
              onClick={async (e) => {
                // Ask why it failed; dismissing the menu marks nothing.
                const reason = await pickFailureReason({ x: e.clientX, y: e.clientY });
                if (!reason) return;
                onRunTransition({
                  unit_ids: [unit.id],
                  to_state: "Queued",
                  actor_device: actorDevice(),
                  source_surface: "Part Tile Popover · Mark Failed",
                  printer_id: unit.printer_id,
                  action_label: `${unit.part_name} Failed (Reprint)`,
                  failure_reason: reason,
                  failure_note: "Marked Failed / Needs Reprint",
                });
              }}
            >
              <Icon icon={X} /> Mark Failed (Queue Reprint)
            </button>
          </div>
        </>
      )}
    </div>
  );
};
