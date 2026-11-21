import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../../tauriInvoke";
import { Order, OverstockItem, PartUnit, Product, ShopSnapshot } from "../../types";
import { ProductCompositeThumbnail3D } from "../../components/PartThumbnail3D";
import { StatusLegendHeader } from "../OrdersAndonViews";
import { csvText, notifyBanner, notifyError, saveTextFile } from "../../uiFeedback";
import { PartTile64, type PrintersQueueCommonProps, type SuggestedPrintGroup, isPrinterReadyFirst, prefersLightOnHex } from "./printersShared";
import { isThumbnailOnlyPart } from "../../partThumbnails";
import { useShopSettings } from "../../settingsStore";
import { modKey, osKind } from "../../platform";
import { isTypingTarget } from "../../uiFeedback";
import {
  groupState,
  isToggleClick,
  pruneSelection,
  selectRange,
  selectedInOrder,
  selectionSummary,
  toggleGroup,
  toggleUnit,
  type Selection,
} from "./partSelection";
import { CirclePlay, Package, Printer } from "lucide-react";
import { Icon } from "../../icons";

/** Header checkbox for a group: checked, unchecked, or mixed when only some are selected. */
const GroupCheck: React.FC<{ sel: Selection; ids: string[]; label: string; onToggle: () => void }> = ({
  sel,
  ids,
  label,
  onToggle,
}) => {
  const ref = useRef<HTMLInputElement | null>(null);
  const state = groupState(sel, ids);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      title={label}
      checked={state === "all"}
      aria-checked={state === "some" ? "mixed" : state === "all"}
      onChange={onToggle}
      onClick={(e) => e.stopPropagation()}
      style={{ width: 16, height: 16, margin: 0, flexShrink: 0, cursor: "pointer", accentColor: "#0a84ff" }}
    />
  );
};

