import React, { useMemo, useState } from "react";
import { actorDevice } from "../../deviceLabel";
import { getProcessSteps, printerAccent, stepLabel, useShopSettings } from "../../settingsStore";
import { outlineReplacesRing } from "../../thumbnailOutline";
import { showContextMenu } from "../../tauriInvoke";
import { Order, OrderLine, PartUnit, TransitionRequest } from "../../types";
import { isThumbnailOnlyUnit, PartThumb, ProductCompositeThumb } from "../../partThumbnails";
import { OrderLinePicture } from "../../orderLineThumbs";
import { pickFailureReason } from "../../uiFeedback";
import { isCompletedUnitState, progressColorHex, statusStepFor, unitMatchesStep } from "./orderStatus";
import { OrderLinesCompositeGrid, ShopOrderCardHeader } from "./ShopOrderCardParts";

/**
 * Stacked macOS Shop Card matching `OrderCardView.swift` 1:1.
 * Frosted header (Customer Name + displayCode + Rush/Overdue/Hold + % completion + multi-line folder badge),
 * full-width 3D composite preview on top, product name + Qty + status chip + progress bar,
 * and chrome-free square 3D part tiles with status ring borders underneath.
 */
export const ShopOrderCard: React.FC<{
  order: Order;
  line?: OrderLine;
  visibleUnits?: PartUnit[];
  ghostNonVisible?: boolean;
  statusOverride?: string;
  fullWidth?: boolean;
  cardWidth?: number;
  compositeSide?: number;
  partColumns?: number;
  selected?: boolean;
  onToggleSelect?: (orderId: string, e: React.MouseEvent) => void;
  andonAgeBadge?: { label: string; isLate?: boolean; isStuck?: boolean };
  onOpenOrder: (orderId: string) => void;
  onOpenFolder?: (orderId: string) => void;
  onSelectUnit: (unit: PartUnit, e: React.MouseEvent<HTMLElement>) => void;
  onContextAction?: (
    order: Order,
    action: "stage" | "processed" | "details" | "kitting" | "hold" | "delete"
  ) => void;
  onUnitTransition?: (req: TransitionRequest) => void;
}> = ({
  order,
  line,
  visibleUnits,
  ghostNonVisible = false,
  statusOverride,
  fullWidth = false,
  cardWidth = 284,
  compositeSide = 256,
  partColumns = 3,
  selected = false,
  onToggleSelect,
  andonAgeBadge,
  onOpenOrder,
  onOpenFolder,
  onSelectUnit,
  onContextAction,
  onUnitTransition,
}) => {
  const [expandedBand, setExpandedBand] = useState(false);
  const hideRing = outlineReplacesRing(useShopSettings().appearance_studio);
  const primaryLine = line || order.lines[0];
  const rawUnits = useMemo(
    () => (line ? line.units : order.lines.flatMap((l) => l.units)),
    [order, line]
  );
  const allUnits = useMemo(
    () => rawUnits.filter((u) => !isThumbnailOnlyUnit(u)),
    [rawUnits]
  );
  const shownUnits = useMemo(
    () => (visibleUnits || allUnits).filter((u) => !isThumbnailOnlyUnit(u)),
    [visibleUnits, allUnits]
  );

  const compositeParts = useMemo(
    () =>
      allUnits.map((u) => ({
        partName: u.part_name,
        colorHex: u.filament_hex,
        visible:
          !ghostNonVisible ||
          shownUnits.some((su) => su.id === u.id),
      })),
    [allUnits, shownUnits, ghostNonVisible]
  );

  const readyCount = allUnits.filter((u) => isCompletedUnitState(u.state)).length;
  const pct =
    allUnits.length > 0
      ? Math.round((readyCount / allUnits.length) * 100)
      : Math.round(order.progress_pct);

  const dominantState = useMemo(() => {
    if (statusOverride) return statusOverride;
    const pool = visibleUnits && visibleUnits.length > 0 ? shownUnits : allUnits;
    if (pool.some((u) => unitMatchesStep(u.state, "Printing"))) return "Printing";
    if (pool.some((u) => unitMatchesStep(u.state, "Staged"))) return "Staged";
    if (pool.some((u) => unitMatchesStep(u.state, "Queued"))) return "Queued";
    if (pool.some((u) => unitMatchesStep(u.state, "Post-Processing"))) return "Post-Processing";
    if (pool.some((u) => unitMatchesStep(u.state, "Printed"))) return "Printed";
    if (pool.length > 0 && pool.every((u) => unitMatchesStep(u.state, "Ready")))
      return "Ready";
    return "Queued";
  }, [allUnits, shownUnits, visibleUnits, statusOverride]);

  const stepInfo = statusStepFor(dominantState);
  const maxVisibleCollapsed = partColumns * 2;
  const hasOverflow = shownUnits.length > maxVisibleCollapsed;
  const displayedUnits = expandedBand
    ? shownUnits
    : hasOverflow
    ? shownUnits.slice(0, maxVisibleCollapsed - 1)
    : shownUnits;
  const overflowCount = shownUnits.length - displayedUnits.length;
  const tileSide = Math.floor((compositeSide - (partColumns - 1) * 6) / partColumns);

  return (
    <div
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) {
          onToggleSelect?.(order.id, e);
          return;
        }
        onOpenOrder(order.id);
      }}
      onContextMenu={(e) => {
        if (!onContextAction) return;
        e.preventDefault();
        e.stopPropagation();
        void showContextMenu(
          [
            { id: "details", label: "Open Order Details" },
            { id: "stage", label: "Stage & Print Queued Parts" },
            { id: "processed", label: "Mark Processed…" },
            { id: "kitting", label: "Print Kitting Card" },
            { id: "hold", label: order.is_on_hold ? "Resume Order" : "Put On Hold" },
            { separator: true },
            { id: "delete", label: "Delete Order…" },
          ],
          { x: e.clientX, y: e.clientY }
        ).then((choice) => {
          if (choice) onContextAction(order, choice as Parameters<typeof onContextAction>[1]);
        });
      }}
      style={{
        width: fullWidth ? "100%" : cardWidth,
        minWidth: fullWidth ? 0 : cardWidth,
        flexShrink: 0,
        borderRadius: 12,
        overflow: "hidden",
        background: "var(--fp-card-bg, rgba(30, 32, 38, 0.94))",
        backdropFilter: "var(--fp-card-backdrop, none)",
        border: selected
          ? "2px solid #0a84ff"
          : order.is_rush
          ? "1.5px solid rgba(255, 69, 58, 0.65)"
          : order.is_on_hold
          ? "1.5px solid rgba(255, 159, 10, 0.65)"
          : "1px solid rgba(255, 255, 255, 0.12)",
        boxShadow: selected
          ? "0 0 0 3px rgba(10, 132, 255, 0.25), 0 8px 24px rgba(0, 0, 0, 0.45)"
          : "0 8px 24px rgba(0, 0, 0, 0.35)",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        userSelect: "none",
        position: "relative",
        opacity: order.is_on_hold ? 0.78 : 1,
      }}
    >
      {/* Top Frosted Header Band */}
      <ShopOrderCardHeader
        onToggleSelect={onToggleSelect}
        selected={selected}
        order={order}
        line={line}
        onOpenFolder={onOpenFolder}
        onOpenOrder={onOpenOrder}
        andonAgeBadge={andonAgeBadge}
        pct={pct}
        readyCount={readyCount}
        allUnits={allUnits}
      />

      {/* Body: Full-width Composite Thumbnail + Product Line + Progress + Part Tiles */}
      <div
        style={{
          padding: "10px 14px 12px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        {!line && order.lines.length > 1 ? (
          <OrderLinesCompositeGrid compositeSide={compositeSide} order={order} stepInfo={stepInfo} />
        ) : (
          <>
            {(() => {
              const composite = (
                <ProductCompositeThumb
                  productIdOrName={primaryLine?.product_id || primaryLine?.product_name || ""}
                  parts={compositeParts}
                  size={compositeSide}
                  inscriptionText={primaryLine?.custom_text}
                  liveTint
                  ghostHidden={ghostNonVisible}
                  statusHex={stepInfo.bg}
                />
              );
              // Ghosted cards (some parts hidden) keep the composite so hidden parts stay dimmed.
              return primaryLine && !ghostNonVisible ? (
                <OrderLinePicture order={order} line={primaryLine} size={compositeSide} fallback={composite} />
              ) : composite;
            })()}

            {/* Product Title + Qty + Status Chip */}
            <div
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 6,
              }}
            >
              <div
                style={{
                  fontSize: 12.5,
                  fontWeight: 700,
                  color: "#e2e8f0",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {line
                  ? line.item_label || line.product_name
                  : primaryLine?.product_name || "Product"}
                {primaryLine && primaryLine.quantity > 1 ? ` ×${primaryLine.quantity}` : ""}
              </div>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 7px",
                  borderRadius: 999,
                  background: stepInfo.bg,
                  color: stepInfo.fg,
                  flexShrink: 0,
                }}
              >
                {stepInfo.name}
              </span>
            </div>
          </>
        )}

        {primaryLine?.custom_text && (
          <div
            style={{
              width: "100%",
              fontSize: 11,
              color: "#64d2ff",
              fontWeight: 600,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              marginTop: -4,
            }}
          >
            Inscription: “{primaryLine.custom_text}”
          </div>
        )}

        {/* Progress Bar */}
        <div
          style={{
            width: "100%",
            height: 5,
            borderRadius: 999,
            background: "rgba(255,255,255,0.08)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.min(100, Math.max(0, pct))}%`,
              height: "100%",
              background: progressColorHex(pct),
              transition: "width 180ms ease",
            }}
          />
        </div>

        {/* Square Part Tiles Grid with Status Ring Borders */}
        <div
          style={{
            width: "100%",
            display: "grid",
            gridTemplateColumns: `repeat(${partColumns}, ${tileSide}px)`,
            gap: 6,
            justifyContent: "space-between",
            marginTop: 2,
          }}
        >
          {displayedUnits.map((u) => {
            const uStep = statusStepFor(u.state);
            return (
              <button
                key={u.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectUnit(u, e);
                }}
                onContextMenu={(e) => {
                  if (!onUnitTransition) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const at = { x: e.clientX, y: e.clientY };
                  void showContextMenu(
                    [
                      ...getProcessSteps().map((st) => ({
                        id: `state:${st.id}`,
                        label: `Mark ${st.name}`,
                        enabled: u.state !== st.id,
                      })),
                      { separator: true as const },
                      { id: "failed", label: "Mark Failed (Queue Reprint)" },
                    ],
                    { x: e.clientX, y: e.clientY }
                  ).then(async (choice) => {
                    if (!choice) return;
                    const failed = choice === "failed";
                    const st = failed ? "Queued" : choice.slice(6);
                    // Ask why it failed (Bed Adhesion, Spaghetti, …); dismissing marks nothing.
                    const reason = failed ? await pickFailureReason(at) : null;
                    if (failed && !reason) return;
                    onUnitTransition({
                      unit_ids: [u.id],
                      to_state: st,
                      printer_id: u.printer_id ?? null,
                      actor_device: actorDevice(),
                      source_surface: "Part Tile Context Menu",
                      action_label: failed ? `${u.part_name} Failed (Reprint)` : `${u.part_name} → ${st}`,
                      failure_reason: reason,
                      failure_note: failed ? "Marked Failed / Needs Reprint" : null,
                    });
                  });
                }}
                title={`${primaryLine?.product_name || "Product"} · ${u.part_name}: ${stepLabel(u.state)} · ${u.filament_name}`}
                style={{
                  width: tileSide,
                  height: tileSide,
                  borderRadius: 8,
                  background: "var(--fp-tile-bg, rgba(255,255,255,0.04))",
                  backdropFilter: "var(--fp-tile-backdrop, none)",
                  border: hideRing
                    ? "2.5px solid transparent"
                    : `2.5px solid ${uStep.bg}`,
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  position: "relative",
                }}
              >
                <PartThumb
                  partName={u.part_name}
                  colorHex={u.filament_hex}
                  size={Math.max(20, tileSide - 8)}
                  productId={u.product_id}
                  statusHex={uStep.bg}
                />
                {printerAccent(u.printer_id) && (
                  <span
                    title="Assigned printer"
                    style={{
                      position: "absolute",
                      top: 3,
                      right: 3,
                      width: 7,
                      height: 7,
                      borderRadius: 999,
                      background: printerAccent(u.printer_id),
                      boxShadow: "0 0 0 1px rgba(0,0,0,0.45)",
                    }}
                  />
                )}
              </button>
            );
          })}

          {!expandedBand && overflowCount > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpandedBand(true);
              }}
              style={{
                width: tileSide,
                height: tileSide,
                borderRadius: 8,
                background: "rgba(255,255,255,0.04)",
                border: "2px solid rgba(255,255,255,0.18)",
                color: "rgba(235,235,245,0.8)",
                fontWeight: 700,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              +{overflowCount}
            </button>
          )}
          {expandedBand && hasOverflow && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpandedBand(false);
              }}
              style={{
                width: tileSide,
                height: tileSide,
                borderRadius: 8,
                background: "rgba(255,255,255,0.04)",
                border: "2px solid rgba(255,255,255,0.18)",
                color: "rgba(235,235,245,0.8)",
                fontWeight: 700,
                fontSize: 10,
                cursor: "pointer",
              }}
            >
              Show less
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
