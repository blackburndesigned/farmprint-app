// Auto-updater (Tauri v2: @tauri-apps/plugin-updater + plugin-process).
// Every call is safe outside Tauri (browser/dev) and never throws.
import React, { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { errorText } from "./errorText";

export function updaterAvailable(): boolean {
  return typeof window !== "undefined" && !!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ && !import.meta.env?.DEV;
}

export type CheckResult =
  | { kind: "unavailable" }
  | { kind: "none" }
  | { kind: "update"; update: Update }
  | { kind: "error"; message: string };

export async function checkForUpdate(): Promise<CheckResult> {
  if (!updaterAvailable()) return { kind: "unavailable" };
  try {
    const update = await check();
    return update ? { kind: "update", update } : { kind: "none" };
  } catch (e) {
    return { kind: "error", message: errorText(e, "Update check failed") };
  }
}

export async function installUpdate(update: Update, onProgress?: (pct: number | null) => void): Promise<string | null> {
  try {
    let total = 0;
    let got = 0;
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength || 0;
      else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        onProgress?.(total ? Math.min(100, Math.round((got / total) * 100)) : null);
      }
    });
    await relaunch();
    return null;
  } catch (e) {
    return errorText(e, "Update failed");
  }
}

/** Release notes from latest.json ("notes" → update.body), trimmed for a small banner. */
export function releaseNotes(update: Update, maxChars = 280): string {
  const body = String(update.body || "").trim();
  if (!body) return "";
  return body.length > maxChars ? `${body.slice(0, maxChars - 1).trimEnd()}…` : body;
}

const notesStyle = { fontSize: 11.5, opacity: 0.85, whiteSpace: "pre-wrap" as const, maxWidth: 360 };

/** Background re-check interval: FarmPrint often stays open for days. */
const RECHECK_MS = 60 * 60 * 1000;

/** Settings → General → About: "Check for updates". */
export const CheckForUpdatesButton: React.FC = () => {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const onCheck = async () => {
    setBusy(true);
    setStatus("Checking…");
    const r = await checkForUpdate();
    setBusy(false);
    if (r.kind === "unavailable") setStatus("Updates are only available in the installed app.");
    else if (r.kind === "none") setStatus("You're up to date.");
    else if (r.kind === "error") setStatus("Couldn't check for updates. Try again later.");
    else {
      setUpdate(r.update);
      setStatus(`Version ${r.update.version} is available.`);
    }
  };
  const onInstall = async () => {
    if (!update) return;
    setBusy(true);
    setStatus("Downloading…");
    const err = await installUpdate(update, (p) => setStatus(p == null ? "Downloading…" : `Downloading… ${p}%`));
    setBusy(false);
    if (err) setStatus("Update failed. Try again later.");
  };
  const notes = update ? releaseNotes(update, 600) : "";
  return React.createElement(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 6 } },
    React.createElement(
      "div",
      { style: { display: "flex", gap: 8, alignItems: "center" } },
      update
        ? React.createElement("button", { type: "button", className: "fp-btn fp-btn-sm fp-btn-primary", disabled: busy, onClick: onInstall }, "Install and restart")
        : React.createElement("button", { type: "button", className: "fp-btn fp-btn-sm", disabled: busy, onClick: onCheck }, "Check for updates"),
      status ? React.createElement("span", { style: { fontSize: 11.5, opacity: 0.8 } }, status) : null
    ),
    notes ? React.createElement("div", { style: notesStyle }, notes) : null
  );
};

/** Quiet check at startup and then hourly; renders a small dismissible banner only when an
 *  update exists. "Later" hides that version; a newer version shows the banner again. */
export const UpdateBanner: React.FC = () => {
  const [update, setUpdate] = useState<Update | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [hiddenVersion, setHiddenVersion] = useState<string | null>(null);
  const busyRef = React.useRef(false);
  busyRef.current = busy;
  useEffect(() => {
    let alive = true;
    const run = () => {
      if (busyRef.current) return; // never swap the update object mid-download
      checkForUpdate().then((r) => {
        if (alive && r.kind === "update" && !busyRef.current) {
          setUpdate((prev) => (prev && prev.version === r.update.version ? prev : r.update));
        }
      });
    };
    const t = window.setTimeout(run, 4000);
    const iv = window.setInterval(run, RECHECK_MS);
    return () => {
      alive = false;
      window.clearTimeout(t);
      window.clearInterval(iv);
    };
  }, []);
  if (!update || hiddenVersion === update.version) return null;
  const notes = releaseNotes(update);
  const onInstall = async () => {
    setBusy(true);
    setStatus("Downloading…");
    const err = await installUpdate(update, (p) => setStatus(p == null ? "Downloading…" : `Downloading… ${p}%`));
    setBusy(false);
    if (err) setStatus("Update failed. Try again from Settings → General.");
  };
  return React.createElement(
    "div",
    {
      role: "status",
      style: {
        position: "fixed", right: 16, bottom: 16, zIndex: 9999, display: "flex", gap: 10, alignItems: "center",
        padding: "8px 12px", borderRadius: 10, background: "rgba(30,30,34,0.92)", color: "#fff", fontSize: 12.5,
        boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
      },
    },
    React.createElement(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 3 } },
      React.createElement("span", null, status || `FarmPrint ${update.version} is available.`),
      notes ? React.createElement("span", { style: notesStyle }, notes) : null
    ),
    React.createElement("button", { type: "button", className: "fp-btn fp-btn-sm fp-btn-primary", disabled: busy, onClick: onInstall }, "Install and restart"),
    React.createElement("button", { type: "button", className: "fp-btn fp-btn-sm", disabled: busy, onClick: () => setHiddenVersion(update.version) }, "Later")
  );
};
