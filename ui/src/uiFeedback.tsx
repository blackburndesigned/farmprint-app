import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke, showContextMenu } from "./tauriInvoke";
import { CONFIRM_Z_INDEX } from "./layers";

/**
 * Shared confirm dialog and banner bus.
 * - `askConfirm` shows one in-app confirmation (WKWebView has no reliable window.confirm)
 *   and resolves true only when the user clicks the confirm button.
 * - `notifyBanner` lets any view show the app banner without threading props.
 */

export interface ConfirmOptions {
  title: string;
  message?: React.ReactNode;
  /** Bullet list of what is affected (orders, parts, ...). */
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type ConfirmRequest = ConfirmOptions & { resolve: (ok: boolean) => void };

let confirmListener: ((req: ConfirmRequest) => void) | null = null;

export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!confirmListener) {
      resolve(false);
      return;
    }
    confirmListener({ ...opts, resolve });
  });
}

export type BannerOptions = { error?: boolean };
let bannerListener: ((msg: string, opts?: BannerOptions) => void) | null = null;

export function notifyBanner(msg: string, opts?: BannerOptions) {
  bannerListener?.(msg, opts);
}

export function notifyError(prefix: string, err: unknown) {
  const text = err instanceof Error ? err.message : String(err);
  notifyBanner(`${prefix}: ${text}`, { error: true });
}

export function useBannerBus(onBanner: (msg: string, opts?: BannerOptions) => void) {
  const ref = useRef(onBanner);
  ref.current = onBanner;
  useEffect(() => {
    const fn = (msg: string, opts?: BannerOptions) => ref.current(msg, opts);
    bannerListener = fn;
    return () => {
      if (bannerListener === fn) bannerListener = null;
    };
  }, []);
}

/**
 * Mount once (App). Renders the pending confirmation above everything else: it is portaled
 * into <body> at CONFIRM_Z_INDEX, so it is never trapped under a sheet or modal that is
 * itself portaled into <body> or stacked higher than the app shell (e.g. Settings ›
 * Printers › edit sheet › Remove printer).
 */
