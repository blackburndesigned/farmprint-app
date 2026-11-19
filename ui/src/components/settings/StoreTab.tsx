import React, { useEffect, useState } from "react";
import { askConfirm } from "../../uiFeedback";
import { ProductShippingSetting, ShippingBoxPreset, ShippingTier, ShipsTogetherRule, ShopSettings, ShopSnapshot } from "../../types";
import { Check, NumField, Row, Section, type Setter, caption, copyText, inputStyle, sectionTitle } from "./settingsUi";
import { PublishCatalogSection, ShopAccountSection } from "./StoreAccountSections";

// --- Store (link, shop connection, catalog, orders, shipping, boxes) ---

const TIER_OPTIONS: Array<[ShippingTier, string]> = [
  ["not_set", "Not set"],
  ["ignore", "Don't ship"],
  ["small", "Small"],
  ["medium", "Medium"],
  ["large", "Large"],
];
const BOX_TIERS = TIER_OPTIONS.filter(([t]) => t === "small" || t === "medium" || t === "large");

/** Store › Shipping keys fp-core keeps but `ShopSettings` (types.ts) doesn't list. */
type CheckoutShippingSettings = {
  /** True once a flat rate was entered, so $0 is a real rate (not "use the shop default"). */
  flat_shipping_cents_set?: boolean;
  /** Absent = legacy (free over the entered amount, or $40 when blank); false = never free. */
  free_shipping_threshold_enabled?: boolean;
};

/** Dollars input stored as cents. Blank shows the placeholder (the shop default). */
const DollarField: React.FC<{ cents: number | null; onChange: (cents: number) => void; placeholder: string }> = ({
  cents,
  onChange,
  placeholder,
}) => {
  const [text, setText] = useState(cents === null ? "" : (cents / 100).toFixed(2));
  useEffect(() => {
    const parsed = Math.round(parseFloat(text) * 100);
    if (cents === null ? text !== "" : parsed !== cents) setText(cents === null ? "" : (cents / 100).toFixed(2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cents]);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      $
      <input
        type="number"
        min={0}
        step={0.01}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v >= 0) onChange(Math.round(v * 100));
        }}
        style={{ ...inputStyle, width: 110 }}
      />
    </span>
  );
};

/** Decimal number input (inches, ounces). Blank = 0. */
const DecField: React.FC<{ value: number; onChange: (n: number) => void; label: string; width?: number }> = ({
  value,
  onChange,
  label,
  width,
}) => (
  <input
    type="number"
    min={0}
    step={0.1}
    aria-label={label}
    title={label}
    placeholder={label}
    value={value ? value : ""}
    onChange={(e) => {
      const v = parseFloat(e.target.value);
      onChange(Number.isFinite(v) && v > 0 ? v : 0);
    }}
    style={{ ...inputStyle, width: width ?? 64 }}
  />
);

