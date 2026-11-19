/**
 * Maps legacy root-relative catalog paths (`/catalog/<rel>`, stored by older catalog
 * entries) onto the backend's `fpcatalog` scheme inside the Tauri app. Release builds
 * no longer run the 127.0.0.1:1420 HTTP server, and the bundled UI does not ship
 * ui/public/catalog, so a bare `/catalog/...` would 404 under tauri://localhost.
 * Same base as partThumbnails' CATALOG_BASE (kept here to avoid an import cycle).
 * Plain browser / vite dev keeps `/catalog/...` unchanged.
 */
function catalogSchemeBase(): string | null {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  const isWindows = typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
  return isWindows ? "http://fpcatalog.localhost" : "fpcatalog://localhost";
}

export function toCatalogUrl(url: string): string {
  if (!url.startsWith("/catalog/")) return url;
  const base = catalogSchemeBase();
  return base ? `${base}${url.slice("/catalog".length)}` : url;
}
