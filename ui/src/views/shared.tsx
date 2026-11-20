import React from "react";
import { DockTab } from "../components/DockAndHeader";
import { FilamentSwatch, Order, OrderLine, PartUnit, Product } from "../types";
import { CreatedCatalogProductPayload } from "../components/ProductImportModal3D";
import { isThumbnailOnlyUnit, PartThumb, ProductCompositeThumb } from "../partThumbnails";
import { statusStepFor } from "./OrdersAndonViews";
import { useShopSettings } from "../settingsStore";
import { outlineReplacesRing } from "../thumbnailOutline";
import { SuggestedPrintGroup } from "./PrintersQueueViews";

export type { DockTab, SuggestedPrintGroup };

export const ALL_STATES = [
  "Queued",
  "Staged",
  "Printing",
  "Printed",
  "Post-Processing",
  "Ready",
  "Shipped",
] as const;

export function fmtUsd(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents || 0) / 100;
  return `${neg ? "-" : ""}$${abs.toFixed(2)}`;
}

export const LineCompositeThumb: React.FC<{
  line: OrderLine;
  product?: Product;
  filaments?: FilamentSwatch[];
  customPayload?: CreatedCatalogProductPayload;
  size?: number;
  /** Pixel size the picture is drawn at (default 240). Pass ~640 for a print-size picture. */
  renderPx?: number;
}> = ({ line, product, size = 160, renderPx }) => {
  const parts = line.units
    .filter((u) => !isThumbnailOnlyUnit(u))
    .map((u) => ({
      partName: u.part_name,
      colorHex: u.filament_hex,
    }));

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 12,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.08)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <ProductCompositeThumb
        productIdOrName={product?.id || line.product_id || line.product_name || ""}
        parts={parts}
        size={Math.round(size * 0.9)}
        inscriptionText={line.custom_text}
        // Order lines carry per-part colors; the baked product.png / registered hero is the
        // product's default colorway, so always tint live from the line's units.
        liveTint
        renderPx={renderPx}
      />
    </div>
  );
};

export const PartTileCard: React.FC<{
  unit: PartUnit;
  order?: Order;
  size?: number;
  onSelectUnit?: (unit: PartUnit, e: React.MouseEvent<HTMLElement>) => void;
}> = ({ unit, size = 72, onSelectUnit }) => {
  const step = statusStepFor(unit.state);
  const hideRing = outlineReplacesRing(useShopSettings().appearance_studio);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelectUnit?.(unit, e);
      }}
      title={`${unit.part_name} • ${unit.filament_name} (${unit.state})`}
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        border: hideRing ? "2.5px solid transparent" : `2.5px solid ${step.bg}`,
        background: "rgba(22, 24, 30, 0.92)",
        padding: 4,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "space-between",
        cursor: "pointer",
        position: "relative",
        flexShrink: 0,
      }}
    >
      <PartThumb
        partName={unit.part_name}
        colorHex={unit.filament_hex}
        size={Math.round(size * 0.62)}
        productId={unit.product_id}
        statusHex={step.bg}
      />
      <span
        style={{
          fontSize: 9.5,
          fontWeight: 700,
          color: "rgba(235,235,245,0.88)",
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {unit.part_name}
      </span>
    </button>
  );
};
