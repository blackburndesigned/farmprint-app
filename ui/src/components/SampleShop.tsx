import React, { useEffect, useState } from "react";
import { invoke } from "../tauriInvoke";
import { askConfirm, notifyBanner } from "../uiFeedback";
import { errorText } from "../errorText";
import { ShopSnapshot } from "../types";

/**
 * "Load sample shop": a made-up demo shop (fp-core `sample`) so a new user can look around
 * before adding their own products. Offered only while the shop has no orders and no
 * products; the backend refuses otherwise. "Clear sample data" removes only sample rows.
 */
export interface SampleShopStatus {
  can_load: boolean;
  has_sample: boolean;
  own_orders: number;
}

export async function loadSampleShop(): Promise<ShopSnapshot> {
  const snap = await invoke<ShopSnapshot>("load_sample_shop");
  notifyBanner("Sample shop loaded. Everything in it is made up; clear it any time in Settings › General.");
  return snap;
}

/** Status for the current snapshot; null outside the app or while loading. */
export function useSampleShopStatus(snapshot: ShopSnapshot | null | undefined): SampleShopStatus | null {
  const [status, setStatus] = useState<SampleShopStatus | null>(null);
  const key = snapshot ? `${snapshot.orders.length}:${snapshot.products.length}:${snapshot.printers.length}:${snapshot.filaments.length}` : "";
  useEffect(() => {
    let alive = true;
    invoke<SampleShopStatus>("sample_shop_status")
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, [key]);
  return status;
}

/** All Orders when the shop is empty: start with your own product, or load the sample shop. */
export const SampleShopEmptyState: React.FC<{
  onSnapshotUpdated: (s: ShopSnapshot) => void;
  onOpenNewOrderModal?: () => void;
}> = ({ onSnapshotUpdated, onOpenNewOrderModal }) => {
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    try {
      onSnapshotUpdated(await loadSampleShop());
    } catch (e) {
      notifyBanner(`Couldn't load the sample shop: ${errorText(e)}`, { error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fp-card" style={{ maxWidth: 520, margin: "48px auto", padding: 24, textAlign: "center" }}>
      <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>No orders yet</div>
      <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 18 }}>
        Add a product from the Products tab and create your first order. Or load a sample shop with made-up
        orders, printers and products to see how FarmPrint works. You can clear it any time in Settings › General.
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        <button type="button" className="fp-btn fp-btn-primary" disabled={busy} onClick={load}>
          {busy ? "Loading…" : "Load sample shop"}
        </button>
        {onOpenNewOrderModal && (
          <button type="button" className="fp-btn" disabled={busy} onClick={onOpenNewOrderModal}>
            New Order
          </button>
        )}
      </div>
    </div>
  );
};

/** Settings › General: load the sample shop into an empty shop, or clear it again. */
export const SampleShopSettingsSection: React.FC<{
  snapshot: ShopSnapshot | null | undefined;
  onSnapshotUpdated?: (s: ShopSnapshot) => void;
  Section: React.FC<{ title?: string; footer?: string; children: React.ReactNode }>;
}> = ({ snapshot, onSnapshotUpdated, Section }) => {
  const status = useSampleShopStatus(snapshot);
  const [busy, setBusy] = useState(false);
  if (!status || !onSnapshotUpdated || (!status.has_sample && !status.can_load)) return null;

  const clear = async () => {
    const ok = await askConfirm({
      title: "Clear sample data?",
      message: "Removes the sample orders, products, printers and filaments. A backup is made first.",
      details:
        status.own_orders > 0
          ? [`Your own ${status.own_orders === 1 ? "order is" : `${status.own_orders} orders are`} kept, with any sample product ${status.own_orders === 1 ? "it uses" : "they use"}.`]
          : undefined,
      confirmLabel: "Clear sample data",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const reply = await invoke<ShopSnapshot & { sample_kept_products?: string[] }>("clear_sample_data");
      onSnapshotUpdated(reply);
      const kept = reply.sample_kept_products || [];
      notifyBanner(kept.length ? `Sample data cleared. Kept ${kept.join(", ")}, used by your own orders.` : "Sample data cleared.");
    } catch (e) {
      notifyBanner(`Couldn't clear the sample data: ${errorText(e)}`, { error: true });
    } finally {
      setBusy(false);
    }
  };
  const load = async () => {
    setBusy(true);
    try {
      onSnapshotUpdated(await loadSampleShop());
    } catch (e) {
      notifyBanner(`Couldn't load the sample shop: ${errorText(e)}`, { error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Sample shop"
      footer={
        status.has_sample
          ? "Sample orders, products, printers and filaments are made up. Clearing removes only them; anything you added yourself stays."
          : "Made-up orders, printers and products to look around with. Only available while the shop is empty."
      }
    >
      {status.has_sample ? (
        <button type="button" className="fp-btn fp-btn-sm fp-btn-danger" disabled={busy} onClick={clear}>
          {busy ? "Clearing…" : "Clear sample data"}
        </button>
      ) : (
        <button type="button" className="fp-btn fp-btn-sm" disabled={busy} onClick={load}>
          {busy ? "Loading…" : "Load sample shop"}
        </button>
      )}
    </Section>
  );
};
