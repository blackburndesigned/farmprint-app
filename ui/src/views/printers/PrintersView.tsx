import { FilamentLibrarySheet } from "../../components/FilamentLibrarySheet";
import { printerAccent } from "../../settingsStore";
import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "../../tauriInvoke";
import { FilamentSwatch, Order, OrderLine, PartUnit, Printer, PrinterSlot, Product, ShopSnapshot } from "../../types";
import { ProductCompositeThumbnail3D } from "../../components/PartThumbnail3D";
import { StatusLegendHeader } from "../OrdersAndonViews";
import { BedSizeFields, parseBedSize } from "../../components/BedSizeFields";
import { FAILURE_REASONS, confirmRemovePrinter, notifyError } from "../../uiFeedback";
import { LANE_COLORS, PartTile64, type PrintersQueueCommonProps, prefersLightOnHex } from "./printersShared";
import { isThumbnailOnlyPart } from "../../partThumbnails";

export const PrintersView: React.FC<PrintersQueueCommonProps> = ({
  snapshot, onTransition, onSelectUnit, wallMode: controlledWall, onToggleWallMode, onSnapshotUpdated,
}) => {
  const [localWall, setLocalWall] = useState(false);
  const wallMode = controlledWall !== undefined ? controlledWall : localWall;
  const setWallMode = (v: boolean) => { setLocalWall(v); onToggleWallMode?.(v); };

  const [localPrinters, setLocalPrinters] = useState<Printer[]>(snapshot.printers);
  const [localFilaments, setLocalFilaments] = useState<FilamentSwatch[]>(snapshot.filaments);
  useEffect(() => { setLocalPrinters(snapshot.printers); }, [snapshot.printers]);
  useEffect(() => { setLocalFilaments(snapshot.filaments); }, [snapshot.filaments]);

  const [editingPrinterSlotsId, setEditingPrinterSlotsId] = useState<string | null>(null);
  const [showAddPrinterModal, setShowAddPrinterModal] = useState(false);
  const [newPrinterName, setNewPrinterName] = useState("");
  const [newPrinterModel, setNewPrinterModel] = useState("Bambu P1S");
  const [newPrinterNozzle, setNewPrinterNozzle] = useState("0.4");
  const [newPrinterBed, setNewPrinterBed] = useState<{ x: string; y: string }>({ x: "", y: "" });
  const [showFilamentModal, setShowFilamentModal] = useState(false);

  const [failureModalTarget, setFailureModalTarget] = useState<{ unitIds: string[]; label: string } | null>(null);
  const [failureReason, setFailureReason] = useState<string>("Bed Adhesion");
  const [failureNote, setFailureNote] = useState<string>("");

  useEffect(() => {
    if (!wallMode) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setWallMode(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wallMode]);

  const productById = useMemo(() => new Map<string, Product>(snapshot.products.map((p) => [p.id, p])), [snapshot.products]);
  const allUnits = useMemo(
    () => snapshot.orders.flatMap((o) => o.lines.flatMap((l) => l.units)).filter((u) => !isThumbnailOnlyPart(u.part_name, productById.get(u.product_id))),
    [snapshot.orders, productById]
  );
  const orderById = useMemo(() => new Map<string, Order>(snapshot.orders.map((o) => [o.id, o])), [snapshot.orders]);
  const activeJobsCount = useMemo(() => allUnits.filter((u) => u.state === "Printing" || u.state === "Staged").length, [allUnits]);

  const handleConfirmFailure = () => {
    if (!failureModalTarget) return;
    onTransition({
      unit_ids: failureModalTarget.unitIds,
      to_state: "Queued",
      printer_id: null,
      actor_device: "Mac Studio (FarmPrint)",
      source_surface: "Printers",
      action_label: `✕ Failed (${failureReason}): ${failureModalTarget.label}`,
      failure_reason: failureReason,
      failure_note: failureNote.trim() || `${failureReason} — queued for reprint`,
    });
    setFailureModalTarget(null);
    setFailureNote("");
  };

  // Failures are shown and never faked locally: the ledger snapshot stays the source of truth.
  const handleCreatePrinter = async () => {
    const name = newPrinterName.trim() || `Printer ${localPrinters.length + 1}`;
    const bed = parseBedSize(newPrinterBed.x, newPrinterBed.y);
    if ("error" in bed) {
      notifyError(`${name} was not added`, bed.error);
      return;
    }
    try {
      const updated = await invoke<ShopSnapshot>("add_printer", { name, model: newPrinterModel, nozzle_mm: parseFloat(newPrinterNozzle) || 0.4, ...bed });
      if (updated?.printers) { setLocalPrinters(updated.printers); onSnapshotUpdated?.(updated); }
    } catch (e) {
      notifyError(`${name} was not added`, e);
      return;
    }
    setNewPrinterName("");
    setNewPrinterBed({ x: "", y: "" });
    setShowAddPrinterModal(false);
  };

  const handleRemovePrinter = async (printerId: string) => {
    const printer = localPrinters.find((p) => p.id === printerId);
    if (!printer || !(await confirmRemovePrinter(snapshot, printer))) return;
    try {
      const updated = await invoke<ShopSnapshot>("delete_printer", { printerId });
      if (updated?.printers) { setLocalPrinters(updated.printers); onSnapshotUpdated?.(updated); }
    } catch (e) {
      notifyError(`${printer.name} was not removed`, e);
    }
  };

  const handleTogglePrinterFilamentSlot = async (printer: Printer, swatch: FilamentSwatch) => {
    const exists = printer.loaded_slots.some((s) => s.filament_id === swatch.id || (s.filament_name === swatch.name && s.filament_hex === swatch.hex));
    const nextSlots: PrinterSlot[] = exists
      ? printer.loaded_slots.filter((s) => !(s.filament_id === swatch.id || (s.filament_name === swatch.name && s.filament_hex === swatch.hex))).map((s, idx) => ({ ...s, slot_index: idx }))
      : [...printer.loaded_slots, { slot_index: printer.loaded_slots.length, filament_id: swatch.id, filament_name: swatch.name, filament_hex: swatch.hex, material: swatch.material }];
    try {
      const updated = await invoke<ShopSnapshot>("set_printer_filament_slots", { printerId: printer.id, filamentIds: nextSlots.map((s) => s.filament_id) });
      if (updated?.printers) { setLocalPrinters(updated.printers); onSnapshotUpdated?.(updated); }
    } catch (e) {
      notifyError(`${printer.name}'s filament slots were not saved`, e);
    }
  };

  const renderSliceComposite40 = (order?: Order, line?: OrderLine, unit?: PartUnit) => {
    const prod = line ? productById.get(line.product_id) : unit ? productById.get(unit.product_id) : undefined;
    const parts = prod?.parts.map((pt) => ({
      partName: pt.name,
      colorHex: line?.units.find((u) => u.part_id === pt.id || u.part_name === pt.name)?.filament_hex || unit?.filament_hex || "#1B1D21",
      visible: true,
    })) || (unit ? [{ partName: unit.part_name, colorHex: unit.filament_hex, visible: true }] : []);
    return <ProductCompositeThumbnail3D productName={line?.product_name || unit?.product_name || order?.customer_name || "Order"} parts={parts} size={40} inscriptionText={line?.custom_text} />;
  };

  const editingPrinter = localPrinters.find((p) => p.id === editingPrinterSlotsId) || null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 18px 4px", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 900, letterSpacing: 1.1 }}>PRINTERS</div>
          <div style={{ fontSize: 11, color: "rgba(235,235,245,0.58)" }}>
            {wallMode ? "Wall TV across-the-room view · Click any tile or press Esc for Work mode" : "Right-click or use Move on a job to reassign it · Click spools to change loaded filament"}
          </div>
        </div>
        <button type="button" className="fp-btn fp-btn-sm" onClick={() => setShowFilamentModal(true)}>
          🎨 Filament Library ({localFilaments.length})
        </button>
        <button type="button" className="fp-btn fp-btn-sm fp-btn-primary" onClick={() => setShowAddPrinterModal(true)}>
          + Add Printer
        </button>
        <div className="fp-mode-toggle">
          <button type="button" className={`fp-mode-btn ${!wallMode ? "active" : ""}`} onClick={() => setWallMode(false)}>Work</button>
          <button type="button" className={`fp-mode-btn ${wallMode ? "active" : ""}`} onClick={() => setWallMode(true)}>Wall TV</button>
        </div>
        <div style={{ flex: 1 }} />
        <span className="fp-badge fp-badge-blue">Printers: {localPrinters.length} machines</span>
        <span className="fp-badge fp-badge-green">Active: {activeJobsCount} parts</span>
      </div>
      {!wallMode && <StatusLegendHeader />}

      {wallMode ? (
        <div className="fp-scroll" style={{ flex: 1, padding: "14px 18px 88px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 16, alignContent: "start" }}>
          {localPrinters.map((printer, idx) => {
            const accent = printerAccent(printer.id) || printer.loaded_slots[0]?.filament_hex || LANE_COLORS[idx % LANE_COLORS.length];
            const laneUnits = allUnits.filter((u) => u.printer_id === printer.id && (u.state === "Printing" || u.state === "Staged"));
            const isPrinting = laneUnits.some((u) => u.state === "Printing");
            const totalMins = laneUnits.reduce((acc, u) => acc + (u.print_minutes || 0), 0);
            const customerNames = Array.from(new Set(laneUnits.map((u) => orderById.get(u.order_id)?.customer_name || u.customer_name))).join(" · ");
            const productLabel = laneUnits[0]?.product_name || "Idle — Ready for next plate";
            return (
              <div
                key={printer.id}
                onClick={() => setWallMode(false)}
                style={{
                  borderRadius: 18, padding: 22, background: "rgba(22,27,38,0.95)",
                  border: `3.5px solid ${isPrinting ? "#30d158" : accent}`,
                  boxShadow: "0 14px 36px rgba(0,0,0,0.45)", display: "flex", justifyContent: "space-between", alignItems: "stretch", gap: 16, cursor: "pointer", minHeight: 220,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flex: 1, minWidth: 0 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 30, fontWeight: 900, letterSpacing: 0.4 }}>{printer.name}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, padding: "3px 10px", borderRadius: 999, background: "rgba(255,255,255,0.1)" }}>{printer.model}</span>
                    </div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: isPrinting ? "#30d158" : "rgba(235,235,245,0.65)", marginTop: 4 }}>
                      {isPrinting ? `● PRINTING (${laneUnits.length} parts)` : laneUnits.length > 0 ? `◐ STAGED (${laneUnits.length} parts)` : "○ IDLE"}
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: "#f8fafc", marginTop: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {productLabel}
                    </div>
                    {customerNames && (
                      <div style={{ fontSize: 17, fontWeight: 600, color: "rgba(235,235,245,0.75)", marginTop: 2 }}>
                        {customerNames}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 12 }}>
                    <span style={{ fontSize: 40, fontWeight: 900, fontVariantNumeric: "tabular-nums", color: isPrinting ? "#64d2ff" : "rgba(235,235,245,0.4)" }}>
                      {laneUnits.length > 0 ? `~${Math.max(1, Math.round(totalMins / 60))}h ${totalMins % 60}m` : "0m"}
                    </span>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {printer.loaded_slots.map((s) => (
                        <span key={s.slot_index} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999, background: "rgba(255,255,255,0.08)", fontSize: 12, fontWeight: 700 }}>
                          <span style={{ width: 12, height: 12, borderRadius: "50%", background: s.filament_hex, border: "1.5px solid #fff" }} />
                          {s.filament_name}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                {laneUnits.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, justifyContent: "center" }} onClick={(e) => e.stopPropagation()}>
                    <button type="button" title="Mark whole job done" onClick={() => onTransition({ unit_ids: laneUnits.map((u) => u.id), to_state: "Printed", printer_id: printer.id, actor_device: "Mac Studio (FarmPrint)", source_surface: "Printers Wall TV", action_label: `Plate done on ${printer.name}`, failure_reason: null, failure_note: null })} style={{ width: 54, height: 54, borderRadius: 14, border: "2px solid #30d158", background: "rgba(48,209,88,0.22)", color: "#30d158", fontSize: 24, fontWeight: 900, cursor: "pointer" }}>✓</button>
                    <button type="button" title="Mark whole job failed" onClick={() => setFailureModalTarget({ unitIds: laneUnits.map((u) => u.id), label: `All jobs on ${printer.name}` })} style={{ width: 54, height: 54, borderRadius: 14, border: "2px solid #ff453a", background: "rgba(255,69,58,0.22)", color: "#ff6961", fontSize: 24, fontWeight: 900, cursor: "pointer" }}>✕</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", gap: 12, overflowX: "auto", overflowY: "hidden", padding: "8px 18px 88px" }}>
          {localPrinters.map((printer, idx) => {
            const accent = printerAccent(printer.id) || printer.loaded_slots[0]?.filament_hex || LANE_COLORS[idx % LANE_COLORS.length];
            const laneUnits = allUnits.filter((u) => u.printer_id === printer.id && (u.state === "Printing" || u.state === "Staged"));
            const byOrder = new Map<string, PartUnit[]>();
            for (const u of laneUnits) byOrder.set(u.order_id, [...(byOrder.get(u.order_id) || []), u]);
            const slices = Array.from(byOrder.entries());
            const lightText = prefersLightOnHex(accent);
            return (
              <div key={printer.id} style={{ width: 282, flexShrink: 0, display: "flex", flexDirection: "column", borderRadius: 14, background: "rgba(22,27,38,0.92)", border: "1px solid rgba(255,255,255,0.1)", overflow: "hidden" }}>
                <div style={{ background: accent, color: lightText ? "#fff" : "#111", padding: "8px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{printer.name}</div>
                    <div style={{ fontSize: 11, opacity: 0.84 }}>{slices.length} {slices.length === 1 ? "job" : "jobs"} · {laneUnits.length} parts · {laneUnits.some((u) => u.state === "Printing") ? "Printing" : "Idle"}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                    <button type="button" title={`Set loaded filament spools on ${printer.name}`} onClick={() => setEditingPrinterSlotsId(printer.id)} style={{ width: 24, height: 24, borderRadius: "50%", border: "none", background: "rgba(0,0,0,0.26)", color: "#fff", cursor: "pointer", fontSize: 12 }}>🎨</button>
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: "rgba(0,0,0,0.22)", color: "#fff" }}>{printer.model}</span>
                  </div>
                </div>
                <div onClick={() => setEditingPrinterSlotsId(printer.id)} title="Click to change loaded filament spools" style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", background: "rgba(255,255,255,0.04)", borderBottom: "1px solid rgba(255,255,255,0.06)", overflowX: "auto", cursor: "pointer" }}>
                  {printer.loaded_slots.length === 0 ? (
                    <span style={{ fontSize: 11, color: "rgba(235,235,245,0.55)" }}>+ No filament · tap to load spool</span>
                  ) : (
                    printer.loaded_slots.map((slot) => (
                      <span key={slot.slot_index} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 7px", borderRadius: 999, background: "rgba(255,255,255,0.07)", fontSize: 10.5, fontWeight: 600 }}>
                        <span style={{ width: 14, height: 14, borderRadius: "50%", background: slot.filament_hex, border: "2px solid rgba(255,255,255,0.75)", boxShadow: "inset 0 0 0 3px rgba(0,0,0,0.28)" }} />
                        <span>{slot.filament_name}</span>
                      </span>
                    ))
                  )}
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: 9, display: "flex", flexDirection: "column", gap: 8 }}>
                  {slices.length === 0 ? (
                    <div style={{ textAlign: "center", fontSize: 12, color: "rgba(235,235,245,0.45)", paddingTop: 18 }}>Idle</div>
                  ) : (
                    slices.map(([orderId, units]) => {
                      const ord = orderById.get(orderId);
                      const first = units[0];
                      const line = ord?.lines.find((l) => l.id === first.line_id) || ord?.lines[0];
                      const totalMins = units.reduce((acc, u) => acc + (u.print_minutes || 0), 0);
                      return (
                        <div key={orderId} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 11, padding: 8, display: "flex", flexDirection: "column", gap: 7 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            {renderSliceComposite40(ord, line, first)}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ord?.customer_name || first.customer_name}</div>
                              <div style={{ fontSize: 11, color: "rgba(235,235,245,0.62)" }}>{first.filament_name} · ×{units.length}</div>
                              <div style={{ fontSize: 10.5, fontWeight: 600, color: "#64d2ff" }}>{units.some((u) => u.state === "Printing") ? `Printing ~${Math.max(1, Math.round(totalMins / 60))}h` : "Staged on plate"}</div>
                            </div>
                            <div style={{ display: "flex", gap: 3 }}>
                              <button type="button" className="fp-btn fp-btn-sm fp-btn-success" style={{ padding: "2px 6px" }} title="Mark plate done" onClick={() => onTransition({ unit_ids: units.map((u) => u.id), to_state: "Printed", printer_id: printer.id, actor_device: "Mac Studio (FarmPrint)", source_surface: "Printers", action_label: `Done: ${ord?.customer_name || first.order_code}`, failure_reason: null, failure_note: null })}>✓</button>
                              <button type="button" className="fp-btn fp-btn-sm fp-btn-danger" style={{ padding: "2px 6px" }} title="Mark plate failed" onClick={() => setFailureModalTarget({ unitIds: units.map((u) => u.id), label: `${ord?.customer_name || first.order_code} on ${printer.name}` })}>✕</button>
                            </div>
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {units.map((u) => <PartTile64 key={u.id} unit={u} order={ord} onTransition={onTransition} onSelectUnit={onSelectUnit} sourceSurface="Printers" onRequestFailureReason={(ids, lbl) => setFailureModalTarget({ unitIds: ids, label: lbl })} />)}
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 4, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                            <select aria-label="Move job" value="" onChange={(e) => e.target.value && onTransition({ unit_ids: units.map((u) => u.id), to_state: "Printing", printer_id: e.target.value, actor_device: "Mac Studio (FarmPrint)", source_surface: "Printers", action_label: "Moved job to printer", failure_reason: null, failure_note: null })} style={{ background: "rgba(255,255,255,0.06)", color: "#e2e8f0", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, fontSize: 10.5, padding: "2px 6px" }}>
                              <option value="">⇄ Move…</option>
                              {localPrinters.filter((p) => p.id !== printer.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                            <button type="button" className="fp-btn fp-btn-sm" style={{ padding: "2px 8px", fontSize: 10.5 }} onClick={() => onTransition({ unit_ids: units.map((u) => u.id), to_state: "Queued", printer_id: null, actor_device: "Mac Studio (FarmPrint)", source_surface: "Printers", action_label: "Returned job to In Queue", failure_reason: null, failure_note: null })}>Queue</button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Failure Reason Picker Sheet */}
      {failureModalTarget && (
        <div className="fp-modal-backdrop" onClick={() => setFailureModalTarget(null)}>
          <div className="fp-modal-window" style={{ width: "min(460px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className="fp-modal-header">
              <div>
                <div className="fp-modal-title">Mark Failed — Queue Reprint</div>
                <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>{failureModalTarget.label}</div>
              </div>
              <button type="button" className="fp-btn fp-btn-sm" onClick={() => setFailureModalTarget(null)}>Cancel</button>
            </div>
            <div className="fp-modal-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {FAILURE_REASONS.map((r) => (
                  <button key={r} type="button" className={`fp-btn fp-btn-sm ${failureReason === r ? "fp-btn-danger" : ""}`} onClick={() => setFailureReason(r)}>
                    {r}
                  </button>
                ))}
              </div>
              <label style={{ fontSize: 11.5 }}>
                Optional Note (kept with Flow ledger)
                <input type="text" placeholder="What went wrong?" value={failureNote} onChange={(e) => setFailureNote(e.target.value)} style={{ width: "100%", marginTop: 4, padding: "7px 10px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.16)", color: "#fff" }} />
              </label>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="fp-btn" onClick={() => setFailureModalTarget(null)}>Cancel</button>
                <button type="button" className="fp-btn fp-btn-danger" onClick={handleConfirmFailure}>Failed — Reprint</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Printer Loaded Filament Spool Picker Sheet */}
      {editingPrinter && (
        <div className="fp-modal-backdrop" onClick={() => setEditingPrinterSlotsId(null)}>
          <div className="fp-modal-window" style={{ width: "min(560px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className="fp-modal-header">
              <div>
                <div className="fp-modal-title">{editingPrinter.name} — Loaded Filament Spools</div>
                <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>Click any spool in your Filament Library to load or unload it on {editingPrinter.name}</div>
              </div>
              <button type="button" className="fp-btn fp-btn-sm fp-btn-primary" onClick={() => setEditingPrinterSlotsId(null)}>Done</button>
            </div>
            <div className="fp-modal-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(155px, 1fr))", gap: 8 }}>
              {localFilaments.map((sw) => {
                const loaded = editingPrinter.loaded_slots.some((s) => s.filament_id === sw.id || (s.filament_name === sw.name && s.filament_hex === sw.hex));
                return (
                  <button key={sw.id} type="button" onClick={() => handleTogglePrinterFilamentSlot(editingPrinter, sw)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 10, border: loaded ? "2px solid #38bdf8" : "1px solid rgba(255,255,255,0.12)", background: loaded ? "rgba(56,189,248,0.16)" : "rgba(255,255,255,0.04)", color: "#f8fafc", cursor: "pointer", textAlign: "left" }}>
                    <span style={{ width: 20, height: 20, borderRadius: "50%", background: sw.hex, border: "2px solid rgba(255,255,255,0.8)", flexShrink: 0 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sw.name}</div>
                      <div style={{ fontSize: 10, color: "rgba(235,235,245,0.6)" }}>{sw.brand} · {sw.material}</div>
                    </div>
                    {loaded && <span style={{ color: "#38bdf8", fontWeight: 900 }}>✓</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Add / Manage Printers Modal */}
      {showAddPrinterModal && (
        <div className="fp-modal-backdrop" onClick={() => setShowAddPrinterModal(false)}>
          <div className="fp-modal-window" style={{ width: "min(620px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className="fp-modal-header">
              <div>
                <div className="fp-modal-title">Shop Printers Fleet ({localPrinters.length})</div>
                <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>Add or remove printers on the Printers board (matches Settings → Workflow → Printers)</div>
              </div>
              <button type="button" className="fp-btn fp-btn-sm" onClick={() => setShowAddPrinterModal(false)}>Done</button>
            </div>
            <div className="fp-modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                <label style={{ flex: 1, minWidth: 160, fontSize: 11.5 }}>
                  Printer Name
                  <input type="text" placeholder="e.g. P1S #2 or H2D" value={newPrinterName} onChange={(e) => setNewPrinterName(e.target.value)} style={{ width: "100%", marginTop: 4, padding: "7px 10px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.16)", color: "#fff" }} />
                </label>
                <label style={{ width: 150, fontSize: 11.5 }}>
                  Model
                  <select value={newPrinterModel} onChange={(e) => setNewPrinterModel(e.target.value)} style={{ width: "100%", marginTop: 4, padding: "7px 10px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.16)", color: "#fff" }}>
                    <option value="Bambu H2C">Bambu H2C</option>
                    <option value="Bambu H2D">Bambu H2D</option>
                    <option value="Bambu X1C">Bambu X1C</option>
                    <option value="Bambu P1S">Bambu P1S</option>
                    <option value="Bambu A1">Bambu A1</option>
                    <option value="Bambu A1 Mini">Bambu A1 Mini</option>
                  </select>
                </label>
                <label style={{ width: 90, fontSize: 11.5 }}>
                  Nozzle (mm)
                  <input type="text" value={newPrinterNozzle} onChange={(e) => setNewPrinterNozzle(e.target.value)} style={{ width: "100%", marginTop: 4, padding: "7px 10px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.16)", color: "#fff" }} />
                </label>
                <BedSizeFields
                  bedX={null}
                  bedY={null}
                  onChangeText={(x, y) => setNewPrinterBed({ x, y })}
                  inputStyle={{ padding: "7px 8px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.16)", color: "#fff" }}
                />
                <button type="button" className="fp-btn fp-btn-primary" onClick={handleCreatePrinter}>+ Add Printer</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {localPrinters.map((p) => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderRadius: 10, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}>
                    <div>
                      <div style={{ fontSize: 13.5, fontWeight: 800 }}>{p.name} <span style={{ fontSize: 11.5, color: "rgba(235,235,245,0.55)", fontWeight: 600 }}>({p.model} · {p.nozzle_mm}mm{p.bed_x_mm && p.bed_y_mm ? ` · bed ${p.bed_x_mm}×${p.bed_y_mm}mm` : ""})</span></div>
                      <div style={{ fontSize: 11, color: "rgba(235,235,245,0.6)", marginTop: 2 }}>
                        {p.loaded_slots.length > 0 ? p.loaded_slots.map((s) => s.filament_name).join(" · ") : "No filament loaded"}
                      </div>
                      <div style={{ marginTop: 4 }}>
                        <BedSizeFields
                          bedX={p.bed_x_mm}
                          bedY={p.bed_y_mm}
                          inputStyle={{ padding: "3px 6px", borderRadius: 6, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.16)", color: "#fff" }}
                          onCommit={async (size) => {
                            try {
                              const updated = await invoke<ShopSnapshot>("set_printer_bed_size", { printer_id: p.id, ...size });
                              if (updated?.printers) { setLocalPrinters(updated.printers); onSnapshotUpdated?.(updated); }
                            } catch (e) {
                              notifyError(`Bed size for ${p.name} was not saved`, e);
                            }
                          }}
                        />
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button type="button" className="fp-btn fp-btn-sm" onClick={() => setEditingPrinterSlotsId(p.id)}>🎨 Spools</button>
                      <button type="button" className="fp-btn fp-btn-sm fp-btn-danger" onClick={() => handleRemovePrinter(p.id)}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Filament Library Manager Sheet (FilamentLibraryManagerSheet.swift 1:1) */}
      {showFilamentModal && (
        <FilamentLibrarySheet
          snapshot={snapshot}
          onSnapshot={(s) => {
            setLocalFilaments(s.filaments);
            onSnapshotUpdated?.(s);
          }}
          onClose={() => setShowFilamentModal(false)}
        />
            )}
    </div>
  );
};
