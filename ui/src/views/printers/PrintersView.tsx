import { FilamentLibrarySheet } from "../../components/FilamentLibrarySheet";
import { printerAccent, saveShopSettingsPatch, useShopSettings } from "../../settingsStore";
import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "../../tauriInvoke";
import { FilamentSwatch, Order, OrderLine, PartUnit, Printer, Product, ShopSnapshot } from "../../types";
import { ProductCompositeThumbnail3D } from "../../components/PartThumbnail3D";
import { StatusLegendHeader } from "../OrdersAndonViews";
import { BedSizeFields, parseBedSize } from "../../components/BedSizeFields";
import { FAILURE_REASONS, confirmRemovePrinter, notifyError } from "../../uiFeedback";
import { LANE_COLORS, PartTile64, type PrintersQueueCommonProps, prefersLightOnHex } from "./printersShared";
import { lineForUnit, unitsProductHeading } from "../../orderLabels";
import { groupLaneUnits, laneCountLabel } from "./laneGroups";
import { isThumbnailOnlyPart } from "../../partThumbnails";
import { Check, Circle, CircleDot, Palette, X } from "lucide-react";
import { Icon } from "../../icons";
import { setSlotFilament, slotIdsByPosition, slotsHoldingSwatch, unloadSlot } from "./printerSlots";
import { dryBoxIds, feedersOf, feederPayload, loadIntoFeeders } from "./printerFeeders";
import { type FeederCellRef, FeederBoxes } from "./FeederBoxes";
import { FeederEditor } from "./FeederEditor";
import "./feeders.css";
import { UNASSIGNED_LANE_ID, printerLaneUnits, unassignedLaneUnits } from "./markPrinting";

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
  // In the spool sheet: the feeder slot the next picked swatch goes into (null = next free slot).
  const [pickedCell, setPickedCell] = useState<FeederCellRef | null>(null);
  const [showFeederEditor, setShowFeederEditor] = useState(false);
  useEffect(() => { setPickedCell(null); setShowFeederEditor(false); }, [editingPrinterSlotsId]);
  const [showAddPrinterModal, setShowAddPrinterModal] = useState(false);
  const [newPrinterName, setNewPrinterName] = useState("");
  const [newPrinterModel, setNewPrinterModel] = useState("Bambu P1S");
  const [newPrinterNozzle, setNewPrinterNozzle] = useState("0.4");
  const [newPrinterBed, setNewPrinterBed] = useState<{ x: string; y: string }>({ x: "", y: "" });
  const [showFilamentModal, setShowFilamentModal] = useState(false);

  // "By job" (default) shows each batch exactly as it was sent; "By order" splits lanes by order.
  const settings = useShopSettings();
  const savedBoardView = settings.printers_board_view === "order" ? "order" : "job";
  const [boardView, setBoardView] = useState<"job" | "order">(savedBoardView);
  useEffect(() => { setBoardView(savedBoardView); }, [savedBoardView]);
  const chooseBoardView = (v: "job" | "order") => {
    setBoardView(v);
    saveShopSettingsPatch({ printers_board_view: v }).catch((e) => notifyError("The Printers board view was not saved", e));
  };

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
  // Jobs marked Printing (or Staged) with no printer, or on a printer that was removed,
  // get their own "Unassigned" lane first on the board; it only shows when it has parts.
  const unassignedUnits = useMemo(() => unassignedLaneUnits(allUnits, localPrinters), [allUnits, localPrinters]);
  const lanes = useMemo<Printer[]>(
    () =>
      unassignedUnits.length > 0
        ? [{ id: UNASSIGNED_LANE_ID, name: "Unassigned", model: "No printer", nozzle_mm: 0, status: "", loaded_slots: [], active_units: [], staged_units: [], remaining_minutes: 0, utilization_pct: 0 }, ...localPrinters]
        : localPrinters,
    [unassignedUnits.length, localPrinters]
  );
  const isUnassignedLane = (p: Printer) => p.id === UNASSIGNED_LANE_ID;
  const laneUnitsFor = (p: Printer) => (isUnassignedLane(p) ? unassignedUnits : printerLaneUnits(allUnits, p.id));
  /** The printer id a lane's Done action keeps: none for the Unassigned lane. */
  const lanePrinterId = (p: Printer) => (isUnassignedLane(p) ? null : p.id);
  const UNASSIGNED_ACCENT = "#64748b";
  const activeJobsCount = useMemo(() => allUnits.filter((u) => u.state === "Printing" || u.state === "Staged").length, [allUnits]);

  const handleConfirmFailure = () => {
    if (!failureModalTarget) return;
    onTransition({
      unit_ids: failureModalTarget.unitIds,
      to_state: "Queued",
      printer_id: null,
      actor_device: "Mac Studio (FarmPrint)",
      source_surface: "Printers",
      action_label: `Failed (${failureReason}): ${failureModalTarget.label}`,
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

  // Slots are positions, not a set of colors: the same spool color can be loaded in
  // several slots, and unloading one slot leaves the others on their own numbers.
  const savePrinterFilamentSlots = async (printer: Printer, filamentIds: string[]) => {
    try {
      const updated = await invoke<ShopSnapshot>("set_printer_filament_slots", { printerId: printer.id, filamentIds });
      if (updated?.printers) { setLocalPrinters(updated.printers); onSnapshotUpdated?.(updated); }
    } catch (e) {
      notifyError(`${printer.name}'s filament slots were not saved`, e);
    }
  };
  const applySnapshot = (updated?: ShopSnapshot) => {
    if (updated?.printers) { setLocalPrinters(updated.printers); onSnapshotUpdated?.(updated); }
  };
  const saveDryBox = async (printer: Printer, feederId: string, filamentIds: string[]) => {
    try {
      applySnapshot(await invoke<ShopSnapshot>("set_dry_box_spools", { feeder_id: feederId, filament_ids: filamentIds }));
    } catch (e) {
      notifyError(`${printer.name}'s dry box was not saved`, e);
    }
  };
  const saveFeeders = async (printer: Printer, feeders: ReturnType<typeof feederPayload>) => {
    try {
      applySnapshot(await invoke<ShopSnapshot>("set_printer_feeders", { printer_id: printer.id, feeders }));
    } catch (e) {
      notifyError(`${printer.name}'s feeders were not saved`, e);
    }
  };
  // A picked feeder slot takes the swatch; otherwise it goes in the first free feeding slot.
  const handleLoadPrinterFilamentSlot = (printer: Printer, swatch: FilamentSwatch) => {
    const feeders = feedersOf(printer);
    const ids = slotIdsByPosition(printer.loaded_slots);
    const target = pickedCell ? feeders.find((f) => f.id === pickedCell.feederId) : undefined;
    if (target && pickedCell) {
      setPickedCell(null);
      if (target.is_dry_box) return saveDryBox(printer, target.id, setSlotFilament(dryBoxIds(target), pickedCell.position, swatch.id));
      return savePrinterFilamentSlots(printer, setSlotFilament(ids, (target.first_slot ?? 1) + pickedCell.position - 1, swatch.id));
    }
    const next = loadIntoFeeders(ids, feeders, swatch.id);
    if (!next) {
      notifyError(`${swatch.name} was not loaded`, `Every feeder slot on ${printer.name} is full. Pick a slot to replace, or add a feeder.`);
      return;
    }
    return savePrinterFilamentSlots(printer, next);
  };
  const handleUnloadPicked = (printer: Printer) => {
    const target = pickedCell ? feedersOf(printer).find((f) => f.id === pickedCell.feederId) : undefined;
    if (!target || !pickedCell) return;
    setPickedCell(null);
    if (target.is_dry_box) return saveDryBox(printer, target.id, unloadSlot(dryBoxIds(target), pickedCell.position));
    return savePrinterFilamentSlots(printer, unloadSlot(slotIdsByPosition(printer.loaded_slots), (target.first_slot ?? 1) + pickedCell.position - 1));
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
          <Icon icon={Palette} /> Filament Library ({localFilaments.length})
        </button>
        <button type="button" className="fp-btn fp-btn-sm fp-btn-primary" onClick={() => setShowAddPrinterModal(true)}>
          + Add Printer
        </button>
        {/* In Wall TV the auto-hiding controls in TopHeader are the only ones shown. */}
        {!wallMode && (
          <div className="fp-mode-toggle">
            <button type="button" className="fp-mode-btn active" onClick={() => setWallMode(false)}>Work</button>
            <button type="button" className="fp-mode-btn" onClick={() => setWallMode(true)}>Wall TV</button>
          </div>
        )}
        {!wallMode && (
          <div className="fp-mode-toggle" role="group" aria-label="Group printer jobs">
            <button type="button" className={`fp-mode-btn ${boardView === "job" ? "active" : ""}`} title="Show each batch exactly as it was sent, even when it has parts from several orders" onClick={() => chooseBoardView("job")}>By job</button>
            <button type="button" className={`fp-mode-btn ${boardView === "order" ? "active" : ""}`} title="Split each printer's parts by order" onClick={() => chooseBoardView("order")}>By order</button>
          </div>
        )}
        <div style={{ flex: 1 }} />
        <span className="fp-badge fp-badge-blue">Printers: {localPrinters.length} machines</span>
        <span className="fp-badge fp-badge-green">Active: {activeJobsCount} parts</span>
      </div>
      {!wallMode && <StatusLegendHeader />}

      {wallMode ? (
        <div className="fp-scroll" style={{ flex: 1, padding: "14px 18px 88px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 16, alignContent: "start" }}>
          {lanes.map((printer, idx) => {
            const accent = isUnassignedLane(printer) ? UNASSIGNED_ACCENT : printerAccent(printer.id) || printer.loaded_slots[0]?.filament_hex || LANE_COLORS[idx % LANE_COLORS.length];
            const laneUnits = laneUnitsFor(printer);
            const isPrinting = laneUnits.some((u) => u.state === "Printing");
            const totalMins = laneUnits.reduce((acc, u) => acc + (u.print_minutes || 0), 0);
            const customerNames = Array.from(new Set(laneUnits.map((u) => orderById.get(u.order_id)?.customer_name || u.customer_name))).join(" · ");
            const productLabel = unitsProductHeading(laneUnits) || "Idle — Ready for next plate";
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
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <Icon icon={isPrinting ? Circle : laneUnits.length > 0 ? CircleDot : Circle} size={18} strokeWidth={2.5} fill={isPrinting ? "currentColor" : "none"} />
                        {isPrinting ? `PRINTING (${laneUnits.length} parts)` : laneUnits.length > 0 ? `STAGED (${laneUnits.length} parts)` : "IDLE"}
                      </span>
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
                    {!isUnassignedLane(printer) && <FeederBoxes feeders={feedersOf(printer)} variant="wall" />}
                  </div>
                </div>
                {laneUnits.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, justifyContent: "center" }} onClick={(e) => e.stopPropagation()}>
                    <button type="button" title="Mark whole job done" onClick={() => onTransition({ unit_ids: laneUnits.map((u) => u.id), to_state: "Printed", printer_id: lanePrinterId(printer), actor_device: "Mac Studio (FarmPrint)", source_surface: "Printers Wall TV", action_label: `Plate done on ${printer.name}`, failure_reason: null, failure_note: null })} style={{ width: 54, height: 54, borderRadius: 14, border: "2px solid #30d158", background: "rgba(48,209,88,0.22)", color: "#30d158", fontSize: 24, fontWeight: 900, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Icon icon={Check} size={28} strokeWidth={3} /></button>
                    <button type="button" title="Mark whole job failed" onClick={() => setFailureModalTarget({ unitIds: laneUnits.map((u) => u.id), label: `All jobs on ${printer.name}` })} style={{ width: 54, height: 54, borderRadius: 14, border: "2px solid #ff453a", background: "rgba(255,69,58,0.22)", color: "#ff6961", fontSize: 24, fontWeight: 900, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Icon icon={X} size={28} strokeWidth={3} /></button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", gap: 12, overflowX: "auto", overflowY: "hidden", padding: "8px 18px 88px" }}>
          {lanes.map((printer, idx) => {
            const accent = isUnassignedLane(printer) ? UNASSIGNED_ACCENT : printerAccent(printer.id) || printer.loaded_slots[0]?.filament_hex || LANE_COLORS[idx % LANE_COLORS.length];
            const laneUnits = laneUnitsFor(printer);
            const slices = groupLaneUnits(laneUnits, boardView);
            const lightText = prefersLightOnHex(accent);
            return (
              <div key={printer.id} style={{ width: 282, flexShrink: 0, display: "flex", flexDirection: "column", borderRadius: 14, background: "rgba(22,27,38,0.92)", border: "1px solid rgba(255,255,255,0.1)", overflow: "hidden" }}>
                <div style={{ background: accent, color: lightText ? "#fff" : "#111", padding: "8px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{printer.name}</div>
                    <div style={{ fontSize: 11, opacity: 0.84 }}>{laneCountLabel(slices, boardView)} · {laneUnits.length} parts · {laneUnits.some((u) => u.state === "Printing") ? "Printing" : "Idle"}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                    {!isUnassignedLane(printer) && <button type="button" title={`Set loaded filament spools on ${printer.name}`} onClick={() => setEditingPrinterSlotsId(printer.id)} style={{ width: 24, height: 24, borderRadius: "50%", border: "none", background: "rgba(0,0,0,0.26)", color: "#fff", cursor: "pointer", fontSize: 12, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0 }}><Icon icon={Palette} size={14} /></button>}
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: "rgba(0,0,0,0.22)", color: "#fff" }}>{printer.model}</span>
                  </div>
                </div>
                {isUnassignedLane(printer) ? (
                  <div style={{ padding: "6px 8px", fontSize: 11, color: "rgba(235,235,245,0.6)", background: "rgba(255,255,255,0.04)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                    Marked Printing with no printer · use Assign to pick one
                  </div>
                ) : (
                <div onClick={() => setEditingPrinterSlotsId(printer.id)} title="Click to change loaded filament spools and feeders" style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", background: "rgba(255,255,255,0.04)", borderBottom: "1px solid rgba(255,255,255,0.06)", overflowX: "auto", cursor: "pointer" }}>
                  <FeederBoxes feeders={feedersOf(printer)} variant="lane" />
                  {feedersOf(printer).every((f) => f.spools.length === 0) && (
                    <span style={{ fontSize: 11, color: "rgba(235,235,245,0.55)", whiteSpace: "nowrap" }}>Tap to load spools</span>
                  )}
                </div>
                )}
                <div style={{ flex: 1, overflowY: "auto", padding: 9, display: "flex", flexDirection: "column", gap: 8 }}>
                  {slices.length === 0 ? (
                    <div style={{ textAlign: "center", fontSize: 12, color: "rgba(235,235,245,0.45)", paddingTop: 18 }}>Idle</div>
                  ) : (
                    slices.map(({ key, kind, units }) => {
                      const first = units[0];
                      const orderIds = Array.from(new Set(units.map((u) => u.order_id)));
                      // One order in the group: that order's picture and name, as before.
                      const ord = orderIds.length === 1 ? orderById.get(orderIds[0]) : undefined;
                      const line = first && ord ? lineForUnit(ord, first) : undefined;
                      const totalMins = units.reduce((acc, u) => acc + (u.print_minutes || 0), 0);
                      const customerOf = (u: PartUnit) => orderById.get(u.order_id)?.customer_name || u.customer_name || u.order_code;
                      const customers = Array.from(new Set(units.map(customerOf)));
                      const filaments = Array.from(new Set(units.map((u) => u.filament_name).filter(Boolean)));
                      const title =
                        kind === "loose" ? "Loose parts"
                          : orderIds.length === 1 ? (ord?.customer_name || first.customer_name || first.order_code)
                          : `Job · ${orderIds.length} orders`;
                      const subtitle = kind === "order" || orderIds.length === 1
                        ? `${first.filament_name} · ×${units.length}`
                        : `${customers.join(" · ")} · ×${units.length}`;
                      const groupLabel = kind === "order" || (kind === "job" && orderIds.length === 1)
                        ? (ord?.customer_name || first.order_code)
                        : kind === "loose" ? "Loose parts" : `Job (${orderIds.length} orders)`;
                      const tooltip = kind === "loose"
                        ? "These parts weren't sent as one job (for example older parts), so they're listed together here."
                        : kind === "job" ? `Sent as one job · ${customers.join(", ")}${filaments.length ? ` · ${filaments.join(", ")}` : ""}` : undefined;
                      return (
                        <div key={key} title={tooltip} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 11, padding: 8, display: "flex", flexDirection: "column", gap: 7 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            {renderSliceComposite40(ord, line, first)}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
                              <div style={{ fontSize: 11, color: "rgba(235,235,245,0.62)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{subtitle}</div>
                              <div style={{ fontSize: 10.5, fontWeight: 600, color: "#64d2ff" }}>{units.some((u) => u.state === "Printing") ? `Printing ~${Math.max(1, Math.round(totalMins / 60))}h` : "Staged on plate"}</div>
                            </div>
                            <div style={{ display: "flex", gap: 3 }}>
                              <button type="button" className="fp-btn fp-btn-sm fp-btn-success" style={{ padding: "2px 6px" }} title="Mark plate done" onClick={() => onTransition({ unit_ids: units.map((u) => u.id), to_state: "Printed", printer_id: lanePrinterId(printer), actor_device: "Mac Studio (FarmPrint)", source_surface: "Printers", action_label: `Done: ${groupLabel}`, failure_reason: null, failure_note: null })}><Icon icon={Check} size={14} /></button>
                              <button type="button" className="fp-btn fp-btn-sm fp-btn-danger" style={{ padding: "2px 6px" }} title="Mark plate failed" onClick={() => setFailureModalTarget({ unitIds: units.map((u) => u.id), label: `${groupLabel} on ${printer.name}` })}><Icon icon={X} size={14} /></button>
                            </div>
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {units.map((u) => <PartTile64 key={u.id} unit={u} order={orderById.get(u.order_id)} onTransition={onTransition} onSelectUnit={onSelectUnit} sourceSurface="Printers" onRequestFailureReason={(ids, lbl) => setFailureModalTarget({ unitIds: ids, label: lbl })} />)}
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 4, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                            <select aria-label={isUnassignedLane(printer) ? "Assign job to a printer" : "Move job"} value="" onChange={(e) => e.target.value && onTransition({ unit_ids: units.map((u) => u.id), to_state: "Printing", printer_id: e.target.value, actor_device: "Mac Studio (FarmPrint)", source_surface: "Printers", action_label: "Moved job to printer", failure_reason: null, failure_note: null }, { markPrinting: isUnassignedLane(printer) })} style={{ background: "rgba(255,255,255,0.06)", color: "#e2e8f0", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, fontSize: 10.5, padding: "2px 6px" }}>
                              <option value="">{isUnassignedLane(printer) ? "Assign…" : "Move…"}</option>
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
          <div className="fp-modal-window" style={{ width: "min(700px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className="fp-modal-header">
              <div>
                <div className="fp-modal-title">{editingPrinter.name} — Loaded Filament Spools</div>
                <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>Click a spool to load it into the next free slot on {editingPrinter.name}, or pick a slot in a feeder first. Click it again to load the same color into another slot.</div>
              </div>
              <button type="button" className="fp-btn fp-btn-sm fp-btn-primary" onClick={() => setEditingPrinterSlotsId(null)}>Done</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 16px 0" }} aria-label={`Feeders on ${editingPrinter.name}`}>
              <FeederBoxes
                feeders={feedersOf(editingPrinter)}
                variant="sheet"
                selected={pickedCell}
                onCellClick={(f, c) =>
                  setPickedCell((cur) => (cur && cur.feederId === f.id && cur.position === c.position ? null : { feederId: f.id, position: c.position }))
                }
              />
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11.5, color: "rgba(235,235,245,0.65)" }}>
                {(() => {
                  const f = pickedCell ? feedersOf(editingPrinter).find((x) => x.id === pickedCell.feederId) : undefined;
                  if (!f || !pickedCell) return <span>Pick a swatch below to load it into the next free slot, or pick a slot above first.</span>;
                  const where = f.is_dry_box ? `${f.name} · spot ${pickedCell.position}` : `Slot ${(f.first_slot ?? 1) + pickedCell.position - 1} (${f.name})`;
                  const filled = f.spools.some((s) => s.slot_index === (f.is_dry_box ? pickedCell.position : (f.first_slot ?? 1) + pickedCell.position - 1));
                  return (
                    <>
                      <span>Next swatch goes in <b>{where}</b>.</span>
                      {filled && <button type="button" className="fp-btn fp-btn-sm" onClick={() => void handleUnloadPicked(editingPrinter)}>Unload {where}</button>}
                    </>
                  );
                })()}
                <div style={{ flex: 1 }} />
                <button type="button" className="fp-btn fp-btn-sm" aria-expanded={showFeederEditor} onClick={() => setShowFeederEditor((v) => !v)}>
                  {showFeederEditor ? "Hide feeders" : "Edit feeders…"}
                </button>
              </div>
              {showFeederEditor && (
                <div style={{ padding: 10, borderRadius: 10, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.03)" }}>
                  <FeederEditor printerName={editingPrinter.name} feeders={feedersOf(editingPrinter)} onSave={(f) => saveFeeders(editingPrinter, f)} />
                </div>
              )}
            </div>
            <div className="fp-modal-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(155px, 1fr))", gap: 8 }}>
              {localFilaments.map((sw) => {
                const inSlots = slotsHoldingSwatch(editingPrinter.loaded_slots, sw);
                const loaded = inSlots.length > 0;
                return (
                  <button key={sw.id} type="button" title={loaded ? `In slot ${inSlots.join(", ")}. Click to load it into another slot.` : `Load into the next free slot`} onClick={() => handleLoadPrinterFilamentSlot(editingPrinter, sw)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 10, border: loaded ? "2px solid #38bdf8" : "1px solid rgba(255,255,255,0.12)", background: loaded ? "rgba(56,189,248,0.16)" : "rgba(255,255,255,0.04)", color: "#f8fafc", cursor: "pointer", textAlign: "left" }}>
                    <span style={{ width: 20, height: 20, borderRadius: "50%", background: sw.hex, border: "2px solid rgba(255,255,255,0.8)", flexShrink: 0 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sw.name}</div>
                      <div style={{ fontSize: 10, color: "rgba(235,235,245,0.6)" }}>{sw.brand} · {sw.material}</div>
                    </div>
                    {loaded && (
                      <span style={{ color: "#38bdf8", display: "inline-flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 800 }}>
                        <Icon icon={Check} size={16} strokeWidth={3} />
                        {inSlots.length > 1 && <span>×{inSlots.length}</span>}
                      </span>
                    )}
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
                      <button type="button" className="fp-btn fp-btn-sm" onClick={() => setEditingPrinterSlotsId(p.id)}><Icon icon={Palette} /> Spools</button>
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
