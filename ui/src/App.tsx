import { FilamentLibrarySheet } from "./components/FilamentLibrarySheet";
import { loadShopSettings, setShopSettings, useShopSettings } from "./settingsStore";
import { SetupWizard, needsSetup } from "./components/SetupWizard";
import { AppLockStatus, LockScreen, effectiveLockMethod, fetchLockStatus } from "./components/AppLock";
import React, { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { invoke, setKnownSnapshot } from "./tauriInvoke";
import { assignPartStems, buildEditorJson, loadProductEditorDraft, meshToStlBase64 } from "./productEditorSource";
import { UpdateBanner } from "./updater";
import { forgetCatalogProduct, registerCatalogProducts, registerCustomNeutralPartPng, registerProductComposite, registerProductLayers } from "./partThumbnails";
import { FALLBACK_SNAPSHOT } from "./mockData";
import {
  FlowEvent,
  Order,
  PartUnit,
  Product,
  ShopSnapshot,
  TransitionRequest,
} from "./types";
import {
  BottomDock,
  DockTab,
  SidebarNav,
  TopHeader,
} from "./components/DockAndHeader";
import { CreatedCatalogProductPayload, partIconCameraToJson } from "./components/productImport/importTypes";
import { NewOrderSheet, PlateView, ProductImportModal3D, preload3D } from "./lazy3D";
import { AllOrdersView, AndonBoardView } from "./views/OrdersRoutes";
import {
  ProductsCatalogView,
  ReadyToShipView,
} from "./views/ProductsAndShipViews";
import { actorDevice } from "./deviceLabel";
import {
  OverstockView,
  PartsToPrintView,
  PrintersView,
} from "./views/PrintersQueueViews";
import {
  FlowView,
  HistoryView,
  ProductionValueView,
} from "./views/FlowAnalyticsViews";
import { saveOrderLineThumb, useOrderThumbAutoRender } from "./orderLineThumbs";
import { clearOrderModelCache } from "./components/orderModelCache";
import { KittingCardModal, OrderModals, UnitStatePopover } from "./views/ModalsAndDock";
import { PeopleView, SettingsModal } from "./components/SettingsAndPeopleViews";
import { ConfirmHost, askConfirm, useBannerBus } from "./uiFeedback";
import { type PendingPrintPick, PrinterPickModal } from "./views/printers/PrinterPickModal";
import { type TransitionOptions, canConfirmPick, confirmedPickRequest, transitionArgs } from "./views/printers/markPrinting";

/** Banner text that reports a failure (shown without the ✓ and kept on screen longer). */
const looksLikeError = (msg: string) =>
  /\b(fail|failed|error|could not|couldn't|can't|cannot|nothing was|not saved|refused)\b/i.test(msg);

export default function App() {
  const [snapshot, setSnapshot] = useState<ShopSnapshot>(FALLBACK_SNAPSHOT);
  const [activeTab, setActiveTab] = useState<DockTab>("orders");
  // Live Settings: every screen re-renders when Settings saves.
  const shopSettings = useShopSettings();
  // First-run setup + app lock. Only decided once real settings + ledger loaded (never the mock).
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [ledgerLoaded, setLedgerLoaded] = useState(false);
  const [wizardMode, setWizardMode] = useState<"auto" | "rerun" | "off">("auto");
  const [lockStatus, setLockStatus] = useState<AppLockStatus | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [lockChecked, setLockChecked] = useState(false);
  useEffect(() => {
    void loadShopSettings();
    invoke<import("./types").ShopSettings>("get_shop_settings")
      .then((s) => {
        setShopSettings(s);
        setSettingsLoaded(true);
      })
      .catch(() => {});
    fetchLockStatus().then((st) => {
      setLockStatus(st);
      setLockChecked(true);
    });
  }, []);
  // Swift: anything other than "bottomTabs" is the sidebar.
  const useSidebar = shopSettings.navigation_chrome !== "bottomTabs";
  const [statusFilter, setStatusFilter] = useState<string>("All");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [andonWallMode, setAndonWallMode] = useState<boolean>(false);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [showSuggestedGroups, setShowSuggestedGroups] = useState<boolean>(false);
  const [showImportModal, setShowImportModal] = useState<boolean>(false);
  // The Product Editor's code loads on first open; once mounted it stays mounted (closed, it
  // renders nothing), exactly as when it was always mounted.
  const [importModalMounted, setImportModalMounted] = useState(false);
  if (showImportModal && !importModalMounted) setImportModalMounted(true);
  useEffect(() => {
    const t = window.setTimeout(preload3D, 2000);
    return () => window.clearTimeout(t);
  }, []);
  const [importDraft, setImportDraft] = useState<CreatedCatalogProductPayload | null>(null);
  const [showNewOrderModal, setShowNewOrderModal] = useState<boolean>(false);
  /** Order open in the order window (Edit Order), by id. */
  const [editOrderId, setEditOrderId] = useState<string | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [showFilamentLibrarySheet, setShowFilamentLibrarySheet] = useState<boolean>(false);
  const [kittingCardOrders, setKittingCardOrders] = useState<Order[]>([]);
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);

  const [pendingBulkOrder, setPendingBulkOrder] = useState<{
    order: Order;
    unfinishedUnits: PartUnit[];
  } | null>(null);

  const [activeUnitMenu, setActiveUnitMenu] = useState<{
    unit: PartUnit;
    x: number;
    y: number;
  } | null>(null);

  const [customProducts, setCustomProducts] = useState<
    Record<string, CreatedCatalogProductPayload>
  >({});

  useEffect(() => {
    registerCatalogProducts(snapshot.products, snapshot.filaments);
  }, [snapshot.products, snapshot.filaments]);

  // Replies then carry only the orders that changed since this snapshot (see tauriInvoke).
  useEffect(() => {
    setKnownSnapshot(snapshot);
  }, [snapshot]);

  useEffect(() => {
    invoke<ShopSnapshot>("get_shop_snapshot")
      .then((data) => {
        if (data && Array.isArray(data.orders) && Array.isArray(data.products)) {
          setSnapshot(data);
          setLedgerLoaded(true);
        } else {
          setBannerMessage("Could not load the shop ledger.");
        }
      })
      .catch((err) => {
        setBannerMessage(
          `Could not load the shop ledger: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
  }, []);

  // Undo is offered on a banner only when that banner reports the action it would revert.
  const [bannerUndoEventId, setBannerUndoEventId] = useState<string | null>(null);
  const [bannerIsError, setBannerIsError] = useState(false);
  const flashBanner = (msg: string, opts?: { undoEventId?: string | null; error?: boolean }) => {
    const isError = opts?.error ?? looksLikeError(msg);
    setBannerMessage(msg);
    setBannerUndoEventId(opts?.undoEventId ?? null);
    setBannerIsError(isError);
    window.setTimeout(() => {
      setBannerMessage((prev) => (prev === msg ? null : prev));
    }, isError ? 9000 : 4200);
  };
  const flashError = (msg: string) => flashBanner(msg, { error: true });
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  useBannerBus((msg, opts) => flashBanner(msg, { error: opts?.error }));
  const reloadSnapshot = async () => {
    try {
      const data = await invoke<ShopSnapshot>("get_shop_snapshot");
      if (data && Array.isArray(data.orders)) setSnapshot(data);
    } catch {
      // keep the current snapshot; the error that led here is already shown
    }
  };

  // Print! asks which printer gets the job before anything goes to the slicer. The same
  // picker offers Mark Printing: the same job and history, with no .3mf and no slicer.
  const [pendingPrint, setPendingPrint] = useState<PendingPrintPick | null>(null);
  // The optional plate view ("Arrange plate…" in the picker). Cancel goes back to the picker.
  const [plateView, setPlateView] = useState<PendingPrintPick | null>(null);
  const runTransition = async (req: TransitionRequest, opts?: TransitionOptions) => {
    const o: TransitionOptions = opts && typeof opts === "object" ? opts : {};
    if (!o.confirmed && req.to_state === "Printing" && !req.failure_reason) {
      // Never preselect a printer id that doesn't exist in this shop.
      const known = snapshot.printers.some((p) => p.id === req.printer_id);
      const ids = new Set(req.unit_ids);
      const stagedOnPrinter = allUnits.some((u) => ids.has(u.id) && u.state === "Staged" && !!u.printer_id);
      setPendingPrint({ req, printerId: known ? req.printer_id || "" : "", mode: o.markPrinting ? "mark" : "print", stagedOnPrinter });
      return;
    }
    try {
      const updated = await invoke<ShopSnapshot>(
        "transition_units",
        transitionArgs(req, { allowWithoutSlicer: o.allowWithoutSlicer, skipSlicer: o.markPrinting, layout: o.layout })
      );
      setSnapshot(updated);
      setActiveUnitMenu(null);
      // Newest undoable event written for these units = this action's batch.
      const ids = new Set(req.unit_ids);
      const own = updated.flow_events.find((ev) => ev.can_undo && ev.unit_id && ids.has(ev.unit_id));
      const label = o.markPrinting ? req.action_label : `${req.action_label} (${req.unit_ids.length} part${req.unit_ids.length === 1 ? "" : "s"})`;
      flashBanner(label, { undoEventId: own?.id ?? null, error: false });
    } catch (e) {
      const m = errText(e);
      if (m.startsWith("Nothing was moved to Printing: the slicer could not be opened")) {
        const anyway = await askConfirm({
          title: "The slicer didn't open",
          message: m,
          confirmLabel: "Mark Printing anyway",
          cancelLabel: "Leave in queue",
        });
        if (anyway) void runTransition(req, { confirmed: true, allowWithoutSlicer: true, layout: o.layout });
        else flashError("Nothing was moved to Printing.");
        return;
      }
      flashError(m.startsWith("Nothing was") ? m : `Couldn't update the parts: ${m}`);
    }
  };

  const handleUndoEvent = async (event: FlowEvent) => {
    if (!event.can_undo) {
      flashError("That action can't be undone.");
      return;
    }
    const batchSize = event.batch_id
      ? snapshot.flow_events.filter((ev) => ev.batch_id === event.batch_id && ev.can_undo).length
      : 1;
    try {
      const updated = await invoke<ShopSnapshot>("undo_flow_event", {
        eventId: event.id,
        actorDevice: actorDevice(),
      });
      setSnapshot(updated);
      flashBanner(
        `Undid: ${event.action_label} (${batchSize} part${batchSize === 1 ? "" : "s"})`,
        { error: false }
      );
    } catch (e) {
      // The backend may have marked the action as undone even when nothing could move.
      await reloadSnapshot();
      flashError(`Undo failed: ${errText(e)}`);
    }
  };

  /** Newest action that can still be undone (Cmd/Ctrl-Z). */
  const lastUndoableEvent = useMemo(
    () => snapshot.flow_events.find((ev) => ev.can_undo) || null,
    [snapshot.flow_events]
  );
  const bannerUndoEvent = useMemo(
    () =>
      bannerUndoEventId
        ? snapshot.flow_events.find((ev) => ev.id === bannerUndoEventId && ev.can_undo) || null
        : null,
    [snapshot.flow_events, bannerUndoEventId]
  );

  /**
   * Before saving a product: when a part stops being printed (Prints -> Color only /
   * Thumbnail only) while open orders use it, list what changes and ask first.
   * Queued parts are removed (and logged in Flow); parts already started are kept.
   */
  const confirmPartRoleChanges = async (
    productId: string,
    nextParts: Array<{ id: string; name: string; is_tracked: boolean; is_color_only: boolean }>
  ): Promise<boolean> => {
    const prev = snapshot.products.find((p) => p.id === productId);
    if (!prev) return true;
    const printed = (pt?: { is_tracked: boolean; is_color_only: boolean }) =>
      !!pt && pt.is_tracked && !pt.is_color_only;
    const changed = nextParts.filter((pt) => printed(prev.parts.find((o) => o.id === pt.id)) && !printed(pt));
    if (!changed.length) return true;
    const ids = new Set(changed.map((p) => p.id));
    let queued = 0;
    const details: string[] = [];
    for (const o of snapshot.orders) {
      const units = o.lines
        .flatMap((l) => l.units)
        .filter((u) => ids.has(u.part_id) && u.state !== "Shipped" && u.state !== "Closed");
      if (!units.length) continue;
      const q = units.filter((u) => u.state === "Queued").length;
      const started = units.length - q;
      queued += q;
      const bits = [
        q ? `${q} queued part${q === 1 ? "" : "s"} removed` : "",
        started ? `${started} already started kept` : "",
      ].filter(Boolean);
      details.push(`${o.order_code} · ${o.customer_name}: ${bits.join(", ")}`);
    }
    if (!details.length) return true;
    return askConfirm({
      title: `Stop printing ${changed.map((p) => p.name).join(", ")}?`,
      message:
        "These open orders use this part. Queued parts that haven't started are removed from the orders and logged in Flow. " +
        "Parts already staged, printing or printed are kept, and show again if you switch the part back to Prints.",
      details,
      confirmLabel: queued ? `Save and remove ${queued} queued` : "Save",
      danger: queued > 0,
    });
  };

  const handleSaveImportedProduct = async (
    payload: CreatedCatalogProductPayload
  ): Promise<boolean> => {
    const okToSave = await confirmPartRoleChanges(
      payload.id,
      payload.parts.map((pt) => ({
        id: pt.id,
        name: pt.partName,
        is_tracked: pt.role === "Prints",
        is_color_only: pt.role === "Color only",
      }))
    );
    if (!okToSave) return false;
    setCustomProducts((prev) => ({
      ...prev,
      [payload.id]: payload,
    }));

    const filamentFor = (name: string, hex: string) => {
      const byName = snapshot.filaments.find(
        (f) => f.name.toLowerCase() === name.toLowerCase()
      );
      if (byName) return byName.id;
      const want = (hex || "").replace("#", "").toLowerCase();
      const byHex = snapshot.filaments.find(
        (f) => f.hex.replace("#", "").toLowerCase() === want
      );
      return byHex?.id || snapshot.filaments[0]?.id || "color-unknown";
    };

    if (payload.compositeThumbnailDataUrl) {
      registerProductComposite(payload.id, payload.compositeThumbnailDataUrl);
    }
    // One file stem per part id, so same-named parts don't overwrite each other's files.
    const partStems = assignPartStems(payload.parts);
    const stemOf = (pt: { id: string; partName: string }) => partStems.get(pt.id) || catalogPartStem(pt.partName);
    for (const pt of payload.parts) {
      const picture = pt.neutralThumbnailDataUrl || pt.bakedThumbnailDataUrl;
      if (picture) {
        registerCustomNeutralPartPng(`${payload.id}::${pt.id}`, picture);
        // Name key only when the name is unique; a duplicate name can't pick one picture.
        if (payload.parts.filter((o) => o.partName === pt.partName).length === 1) {
          registerCustomNeutralPartPng(`${payload.id}::${pt.partName}`, picture);
        }
      }
    }
    // Per-part layers (same camera as product.png) let order thumbnails recolor live.
    // Layer files are keyed per part, not per name: duplicate names ("Handle", "Handle")
    // would otherwise overwrite each other's layer_<stem>.png.
    const usedLayerStems = new Set<string>();
    const layers = (payload.compositeLayers || []).map((l) => ({
      imageStem: (() => {
        const base = `layer_${catalogPartStem(l.partName)}`;
        let stem = base;
        for (let n = 2; usedLayerStems.has(stem.toLowerCase()); n++) stem = `${base}_${n}`;
        usedLayerStems.add(stem.toLowerCase());
        return stem;
      })(),
      partId: l.partId || "",
      iconStem: (() => {
        const pt = payload.parts.find((p) => p.id === l.partId);
        return pt ? stemOf(pt) : catalogPartStem(l.partName);
      })(),
      name: l.partName,
      compositeZ: l.compositeZ,
      dataUrl: l.dataUrl,
    }));
    if (layers.length) {
      registerProductLayers(
        payload.id,
        layers.map(({ dataUrl, ...rest }) => ({ ...rest, file: dataUrl }))
      );
    }
    let pictureError = null as string | null;
    await invoke("save_product_thumbnail", {
      product_id: payload.id,
      png_data_url: payload.compositeThumbnailDataUrl || "",
      parts: [
        ...payload.parts.map((pt) => {
          const hasMesh = pt.meshIndices.length > 0;
          const pic = pt.neutralThumbnailDataUrl || pt.bakedThumbnailDataUrl || "";
          return {
            stem: stemOf(pt),
            // A part with no saved mesh (older import reopened in Edit) keeps its existing picture.
            png_data_url: hasMesh && pic.startsWith("data:") ? pic : "",
            // Binary STL so Edit can reopen this product with its 3D parts.
            stl_b64: hasMesh ? meshToStlBase64(pt.meshPositions, pt.meshIndices) : "",
          };
        }),
        ...layers.map((l) => ({ stem: l.imageStem, png_data_url: l.dataUrl })),
      ],
      // Each part tile's camera, so reopening the editor restores the part pictures' views.
      part_icon_cameras_json: (() => {
        const cams: Record<string, unknown> = {};
        for (const pt of payload.parts) {
          if (pt.thumbnailCamera) cams[pt.id] = partIconCameraToJson(pt.thumbnailCamera);
        }
        return JSON.stringify({ version: 1, part_icon_cameras: cams });
      })(),
      editor_json: buildEditorJson(payload),
      layers_json: layers.length
        ? JSON.stringify({
            version: 1,
            layers: layers.map(({ dataUrl: _dataUrl, ...rest }) => rest),
          })
        : "",
    }).catch((e) => {
      pictureError = errText(e);
    });
    clearOrderModelCache(payload.id); // order 3D views reload the re-saved meshes

    const newCatalogProduct: Product = {
      id: payload.id,
      name: payload.name,
      sku: payload.sku,
      price_cents: Math.round(payload.basePriceUsd * 100),
      packed_weight_oz: 4.5,
      default_box_name: `${payload.shippingBox} Box`,
      box_cost_cents:
        payload.shippingBox === "Small"
          ? 1089
          : payload.shippingBox === "Medium"
          ? 2028
          : 2806,
      supports_custom_text: payload.inscription.enabled,
      parts: payload.parts.map((pt, idx) => ({
        id: pt.id,
        product_id: payload.id,
        name: pt.partName,
        is_tracked: pt.role === "Prints",
        is_color_only: pt.role === "Color only",
        default_filament_id: filamentFor(pt.defaultColorName, pt.defaultColorHex),
        grams: pt.grams,
        print_minutes: pt.printMinutes,
        unit_cost: 0,
        // Points at the picture saved under catalog/<productId>/parts/ by save_product_thumbnail.
        mesh_file: `${stemOf(pt)}.png`,
        sort_order: idx,
      })),
    };

    try {
      const updated = await invoke<ShopSnapshot>("upsert_product", {
        product: newCatalogProduct,
      });
      setSnapshot(updated);
    } catch (e) {
      // Keep the editor open so nothing is lost; the ledger is unchanged.
      flashError(`"${newCatalogProduct.name}" was not saved: ${errText(e)}`);
      return false;
    }
    setShowImportModal(false);
    setImportDraft(null);
    setActiveTab("products");
    if (pictureError) {
      flashError(`Saved "${newCatalogProduct.name}", but its pictures and model files could not be saved: ${pictureError}`);
    } else {
      flashBanner(
        `Saved "${newCatalogProduct.name}" (${newCatalogProduct.parts.length} parts with 3D thumbnails)`
      );
    }
    return true;
  };

  const handleSaveEditedProduct = async (product: Product) => {
    if (!(await confirmPartRoleChanges(product.id, product.parts))) return;
    try {
      const updated = await invoke<ShopSnapshot>("upsert_product", { product });
      setSnapshot(updated);
    } catch (e) {
      flashError(`“${product.name}” was not saved: ${errText(e)}`);
      return;
    }
    flashBanner(`Saved “${product.name}”`);
  };

  const handleDeleteProduct = async (product: Product) => {
    try {
      const updated = await invoke<ShopSnapshot>("delete_product", {
        product_id: product.id,
      });
      setSnapshot(updated);
    } catch (e) {
      flashError(`“${product.name}” was not deleted: ${errText(e)}`);
      return;
    }
    setCustomProducts((prev) => {
      const next = { ...prev };
      delete next[product.id];
      return next;
    });
    forgetCatalogProduct(product.id);
    clearOrderModelCache(product.id);
    flashBanner(`Deleted “${product.name}”`);
  };

  const allUnits = useMemo(
    () => snapshot.orders.flatMap((o) => o.lines.flatMap((l) => l.units)),
    [snapshot.orders]
  );

  const orderById = useMemo(
    () => new Map<string, Order>(snapshot.orders.map((o) => [o.id, o])),
    [snapshot.orders]
  );
  const editingOrder = editOrderId ? orderById.get(editOrderId) ?? null : null;

  const productById = useMemo(
    () => new Map<string, Product>(snapshot.products.map((p) => [p.id, p])),
    [snapshot.products]
  );

  const sortedPrinters = useMemo(() => {
    // Count each printer's active parts once (was a full scan per comparison).
    const active = new Map<string, number>();
    for (const u of allUnits) {
      if (u.printer_id && (u.state === "Staged" || u.state === "Printing" || u.state === "Queued")) {
        active.set(u.printer_id, (active.get(u.printer_id) || 0) + 1);
      }
    }
    return [...snapshot.printers].sort((a, b) => {
      const aActive = active.get(a.id) || 0;
      const bActive = active.get(b.id) || 0;
      if (aActive !== bActive) return bActive - aActive;
      return a.name.localeCompare(b.name);
    });
  }, [snapshot.printers, allUnits]);

  const activeOrders = useMemo(() => {
    return snapshot.orders.filter((o) => {
      if (o.overall_state === "Shipped" || o.overall_state === "Cancelled")
        return false;
      if (statusFilter === "Waiting") {
        if (
          o.overall_state !== "Waiting" &&
          o.overall_state !== "Queued" &&
          o.overall_state !== "Staged"
        )
          return false;
      } else if (statusFilter === "Ready to Ship") {
        const units = o.lines.flatMap((l) => l.units);
        const isReady =
          o.overall_state === "Ready" ||
          o.overall_state === "Ready to Ship" ||
          (units.length > 0 &&
            units.every((u) => u.state === "Ready" || u.state === "Shipped" || u.state === "Closed"));
        if (!isReady) return false;
      } else if (statusFilter !== "All" && o.overall_state !== statusFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchOrder =
          o.order_code.toLowerCase().includes(q) ||
          o.customer_name.toLowerCase().includes(q) ||
          o.lines.some(
            (l) =>
              l.product_name.toLowerCase().includes(q) ||
              (l.custom_text && l.custom_text.toLowerCase().includes(q))
          );
        if (!matchOrder) return false;
      }
      return true;
    });
  }, [snapshot.orders, statusFilter, searchQuery]);

  // Per-order-line pictures: load them for open orders, draw website orders' pictures once,
  // and redraw a picture (same angle) when a line's filament changes. Local only.
  const openOrders = useMemo(
    () => snapshot.orders.filter((o) => o.overall_state !== "Shipped" && o.overall_state !== "Cancelled"),
    [snapshot.orders]
  );
  useOrderThumbAutoRender(openOrders, productById, snapshot.filaments);

  const readyToShipOrders = useMemo(() => {
    return snapshot.orders.filter((o) => {
      if (o.overall_state === "Shipped" || o.overall_state === "Cancelled")
        return false;
      const units = o.lines.flatMap((l) => l.units);
      return (
        units.length > 0 &&
        units.every((u) => u.state === "Ready" || u.state === "Shipped" || u.state === "Closed")
      );
    });
  }, [snapshot.orders]);

  const historyOrders = useMemo(() => {
    return snapshot.orders.filter(
      (o) =>
        o.overall_state === "Shipped" ||
        o.lines
          .flatMap((l) => l.units)
          .every((u) => u.state === "Ready" || u.state === "Shipped" || u.state === "Closed")
    );
  }, [snapshot.orders]);

  const waitingParts = useMemo(
    () => allUnits.filter((u) => u.state === "Queued" || u.state === "Staged"),
    [allUnits]
  );

  const statusCounts = useMemo(
    () => ({
      All: snapshot.orders.filter(
        (o) => o.overall_state !== "Shipped" && o.overall_state !== "Cancelled"
      ).length,
      Waiting: snapshot.orders.filter(
        (o) =>
          o.overall_state === "Waiting" ||
          o.overall_state === "Queued" ||
          o.overall_state === "Staged"
      ).length,
      Printing: snapshot.orders.filter((o) => o.overall_state === "Printing")
        .length,
      "Ready to Ship": readyToShipOrders.length,
    }),
    [snapshot.orders, readyToShipOrders.length]
  );

  const selectedOrder = useMemo(
    () =>
      selectedOrderId
        ? snapshot.orders.find((o) => o.id === selectedOrderId) || null
        : null,
    [snapshot.orders, selectedOrderId]
  );

  const closeUnitMenu = useCallback(() => setActiveUnitMenu(null), []);

  const handleSelectUnit = (unit: PartUnit, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setActiveUnitMenu({
      unit,
      x: Math.min(window.innerWidth - 260, rect.left),
      y: Math.min(window.innerHeight - 310, rect.bottom + 6),
    });
  };

  const triggerMarkOrderProcessed = (order: Order) => {
    const units = order.lines.flatMap((l) => l.units);
    const unfinished = units.filter(
      (u) => u.state !== "Ready" && u.state !== "Shipped" && u.state !== "Closed"
    );
    if (unfinished.length > 0) {
      setPendingBulkOrder({ order, unfinishedUnits: unfinished });
      return;
    }
    runTransition({
      unit_ids: units.map((u) => u.id),
      to_state: "Ready",
      actor_device: actorDevice(),
      source_surface: "All Orders",
      printer_id: null,
      failure_reason: null,
      failure_note: null,
      action_label: `Marked ${order.order_code} Processed`,
    });
  };

  // Shop Flow badge: today's activity, not the whole history.
  const flowToday = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const t0 = start.getTime();
    return snapshot.flow_events.filter((ev) => Date.parse(ev.created_at) >= t0).length;
  }, [snapshot.flow_events]);

  const dockBadges = {
          orders: activeOrders.length,
          // Orders on the floor (open work), not every part ever made.
          andon: openOrders.length,
          printers: snapshot.printers.length,
          parts: waitingParts.length,
          overstock: snapshot.overstock.length,
          flow: flowToday,
          products: snapshot.products.length,
          ready: readyToShipOrders.length,
          history: historyOrders.length,
        };

  // App lock: nothing from the shop renders until the lock status is known, and only the
  // lock screen renders while locked.
  const lockMethod = lockStatus ? effectiveLockMethod(lockStatus) : null;
  if (!lockChecked) {
    return <div className="fp-shell" />;
  }
  if (lockMethod && !unlocked) {
    return (
      <div className="fp-shell">
        <LockScreen
          method={lockMethod}
          status={lockStatus!}
          shopName={shopSettings.shop_name}
          onUnlocked={() => setUnlocked(true)}
        />
      </div>
    );
  }

  return (
    <div
      className={`fp-shell ${useSidebar ? "fp-nav-sidebar" : ""}`}
      onClick={() => {
        if (activeUnitMenu) setActiveUnitMenu(null);
      }}
    >
      <UpdateBanner />
      <ConfirmHost />
      {pendingPrint && (
        <PrinterPickModal
          pending={pendingPrint}
          printers={snapshot.printers}
          onChange={setPendingPrint}
          onCancel={() => setPendingPrint(null)}
          onConfirm={(mode) => {
            const { req, printerId } = pendingPrint;
            if (!canConfirmPick(mode, printerId, snapshot.printers)) return;
            setPendingPrint(null);
            void runTransition(confirmedPickRequest(req, mode, printerId, snapshot.printers), {
              confirmed: true,
              markPrinting: mode === "mark",
            });
          }}
          onArrange={() => {
            if (!canConfirmPick("print", pendingPrint.printerId, snapshot.printers)) return;
            setPlateView(pendingPrint);
            setPendingPrint(null);
          }}
        />
      )}
      {plateView && (
        <Suspense fallback={null}>
          <PlateView
            unitIds={plateView.req.unit_ids}
            printers={snapshot.printers}
            printerId={plateView.printerId}
            onSnapshot={(snap) => setSnapshot(snap)}
            onCancel={() => {
              setPendingPrint(plateView);
              setPlateView(null);
            }}
            onSend={({ unitIds, printerId, layout }) => {
              // Parts removed in the plate view leave this job only; they stay in Parts to Print.
              const req = { ...plateView.req, unit_ids: unitIds };
              setPlateView(null);
              void runTransition(confirmedPickRequest(req, "print", printerId, snapshot.printers), { confirmed: true, layout });
            }}
          />
        </Suspense>
      )}
      {useSidebar && !andonWallMode && (
        <SidebarNav
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onOpenSettings={() => setShowSettingsModal(true)}
          badges={dockBadges}
        />
      )}
      <div className="fp-shell-column" style={useSidebar ? undefined : { display: "contents" }}>
      <TopHeader
        activeTab={activeTab}
        onTabChange={setActiveTab}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        statusCounts={statusCounts}
        wallMode={andonWallMode}
        andonWallMode={andonWallMode}
        onToggleWallMode={(next) => {
          setAndonWallMode(next);
          if (next && activeTab !== "andon" && activeTab !== "printers") {
            setActiveTab("andon");
          }
        }}
        ordersCount={snapshot.orders.length}
        waitingPartsCount={waitingParts.length}
        totalPartsCount={allUnits.length}
        bannerMessage={bannerMessage}
        bannerIsError={bannerIsError}
        onBannerUndo={bannerUndoEvent ? () => handleUndoEvent(bannerUndoEvent) : undefined}
        onUndoLastAction={lastUndoableEvent ? () => handleUndoEvent(lastUndoableEvent) : undefined}
        onOpenPrintGroups={() => {
          setActiveTab("parts");
          setShowSuggestedGroups(true);
        }}
        onOpenImportModal={() => {
          setImportDraft(null);
          setShowImportModal(true);
        }}
        onOpenNewOrderModal={() => setShowNewOrderModal(true)}
        onOpenFilamentLibrary={() => setShowFilamentLibrarySheet(true)}
        onOpenSettings={() => setShowSettingsModal(true)}
      />

      <main className="fp-main">
        {activeTab === "orders" && (
          <AllOrdersView
            activeOrders={activeOrders}
            orderById={orderById}
            productById={productById}
            filaments={snapshot.filaments}
            sortedPrinters={sortedPrinters}
            customProducts={customProducts}
            selectedOrderId={selectedOrderId}
            onSelectOrder={setSelectedOrderId}
            onSelectUnit={handleSelectUnit}
            onRunTransition={runTransition}
            onTriggerProcessed={triggerMarkOrderProcessed}
            onFlashBanner={flashBanner}
            onSnapshotUpdated={setSnapshot}
            onOpenNewOrderModal={() => setShowNewOrderModal(true)}
            onPrintKittingCards={(ords: Order[]) => setKittingCardOrders(ords)}
          />
        )}

        {activeTab === "andon" && (
          <AndonBoardView
            orders={openOrders}
            allUnits={allUnits}
            orderById={orderById}
            customProducts={customProducts}
            andonWallMode={andonWallMode}
            onToggleWallMode={setAndonWallMode}
            onSelectUnit={handleSelectUnit}
            onSelectOrder={setSelectedOrderId}
            onRunTransition={runTransition}
          />
        )}

        {activeTab === "printers" && (
          <PrintersView
            snapshot={snapshot}
            onTransition={runTransition}
            onSelectUnit={handleSelectUnit}
            showSuggestedGroups={showSuggestedGroups}
            onToggleSuggestedGroups={(open) => {
              setActiveTab("parts");
              setShowSuggestedGroups(open);
            }}
            wallMode={andonWallMode}
            onToggleWallMode={setAndonWallMode}
            onSnapshotUpdated={setSnapshot}
          />
        )}

        {activeTab === "parts" && (
          <PartsToPrintView
            snapshot={snapshot}
            onTransition={runTransition}
            onSelectUnit={handleSelectUnit}
            onSnapshotUpdated={setSnapshot}
            showSuggestedGroups={showSuggestedGroups}
            onToggleSuggestedGroups={setShowSuggestedGroups}
          />
        )}

        {activeTab === "overstock" && (
          <OverstockView overstock={snapshot.overstock} snapshot={snapshot} onSnapshotUpdated={setSnapshot} />
        )}

        {activeTab === "flow" && (
          <FlowView
            snapshot={snapshot}
            events={snapshot.flow_events}
            onUndoEvent={handleUndoEvent}
            onSnapshotUpdated={setSnapshot}
            onSelectOrder={setSelectedOrderId}
          />
        )}

        {activeTab === "products" && (
          ledgerLoaded && snapshot.products.length === 0 && Object.keys(customProducts).length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: "80px 20px", textAlign: "center" }}>
              <div style={{ fontSize: 18, fontWeight: 700 }}>No products yet</div>
              <div style={{ fontSize: 13, opacity: 0.75, maxWidth: 380 }}>Import a 3MF or STL to add your first one.</div>
              <button type="button" className="fp-btn fp-btn-primary" onClick={() => { setImportDraft(null); setShowImportModal(true); }}>
                Import your first model
              </button>
            </div>
          ) : (
          <ProductsCatalogView
            products={snapshot.products}
            filaments={snapshot.filaments}
            customProducts={customProducts}
            onOpenImportModal={() => {
              setImportDraft(null);
              setShowImportModal(true);
            }}
            onSaveProduct={handleSaveEditedProduct}
            onDeleteProduct={handleDeleteProduct}
            onOpenStudio={(product) => {
              const draft = customProducts[product.id];
              if (draft) {
                setImportDraft(draft);
                setShowImportModal(true);
                return;
              }
              // Existing product: rebuild the editor draft from catalog/<id>/ (meshes, editor.json, tile cameras).
              void loadProductEditorDraft(product, snapshot.filaments)
                .then(({ draft: loaded, missingMeshes }) => {
                  setImportDraft(loaded);
                  setShowImportModal(true);
                  if (missingMeshes.length) {
                    flashBanner(
                      `No saved 3D model for: ${missingMeshes.join(", ")}. Those parts keep their current pictures; re-import them to edit in 3D.`
                    );
                  }
                })
                .catch((e) => flashBanner(`Couldn't open "${product.name}" in the editor: ${String(e)}`));
            }}
          />
          )
        )}

        {activeTab === "ready" && (
          <ReadyToShipView
            readyToShipOrders={readyToShipOrders}
            productById={productById}
            filaments={snapshot.filaments}
            customProducts={customProducts}
            onRunTransition={runTransition}
          />
        )}

        {activeTab === "history" && (
          <HistoryView
            orders={snapshot.orders}
            products={snapshot.products}
            onSelectOrder={(id) => setSelectedOrderId(id)}
          />
        )}

        {activeTab === "value" && (
          <ProductionValueView
            analytics={snapshot.analytics}
            orders={snapshot.orders}
            snapshot={snapshot}
          />
        )}

        {activeTab === "people" && (
          <PeopleView
            orders={snapshot.orders}
            onSelectOrder={(id) => setSelectedOrderId(id)}
          />
        )}
      </main>

      <UnitStatePopover
        activeUnitMenu={activeUnitMenu}
        sortedPrinters={sortedPrinters}
        filaments={snapshot.filaments}
        onSnapshotUpdated={setSnapshot}
        onRunTransition={runTransition}
        onClose={closeUnitMenu}
      />

      <OrderModals
        pendingBulkOrder={pendingBulkOrder}
        onCloseBulkOrder={() => setPendingBulkOrder(null)}
        selectedOrder={selectedOrder}
        onCloseSelectedOrder={() => setSelectedOrderId(null)}
        onSelectOrder={setSelectedOrderId}
        allOrders={activeOrders}
        orderById={orderById}
        productById={productById}
        filaments={snapshot.filaments}
        sortedPrinters={sortedPrinters}
        customProducts={customProducts}
        onSelectUnit={handleSelectUnit}
        onRunTransition={runTransition}
        onSnapshotUpdated={setSnapshot}
        onEditOrder={(o) => setEditOrderId(o.id)}
      />
      {kittingCardOrders.length > 0 && (
        <KittingCardModal
          orders={kittingCardOrders}
          onClose={() => setKittingCardOrders([])}
        />
      )}

      {(showNewOrderModal || editingOrder) && (
        <Suspense fallback={null}>
          <NewOrderSheet
            // One window for New Order and Edit Order; a fresh one for each order.
            key={editingOrder ? `edit:${editingOrder.id}` : "new"}
            snapshot={snapshot}
            editOrder={editingOrder}
            onClose={() => { setShowNewOrderModal(false); setEditOrderId(null); }}
            onCreated={(snap, msg) => {
              setSnapshot(snap);
              setShowNewOrderModal(false);
              setEditOrderId(null);
              flashBanner(msg);
            }}
            onOrderThumbnails={async (items) => {
              // Each new order line's own picture + camera, saved locally (never synced).
              let failed = 0;
              for (const it of items) {
                if (!it.orderLineId) continue;
                try {
                  await saveOrderLineThumb(it.orderId, it.orderLineId, it.productId, it.thumbnail, it.source ?? "new_order");
                } catch {
                  failed += 1;
                }
              }
              if (failed) flashBanner(`Order saved, but ${failed} order picture${failed === 1 ? "" : "s"} couldn't be saved.`);
            }}
          />
        </Suspense>
      )}

      {importModalMounted && (
        <Suspense fallback={null}>
          <ProductImportModal3D
            open={showImportModal}
            editingDraft={importDraft}
            onClose={() => {
              setShowImportModal(false);
              setImportDraft(null);
            }}
            onCreateProduct={handleSaveImportedProduct}
            filaments={snapshot.filaments}
          />
        </Suspense>
      )}

      {showFilamentLibrarySheet && (
        <FilamentLibrarySheet
          snapshot={snapshot}
          onSnapshot={(s) => {
            setSnapshot(s);
            flashBanner("Filament library updated");
          }}
          onClose={() => setShowFilamentLibrarySheet(false)}
        />
      )}

      <SettingsModal
        open={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        snapshot={snapshot}
        onSnapshotUpdated={setSnapshot}
        onNavigateTab={setActiveTab}
        onFlashBanner={flashBanner}
        onRunSetup={() => setWizardMode("rerun")}
      />

      {settingsLoaded && ledgerLoaded && (wizardMode === "rerun" || (wizardMode === "auto" && needsSetup(shopSettings, snapshot))) && (
        <SetupWizard
          initial={shopSettings}
          fresh={wizardMode !== "rerun"}
          onCancel={wizardMode === "rerun" ? () => setWizardMode("off") : undefined}
          onFinished={(snap, openImport, goTo) => {
            if (snap) setSnapshot(snap);
            setWizardMode("off");
            setActiveTab(goTo || "products");
            if (openImport) {
              setImportDraft(null);
              setShowImportModal(true);
            }
          }}
        />
      )}


      {!useSidebar && (
        <BottomDock
          activeTab={activeTab}
          onOpenFilamentLibrary={() => setShowFilamentLibrarySheet(true)}
          onOpenSettings={() => setShowSettingsModal(true)}
          onTabChange={setActiveTab}
          badges={dockBadges}
        />
      )}
      </div>
    </div>
  );
}

/** Same stem rule the backend uses for catalog/<productId>/parts/<stem>.png. */
function catalogPartStem(name: string): string {
  return (name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "part";
}