export const PartsToPrintView: React.FC<PrintersQueueCommonProps> = ({
  snapshot,
  onTransition,
  onSelectUnit,
  onSnapshotUpdated,
  showSuggestedGroups = false,
  onToggleSuggestedGroups,
}) => {
  // Off by default: FarmPrint doesn't pick a printer; Settings › Printers › "Suggest a printer" turns the hint on.
  const suggestPrinter = !!useShopSettings().suggest_printer;
  const [localOpen, setLocalOpen] = useState(false);
  const [productFilter, setProductFilter] = useState<string>("ALL");
  const [sortMode, setSortMode] = useState<"color" | "order">("order");
  const isOpen = showSuggestedGroups || localOpen;
  const setOpen = (v: boolean) => {
    setLocalOpen(v);
    onToggleSuggestedGroups?.(v);
  };

  const productById = useMemo(
    () => new Map<string, Product>(snapshot.products.map((p) => [p.id, p])),
    [snapshot.products]
  );
  const allUnits = useMemo(
    () =>
      snapshot.orders
        .flatMap((o) => o.lines.flatMap((l) => l.units))
        .filter((u) => !isThumbnailOnlyPart(u.part_name, productById.get(u.product_id))),
    [snapshot.orders, productById]
  );
  const waitingUnits = useMemo(
    () =>
      allUnits.filter(
        (u) =>
          (u.state === "Queued" || u.state === "Staged") &&
          (productFilter === "ALL" || u.product_id === productFilter)
      ),
    [allUnits, productFilter]
  );
  const orderById = useMemo(
    () => new Map<string, Order>(snapshot.orders.map((o) => [o.id, o])),
    [snapshot.orders]
  );
  // Only used for the optional suggestion hint: among printers that already have the
  // group's filament loaded, an idle one comes first.
  const readyPrinters = useMemo(
    () =>
      suggestPrinter
        ? [...snapshot.printers].sort(
            (a, b) =>
              isPrinterReadyFirst(a, allUnits) - isPrinterReadyFirst(b, allUnits) ||
              a.name.localeCompare(b.name)
          )
        : [],
    [suggestPrinter, snapshot.printers, allUnits]
  );

  const findOverstockMatch = (u: PartUnit): OverstockItem | undefined =>
    snapshot.overstock.find(
      (ov) =>
        ov.quantity > 0 &&
        ov.product_id === u.product_id &&
        ov.part_name.toLowerCase() === u.part_name.toLowerCase() &&
        ov.filament_name.toLowerCase() === u.filament_name.toLowerCase()
    );

  const handlePullFromOverstock = async (ov: OverstockItem, unit: PartUnit) => {
    const next = await invoke<ShopSnapshot>("pull_from_overstock", {
      overstockId: ov.id,
      unitId: unit.id,
    });
    onSnapshotUpdated?.(next);
  };

  const handleExportQueueCsv = async () => {
    const csv = csvText([
      ["Order Code", "Customer", "Product", "Part", "Filament", "State", "Est Minutes"],
      ...waitingUnits.map((u) => [
        u.order_code,
        u.customer_name || "",
        u.product_name,
        u.part_name,
        u.filament_name,
        u.state,
        u.print_minutes,
      ]),
    ]);
    try {
      const path = await saveTextFile("FarmPrint-PartsToPrint.csv", csv);
      if (path) notifyBanner(`Saved ${waitingUnits.length} parts to ${path}`);
    } catch (e) {
      notifyError("The CSV was not saved", e);
    }
  };

  const colorGroups: SuggestedPrintGroup[] = useMemo(() => {
    const map = new Map<string, SuggestedPrintGroup>();
    for (const u of waitingUnits) {
      const key = `${u.product_id}::${u.filament_name}::${u.filament_hex}`;
      const ord = orderById.get(u.order_id);
      const cust = ord?.customer_name || u.customer_name || u.order_code;
      const code = ord?.order_code || u.order_code;
      const ex = map.get(key);
      if (ex) {
        ex.units.push(u);
        if (!ex.customerNames.includes(cust)) ex.customerNames.push(cust);
        if (!ex.orderCodes.includes(code)) ex.orderCodes.push(code);
      } else {
        // A suggestion only when a printer really has this filament loaded; never a
        // fallback to "the first printer". Empty when suggestions are off.
        const matched = readyPrinters.find((p) =>
          p.loaded_slots.some(
            (s) => s.filament_name.toLowerCase() === u.filament_name.toLowerCase()
          )
        );
        map.set(key, {
          key,
          filamentName: u.filament_name,
          filamentHex: u.filament_hex,
          material: u.filament_material || "PLA",
          productId: u.product_id,
          productName: u.product_name,
          units: [u],
          customerNames: [cust],
          orderCodes: [code],
          suggestedPrinter: matched,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.units.length - a.units.length);
  }, [waitingUnits, orderById, readyPrinters]);

  const distinctColors = useMemo(
    () => new Set(waitingUnits.map((u) => u.filament_name)).size,
    [waitingUnits]
  );

  // By Order view: each order with waiting parts, its parts shown in tile order.
  const orderGroups = useMemo(
    () =>
      snapshot.orders
        .map((ord) => {
          const allOrdUnits = ord.lines
            .flatMap((l) => l.units)
            .filter((u) => !isThumbnailOnlyPart(u.part_name, productById.get(u.product_id)));
          const ordUnits = allOrdUnits.filter(
            (u) =>
              (u.state === "Queued" || u.state === "Staged") &&
              (productFilter === "ALL" || u.product_id === productFilter)
          );
          return { ord, allOrdUnits, ordUnits };
        })
        .filter((g) => g.ordUnits.length > 0),
    [snapshot.orders, productById, productFilter]
  );

  // --- Multi-select: pick single parts from any order or color and send them as one job.
  const [selected, setSelected] = useState<Selection>(() => new Set<string>());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  // Tiles in the order they are shown, for Shift-click ranges across groups.
  const shownUnits = useMemo(
    () => (sortMode === "color" ? colorGroups.flatMap((g) => g.units) : orderGroups.flatMap((g) => g.ordUnits)),
    [sortMode, colorGroups, orderGroups]
  );
  const shownIds = useMemo(() => shownUnits.map((u) => u.id), [shownUnits]);
  const waitingIdSet = useMemo(() => new Set(waitingUnits.map((u) => u.id)), [waitingUnits]);
  // Parts that stop waiting (sent to a printer, removed, filtered out) leave the
  // selection, which is how it clears after a send. A cancelled printer pick keeps it.
  useEffect(() => {
    setSelected((s) => pruneSelection(s, waitingIdSet));
  }, [waitingIdSet]);
  const clearSelection = () => {
    setSelected(new Set<string>());
    setAnchorId(null);
  };
  const selectedUnits = useMemo(() => selectedInOrder(selected, shownUnits), [selected, shownUnits]);
  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A dialog (the printer picker, a part menu) or a text field gets Esc first.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], .fp-modal-backdrop')) return;
      if (isTypingTarget(e.target)) return;
      setSelected(new Set<string>());
      setAnchorId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size]);
  const mac = osKind() === "mac";
  const rangeOrToggle = (u: PartUnit, shift: boolean) => {
    setSelected((s) => (shift ? selectRange(s, shownIds, anchorId, u.id) : toggleUnit(s, u.id)));
    setAnchorId(u.id);
  };
  const selectProps = (u: PartUnit) => ({
    selected: selected.has(u.id),
    onCheckClick: (e: React.MouseEvent) => rangeOrToggle(u, e.shiftKey),
    onSelectClick: (e: React.MouseEvent) => {
      if (e.shiftKey || isToggleClick(e, mac)) {
        rangeOrToggle(u, e.shiftKey);
        return true;
      }
      return false;
    },
  });
  const groupToggle = (ids: string[]) => () => setSelected((s) => toggleGroup(s, ids));
  // Mark Printing = Print! without the plate and slicer: same picker, same one job.
  const sendSelection = (markPrinting = false) => {
    const units = selectedUnits;
    if (units.length === 0) return;
    // One request, so every part shares one plate job and one plate in the slicer.
    // No printer is preset: the picker always asks.
    onTransition(
      {
        unit_ids: units.map((u) => u.id),
        to_state: "Printing",
        printer_id: null,
        actor_device: "Mac Studio (FarmPrint)",
        source_surface: "Parts to Print (selection)",
        action_label: `Print ${units.length} selected part${units.length === 1 ? "" : "s"}`,
        failure_reason: null,
        failure_note: null,
      },
      { markPrinting }
    );
  };

  const sendOrder = (units: PartUnit[], customer: string, markPrinting: boolean) =>
    onTransition(
      {
        unit_ids: units.map((u) => u.id),
        to_state: "Printing",
        printer_id: null,
        actor_device: "Mac Studio (FarmPrint)",
        source_surface: "Parts to Print",
        action_label: `Print Order ${customer}`,
        failure_reason: null,
        failure_note: null,
      },
      { markPrinting }
    );

  const renderColorCard = (
    grp: SuggestedPrintGroup,
    surface: string,
    closeOnPrint = false
  ) => {
    const lightText = prefersLightOnHex(grp.filamentHex);
    const ovMatch = findOverstockMatch(grp.units[0]);
    // The hint shows inside Suggested Groups only, and only when the setting is on.
    const hint = surface === "Suggested Groups" ? grp.suggestedPrinter : undefined;
    // Multi-select lives on the page itself, not in the Suggested Groups window.
    const selectable = !closeOnPrint;
    // No printer is preselected unless the user turned the suggestion on;
    // the "which printer?" picker always asks before anything is sent.
    const sendGroup = (markPrinting: boolean) =>
      onTransition(
        {
          unit_ids: grp.units.map((u) => u.id),
          to_state: "Printing",
          printer_id: hint?.id || null,
          actor_device: "Mac Studio (FarmPrint)",
          source_surface: surface,
          action_label: `Print ${grp.units.length} ${grp.filamentName}`,
          failure_reason: null,
          failure_note: null,
        },
        { markPrinting }
      );
    return (
      <div
        key={grp.key}
        style={{
          background: "rgba(22,27,38,0.94)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 14,
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div
          style={{
            background: grp.filamentHex,
            color: lightText ? "#fff" : "#111",
            borderRadius: 10,
            padding: "8px 12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          {selectable && (
            <GroupCheck
              sel={selected}
              ids={grp.units.map((u) => u.id)}
              label={`Select all ${grp.units.length} ${grp.filamentName} parts`}
              onToggle={groupToggle(grp.units.map((u) => u.id))}
            />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 13.5,
                fontWeight: 800,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {grp.filamentName}
            </div>
            <div
              style={{
                fontSize: 10.5,
                opacity: 0.86,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {grp.productName}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {ovMatch && (
              <button
                type="button"
                title={`Pull 1 from Overstock (${ovMatch.quantity} available)`}
                onClick={() => handlePullFromOverstock(ovMatch, grp.units[0])}
                style={{
                  padding: "3px 9px",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.75)",
                  background: "rgba(48,209,88,0.88)",
                  color: "#fff",
                  fontSize: 10.5,
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                <Icon icon={Package} size={12} /> {ovMatch.quantity} in stock · Pull
              </button>
            )}
            <span
              style={{
                padding: "2px 8px",
                borderRadius: 999,
                background: "rgba(0,0,0,0.28)",
                color: "#fff",
                fontSize: 11,
                fontWeight: 800,
              }}
            >
              {grp.units.length}
            </span>
            <button
              type="button"
              aria-label={`Mark ${grp.units.length} ${grp.filamentName} parts Printing without the slicer`}
              title="Mark Printing: move these parts to Printing without opening the slicer"
              onClick={() => {
                sendGroup(true);
                if (closeOnPrint) setOpen(false);
              }}
              style={{
                padding: "3px 8px",
                borderRadius: 999,
                border: "1.5px solid rgba(255,255,255,0.85)",
                background: "rgba(0,0,0,0.5)",
                color: "#fff",
                fontSize: 11.5,
                fontWeight: 800,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <Icon icon={CirclePlay} size={13} /> Mark
            </button>
            <button
              type="button"
              onClick={() => {
                sendGroup(false);
                if (closeOnPrint) setOpen(false);
              }}
              style={{
                padding: "4px 12px",
                borderRadius: 999,
                border: "1.5px solid rgba(255,255,255,0.85)",
                background: "rgba(0,0,0,0.82)",
                color: "#fff",
                fontSize: 11.5,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Send…
            </button>
          </div>
        </div>
        {hint && (
          <div
            title={`${hint.name} has ${grp.filamentName} loaded. You still choose the printer when you send.`}
            style={{ fontSize: 10.5, color: "rgba(235,235,245,0.5)", padding: "0 4px" }}
          >
            Suggestion: {hint.name} has this filament loaded
          </div>
        )}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            padding: "2px 4px 4px",
          }}
        >
          {grp.units.map((u) => (
            <PartTile64
              key={u.id}
              unit={u}
              order={orderById.get(u.order_id)}
              onTransition={onTransition}
              onSelectUnit={onSelectUnit}
              sourceSurface={surface}
              showOutcomeButtons={false}
              thumbSize={76}
              {...(selectable ? selectProps(u) : {})}
            />
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="fp-scroll">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 6,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 17, fontWeight: 800 }}>Parts to Print</div>
          <div style={{ fontSize: 12, color: "rgba(235,235,245,0.62)" }}>
            {waitingUnits.length} part(s) across {distinctColors} color(s) left to print · {modKey()}-click parts to
            pick them from any order or color, Shift-click for a range
          </div>
        </div>
        <select
          value={productFilter}
          onChange={(e) => setProductFilter(e.target.value)}
          style={{
            background: "rgba(255,255,255,0.06)",
            color: "#f8fafc",
            border: "1px solid rgba(255,255,255,0.14)",
            borderRadius: 8,
            padding: "5px 10px",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <option value="ALL">All Products</option>
          {snapshot.products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="fp-mode-toggle">
          <button
            type="button"
            className={`fp-mode-btn ${sortMode === "order" ? "active" : ""}`}
            onClick={() => setSortMode("order")}
          >
            By Order
          </button>
          <button
            type="button"
            className={`fp-mode-btn ${sortMode === "color" ? "active" : ""}`}
            onClick={() => setSortMode("color")}
          >
            By Color
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <button type="button" className="fp-btn fp-btn-sm" onClick={handleExportQueueCsv}>
          Export CSV
        </button>
        <button
          type="button"
          className="fp-btn fp-btn-primary"
          onClick={() => setOpen(true)}
        >
          <Icon icon={Printer} /> Print… ({colorGroups.length} Suggested Groups)
        </button>
      </div>
      <StatusLegendHeader />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          gap: 12,
          marginTop: 8,
        }}
      >
        {sortMode === "color"
          ? colorGroups.map((grp) => renderColorCard(grp, "Parts to Print"))
          : orderGroups.map(({ ord, allOrdUnits, ordUnits }) => {
                const line = ord.lines[0];
                const prod = snapshot.products.find((p) => p.id === line?.product_id);
                const compositeParts =
                  prod?.parts.map((pt) => ({
                    partName: pt.name,
                    colorHex:
                      line?.units.find(
                        (u) => u.part_id === pt.id || u.part_name === pt.name
                      )?.filament_hex ||
                      snapshot?.filaments.find((f) => f.id === pt.default_filament_id)?.hex ||
                      "#1B1D21",
                    visible: true,
                  })) ||
                  allOrdUnits.map((u) => ({
                    partName: u.part_name,
                    colorHex: u.filament_hex,
                    visible: true,
                  }));
                return (
                  <div
                    key={ord.id}
                    style={{
                      background: "rgba(22,27,38,0.94)",
                      border: "1px solid rgba(255,255,255,0.12)",
                      borderRadius: 14,
                      padding: 12,
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <GroupCheck
                        sel={selected}
                        ids={ordUnits.map((u) => u.id)}
                        label={`Select all ${ordUnits.length} waiting parts for ${ord.customer_name}`}
                        onToggle={groupToggle(ordUnits.map((u) => u.id))}
                      />
                      <ProductCompositeThumbnail3D
                        productName={line?.product_name || ord.customer_name}
                        parts={compositeParts}
                        size={84}
                        inscriptionText={line?.custom_text}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            flexWrap: "wrap",
                          }}
                        >
                          <span style={{ fontSize: 15, fontWeight: 800 }}>
                            {ord.customer_name}
                          </span>
                          <span
                            style={{
                              fontSize: 11.5,
                              color: "rgba(235,235,245,0.55)",
                            }}
                          >
                            {ord.order_code}
                          </span>
                          {ord.is_rush && (
                            <span className="fp-badge fp-badge-red">RUSH</span>
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: 12.5,
                            fontWeight: 700,
                            color: "#e2e8f0",
                            marginTop: 2,
                          }}
                        >
                          {line?.product_name}{" "}
                          {line?.quantity && line.quantity > 1 ? `×${line.quantity}` : ""}
                        </div>
                        {line?.custom_text && (
                          <div
                            style={{
                              fontSize: 11,
                              color: "#38bdf8",
                              fontWeight: 600,
                              marginTop: 2,
                            }}
                          >
                            “{line.custom_text}”
                          </div>
                        )}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            marginTop: 6,
                            flexWrap: "wrap",
                          }}
                        >
                          <span className="fp-badge fp-badge-blue">
                            {ordUnits.length} of {allOrdUnits.length} parts waiting
                          </span>
                          <button
                            type="button"
                            className="fp-btn fp-btn-sm fp-btn-primary"
                            onClick={() => sendOrder(ordUnits, ord.customer_name, false)}
                          >
                            Print Order…
                          </button>
                          <button
                            type="button"
                            className="fp-btn fp-btn-sm"
                            title="Mark Printing: move this order's waiting parts to Printing without opening the slicer"
                            onClick={() => sendOrder(ordUnits, ord.customer_name, true)}
                          >
                            <Icon icon={CirclePlay} size={14} /> Mark Printing…
                          </button>
                        </div>
                      </div>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 8,
                        paddingTop: 8,
                        borderTop: "1px solid rgba(255,255,255,0.07)",
                      }}
                    >
                      {ordUnits.map((u) => {
                        const ov = findOverstockMatch(u);
                        return (
                          <div
                            key={u.id}
                            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}
                          >
                            <PartTile64
                              unit={u}
                              order={ord}
                              onTransition={onTransition}
                              onSelectUnit={onSelectUnit}
                              sourceSurface="Parts to Print"
                              showOutcomeButtons={false}
                              {...selectProps(u)}
                            />
                            {ov && (
                              <button
                                type="button"
                                className="fp-btn fp-btn-sm"
                                style={{
                                  height: 19,
                                  padding: "0 6px",
                                  fontSize: 9.5,
                                  background: "rgba(48,209,88,0.22)",
                                  borderColor: "rgba(48,209,88,0.5)",
                                  color: "#30d158",
                                }}
                                title={`Pull from Overstock (${ov.quantity} in stock)`}
                                onClick={() => handlePullFromOverstock(ov, u)}
                              >
                                <Icon icon={Package} size={12} /> Pull ({ov.quantity})
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
      </div>
      {isOpen && (
        <div className="fp-modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="fp-modal-window"
            style={{ width: "min(980px, 92vw)", maxHeight: "86vh" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="fp-modal-header">
              <div>
                <div className="fp-modal-title">
                  Print — Suggested Groups ({colorGroups.length})
                </div>
                <div style={{ fontSize: 12, color: "rgba(235,235,245,0.62)" }}>
                  Every part still waiting, grouped by filament spool · You choose the
                  printer when you send each group
                </div>
              </div>
              <button
                type="button"
                className="fp-btn fp-btn-sm"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>
            <div
              className="fp-modal-body"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                gap: 12,
              }}
            >
              {colorGroups.map((grp) => renderColorCard(grp, "Suggested Groups", true))}
            </div>
          </div>
        </div>
      )}
      {selectedUnits.length > 0 && (
        <div className="fp-selection-bar" role="region" aria-label="Selected parts">
          <span>{selectionSummary(selectedUnits)}</span>
          <button type="button" className="fp-btn fp-btn-sm fp-btn-primary" onClick={() => sendSelection(false)}>
            Send…
          </button>
          <button
            type="button"
            className="fp-btn fp-btn-sm"
            onClick={() => sendSelection(true)}
            title="Mark Printing: move the selected parts to Printing on a printer you pick, without opening the slicer"
          >
            <Icon icon={CirclePlay} size={14} /> Mark Printing…
          </button>
          <button type="button" className="fp-btn fp-btn-sm" onClick={clearSelection} title="Clear the selection (Esc)">
            Clear
          </button>
        </div>
      )}
    </div>
  );
};
