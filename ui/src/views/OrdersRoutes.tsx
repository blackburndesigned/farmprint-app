// App-level routes for the All Orders and ANDON tabs: map App state onto the board views in
// views/orders/. (Formerly OrdersAndAndonViews.tsx, renamed so it is not confused with
// OrdersAndonViews.tsx, which re-exports the screens themselves.)
import React from "react";
import { FilamentSwatch, Order, PartUnit, Printer, Product, ShopSnapshot, TransitionRequest } from "../types";
import { CreatedCatalogProductPayload } from "../components/ProductImportModal3D";
import { AllOrdersBoardView } from "./orders/AllOrdersBoardView";
import { AndonBoardView as InnerAndonBoardView } from "./orders/AndonBoardView";

export const AllOrdersView: React.FC<{
  activeOrders: Order[];
  orderById?: Map<string, Order>;
  productById?: Map<string, Product>;
  filaments?: FilamentSwatch[];
  sortedPrinters?: Printer[];
  customProducts?: Record<string, CreatedCatalogProductPayload>;
  selectedOrderId: string | null;
  onSelectOrder: (orderId: string | null) => void;
  onSelectUnit: (unit: PartUnit, e: React.MouseEvent<HTMLElement>) => void;
  onRunTransition?: (req: TransitionRequest) => void;
  onTriggerProcessed?: (order: Order) => void;
  onFlashBanner?: (msg: string) => void;
  onSnapshotUpdated?: (s: ShopSnapshot) => void;
  onOpenNewOrderModal?: () => void;
  onOpenFilamentLibrary?: () => void;
  onOpenSettings?: () => void;
  onPrintKittingCards?: (orders: Order[]) => void;
}> = ({
  activeOrders,
  productById,
  sortedPrinters,
  selectedOrderId,
  onSelectOrder,
  onSelectUnit,
  onRunTransition,
  onTriggerProcessed,
  onFlashBanner,
  onSnapshotUpdated,
  onOpenNewOrderModal,
  onPrintKittingCards,
}) => {
  const products = React.useMemo(
    () => (productById ? Array.from(productById.values()) : []),
    [productById]
  );
  return (
    <AllOrdersBoardView
      activeOrders={activeOrders}
      products={products}
      printers={sortedPrinters || []}
      selectedOrderId={selectedOrderId}
      onSelectOrder={onSelectOrder}
      onSelectUnit={onSelectUnit}
      onRunTransition={onRunTransition}
      onTriggerProcessed={onTriggerProcessed}
      onOpenNewOrderModal={onOpenNewOrderModal}
      onSnapshotUpdated={onSnapshotUpdated}
      onFlashBanner={onFlashBanner}
      onPrintKittingCards={onPrintKittingCards}
    />
  );
};

export const AndonBoardView: React.FC<{
  orders?: Order[];
  allUnits?: PartUnit[];
  orderById?: Map<string, Order>;
  customProducts?: Record<string, CreatedCatalogProductPayload>;
  wallMode?: boolean;
  andonWallMode?: boolean;
  onToggleWallMode: (wall: boolean) => void;
  onOpenOrder?: (orderId: string) => void;
  onSelectOrder?: (orderId: string | null) => void;
  onSelectUnit: (unit: PartUnit, e: React.MouseEvent<HTMLElement>) => void;
  onRunTransition: (req: TransitionRequest) => void;
}> = ({
  orders,
  orderById,
  wallMode,
  andonWallMode,
  onToggleWallMode,
  onOpenOrder,
  onSelectOrder,
  onSelectUnit,
  onRunTransition,
}) => {
  const resolvedOrders = React.useMemo(
    () => orders || (orderById ? Array.from(orderById.values()) : []),
    [orders, orderById]
  );
  const resolvedWall = wallMode ?? andonWallMode ?? false;
  const handleOpen = (orderId: string) => {
    if (onOpenOrder) onOpenOrder(orderId);
    else if (onSelectOrder) onSelectOrder(orderId);
  };
  return (
    <InnerAndonBoardView
      orders={resolvedOrders}
      wallMode={resolvedWall}
      onToggleWallMode={onToggleWallMode}
      onOpenOrder={handleOpen}
      onSelectUnit={onSelectUnit}
      onRunTransition={onRunTransition}
    />
  );
};
