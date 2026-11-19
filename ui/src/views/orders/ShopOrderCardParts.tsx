import React from "react";
import type { ProcessStep } from "../../settingsStore";
import { modKey } from "../../platform";
import { Order, OrderLine, PartUnit } from "../../types";
import { isThumbnailOnlyUnit, ProductCompositeThumb } from "../../partThumbnails";
import { OrderLinePicture } from "../../orderLineThumbs";
import { progressColorHex } from "./orderStatus";

/** Multi-product order: one small composite per product line, in a grid. */
export const OrderLinesCompositeGrid: React.FC<{
  compositeSide: number;
  order: Order;
  stepInfo: ProcessStep;
}> = ({ compositeSide, order, stepInfo }) => (
  <>
    <div
      style={{
        width: "100%",
        maxWidth: compositeSide,
        height: compositeSide,
        borderRadius: 12,
        padding: 8,
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.10)",
        boxSizing: "border-box",
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gridTemplateRows:
          order.lines.length === 2
            ? "minmax(0, 1fr)"
            : "repeat(2, minmax(0, 1fr))",
        gap: 8,
      }}
    >
      {(order.lines.length === 2 ? [0, 1] : [0, 1, 2, 3]).map((slot) => {
        const slotLine = order.lines[slot];
        const extraCount = Math.max(0, order.lines.length - 4);
        const cellSide =
          order.lines.length === 2
            ? Math.floor((compositeSide - 20) / 1.75)
            : Math.floor((compositeSide - 22) / 2);
        if (!slotLine) {
          return (
            <div
              key={slot}
              style={{
                borderRadius: 8,
                background: "rgba(255,255,255,0.025)",
              }}
            />
          );
        }
        const slotParts = slotLine.units
          .filter((u) => !isThumbnailOnlyUnit(u))
          .map((u) => ({ partName: u.part_name, colorHex: u.filament_hex }));
        return (
          <div
            key={slotLine.id}
            style={{
              position: "relative",
              borderRadius: 8,
              overflow: "hidden",
              background: "rgba(255,255,255,0.04)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <OrderLinePicture
              order={order}
              line={slotLine}
              size={cellSide}
              fallback={
                <ProductCompositeThumb
                  productIdOrName={slotLine.product_id || slotLine.product_name || ""}
                  parts={slotParts}
                  size={cellSide}
                  inscriptionText={slotLine.custom_text}
                  liveTint
                />
              }
            />
            {slot === 3 && extraCount > 0 ? (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(0,0,0,0.58)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  fontWeight: 800,
                  color: "#ffffff",
                }}
              >
                +{extraCount}
              </div>
            ) : (
              <span
                style={{
                  position: "absolute",
                  right: 4,
                  bottom: 4,
                  fontSize: 9,
                  fontWeight: 700,
                  padding: "1px 5px",
                  borderRadius: 999,
                  background: "rgba(15,23,42,0.82)",
                  color: "#e2e8f0",
                }}
              >
                ×{slotLine.quantity}
              </span>
            )}
          </div>
        );
      })}
    </div>
    <div
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 6,
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#e2e8f0" }}>
        {order.lines.length} products
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
);

/** Frosted header band: order code, customer, age badge, selection and open buttons, progress. */
export const ShopOrderCardHeader: React.FC<{
  onToggleSelect?: (orderId: string, e: React.MouseEvent) => void;
  selected: boolean;
  order: Order;
  line?: OrderLine;
  onOpenFolder?: (orderId: string) => void;
  onOpenOrder: (orderId: string) => void;
  andonAgeBadge?: { label: string; isLate?: boolean; isStuck?: boolean; };
  pct: number;
  readyCount: number;
  allUnits: PartUnit[];
}> = ({ onToggleSelect, selected, order, line, onOpenFolder, onOpenOrder, andonAgeBadge, pct, readyCount, allUnits }) => (
  <div
    className="fp-order-card-header"
    style={{
      padding: "8px 12px 7px",
      background: "rgba(255, 255, 255, 0.04)",
      borderBottom: "1px solid rgba(255, 255, 255, 0.07)",
      display: "flex",
      flexDirection: "column",
      gap: 3,
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={selected}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onToggleSelect(order.id, e as unknown as React.MouseEvent)}
            style={{ cursor: "pointer", margin: 0 }}
            title={`Select order for batch actions (or ${modKey()}-click card)`}
          />
        )}
        <div
          style={{
            fontWeight: 700,
            fontSize: 13.5,
            color: "#f8fafc",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {order.customer_name}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
        {!line && order.lines.length > 1 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (onOpenFolder) onOpenFolder(order.id);
              else onOpenOrder(order.id);
            }}
            title="Open multi-product order folder"
            style={{
              fontSize: 9.5,
              fontWeight: 800,
              padding: "1px 6px",
              borderRadius: 999,
              background: "rgba(10, 132, 255, 0.24)",
              border: "1px solid rgba(100, 210, 255, 0.45)",
              color: "#64d2ff",
              cursor: "pointer",
            }}
          >
            📁 {order.lines.length} items
          </button>
        )}
        {order.is_on_hold && (
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 800,
              padding: "1px 5px",
              borderRadius: 4,
              background: "rgba(255, 159, 10, 0.22)",
              color: "#ff9f0a",
            }}
          >
            HOLD
          </span>
        )}
        {order.is_rush && (
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 800,
              padding: "1px 5px",
              borderRadius: 4,
              background: "rgba(255, 69, 58, 0.22)",
              color: "#ff6961",
            }}
          >
            RUSH
          </span>
        )}
        {andonAgeBadge && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: "1px 6px",
              borderRadius: 999,
              background: andonAgeBadge.isLate
                ? "rgba(255,69,58,0.22)"
                : andonAgeBadge.isStuck
                ? "rgba(255,159,10,0.22)"
                : "rgba(255,255,255,0.08)",
              color: andonAgeBadge.isLate
                ? "#ff6961"
                : andonAgeBadge.isStuck
                ? "#ff9f0a"
                : "rgba(235,235,245,0.7)",
            }}
          >
            {andonAgeBadge.label}
          </span>
        )}
      </div>
    </div>

    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: 11,
        color: "rgba(235,235,245,0.55)",
      }}
    >
      <span style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>
        {order.order_code}
      </span>
      <span
        style={{
          fontWeight: 700,
          color: progressColorHex(pct),
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {pct}% ({readyCount}/{allUnits.length})
      </span>
    </div>
  </div>
);