/** Store › Shipping boxes: the boxes you pack in. Edit product picks one per product. */
const ShippingBoxesSection: React.FC<{ boxes: ShippingBoxPreset[]; onChange: (boxes: ShippingBoxPreset[]) => void }> = ({
  boxes,
  onChange,
}) => {
  const set = (i: number, p: Partial<ShippingBoxPreset>) => onChange(boxes.map((b, j) => (j === i ? { ...b, ...p } : b)));
  const add = () =>
    onChange([
      ...boxes,
      {
        id: `box-${Date.now().toString(36)}`,
        name: `Box ${boxes.length + 1}`,
        length_in: 0,
        width_in: 0,
        height_in: 0,
        box_weight_oz: 0,
        cost_cents: 0,
      },
    ]);
  const remove = async (i: number) => {
    const ok = await askConfirm({
      title: `Delete the box "${boxes[i].name}"?`,
      message: "Products that use it will show it as not in your shipping boxes until you pick another.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) onChange(boxes.filter((_, j) => j !== i));
  };
  return (
    <Section
      title="Shipping boxes"
      footer="The boxes you pack in, in inches and ounces. Pick one per product in Edit product. Sent with the catalog for packing; checkout still charges the flat rate above."
    >
      {boxes.length === 0 && <div style={caption}>No boxes yet. Add the boxes you ship in.</div>}
      {boxes.map((b, i) => (
        <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 12.5 }}>
          <input
            type="text"
            value={b.name}
            aria-label="Box name"
            placeholder="Box name"
            onChange={(e) => set(i, { name: e.target.value })}
            style={{ ...inputStyle, width: 150 }}
          />
          <DecField label="Length (in)" value={b.length_in} onChange={(n) => set(i, { length_in: n })} />
          <span style={caption}>×</span>
          <DecField label="Width (in)" value={b.width_in} onChange={(n) => set(i, { width_in: n })} />
          <span style={caption}>×</span>
          <DecField label="Height (in)" value={b.height_in} onChange={(n) => set(i, { height_in: n })} />
          <span style={caption}>in</span>
          <DecField label="Empty weight (oz)" value={b.box_weight_oz} onChange={(n) => set(i, { box_weight_oz: n })} />
          <span style={caption}>oz</span>
          <DollarField cents={b.cost_cents || null} placeholder="Box cost" onChange={(c) => set(i, { cost_cents: c })} />
          <button type="button" className="fp-btn fp-btn-sm" onClick={() => void remove(i)} aria-label={`Delete box ${b.name}`}>
            Delete…
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="fp-btn fp-btn-sm" onClick={add}>
          Add box
        </button>
      </div>
    </Section>
  );
};

export const StoreTab: React.FC<{
  settings: ShopSettings;
  patch: Setter;
  persist: () => Promise<void>;
  snapshot?: ShopSnapshot;
  onManageCatalog: () => void;
}> = ({ settings, patch, persist, snapshot, onManageCatalog }) => {
  const ship = settings as ShopSettings & CheckoutShippingSettings;
  const patchShip = (p: Partial<ShopSettings> & CheckoutShippingSettings) => patch(p as Partial<ShopSettings>);
  const flatSet = ship.flat_shipping_cents_set === true || settings.flat_shipping_cents > 0;
  const freeOn = ship.free_shipping_threshold_enabled !== false;
  const freeSet = ship.free_shipping_threshold_enabled === true || settings.free_shipping_threshold_cents > 0;
  const [showKey, setShowKey] = useState(false);
  const products = snapshot?.products ?? [];
  const productCount = products.length;
  const shopConnected = !!settings.supabase_url.trim() && !!settings.supabase_anon_key.trim();
  const nameOf = (id: string) => products.find((p) => p.id === id)?.name || id;

  const shipFor = (id: string): ProductShippingSetting =>
    settings.product_shipping.find((s) => s.product_id === id) || { product_id: id, box_class: "not_set", per_box: 0 };
  const setShip = (id: string, p: Partial<ProductShippingSetting>) => {
    const next = { ...shipFor(id), ...p };
    patch({
      product_shipping: [...settings.product_shipping.filter((s) => s.product_id !== id), next],
    });
  };

  const setRule = (idx: number, r: ShipsTogetherRule) =>
    patch({ ships_together: settings.ships_together.map((x, i) => (i === idx ? r : x)) });
  const addRule = () =>
    patch({
      ships_together: [
        ...settings.ships_together,
        { id: `share-${Date.now().toString(36)}`, box_class: "small", limits: {} },
      ],
    });
  const removeRule = (idx: number) =>
    patch({ ships_together: settings.ships_together.filter((_, i) => i !== idx) });

  return (
    <>
      <Section
        title="Store link"
        footer="Your shop website's private link. Only people with this link can open it."
      >
        <input
          type="text"
          value={settings.store_url}
          placeholder="No link yet."
          onChange={(e) => patch({ store_url: e.target.value })}
          style={inputStyle}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="fp-btn fp-btn-sm"
            disabled={!settings.store_url}
            onClick={() => copyText(settings.store_url)}
          >
            Copy link
          </button>
        </div>
      </Section>
      <Section
        title="Shop connection"
        footer="Publishing sends your catalog, colors and shipping settings to your shop website."
      >
        <details open={!shopConnected}>
          <summary style={{ cursor: "pointer", fontSize: 12.5 }}>
            Advanced: shop server address and public key {shopConnected ? "(set)" : "(not set)"}
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            <input
              type="text"
              value={settings.supabase_url}
              placeholder="Shop server address (https://…)"
              aria-label="Shop server address"
              onChange={(e) => patch({ supabase_url: e.target.value })}
              style={inputStyle}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type={showKey ? "text" : "password"}
                value={settings.supabase_anon_key}
                placeholder="Shop public key"
                aria-label="Shop public key"
                onChange={(e) => patch({ supabase_anon_key: e.target.value })}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button type="button" className="fp-btn fp-btn-sm" onClick={() => setShowKey((v) => !v)}>
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
            <div style={caption}>Your shop website's setup page lists both. The public key is safe to keep here; never paste a secret or service key.</div>
          </div>
        </details>
      </Section>
      <ShopAccountSection
        connectedHint={shopConnected}
        persist={persist}
      />
      <Section
        title="3D product pages"
        footer="Shows the 3D view on the shop's product pages. Takes effect on the next catalog publish."
      >
        <Check
          label="Show 3D product pages"
          checked={!!settings.product_page_3d}
          onChange={(v) => patch({ product_page_3d: v, product_page_3d_set: true })}
        />
      </Section>
      <Section
        title="Website orders"
        footer="When on, Import Website Orders claims each order on the shop before adding it here, so two devices never import the same order. Uses your shop sign-in. Order status is never changed. Off: read-only import."
      >
        <Check
          label="Claim imported orders on the shop"
          checked={settings.store_ingest_claim_enabled !== false}
          onChange={(v) => patch({ store_ingest_claim_enabled: v })}
        />
      </Section>
      <Section title="Test bench" footer="Shows the Test bench tools in New Order (split a quantity into many qty-1 orders). Off by default.">
        <Check
          label="Show Test bench in New Order"
          checked={!!settings.test_bench_enabled}
          onChange={(v) => patch({ test_bench_enabled: v })}
        />
      </Section>
      <PublishCatalogSection persist={persist} settingsKey={JSON.stringify(settings)} />
      <Section
        title="Catalog"
        footer="Publishing sends every product in your catalog, with its price, and your filament colors to the shop."
      >
        <Row label={productCount === 1 ? "1 product in the catalog." : `${productCount} products in the catalog.`}>
          <button type="button" className="fp-btn fp-btn-sm" onClick={onManageCatalog}>
            Manage Catalog →
          </button>
        </Row>
      </Section>

      <Section
        title="Shipping at checkout"
        footer="The shop charges one flat rate per order. Orders of only Don't ship products have no shipping. Takes effect on the next catalog publish."
      >
        <Row label="Flat rate">
          <DollarField
            cents={flatSet ? settings.flat_shipping_cents : null}
            placeholder="7.95"
            onChange={(c) => patchShip({ flat_shipping_cents: c, flat_shipping_cents_set: true })}
          />
        </Row>
        {!flatSet && <div style={caption}>Blank uses the shop default, $7.95. Enter 0 for free shipping on every order.</div>}
        <Check
          label="Free shipping over an amount"
          checked={freeOn}
          onChange={(v) =>
            patchShip(
              v
                ? {
                    free_shipping_threshold_enabled: true,
                    free_shipping_threshold_cents: freeSet ? settings.free_shipping_threshold_cents : 4000,
                  }
                : { free_shipping_threshold_enabled: false },
            )
          }
        />
        {freeOn && (
          <Row label="Free shipping over">
            <DollarField
              cents={freeSet ? settings.free_shipping_threshold_cents : null}
              placeholder="40.00"
              onChange={(c) => patchShip({ free_shipping_threshold_cents: c, free_shipping_threshold_enabled: true })}
            />
          </Row>
        )}
        {freeOn && !freeSet && <div style={caption}>Blank uses the shop default, $40.00.</div>}
      </Section>

      <ShippingBoxesSection boxes={settings.box_presets || []} onChange={(box_presets) => patch({ box_presets })} />

      <Section
        title="Shipping — products"
        footer="Don't ship products add no shipping at checkout. Box sizes and per-box counts are saved for packing; the shop doesn't price from them yet."
      >
        {products.length === 0 && <div style={caption}>No products yet. Import a 3MF or STL to add your first one.</div>}
        {products.map((p) => {
          const s = shipFor(p.id);
          const boxed = s.box_class === "small" || s.box_class === "medium" || s.box_class === "large";
          return (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
              <select
                value={s.box_class}
                onChange={(e) => setShip(p.id, { box_class: e.target.value as ShippingTier })}
                style={{ ...inputStyle, width: 120 }}
              >
                {TIER_OPTIONS.map(([t, l]) => (
                  <option key={t} value={t}>
                    {l}
                  </option>
                ))}
              </select>
              <span style={caption}>per box</span>
              {boxed ? (
                <NumField value={s.per_box} onChange={(n) => setShip(p.id, { per_box: n })} width={70} />
              ) : (
                <span style={{ ...caption, width: 70, textAlign: "center" }}>—</span>
              )}
            </div>
          );
        })}
      </Section>

      <details className="fp-card" style={{ textAlign: "left" }}>
        <summary style={{ ...sectionTitle, cursor: "pointer" }}>Not used by the shop yet</summary>
        <div style={{ ...caption, margin: "6px 0 10px" }}>
          Box prices and ships-together rules are saved, but the shop doesn't use them. Checkout uses the flat rate above.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Section
        title="Shipping — box prices"
        footer="Postage per box. Blank until you enter it; Not set and Don't ship products add nothing."
      >
        {BOX_TIERS.map(([tier, label]) => (
          <Row key={tier} label={`${label} (cents)`}>
            <NumField
              value={settings.shipping_rates_cents[tier as "small" | "medium" | "large"]}
              onChange={(n) =>
                patch({ shipping_rates_cents: { ...settings.shipping_rates_cents, [tier]: n } })
              }
            />
          </Row>
        ))}
      </Section>

      <Section
        title="Ships together"
        footer="Combines these products into one shared box, up to each product's limit, only when that's cheaper than shipping them separately or the same price with fewer boxes. A rule can apply more than once."
      >
        {settings.ships_together.length === 0 && <div style={caption}>No rules yet. A rule packs several products into one shared box.</div>}
        {settings.ships_together.map((rule, idx) => (
          <div
            key={rule.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: 8,
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
              <span>Shared box</span>
              <select
                value={rule.box_class}
                onChange={(e) => setRule(idx, { ...rule, box_class: e.target.value as ShippingTier })}
                style={{ ...inputStyle, width: 110 }}
              >
                {BOX_TIERS.map(([t, l]) => (
                  <option key={t} value={t}>
                    {l}
                  </option>
                ))}
              </select>
              <span style={{ flex: 1 }} />
              <button type="button" className="fp-btn fp-btn-sm" onClick={() => removeRule(idx)}>
                Remove
              </button>
            </div>
            {Object.entries(rule.limits).map(([pid, max]) => (
              <div key={pid} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                <span style={{ flex: 1 }}>{nameOf(pid)}</span>
                <span style={caption}>up to</span>
                <NumField
                  value={max}
                  width={70}
                  onChange={(n) => setRule(idx, { ...rule, limits: { ...rule.limits, [pid]: n } })}
                />
                <button
                  type="button"
                  className="fp-btn fp-btn-sm"
                  onClick={() => {
                    const { [pid]: _gone, ...rest } = rule.limits;
                    setRule(idx, { ...rule, limits: rest });
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <select
              value=""
              onChange={(e) => {
                const pid = e.target.value;
                if (pid) setRule(idx, { ...rule, limits: { ...rule.limits, [pid]: 0 } });
              }}
              style={{ ...inputStyle, width: 220 }}
            >
              <option value="">Add product…</option>
              {products
                .filter((p) => !(p.id in rule.limits))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            {Object.keys(rule.limits).length < 2 && (
              <div style={caption}>Add at least two products for this rule to apply.</div>
            )}
          </div>
        ))}
        <div>
          <button type="button" className="fp-btn fp-btn-sm" onClick={addRule} disabled={products.length < 2}>
            Add rule
          </button>
        </div>
      </Section>

        </div>
      </details>

    </>
  );
};
