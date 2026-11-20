// First-run setup. Shown only when there is no shop yet (no name, no products, no orders,
// setup not completed). Everything but the shop name can be skipped and edited later in Settings.
import React, { useState } from "react";
import { loadShopSettings, normalizeSettings, setShopSettings, BUILTIN_PROCESS_STEPS } from "../settingsStore";
import { invoke } from "../tauriInvoke";
import { chooseLogoPath } from "./settings/settingsUi";
import { errorText } from "../errorText";
import { loadSampleShop } from "./SampleShop";
import { joinHexAlpha, splitHexAlpha, swatchBackground } from "../platform";
import { ShopSettings, ShopSnapshot } from "../types";
import { Lock } from "lucide-react";
import { Icon } from "../icons";

type Step = "welcome" | "basics" | "printers" | "filament" | "process" | "store" | "done";
const ORDER: Step[] = ["welcome", "basics", "printers", "filament", "process", "store", "done"];
const TITLES: Record<Step, string> = {
  welcome: "Welcome",
  basics: "Shop basics",
  printers: "Printers",
  filament: "Filament",
  process: "Process steps",
  store: "Connect a FarmPrint shop website",
  done: "All set",
};

interface DraftPrinter { name: string; color: string; multiSpool: boolean }
interface DraftSpool { name: string; brand: string; material: string; hex: string; cost: string; grams: string }

const input: React.CSSProperties = { width: "100%", padding: "7px 9px", borderRadius: 6, boxSizing: "border-box" };
const label: React.CSSProperties = { fontSize: 12, opacity: 0.75, marginBottom: 3, display: "block" };
const Field: React.FC<{ l: string; children: React.ReactNode }> = ({ l, children }) => (
  <div style={{ marginBottom: 10 }}><span style={label}>{l}</span>{children}</div>
);
const dollarsToCents = (v: string) => Math.max(0, Math.round((parseFloat(v) || 0) * 100));

export function needsSetup(settings: ShopSettings, snap: ShopSnapshot | null): boolean {
  if (!snap) return false;
  return !settings.setup_completed && !settings.shop_name.trim() && snap.products.length === 0 && snap.orders.length === 0;
}

