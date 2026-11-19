import React, { useEffect, useRef, useState } from "react";
import { invoke } from "../../tauriInvoke";
import { Section, inputStyle } from "./settingsUi";
import { errorText } from "../../errorText";

// --- Shop account sign-in (Supabase Auth; tokens stay in Rust, never shown) ---
type ShopSessionStatus = {
  connected?: boolean;
  signed_in: boolean;
  email?: string | null;
  expired?: boolean;
};

export const ShopAccountSection: React.FC<{ connectedHint: boolean; persist: () => Promise<void> }> = ({
  connectedHint,
  persist,
}) => {
  const [status, setStatus] = useState<ShopSessionStatus | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = () =>
    invoke<ShopSessionStatus>("shop_session_status")
      .then(setStatus)
      .catch((e) => setError(String(e?.message || e)));
  useEffect(() => {
    refresh();
  }, [connectedHint]);

  const signIn = async () => {
    setBusy(true);
    setError("");
    try {
      await persist(); // sign in with the URL and key on screen, not the last saved ones
      const s = await invoke<ShopSessionStatus>("shop_sign_in", { email, password });
      setStatus(s);
      if (s.signed_in) setPassword("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    setBusy(true);
    setError("");
    try {
      await invoke("shop_sign_out");
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const connected = status ? status.connected !== false : connectedHint;
  return (
    <Section title="Shop account" footer="Sign in with the shop owner's account to publish the catalog and import website orders.">
      {!connected ? (
        <div style={{ fontSize: 12.5 }}>No shop connected yet. Add the shop server address and public key above, then sign in to bring in website orders.</div>
      ) : status?.signed_in ? (
        <>
          <div style={{ fontSize: 12.5 }}>
            Signed in as <b>{status.email || "shop account"}</b>
            {status.expired ? " (session expired; it will refresh on next use)" : ""}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="fp-btn fp-btn-sm" disabled={busy} onClick={signOut}>
              Sign out
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12.5 }}>Not signed in.</div>
          <input
            type="email"
            value={email}
            placeholder="Email"
            autoComplete="username"
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
          />
          <input
            type="password"
            value={password}
            placeholder="Password"
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && email && password && !busy) signIn();
            }}
            style={inputStyle}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="fp-btn fp-btn-sm fp-btn-primary"
              disabled={busy || !email.trim() || !password}
              onClick={signIn}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </>
      )}
      {error && <div style={{ fontSize: 12, color: "var(--fp-danger, #c0392b)" }}>{error}</div>}
    </Section>
  );
};

// --- Publish catalog (dry run first, then confirm) ---
type CatalogDiff = {
  has_current: boolean;
  products_added: string[];
  products_removed: string[];
  products_changed: string[];
  shipping_changes: string[];
  other_changes: string[];
};
type PublishResult = {
  connected: boolean;
  published?: boolean;
  diff?: CatalogDiff;
  preview_path?: string;
  message?: string;
};

/** True when the diff turns the shop's 3D product pages off. */
function turns3dPagesOff(diff?: CatalogDiff): boolean {
  return !!diff?.other_changes.some((line) => {
    const m = /^product_page_3d:\s*(.*?)\s*->\s*(.*)$/.exec(line.trim());
    return !!m && m[2] === "false" && m[1] !== "false";
  });
}

const DiffList: React.FC<{ label: string; items: string[] }> = ({ label, items }) => (
  <div style={{ fontSize: 12.5 }}>
    <b>{label}:</b> {items.length === 0 ? "none" : items.length}
    {items.length > 0 && (
      <ul style={{ margin: "2px 0 0 18px", padding: 0 }}>
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    )}
  </div>
);

export const PublishCatalogSection: React.FC<{ persist: () => Promise<void>; settingsKey: string }> = ({
  persist,
  settingsKey,
}) => {
  const [preview, setPreview] = useState<PublishResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  // The preview was built from the settings on screen at that moment; any later edit makes it
  // stale, so Publish needs a fresh preview. (Saving itself doesn't count as an edit.)
  const previewKey = useRef<string | null>(null);
  useEffect(() => {
    if (!preview) {
      previewKey.current = null;
    } else if (!busy) {
      if (previewKey.current === null) previewKey.current = settingsKey;
      else if (previewKey.current !== settingsKey) {
        previewKey.current = null;
        setPreview(null);
        setConfirming(false);
      }
    }
  }, [settingsKey, busy, preview]);

  const runPreview = async () => {
    setBusy(true);
    setError("");
    setDone("");
    setConfirming(false);
    try {
      await persist(); // preview what's on screen (Rust builds from saved settings)
      const r = await invoke<PublishResult>("publish_catalog_dry_run");
      previewKey.current = null;
      setPreview(r);
    } catch (e) {
      setPreview(null);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const publish = async () => {
    setBusy(true);
    setError("");
    try {
      await persist();
      const r = await invoke<PublishResult>("publish_catalog");
      if (!r.connected) {
        setPreview(r);
      } else if (r.published) {
        setDone("Catalog published.");
        setPreview(null);
      } else {
        setError("The catalog was not published.");
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const connected = preview?.connected !== false;
  const diff = preview?.diff;
  const canPublish = !!preview && preview.connected && !!diff && !busy;
  const offWarning = turns3dPagesOff(diff);

  return (
    <Section title="Publish catalog" footer="Preview what will change on the shop before publishing.">
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="fp-btn fp-btn-sm" disabled={busy} onClick={runPreview}>
          {busy && !confirming ? "Working…" : "Preview changes"}
        </button>
        <button
          type="button"
          className="fp-btn fp-btn-sm fp-btn-primary"
          disabled={!canPublish || confirming}
          onClick={() => setConfirming(true)}
        >
          Publish
        </button>
      </div>
      {preview && !connected && <div style={{ fontSize: 12.5 }}>No shop connected yet. Connect your shop website above, then publish.</div>}
      {preview && connected && diff && (
        <>
          {!diff.has_current && (
            <div style={{ fontSize: 12.5 }}>The shop has no published catalog yet. This will be the first one.</div>
          )}
          {offWarning && (
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 700,
                padding: 8,
                borderRadius: 6,
                border: "1px solid var(--fp-danger, #c0392b)",
                color: "var(--fp-danger, #c0392b)",
              }}
            >
              Warning: publishing will turn OFF the shop's 3D product pages. Turn on "Show 3D product pages" above
              to keep them.
            </div>
          )}
          <DiffList label="Products added" items={diff.products_added} />
          <DiffList label="Products removed" items={diff.products_removed} />
          <DiffList label="Products changed" items={diff.products_changed} />
          <DiffList label="Shipping changes" items={diff.shipping_changes} />
          <DiffList label="Other changes" items={diff.other_changes} />
          {preview.preview_path && (
            <div style={{ fontSize: 12 }}>
              Preview file: <code style={{ userSelect: "all" }}>{preview.preview_path}</code>
            </div>
          )}
        </>
      )}
      {confirming && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
          <span>Publish these changes to the live shop?</span>
          <button type="button" className="fp-btn fp-btn-sm fp-btn-primary" disabled={busy} onClick={publish}>
            {busy ? "Publishing…" : "Yes, publish"}
          </button>
          <button type="button" className="fp-btn fp-btn-sm" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      )}
      {done && <div style={{ fontSize: 12.5 }}>{done}</div>}
      {error && <div style={{ fontSize: 12, color: "var(--fp-danger, #c0392b)" }}>{error}</div>}
    </Section>
  );
};
