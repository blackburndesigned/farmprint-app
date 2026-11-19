// The 3D code (WebGL viewports, the Product Editor, the New Order 3D builder, Enlarge and
// Re-pose) loads on demand so it stays out of the startup bundle. Each screen is wrapped in
// <Suspense> where it is used; preload3D() fetches the chunks shortly after launch so opening
// one later is still instant.
import React from "react";

const loadProductEditor = () => import("./components/ProductImportModal3D");
const loadNewOrderSheet = () => import("./views/NewOrderSheet");
const loadOrderLine3DViewer = () => import("./components/OrderLine3DViewer");
const loadOrderViewport = () => import("./components/OrderViewport3D");

export const ProductImportModal3D = React.lazy(() => loadProductEditor().then((m) => ({ default: m.ProductImportModal3D })));
export const NewOrderSheet = React.lazy(() => loadNewOrderSheet().then((m) => ({ default: m.NewOrderSheet })));
export const OrderLine3DViewer = React.lazy(() => loadOrderLine3DViewer().then((m) => ({ default: m.OrderLine3DViewer })));
export const OrderRePoseModal = React.lazy(() => loadOrderViewport().then((m) => ({ default: m.OrderRePoseModal })));

/** Offscreen order-line render (website orders, recolors), loaded with the 3D chunk. */
export const renderOrderThumbnail: typeof import("./components/OrderViewport3D").renderOrderThumbnail = async (...args) =>
  (await loadOrderViewport()).renderOrderThumbnail(...args);

/** Warm the 3D chunks after startup (no-op if already loaded). */
export function preload3D() {
  void loadProductEditor();
  void loadNewOrderSheet();
  void loadOrderLine3DViewer();
}