export const SetupWizard: React.FC<{
  initial: ShopSettings;
  /** `goTo`: tab to open afterwards (default: Products). */
  onFinished: (snap: ShopSnapshot | null, openImport: boolean, goTo?: "orders") => void;
  onCancel?: () => void; // only when re-run from Settings
  /** First-run on a new shop: ignore leftover settings/data from an old data folder and start empty. */
  fresh?: boolean;
}> = ({ initial: given, onFinished, onCancel, fresh }) => {
  const initial = fresh ? normalizeSettings({}) : given;
  const [step, setStep] = useState<Step>("welcome");
  const [s, setS] = useState<ShopSettings>(normalizeSettings(initial));
  const patch = (p: Partial<ShopSettings>) => setS((prev) => ({ ...prev, ...p }));
  const [printers, setPrinters] = useState<DraftPrinter[]>([]);
  const [spools, setSpools] = useState<DraftSpool[]>([]);
  const editSpool = (i: number, p: Partial<DraftSpool>) => setSpools((prev) => prev.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const [steps, setSteps] = useState(
    (initial.process_steps?.length ? initial.process_steps : BUILTIN_PROCESS_STEPS.map((b) => ({ id: b.id, name: b.id === "Ready" ? "Closed" : b.name, color_hex: b.bg })))
  );
  const [storeOn, setStoreOn] = useState(!!(initial.store_url || initial.supabase_url));
  const [flatRate, setFlatRate] = useState(
    initial.flat_shipping_cents > 0 ? (initial.flat_shipping_cents / 100).toFixed(2) : "",
  );
  // Shop owner sign-in, sent once on Finish and never saved here (the session is stored by the app).
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [signInNote, setSignInNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const idx = ORDER.indexOf(step);
  const go = (d: number) => { setErr(""); setStep(ORDER[Math.min(ORDER.length - 1, Math.max(0, idx + d))]); };

  const chooseLogo = async () => {
    try {
      const path = await chooseLogoPath("Choose your shop logo");
      if (path) { setErr(""); patch({ logo_path: path }); }
    } catch (e) {
      setErr(errorText(e));
    }
  };

  // First run only: skip setup for now and look around a made-up shop. Settings stay
  // unsaved, so once the sample data is cleared the shop is empty and setup runs again.
  const exploreSample = async () => {
    setBusy(true);
    setErr("");
    try {
      await invoke<ShopSnapshot>("start_fresh_shop");
      const snap = await loadSampleShop();
      await loadShopSettings(); // the fresh start reset leftover settings to defaults
      onFinished(snap, false, "orders");
    } catch (e) {
      setErr(`Couldn't load the sample shop: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    setErr("");
    try {
      let snap: ShopSnapshot | null = null;
      if (fresh) {
        // Old data folder with no orders: back up (fp-core) and clear leftovers so the shop starts empty.
        snap = await invoke<ShopSnapshot>("start_fresh_shop");
      }
      let spoolId = "";
      for (const spool of spools.filter((x) => x.name.trim())) {
        const prior = snap || (await invoke<ShopSnapshot>("get_shop_snapshot").catch(() => null));
        const before = new Set((prior?.filaments || []).map((f) => f.id));
        snap = await invoke<ShopSnapshot>("add_filament_swatch", {
          name: spool.name.trim(), brand: spool.brand.trim(), material: spool.material.trim(),
          hex: spool.hex, cost_per_kg: parseFloat(spool.cost) || 0, grams_remaining: parseFloat(spool.grams) || 0,
        });
        const id = snap.filaments.find((f) => !before.has(f.id) && f.name === spool.name.trim())?.id || snap.filaments.find((f) => !before.has(f.id))?.id || "";
        if (!spoolId) spoolId = id; // first spool is loaded into new printers
      }
      const accents: Record<string, string> = { ...(s.printer_accents || {}) };
      const multi: Record<string, boolean> = { ...(s.printer_multi_spool || {}) };
      for (const p of printers.filter((p) => p.name.trim())) {
        const prevIds = new Set((snap?.printers || []).map((x) => x.id));
        if (!snap) {
          const cur = await invoke<ShopSnapshot>("get_shop_snapshot");
          cur.printers.forEach((x) => prevIds.add(x.id));
        }
        snap = await invoke<ShopSnapshot>("add_printer", {
          name: p.name.trim(), model: "", nozzle_mm: 0.4, slot_filament_ids: spoolId ? [spoolId] : [],
        });
        const created = snap.printers.find((x) => !prevIds.has(x.id));
        if (created) {
          accents[created.id] = p.color;
          multi[created.id] = p.multiSpool;
        }
      }
      const next: ShopSettings = {
        ...s,
        shop_name: s.shop_name.trim(),
        setup_completed: true,
        printer_accents: accents,
        printer_multi_spool: multi,
        process_steps: steps.map((x) => ({ ...x, name: x.name.trim() || x.id })),
        supabase_sync_enabled: storeOn ? s.supabase_sync_enabled : false,
        store_url: storeOn ? s.store_url : "",
        supabase_url: storeOn ? s.supabase_url : "",
        supabase_anon_key: storeOn ? s.supabase_anon_key : "",
        shipping_enabled: storeOn ? s.shipping_enabled : false,
      };
      // Flat rate the shop charges per order; blank keeps the shop default.
      const flat = storeOn && s.shipping_enabled && flatRate.trim() !== "" ? dollarsToCents(flatRate) : null;
      const toSave = flat === null ? next : { ...next, flat_shipping_cents: flat, flat_shipping_cents_set: true };
      const saved = await invoke<ShopSettings>("save_shop_settings", { settings: toSave });
      setShopSettings(saved);
      // Owner sign-in needs the saved server address and key, so it runs after the save.
      setSignInNote("");
      if (storeOn && ownerEmail.trim() && ownerPassword && saved.supabase_url.trim() && saved.supabase_anon_key.trim()) {
        try {
          const st = await invoke<{ signed_in?: boolean }>("shop_sign_in", { email: ownerEmail.trim(), password: ownerPassword });
          setSignInNote(st?.signed_in ? `Signed in to your shop as ${ownerEmail.trim()}.` : "Couldn't sign in to your shop. Sign in later in Settings › Store.");
        } catch (e) {
          setSignInNote(`Couldn't sign in to your shop: ${e instanceof Error ? e.message : String(e)} You can sign in later in Settings › Store.`);
        } finally {
          setOwnerPassword("");
        }
      } else if (storeOn && ownerEmail.trim()) {
        setSignInNote("To sign in to your shop, add the shop server address and public key in Settings › Store, then sign in there.");
      }
      if (!snap) snap = await invoke<ShopSnapshot>("get_shop_snapshot").catch(() => null);
      setStep("done");
      setBusy(false);
      return snap;
    } catch (e) {
      setErr(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
      return null;
    }
  };
  const [finalSnap, setFinalSnap] = useState<ShopSnapshot | null>(null);

  const body = (() => {
    switch (step) {
      case "welcome":
        return (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>Welcome to FarmPrint</div>
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 20 }}>
              Track orders, printers, filament and every part from print bed to shipping box. A few quick questions and you're in. Everything except your shop name can be changed later in Settings.
            </div>
            <button type="button" className="fp-btn fp-btn-primary" onClick={() => go(1)}>Set up my shop</button>
            {fresh && (
              <div style={{ marginTop: 14 }}>
                <button type="button" className="fp-btn fp-btn-sm" disabled={busy} onClick={exploreSample}>
                  {busy ? "Loading…" : "Explore a sample shop first"}
                </button>
                <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 6 }}>
                  Made-up orders, printers and products. Clear them in Settings › General, and setup starts again.
                </div>
              </div>
            )}
          </div>
        );
      case "basics":
        return (
          <>
            <Field l="Shop name (required)"><input autoFocus style={input} value={s.shop_name} onChange={(e) => patch({ shop_name: e.target.value })} placeholder="e.g. Maple Street Prints" /></Field>
            <Field l="Your name"><input style={input} value={s.operator_name} onChange={(e) => patch({ operator_name: e.target.value })} /></Field>
            <Field l="Logo (optional)">
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button type="button" className="fp-btn fp-btn-sm" onClick={chooseLogo}>Choose image…</button>
                <span style={{ fontSize: 11.5, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis" }}>{s.logo_path || "None — your shop's initials are used"}</span>
                {s.logo_path && <button type="button" className="fp-btn fp-btn-sm" onClick={() => patch({ logo_path: "" })}>Clear</button>}
              </div>
            </Field>
          </>
        );
      case "printers":
        return (
          <>
            <div style={{ fontSize: 12.5, opacity: 0.8, marginBottom: 10 }}>Add the printers in your farm. You can skip this and add them later.</div>
            {printers.map((p, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <input style={{ ...input, flex: 1 }} placeholder="Printer name" value={p.name} onChange={(e) => setPrinters(printers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <input type="color" title="Printer color" value={p.color} onChange={(e) => setPrinters(printers.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} />
                <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center", whiteSpace: "nowrap" }}>
                  <input type="checkbox" checked={p.multiSpool} onChange={(e) => setPrinters(printers.map((x, j) => (j === i ? { ...x, multiSpool: e.target.checked } : x)))} />
                  Multi-spool switcher
                </label>
                <button type="button" className="fp-btn fp-btn-sm" onClick={() => setPrinters(printers.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
            <button type="button" className="fp-btn fp-btn-sm" onClick={() => setPrinters([...printers, { name: "", color: "#3b82f6", multiSpool: false }])}>+ Add printer</button>
          </>
        );
      case "filament":
        return (
          <>
            <div style={{ fontSize: 12.5, opacity: 0.8, marginBottom: 10 }}>Add the filaments you stock. Use Opacity for translucent or clear filament. You can skip this and add more later.</div>
            {spools.map((sp, i) => {
              const { rgb, alpha } = splitHexAlpha(sp.hex);
              return (
                <div key={i} style={{ border: "1px solid rgba(148,163,184,0.25)", borderRadius: 8, padding: "10px 10px 2px", marginBottom: 10 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                    <span title={`Opacity ${Math.round(alpha * 100)}%`} style={{ width: 28, height: 28, borderRadius: 6, flex: "none", marginBottom: 10, border: "1px solid rgba(255,255,255,0.3)", background: swatchBackground(sp.hex) }} />
                    <div style={{ flex: 2 }}><Field l="Color name"><input style={input} value={sp.name} onChange={(e) => editSpool(i, { name: e.target.value })} /></Field></div>
                    <Field l="Color"><input type="color" value={rgb} onChange={(e) => editSpool(i, { hex: joinHexAlpha(e.target.value, alpha) })} /></Field>
                    <div style={{ flex: 1 }}>
                      <Field l={`Opacity ${Math.round(alpha * 100)}%`}>
                        <input type="range" min={5} max={100} value={Math.round(alpha * 100)} style={{ width: "100%" }}
                          onChange={(e) => editSpool(i, { hex: joinHexAlpha(rgb, Number(e.target.value) / 100) })} />
                      </Field>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Field l="Brand"><input style={input} value={sp.brand} onChange={(e) => editSpool(i, { brand: e.target.value })} /></Field>
                    <Field l="Material"><input style={input} value={sp.material} placeholder="e.g. PLA" onChange={(e) => editSpool(i, { material: e.target.value })} /></Field>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                    <Field l="Cost per kg ($)"><input style={input} type="number" min={0} value={sp.cost} onChange={(e) => editSpool(i, { cost: e.target.value })} /></Field>
                    <Field l="Grams remaining"><input style={input} type="number" min={0} value={sp.grams} onChange={(e) => editSpool(i, { grams: e.target.value })} /></Field>
                    <div style={{ marginBottom: 10 }}><button type="button" className="fp-btn fp-btn-sm" onClick={() => setSpools(spools.filter((_, j) => j !== i))}>Remove</button></div>
                  </div>
                </div>
              );
            })}
            <button type="button" className="fp-btn fp-btn-sm" onClick={() => setSpools([...spools, { name: "", brand: "", material: "", hex: "#FFFFFF", cost: "", grams: "" }])}>
              {spools.length ? "+ Add another filament" : "+ Add filament"}
            </button>
          </>
        );
      case "process":
        return (
          <>
            <div style={{ fontSize: 12.5, opacity: 0.8, marginBottom: 10 }}>Every part moves through these steps. Rename them to fit your shop. Closed is always last.</div>
            {steps.map((st, i) => (
              <div key={st.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: st.color_hex }} />{st.id === "Staged" && <span title="Fixed step: can be renamed or hidden, not deleted" style={{ display: "inline-flex" }}><Icon icon={Lock} size={12} /></span>}
                <input style={{ ...input, flex: 1 }} value={st.name} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              </div>
            ))}
          </>
        );
      case "store":
        return (
          <>
            <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
              <input type="checkbox" checked={storeOn} onChange={(e) => setStoreOn(e.target.checked)} />
              I have a shop website to connect (optional)
            </label>
            {storeOn && (
              <>
                <Field l="Shop website address"><input style={input} value={s.store_url} onChange={(e) => patch({ store_url: e.target.value })} placeholder="https://" /></Field>
                <div style={{ fontSize: 12, opacity: 0.75, margin: "4px 0 8px" }}>
                  Sign in with the shop owner's account so FarmPrint can bring in website orders and publish your catalog.
                </div>
                <Field l="Owner email">
                  <input style={input} type="email" autoComplete="username" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
                </Field>
                <Field l="Owner password">
                  <input style={input} type="password" autoComplete="current-password" value={ownerPassword} onChange={(e) => setOwnerPassword(e.target.value)} />
                </Field>
                <details style={{ marginBottom: 10 }} open={!!(s.supabase_url || s.supabase_anon_key) && !(s.supabase_url && s.supabase_anon_key)}>
                  <summary style={{ cursor: "pointer", fontSize: 12.5 }}>Advanced</summary>
                  <div style={{ marginTop: 8 }}>
                    <Field l="Shop server address"><input style={input} value={s.supabase_url} onChange={(e) => patch({ supabase_url: e.target.value.trim() })} placeholder="https://" /></Field>
                    <Field l="Shop public key"><input style={input} value={s.supabase_anon_key} onChange={(e) => patch({ supabase_anon_key: e.target.value.trim() })} /></Field>
                    <div style={{ fontSize: 11.5, opacity: 0.65 }}>Your shop website's setup page lists both. Never paste a secret or service key.</div>
                  </div>
                </details>
                <label style={{ fontSize: 12.5, display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                  <input type="checkbox" checked={s.shipping_enabled} onChange={(e) => patch({ shipping_enabled: e.target.checked })} />
                  I ship orders
                </label>
                {s.shipping_enabled && (
                  <Field l="Flat shipping rate per order ($)">
                    <input style={{ ...input, width: 160 }} type="number" min={0} step="0.01" value={flatRate} placeholder="7.95" onChange={(e) => setFlatRate(e.target.value)} />
                    <div style={{ fontSize: 11.5, opacity: 0.65, marginTop: 3 }}>Blank uses the shop default, $7.95. Enter 0 for free shipping.</div>
                  </Field>
                )}
              </>
            )}
          </>
        );
      case "done":
        return (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>{s.shop_name} is ready</div>
            {signInNote && <div style={{ fontSize: 12.5, opacity: 0.85, marginBottom: 10 }}>{signInNote}</div>}
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 20 }}>Next, add your first product by importing a 3MF or STL model.</div>
            <button type="button" className="fp-btn fp-btn-primary" onClick={() => onFinished(finalSnap, true)}>Import your first model</button>
            <div><button type="button" className="fp-btn fp-btn-sm" style={{ marginTop: 10 }} onClick={() => onFinished(finalSnap, false)}>Go to FarmPrint</button></div>
          </div>
        );
    }
  })();

  const isLastInput = step === "store";
  const canNext = step !== "basics" || !!s.shop_name.trim();
  const skippable = ["printers", "filament", "process", "store"].includes(step);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(5,7,12,0.92)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="fp-card" style={{ width: 560, maxHeight: "86vh", overflowY: "auto", padding: 24, textAlign: "left" }}>
        {step !== "welcome" && step !== "done" && (
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{TITLES[step]}</div>
            <div style={{ fontSize: 11.5, opacity: 0.6 }}>Step {idx} of {ORDER.length - 2}</div>
          </div>
        )}
        {body}
        {err && <div style={{ color: "#f87171", fontSize: 12, marginTop: 8 }}>{err}</div>}
        {step !== "welcome" && step !== "done" && (
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 18 }}>
            <button type="button" className="fp-btn" onClick={() => go(-1)} disabled={busy}>Back</button>
            <div style={{ display: "flex", gap: 8 }}>
              {skippable && !isLastInput && <button type="button" className="fp-btn" onClick={() => go(1)}>Skip</button>}
              {isLastInput ? (
                <button type="button" className="fp-btn fp-btn-primary" disabled={busy}
                  onClick={async () => { const snap = await finish(); if (snap !== undefined) setFinalSnap(snap); }}>
                  {busy ? "Saving…" : "Finish"}
                </button>
              ) : (
                <button type="button" className="fp-btn fp-btn-primary" disabled={!canNext} onClick={() => go(1)}>Next</button>
              )}
            </div>
          </div>
        )}
        {onCancel && step === "welcome" && (
          <div style={{ textAlign: "center" }}><button type="button" className="fp-btn fp-btn-sm" onClick={onCancel}>Cancel</button></div>
        )}
      </div>
    </div>
  );
};
