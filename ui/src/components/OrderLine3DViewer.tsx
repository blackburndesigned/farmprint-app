/**
 * Order details "Enlarge" as a turnable 3D view. Read-only: orbit, zoom, pan and
 * twist only — no part picking, no filament changes, and nothing is saved (Re-pose is the
 * only way to change an order line's picture). Opens at the line's saved camera, else the
 * website view_camera, else the product angle, in the line's saved colors. Falls back to
 * `fallback` (the saved PNG) while loading and when the product has no 3D model.
 */
import React, { useRef, useState } from "react";
import type { FilamentSwatch, Order, OrderLine, Product } from "../types";
import { OrderViewport3D, OrderViewport3DHandle } from "./OrderViewport3D";
import { lineUnitColors, lineViewCamera, thumbColorsStale, useOrderLineThumb } from "../orderLineThumbs";

export const OrderLine3DViewer: React.FC<{
  order: Order;
  line: OrderLine;
  product?: Product;
  filaments: FilamentSwatch[];
  /** Square side in px. */
  size: number;
  fallback: React.ReactNode;
}> = ({ order, line, product, filaments, size, fallback }) => {
  const saved = useOrderLineThumb(order.id, line.id);
  const vpRef = useRef<OrderViewport3DHandle | null>(null);
  const [live, setLive] = useState(false);
  if (!product || saved === undefined) return <>{fallback}</>;
  const current = lineUnitColors(line);
  // Saved colors match the saved picture; if a filament changed since, show the line's real colors.
  const partColors = saved && !thumbColorsStale(saved, line) ? { ...current, ...saved.partColors } : current;
  const startCamera = saved?.camera ?? lineViewCamera(line);
  return (
    <div style={{ width: size, height: size, position: "relative", display: "flex" }}>
      <OrderViewport3D
        key={`${order.id}:${line.id}`}
        ref={vpRef}
        product={product}
        filaments={filaments}
        partColors={partColors}
        initialCamera={startCamera}
        resetCamera={startCamera}
        fallback={fallback}
        onAvailableChange={setLive}
      />
      {live && <button
        type="button"
        className="fp-btn fp-btn-sm"
        title="Back to this item's saved picture angle (viewing never changes the picture)"
        onClick={() => vpRef.current?.resetView()}
        style={{ position: "absolute", left: 10, bottom: 10, zIndex: 2 }}
      >
        Reset view
      </button>}
    </div>
  );
};

export default OrderLine3DViewer;
