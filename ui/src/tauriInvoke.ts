import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";

/**
 * Inside the desktop app every call goes through Tauri IPC (no network port).
 * The 127.0.0.1:1420 HTTP API exists only in debug builds of the backend, so a
 * plain browser tab on the dev server (same origin, port 1420) can still use it.
 * There is deliberately no cross-origin fallback to http://127.0.0.1:1420.
 */
function inTauri(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

function devHttpBase(): string {
  if (
    typeof window !== "undefined" &&
    window.location &&
    window.location.protocol.startsWith("http") &&
    window.location.port === "1420"
  ) {
    return "";
  }
  throw new Error("FarmPrint backend unavailable: open the desktop app (or the dev server on port 1420).");
}

/**
 * Smaller replies: the UI registers the snapshot it is showing, every call sends the
 * `order_hash` of each order it holds, and the backend leaves those unchanged orders out
 * (`delta: true` + `order_ids`). The full snapshot is put back together here, so callers
 * still get a normal snapshot.
 */
let knownOrders: Map<string, { order_hash?: string }> | null = null;

export function setKnownSnapshot(snapshot: { orders?: Array<{ id: string; order_hash?: string }> } | null): void {
  if (!snapshot || !Array.isArray(snapshot.orders)) {
    knownOrders = null;
    return;
  }
  const map = new Map<string, { order_hash?: string }>();
  for (const o of snapshot.orders) {
    if (o && o.id && o.order_hash) map.set(o.id, o);
  }
  knownOrders = map;
}

type KnownOrder = { order_hash?: string };
type SnapshotOrder = KnownOrder & { id: string };

function mergeDelta(reply: unknown, known: Map<string, KnownOrder>): unknown | null {
  if (!reply || typeof reply !== "object") return reply;
  const r = reply as Record<string, unknown>;
  if (r.delta !== true || !Array.isArray(r.order_ids)) return reply;
  const sent = new Map<string, KnownOrder>();
  for (const o of (Array.isArray(r.orders) ? r.orders : []) as SnapshotOrder[]) sent.set(o.id, o);
  const orders: KnownOrder[] = [];
  for (const id of r.order_ids as string[]) {
    const o = sent.get(id) ?? known.get(id);
    if (!o) return null; // out of sync: caller refetches the full snapshot
    orders.push(o);
  }
  const { delta: _delta, order_ids: _ids, ...rest } = r;
  return { ...rest, orders };
}

async function rawInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (inTauri()) {
    return (await tauriInvoke<T>("fp_invoke", { cmd, args })) as T;
  }
  const res = await fetch(`${devHttpBase()}/api/invoke/${encodeURIComponent(cmd)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || `HTTP ${res.status} invoking ${cmd}`);
  }
  return (await res.json()) as T;
}

export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  const known = knownOrders;
  if (!known || known.size === 0) {
    return rawInvoke<T>(cmd, args || {});
  }
  const hashes: Record<string, string> = {};
  known.forEach((o, id) => {
    if (o.order_hash) hashes[id] = o.order_hash;
  });
  const reply = await rawInvoke<unknown>(cmd, { ...(args || {}), known_order_hashes: hashes });
  const merged = mergeDelta(reply, known);
  if (merged !== null) return merged as T;
  // A delta referenced an order this window doesn't have: ask for everything.
  return rawInvoke<T>("get_shop_snapshot", {});
}

/**
 * Prints the current window. In the app this is the webview's native print
 * (`print_current_window`); `window.print()` is a no-op in the macOS WKWebView.
 * The plain-browser dev preview uses `window.print()`. Throws when printing fails.
 */
export async function printCurrentWindow(): Promise<void> {
  if (inTauri()) {
    await tauriInvoke("print_current_window");
    return;
  }
  window.print();
}

export interface ParsedMeshPart {
  name: string;
  positions: number[];
  indices: number[];
}

/// Posts the file bytes. Bambu 3MF packages are ZIP64 or use data descriptors,
/// so a JSON array of those bytes never reaches the parser that can read them.
export async function parseMeshFile(
  filename: string,
  bytes: ArrayBuffer
): Promise<ParsedMeshPart[]> {
  if (inTauri()) {
    // Raw bytes as the IPC body; filename travels in a header (see fp_parse_mesh).
    const parts = await tauriInvoke<ParsedMeshPart[]>("fp_parse_mesh", new Uint8Array(bytes), {
      headers: { "x-fp-filename": encodeURIComponent(filename) },
    });
    if (!Array.isArray(parts)) throw new Error(`Could not read ${filename}`);
    return parts;
  }
  const res = await fetch(
    `${devHttpBase()}/api/parse-mesh?filename=${encodeURIComponent(filename)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    }
  );
  const text = await res.text();
  if (!res.ok) {
    let message = text || `Could not read ${filename}`;
    try {
      const body = JSON.parse(text) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // The server returned plain text.
    }
    throw new Error(message);
  }
  const parts = JSON.parse(text) as ParsedMeshPart[];
  if (!Array.isArray(parts)) {
    throw new Error(`Could not read ${filename}`);
  }
  return parts;
}

