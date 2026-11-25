import { getIdentifier, getVersion } from "@tauri-apps/api/app";
import { AppLockSettings } from "../AppLock";
import { CheckForUpdatesButton } from "../../updater";
import React, { useEffect, useState } from "react";
import { revealLabel } from "../../platform";
import { invoke } from "../../tauriInvoke";
import { ShopSettings, ShopSnapshot } from "../../types";
import { SampleShopSettingsSection } from "../SampleShop";
import { Row, Section, Segmented, type Setter, copyText, revealInFileManager } from "./settingsUi";

/** Number box where blank means "not set" (null), never a made-up default. Saves on blur/Enter. */
const OptionalNumberField: React.FC<{
  value: number | null;
  decimals: number;
  placeholder: string;
  ariaLabel: string;
  onCommit: (v: number | null) => void;
}> = ({ value, decimals, placeholder, ariaLabel, onCommit }) => {
  const shown = value == null ? "" : decimals > 0 ? value.toFixed(decimals) : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const t = text.trim().replace(/^\$/, "");
    if (!t) return onCommit(null);
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return setText(shown);
    onCommit(n);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      style={{ width: 110, padding: "6px 8px", borderRadius: 6, textAlign: "right" }}
    />
  );
};

// --- General (About, Security, Navigation, Costs & targets, Data) ---------------

export const GeneralTab: React.FC<{
  open: boolean;
  settings: ShopSettings;
  patch: Setter;
  onRunSetup?: () => void;
  snapshot?: ShopSnapshot;
  onSnapshotUpdated?: (s: ShopSnapshot) => void;
}> = ({ open, settings, patch, onRunSetup, snapshot, onSnapshotUpdated }) => {
  const [dir, setDir] = useState("");
  const [appVersion, setAppVersion] = useState("—");
  const [appId, setAppId] = useState("—");
  useEffect(() => {
    if (!open) return;
    getVersion().then(setAppVersion).catch(() => setAppVersion(import.meta.env?.VITE_APP_VERSION || "—"));
    getIdentifier().then((id) => setAppId(id || "—")).catch(() => setAppId("—"));
  }, [open]);
  useEffect(() => {
    if (!open) return;
    invoke<{ path: string }>("get_shop_data_dir")
      .then((r) => setDir(r?.path || ""))
      .catch(() => setDir(""));
  }, [open]);
  return (
    <>
      <Section title="About">
        <Row label="App">FarmPrint</Row>
        <Row label="Version">{appVersion}</Row>
        <Row label="Bundle ID">{appId}</Row>
        <CheckForUpdatesButton />
      </Section>
      <Section title="Setup" footer="Walk through shop name, printers, filament, process steps and shop website again. Existing data is kept.">
        <button type="button" className="fp-btn fp-btn-sm" disabled={!onRunSetup} onClick={() => onRunSetup?.()}>
          Run setup again
        </button>
      </Section>
      {open && <SampleShopSettingsSection snapshot={snapshot} onSnapshotUpdated={onSnapshotUpdated} Section={Section} />}
      <Section
        title="Security"
        footer="Off by default. Locks FarmPrint on launch. Only the options available on this computer are shown."
      >
        <AppLockSettings open={open} settings={settings} patch={patch} />
      </Section>
      <Section
        title="Navigation"
        footer="Sidebar is the classic left list. Bottom tab bar hides the sidebar and shows a floating liquid-glass strip of destinations along the bottom of the window."
      >
        <Row label="Main navigation">
          <Segmented
            value={settings.navigation_chrome === "bottomTabs" ? "bottomTabs" : "sidebar"}
            options={[
              ["sidebar", "Sidebar"],
              ["bottomTabs", "Bottom tab bar"],
            ]}
            onChange={(v) => patch({ navigation_chrome: v })}
          />
        </Row>
      </Section>
      <Section
        title="Orders"
        footer="On ANDON each order card shows how old the order is. The age turns red once an order is older than this."
      >
        <Row label="Late after">
          <Segmented
            value={settings.orders_late_after_days && settings.orders_late_after_days > 0 ? settings.orders_late_after_days : 3}
            options={[
              [1, "1 day"],
              [2, "2 days"],
              [3, "3 days"],
              [5, "5 days"],
              [7, "7 days"],
              [14, "14 days"],
            ]}
            onChange={(v) => patch({ orders_late_after_days: v })}
          />
        </Row>
      </Section>
      <Section
        title="Costs & targets"
        footer="Both start blank. Blank packaging cost counts as $0 in margin estimates (marked “packaging cost not set”). Blank target days means orders without a ship-by date have no on-time target."
      >
        <Row label="Packaging cost per order ($)">
          <OptionalNumberField
            ariaLabel="Packaging cost per order"
            value={settings.packaging_cost_cents == null ? null : settings.packaging_cost_cents / 100}
            decimals={2}
            placeholder="Not set"
            onCommit={(v) => patch({ packaging_cost_cents: v == null ? null : Math.round(v * 100) })}
          />
        </Row>
        <Row label="Default target (days to ship)">
          <OptionalNumberField
            ariaLabel="Default target days to ship"
            value={settings.default_target_days ?? null}
            decimals={0}
            placeholder="No target"
            onCommit={(v) => patch({ default_target_days: v == null ? null : Math.round(v) })}
          />
        </Row>
      </Section>
      <Section title="Data" footer="Local shop folder (not iCloud Drive).">
        <Row label="Active folder">
          <span style={{ fontSize: 11.5, userSelect: "text" }}>{dir || "—"}</span>
        </Row>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="fp-btn fp-btn-sm" disabled={!dir} onClick={() => revealInFileManager(dir)}>
            {revealLabel()}
          </button>
          <button type="button" className="fp-btn fp-btn-sm" disabled={!dir} onClick={() => copyText(dir)}>
            Copy Path
          </button>
        </div>
      </Section>
    </>
  );
};