export const ConfirmHost: React.FC = () => {
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);
  useEffect(() => {
    const fn = (req: ConfirmRequest) => setQueue((q) => [...q, req]);
    confirmListener = fn;
    return () => {
      if (confirmListener === fn) confirmListener = null;
    };
  }, []);
  const current = queue[0];
  const currentRef = useRef<ConfirmRequest | undefined>(current);
  currentRef.current = current;
  const finish = (ok: boolean) => {
    if (!current) return;
    current.resolve(ok);
    setQueue((q) => q.slice(1));
  };
  // Registered once when the app mounts, before any sheet adds its own Escape handler, so
  // stopImmediatePropagation keeps Esc from also closing the sheet behind the confirmation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const req = currentRef.current;
      if (!req || e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      req.resolve(false);
      setQueue((q) => (q[0] === req ? q.slice(1) : q));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  if (!current) return null;
  return createPortal(
    <div
      className="fp-modal-backdrop fp-confirm-layer"
      style={{ zIndex: CONFIRM_Z_INDEX }}
      role="presentation"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="fp-modal-window"
        role="alertdialog"
        aria-modal="true"
        aria-label={current.title}
        style={{ width: "min(460px, 92vw)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fp-modal-header">
          <div className="fp-modal-title">{current.title}</div>
        </div>
        <div className="fp-modal-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {current.message && (
            <div style={{ fontSize: 13, color: "rgba(235,235,245,0.8)", lineHeight: 1.45 }}>{current.message}</div>
          )}
          {current.details && current.details.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, maxHeight: 180, overflowY: "auto", color: "rgba(235,235,245,0.75)" }}>
              {current.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
            <button type="button" className="fp-btn fp-btn-sm" onClick={() => finish(false)}>
              {current.cancelLabel || "Cancel"}
            </button>
            <button
              type="button"
              autoFocus
              className={`fp-btn fp-btn-sm ${current.danger ? "fp-btn-danger" : "fp-btn-primary"}`}
              onClick={() => finish(true)}
            >
              {current.confirmLabel || "OK"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

/** True when keyboard focus is in a text field, so app shortcuts must not steal keys. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return false;
}

// ---- Shared confirmations for destructive actions ----------------------------------

type SnapshotLike = {
  orders: Array<{ order_code: string; lines: Array<{ units: Array<{ printer_id?: string | null; state: string; filament_id: string }> }> }>;
  products: Array<{ name: string; parts: Array<{ name: string; default_filament_id: string }> }>;
  overstock: Array<{ filament_id: string; quantity: number }>;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Asks before removing a printer and says what goes back to the queue. */
export async function confirmRemovePrinter(
  snapshot: SnapshotLike,
  printer: { id: string; name: string }
): Promise<boolean> {
  const details: string[] = [];
  let moving = 0;
  for (const o of snapshot.orders) {
    const n = o.lines
      .flatMap((l) => l.units)
      .filter((u) => u.printer_id === printer.id && (u.state === "Staged" || u.state === "Printing")).length;
    if (n) {
      moving += n;
      details.push(`${o.order_code}: ${plural(n, "part")}`);
    }
  }
  return askConfirm({
    title: `Remove ${printer.name}?`,
    message: moving
      ? `${plural(moving, "part")} staged or printing on this printer go back to In Queue. This is logged in Flow.`
      : "No parts are staged or printing on this printer.",
    details,
    confirmLabel: "Remove printer",
    danger: true,
  });
}

/**
 * Asks before deleting a filament color. When open orders, product defaults or
 * overstock still use it, explains that instead (the ledger refuses the delete).
 */
export async function confirmDeleteFilament(
  snapshot: SnapshotLike,
  filament: { id: string; name: string; brand?: string }
): Promise<boolean> {
  const openUnits = snapshot.orders
    .flatMap((o) => o.lines.flatMap((l) => l.units))
    .filter((u) => u.filament_id === filament.id && u.state !== "Shipped" && u.state !== "Closed").length;
  const defaults = snapshot.products.flatMap((p) =>
    p.parts.filter((pt) => pt.default_filament_id === filament.id).map((pt) => `${p.name} · ${pt.name}`)
  );
  const overstock = snapshot.overstock.filter((o) => o.filament_id === filament.id && o.quantity > 0).length;
  const label = [filament.brand, filament.name].filter(Boolean).join(" ");
  if (openUnits || defaults.length || overstock) {
    const uses = [
      openUnits ? `${plural(openUnits, "part")} on open orders` : "",
      defaults.length ? `${plural(defaults.length, "product part default")}` : "",
      overstock ? `${plural(overstock, "overstock item")}` : "",
    ].filter(Boolean);
    await askConfirm({
      title: `${label} is still in use`,
      message: `It is used by ${uses.join(", ")}. Change those to another color first, then delete it.`,
      details: defaults.slice(0, 12),
      confirmLabel: "OK",
      cancelLabel: "Close",
    });
    return false;
  }
  return askConfirm({
    title: `Delete ${label}?`,
    message: "It is removed from the filament library and from any printer slots that hold it.",
    confirmLabel: "Delete color",
    danger: true,
  });
}

// --- Shared helpers for Orders, ANDON, Printers and Shop Flow ------------------------

/** Failure reasons offered wherever a part can be marked failed. */
export const FAILURE_REASONS = ["Bed Adhesion", "Spaghetti", "Filament Runout", "Layer Shift", "Other"] as const;

/**
 * Asks why a print failed with a small menu at `at`. Resolves to the reason, or null when
 * dismissed (nothing should be marked failed then).
 */
export async function pickFailureReason(at: { x: number; y: number }): Promise<string | null> {
  const choice = await showContextMenu(
    FAILURE_REASONS.map((r) => ({ id: `reason:${r}`, label: `Failed: ${r}` })),
    at
  );
  return choice && choice.startsWith("reason:") ? choice.slice(7) : null;
}

/** Age badge for an order card: "3h", "2d", "5w". Late once older than `lateAfterDays`. */
export function orderAgeBadge(
  createdAt: string,
  lateAfterDays: number | undefined,
  now: number = Date.now()
): { label: string; isLate: boolean } {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return { label: "–", isLate: false };
  const hours = Math.max(0, (now - t) / 3_600_000);
  const days = hours / 24;
  const label =
    hours < 1 ? "new" : hours < 24 ? `${Math.floor(hours)}h` : days < 14 ? `${Math.floor(days)}d` : `${Math.floor(days / 7)}w`;
  const limit = lateAfterDays && lateAfterDays > 0 ? lateAfterDays : 3;
  return { label, isLate: days >= limit };
}

/** Local wall-clock time for an ISO timestamp (stored in UTC). */
export function localTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** One CSV cell: quoted when needed, inner quotes doubled. */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvText(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/**
 * Saves text through the native Save dialog in the app (a blob download link does nothing
 * in the app's webview); falls back to a browser download in the dev preview.
 * Resolves to the saved path, "" for a browser download, or null when cancelled.
 */
export async function saveTextFile(fileName: string, contents: string): Promise<string | null> {
  try {
    const res = await invoke<{ path: string | null }>("save_text_file", { file_name: fileName, contents });
    return res?.path ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/unavailable|unknown invoke command|404/i.test(msg)) throw e;
  }
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "";
}
