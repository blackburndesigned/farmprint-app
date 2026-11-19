import { getIdentifier, getVersion } from "@tauri-apps/api/app";
import { AppLockSettings } from "../AppLock";
import { CheckForUpdatesButton } from "../../updater";
import React, { useEffect, useState } from "react";
import { revealLabel } from "../../platform";
import { invoke } from "../../tauriInvoke";
import { ShopSettings, ShopSnapshot } from "../../types";
import { SampleShopSettingsSection } from "../SampleShop";
import { Row, Section, Segmented, type Setter, copyText, revealInFileManager } from "./settingsUi";

// --- General (About, Security, Navigation, Data) -------------------------------

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
