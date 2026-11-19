// App lock per OS (off by default). Backend: app_lock_* commands in src-tauri (applock.rs).
import { biometricName } from "../platform";
// macOS: Touch ID (Mac password as system fallback). Windows: Windows Hello (its own PIN fallback).
// Elsewhere, or when no biometric exists: an app password (argon2-hashed in fp-core).
import React, { useEffect, useState } from "react";
import { invoke } from "../tauriInvoke";
import { ShopSettings } from "../types";

export interface AppLockStatus {
  os: string;
  biometric: "touch_id" | "windows_hello" | null;
  password_set: boolean;
  enabled: boolean;
  method: string;
}

export const biometricLabel = (b: AppLockStatus["biometric"]) =>
  b === "touch_id" || b === "windows_hello" ? biometricName() : "";

export async function fetchLockStatus(): Promise<AppLockStatus | null> {
  try {
    return await invoke<AppLockStatus>("app_lock_status");
  } catch {
    return null; // browser preview / backend unavailable
  }
}

/** Which method actually applies now; null = not lockable (never lock the user out). */
export function effectiveLockMethod(st: AppLockStatus | null): "biometric" | "password" | null {
  if (!st || !st.enabled) return null;
  const wantBio = st.method === "biometric" || (st.method === "" && !!st.biometric);
  if (wantBio && st.biometric) return "biometric";
  if (st.password_set) return "password";
  return null;
}

/** Settings › General › Security. Shows only what exists on this OS. */
export const AppLockSettings: React.FC<{
  open: boolean;
  settings: ShopSettings;
  patch: (p: Partial<ShopSettings>) => void;
}> = ({ open, settings, patch }) => {
  const [st, setSt] = useState<AppLockStatus | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState("");
  const refresh = () => fetchLockStatus().then(setSt);
  useEffect(() => {
    if (open) void refresh();
  }, [open]);
  if (!st) return <div style={{ fontSize: 12 }}>App lock is available in the desktop app.</div>;
  const bio = biometricLabel(st.biometric);
  const method = settings.app_lock_method || (st.biometric ? "biometric" : "password");
  const setPassword = async () => {
    if (pw !== pw2) return setMsg("Passwords don't match.");
    try {
      await invoke("app_lock_set_password", { password: pw });
      setPw("");
      setPw2("");
      setMsg("App password saved.");
      void refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const pick = (enabled: boolean, m: string) => patch({ app_lock_enabled: enabled, app_lock_method: m });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5 }}>
      {st.biometric && (
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={settings.app_lock_enabled && method === "biometric"}
            onChange={(e) => pick(e.target.checked, "biometric")}
          />
          Require {bio} to open FarmPrint
        </label>
      )}
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          disabled={!st.password_set}
          checked={settings.app_lock_enabled && method === "password"}
          onChange={(e) => pick(e.target.checked, "password")}
        />
        Require app password{st.password_set ? "" : " (set one below first)"}
      </label>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input type="password" placeholder={st.password_set ? "New app password" : "App password"} value={pw} onChange={(e) => setPw(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6 }} />
        <input type="password" placeholder="Confirm" value={pw2} onChange={(e) => setPw2(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6 }} />
        <button type="button" className="fp-btn fp-btn-sm" disabled={pw.length < 4} onClick={setPassword}>
          {st.password_set ? "Change password" : "Set password"}
        </button>
        {st.password_set && (
          <button
            type="button"
            className="fp-btn fp-btn-sm"
            onClick={async () => {
              await invoke("app_lock_clear_password").catch(() => {});
              if (method === "password") patch({ app_lock_enabled: false });
              setMsg("App password removed.");
              void refresh();
            }}
          >
            Remove password
          </button>
        )}
      </div>
      {msg && <div style={{ fontSize: 11.5, opacity: 0.75 }}>{msg}</div>}
    </div>
  );
};

/** Full-window lock shown at launch when the lock is on. */
export const LockScreen: React.FC<{
  method: "biometric" | "password";
  status: AppLockStatus;
  shopName: string;
  onUnlocked: () => void;
}> = ({ method, status, shopName, onUnlocked }) => {
  const [mode, setMode] = useState(method);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const tryBio = async () => {
    setErr("");
    try {
      const r = await invoke<{ ok: boolean }>("app_lock_unlock", { method: "biometric" });
      if (r.ok) onUnlocked();
      else setErr("Not unlocked.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    if (mode === "biometric") void tryBio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const tryPw = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await invoke<{ ok: boolean }>("app_lock_unlock", { method: "password", password: pw }).catch(() => ({ ok: false }));
    if (r.ok) onUnlocked();
    else {
      setErr("Wrong password.");
      setPw("");
    }
  };
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "var(--bg, #0b0d12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="fp-card" style={{ width: 340, display: "flex", flexDirection: "column", gap: 12, textAlign: "center", padding: 24 }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>{shopName || "FarmPrint"} is locked</div>
        {mode === "biometric" ? (
          <button type="button" className="fp-btn fp-btn-primary" onClick={tryBio}>
            Unlock with {biometricLabel(status.biometric)}
          </button>
        ) : (
          <form onSubmit={tryPw} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input autoFocus type="password" placeholder="App password" value={pw} onChange={(e) => setPw(e.target.value)} style={{ padding: "7px 9px", borderRadius: 6 }} />
            <button type="submit" className="fp-btn fp-btn-primary">Unlock</button>
          </form>
        )}
        {mode === "biometric" && status.password_set && (
          <button type="button" className="fp-btn fp-btn-sm" onClick={() => setMode("password")}>Use app password</button>
        )}
        {err && <div style={{ fontSize: 12, color: "#f87171" }}>{err}</div>}
      </div>
    </div>
  );
};
