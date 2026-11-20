import React, { useMemo, useState } from "react";
import { getProcessSteps, useShopSettings, getShopSettings } from "../../settingsStore";
import { Order, OrderLine, PartUnit, TransitionRequest } from "../../types";
import { isThumbnailOnlyUnit } from "../../partThumbnails";
import { orderAgeBadge } from "../../uiFeedback";
import { LazyMount } from "../../components/LazyMount";
import { unitMatchesStep } from "./orderStatus";
import { StatusLegendHeader } from "./StatusLegendHeader";
import { ShopOrderCard } from "./ShopOrderCard";

export const AndonBoardView: React.FC<{
  orders: Order[];
  wallMode: boolean;
  onToggleWallMode: (wall: boolean) => void;
  onOpenOrder: (orderId: string) => void;
  onSelectUnit: (unit: PartUnit, e: React.MouseEvent<HTMLElement>) => void;
  onRunTransition: (req: TransitionRequest) => void;
}> = ({ orders: allOrders, wallMode, onToggleWallMode, onOpenOrder, onSelectUnit }) => {
  const [collapsedStrips, setCollapsedStrips] = useState<Set<string>>(new Set());
  const settings = useShopSettings();
  // The floor shows open work only: shipped/cancelled orders never sit in a lane.
  const orders = useMemo(
    () =>
      allOrders
        .filter((o) => o.overall_state !== "Shipped" && o.overall_state !== "Cancelled")
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [allOrders]
  );
  // One chip per (order, line) with units in each step, built once per snapshot.
  const steps = getProcessSteps();
  const laneEntries = useMemo(() => {
    const byStep = new Map<string, { id: string; order: Order; line: OrderLine | undefined; matchingUnits: PartUnit[] }[]>();
    for (const step of steps) byStep.set(step.id, []);
    for (const order of orders) {
      for (const line of order.lines) {
        const perStep = new Map<string, PartUnit[]>();
        for (const u of line.units) {
          if (isThumbnailOnlyUnit(u)) continue;
          // Shipped/closed parts are done: they don't keep an order in the Ready lane.
          if (u.state === "Shipped" || u.state === "Closed") continue;
          const step = steps.find((st) => unitMatchesStep(u.state, st.id));
          if (!step) continue;
          const list = perStep.get(step.id);
          if (list) list.push(u);
          else perStep.set(step.id, [u]);
        }
        perStep.forEach((units, stepId) => {
          byStep.get(stepId)?.push({ id: `${order.id}-${line.id}`, order, line, matchingUnits: units });
        });
      }
    }
    return byStep;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, settings.process_steps]);
  const now = Date.now();

  const toggleStrip = (stepId: string) => {
    setCollapsedStrips((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  const totalFloorParts = useMemo(
    () =>
      orders.reduce(
        (acc, o) =>
          acc +
          o.lines
            .flatMap((l) => l.units)
            .filter((u) => !isThumbnailOnlyUnit(u)).length,
        0
      ),
    [orders]
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 18px 2px",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "0 18px", fontSize: 12.5, color: "rgba(235,235,245,0.7)" }}>
            What needs attention right now: failed, held and ready-to-ship work.
          </div>
          <StatusLegendHeader />
        </div>
        {/* In Wall TV the auto-hiding controls in TopHeader are the only ones shown. */}
        {!wallMode && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button type="button" className="fp-btn fp-btn-sm fp-btn-primary" onClick={() => onToggleWallMode(false)}>
              Work Mode
            </button>
            <button type="button" className="fp-btn fp-btn-sm" onClick={() => onToggleWallMode(true)}>
              Wall TV Mode
            </button>
          </div>
        )}
      </div>

      <div
        style={{
          flex: "1 1 0%",
          minHeight: 0,
          height: "100%",
          width: "100%",
          boxSizing: "border-box",
          display: "grid",
          gridTemplateColumns: steps.map((s) =>
            collapsedStrips.has(s.id) ? "44px" : "minmax(220px, 1fr)"
          ).join(" "),
          gap: 10,
          padding: "8px 14px 20px",
          overflowX: "auto",
          overflowY: "hidden",
          alignItems: "stretch",
        }}
      >
        {steps.map((step) => {
          // Match AndonBoardView.swift stepOrders: one OrderChip per (order, line) with units in this step
          const matchingOrders = laneEntries.get(step.id) || [];

          const isCollapsed = collapsedStrips.has(step.id);

          if (isCollapsed) {
            return (
              <div
                key={step.id}
                onClick={() => toggleStrip(step.id)}
                title={`Expand ${step.name} column (${matchingOrders.length} orders)`}
                style={{
                  width: 44,
                  minWidth: 44,
                  borderRadius: 12,
                  background: "rgba(22, 24, 29, 0.92)",
                  border: `2px solid ${step.bg}`,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  padding: "12px 4px",
                  cursor: "pointer",
                  gap: 10,
                }}
              >
                <span
                  style={{
                    background: step.bg,
                    color: step.fg,
                    borderRadius: 999,
                    padding: "2px 7px",
                    fontSize: 11,
                    fontWeight: 800,
                  }}
                >
                  {matchingOrders.length}
                </span>
                <div
                  style={{
                    writingMode: "vertical-rl",
                    textOrientation: "mixed",
                    fontWeight: 800,
                    fontSize: 13,
                    letterSpacing: 0.5,
                    color: "rgba(235,235,245,0.85)",
                  }}
                >
                  {step.name}
                </div>
              </div>
            );
          }

          return (
            <div
              key={step.id}
              style={{
                width: "100%",
                minWidth: 220,
                height: "100%",
                minHeight: 0,
                maxHeight: "100%",
                borderRadius: 12,
                background: "rgba(22, 24, 29, 0.92)",
                border: `2px solid ${step.bg}`,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              {/* Colored Step Header matching AndonBoardView.processStepColumn */}
              <div
                onClick={() => toggleStrip(step.id)}
                title="Click header to collapse/expand lane"
                style={{
                  background: step.bg,
                  color: step.fg,
                  padding: wallMode ? "12px 14px" : "8px 10px",
                  textAlign: wallMode ? "left" : "center",
                  cursor: "pointer",
                  position: "relative",
                }}
              >
                {wallMode ? (
                  <>
                    <div style={{ fontSize: 32, fontWeight: 800, lineHeight: 1 }}>
                      {matchingOrders.length}
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 800 }}>{step.name}</div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 15, fontWeight: 800 }}>{step.name}</div>
                    <div style={{ fontSize: 11.5, opacity: 0.82 }}>
                      {matchingOrders.length}{" "}
                      {matchingOrders.length === 1 ? "order" : "orders"}
                    </div>
                  </>
                )}
              </div>

              <div
                style={{
                  flex: "1 1 0%",
                  minHeight: 0,
                  overflowY: "auto",
                  overflowX: "hidden",
                  padding: 8,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                {matchingOrders.length === 0 ? (
                  <div
                    style={{
                      fontSize: 12,
                      color: "rgba(235,235,245,0.45)",
                      paddingTop: 12,
                    }}
                  >
                    Clear
                  </div>
                ) : wallMode ? (
                  matchingOrders.map(({ id, order, line, matchingUnits }, idx) => (
                    <LazyMount key={id} estimate={64} eager={idx < 20} style={{ width: "100%", flexShrink: 0 }}>
                    <div
                      onClick={() => onOpenOrder(order.id)}
                      style={{
                        width: "100%",
                        flexShrink: 0,
                        padding: "10px 12px",
                        borderRadius: 10,
                        background: "rgba(255,255,255,0.05)",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 800, fontSize: 16 }}>
                        {order.customer_name}
                      </div>
                      <div style={{ fontSize: 12.5, color: "rgba(235,235,245,0.68)" }}>
                        {(line || order.lines[0])?.product_name} · {matchingUnits.length} part(s)
                      </div>
                    </div>
                    </LazyMount>
                  ))
                ) : (
                  matchingOrders.map(({ id, order, line, matchingUnits }, idx) => (
                    <LazyMount key={`${step.id}-${id}`} estimate={380} eager={idx < 4} style={{ width: "100%", flexShrink: 0, display: "flex", justifyContent: "center" }}>
                    <ShopOrderCard
                      order={order}
                      line={line}
                      visibleUnits={matchingUnits}
                      ghostNonVisible={true}
                      statusOverride={step.id}
                      fullWidth={true}
                      cardWidth={240}
                      compositeSide={212}
                      partColumns={(getShopSettings().part_grid_preferred_columns === 4 ? 4 : 3)}
                      andonAgeBadge={orderAgeBadge(order.created_at, settings.orders_late_after_days, now)}
                      onOpenOrder={onOpenOrder}
                      onSelectUnit={onSelectUnit}
                    />
                    </LazyMount>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* AndonBoardView Footer */}
      {!wallMode && (
        <div
          style={{
            padding: "6px 18px 80px",
            fontSize: 11.5,
            color: "rgba(235,235,245,0.55)",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>
            Floor: <strong>{orders.length}</strong> active orders ·{" "}
            <strong>{totalFloorParts}</strong> tracked parts
          </span>
          <span>Tip: Click any step header to collapse it into a narrow strip</span>
        </div>
      )}
    </div>
  );
};