export type ContextMenuItem =
  | { id: string; label: string; enabled?: boolean; separator?: false }
  | { separator: true };

/// Right-click menu. Uses the native Tauri v2 popup (fp_context_menu command);
/// if the native bridge is unavailable (plain browser), shows a small in-app menu.
/// Resolves to the chosen item id, or null when dismissed.
export async function showContextMenu(
  items: ContextMenuItem[],
  at: { x: number; y: number }
): Promise<string | null> {
  try {
    if (inTauri()) {
      const data = await tauriInvoke<{ id?: string | null }>("fp_context_menu", { items });
      return data?.id ?? null;
    }
    const res = await fetch(`${devHttpBase()}/api/context-menu`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    if (res.ok) {
      const data = (await res.json()) as { id?: string | null };
      return data.id ?? null;
    }
  } catch {
    // fall through to in-app menu
  }
  return showInAppMenu(items, at);
}

function showInAppMenu(items: ContextMenuItem[], at: { x: number; y: number }): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.style.cssText = "position:fixed;inset:0;z-index:1000;";
    const menu = document.createElement("div");
    menu.style.cssText =
      "position:fixed;min-width:190px;background:rgba(28,28,34,0.98);border:1px solid rgba(255,255,255,0.18);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,0.6);padding:4px;font-size:13px;color:#fff;";
    const done = (id: string | null) => {
      backdrop.remove();
      resolve(id);
    };
    for (const it of items) {
      if ("separator" in it && it.separator) {
        const hr = document.createElement("div");
        hr.style.cssText = "height:1px;margin:4px 6px;background:rgba(255,255,255,0.14);";
        menu.appendChild(hr);
        continue;
      }
      const item = it as { id: string; label: string; enabled?: boolean };
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.label;
      const enabled = item.enabled !== false;
      btn.disabled = !enabled;
      btn.style.cssText = `display:block;width:100%;text-align:left;padding:5px 10px;border:0;border-radius:5px;background:transparent;color:${enabled ? "#fff" : "rgba(235,235,245,0.35)"};cursor:${enabled ? "pointer" : "default"};font:inherit;`;
      if (enabled) {
        btn.onmouseenter = () => (btn.style.background = "rgba(10,132,255,0.85)");
        btn.onmouseleave = () => (btn.style.background = "transparent");
        btn.onclick = (e) => {
          e.stopPropagation();
          done(item.id);
        };
      }
      menu.appendChild(btn);
    }
    backdrop.onclick = () => done(null);
    backdrop.oncontextmenu = (e) => {
      e.preventDefault();
      done(null);
    };
    menu.onclick = (e) => e.stopPropagation();
    backdrop.appendChild(menu);
    document.body.appendChild(backdrop);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4))}px`;
  });
}
