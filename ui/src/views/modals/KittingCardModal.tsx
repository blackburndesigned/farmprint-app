import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BrandLogo } from "../../components/BrandLogo";
import { printCurrentWindow } from "../../tauriInvoke";
import { getTintedPartCanvas, isThumbnailOnlyUnit, PART_PLACEHOLDER_SRC, PartThumb } from "../../partThumbnails";
import { notifyError } from "../../uiFeedback";
import { Order, OrderLine, PartUnit } from "../../types";
import { LineCompositeThumb } from "../shared";
import { OrderLinePicture } from "../../orderLineThumbs";

/**
 * Kitting card picture for one order line: the full product as ordered, in the line's colors.
 * The line's saved picture when its colors still match, else the live composite the order
 * details draw (LineCompositeThumb), so a line without a saved picture still gets one.
 * Those pictures leave a wide transparent margin around the product, so the card shows a
 * copy trimmed to the product (aspect kept) that fills the box; the original stays mounted,
 * hidden, as the source (and is shown as is while it draws or if the trim fails).
 */
const KittingLinePicture: React.FC<{ order: Order; line: OrderLine; size: number }> = ({ order, line, size }) => {
  const sourceRef = useRef<HTMLSpanElement>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [trim, setTrim] = useState<{ raw: string; src: string | null } | null>(null);

  // Follow the source picture's src (placeholder -> composite -> saved picture).
  useEffect(() => {
    const host = sourceRef.current;
    if (!host) return;
    const read = () => {
      const img = Array.from(host.querySelectorAll("img")).find((i) => {
        const src = i.getAttribute("src") || "";
        return src !== "" && src !== PART_PLACEHOLDER_SRC;
      });
      setRaw(img ? img.getAttribute("src") : null);
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    if (!raw) return;
    let alive = true;
    trimmedPicture(raw).then(
      (src) => { if (alive) setTrim({ raw, src }); },
      () => { if (alive) setTrim({ raw, src: null }); }
    );
    return () => { alive = false; };
  }, [raw]);

  const trimmed = raw !== null && trim?.raw === raw ? trim.src : null;
  return (
    <span
      className="fp-kitting-line-picture"
      data-kitting-pending={raw !== null && trim?.raw !== raw ? "" : undefined}
      style={{ display: "inline-flex", flexShrink: 0, width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      <span ref={sourceRef} style={{ display: trimmed ? "none" : "inline-flex" }}>
        <OrderLinePicture order={order} line={line} size={size} noOutline fallback={<LineCompositeThumb line={line} size={size} renderPx={640} noOutline />} />
      </span>
      {trimmed && (
        <img
          className="fp-kitting-line-trimmed"
          src={trimmed}
          alt={line.product_name}
          draggable={false}
          style={{ width: size, height: size, objectFit: "contain", display: "block" }}
        />
      )}
    </span>
  );
};

/** True for pale filaments (white, cream, light gray) that need an outline on paper. */
function isLightHex(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})/i.exec((hex || "").trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const luma = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return luma > 0.75;
}

/** Outline for pale part pictures so white parts don't vanish on white paper. */
const LIGHT_PART_FILTER = "drop-shadow(0 0 1px #555) drop-shadow(0 0 0.5px #555)";

/**
 * Crops a picture to its visible pixels (alpha > 12) plus `margin` (fraction of the larger
 * side) on each side, as a PNG data URL. `square` centers the crop on a square canvas;
 * otherwise the crop keeps the content's own aspect. Throws for an empty or unreadable
 * (cross-origin) picture.
 */
function cropToContent(src: HTMLCanvasElement | HTMLImageElement, opts: { square: boolean; margin: number }): string {
  const w = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
  const h = src instanceof HTMLImageElement ? src.naturalHeight : src.height;
  let read: HTMLCanvasElement;
  if (src instanceof HTMLCanvasElement) {
    read = src;
  } else {
    read = document.createElement("canvas");
    read.width = w;
    read.height = h;
    read.getContext("2d")?.drawImage(src, 0, 0);
  }
  const px = read.getContext("2d")?.getImageData(0, 0, w, h).data;
  if (!px) throw new Error("no pixels");
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 12) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error("empty picture");
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const pad = Math.ceil(Math.max(bw, bh) * opts.margin);
  const outW = opts.square ? Math.max(bw, bh) + 2 * pad : bw + 2 * pad;
  const outH = opts.square ? outW : bh + 2 * pad;
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  out.getContext("2d")?.drawImage(read, x0, y0, bw, bh, Math.round((outW - bw) / 2), Math.round((outH - bh) / 2), bw, bh);
  return out.toDataURL("image/png");
}

const PICTURE_TRIM_CACHE = new Map<string, Promise<string>>();

/** The product picture with its transparent margin trimmed (aspect kept). Keyed by the
 *  picture URL, so the preview and the print copy share one crop. */
function trimmedPicture(src: string): Promise<string> {
  let p = PICTURE_TRIM_CACHE.get(src);
  if (!p) {
    p = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("picture didn't load"));
      img.src = src;
    }).then((img) => cropToContent(img, { square: false, margin: 0.03 }));
    p.catch(() => PICTURE_TRIM_CACHE.delete(src));
    if (PICTURE_TRIM_CACHE.size > 64) {
      const oldest = PICTURE_TRIM_CACHE.keys().next().value;
      if (oldest !== undefined) PICTURE_TRIM_CACHE.delete(oldest);
    }
    PICTURE_TRIM_CACHE.set(src, p);
  }
  return p;
}

const PART_CROP_CACHE = new Map<string, Promise<string>>();

/**
 * The tinted part picture cropped to the part itself (transparent margin trimmed, then
 * centered on a square with a small margin). Some catalog part pictures are the whole
 * product frame with the part as a speck (Keyfob, Skirt); cropped, every part fills its box.
 * Tinted at up to 1024 px so the crop of a small part is still sharp in print.
 */
function croppedPartPicture(unit: PartUnit): Promise<string> {
  const key = `${unit.product_id || ""}::${unit.part_name}::${unit.filament_hex}`;
  let p = PART_CROP_CACHE.get(key);
  if (!p) {
    p = getTintedPartCanvas(unit.part_name, unit.filament_hex || "#888888", false, unit.product_id, 1024).then((src) =>
      cropToContent(src, { square: true, margin: 0.04 })
    );
    p.catch(() => PART_CROP_CACHE.delete(key));
    PART_CROP_CACHE.set(key, p);
  }
  return p;
}

/** Part picture on the kitting card: cropped to the part (see croppedPartPicture), aspect
 *  kept, outlined when the filament is pale. Shows the plain PartThumb until it's ready or
 *  if cropping fails. */
const KittingPartThumb: React.FC<{ unit: PartUnit; size: number }> = ({ unit, size }) => {
  const key = `${unit.product_id || ""}::${unit.part_name}::${unit.filament_hex}`;
  const [pic, setPic] = useState<{ key: string; src: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    croppedPartPicture(unit).then(
      (src) => { if (alive) setPic({ key, src }); },
      () => { if (alive) setPic({ key, src: null }); }
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` covers the unit fields used
  }, [key]);
  const done = pic?.key === key;
  const light = isLightHex(unit.filament_hex);
  return (
    <span
      className="fp-kitting-part-thumb"
      data-kitting-pending={done ? undefined : ""}
      style={{ display: "inline-flex", flexShrink: 0, width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      {done && pic.src ? (
        <img
          className={light ? "fp-kitting-light" : undefined}
          src={pic.src}
          alt={unit.part_name}
          draggable={false}
          style={{ width: size, height: size, objectFit: "contain", display: "block", filter: light ? LIGHT_PART_FILTER : "none" }}
        />
      ) : (
        <PartThumb partName={unit.part_name} colorHex={unit.filament_hex} productId={unit.product_id} size={size} noOutline />
      )}
    </span>
  );
};

/** One check-list row: check box, color dot, part picture, then "Part · Color" on one line. */
const KittingUnitRow: React.FC<{ unit: PartUnit; z: KittingSizes }> = ({ unit: u, z }) => {
  const light = isLightHex(u.filament_hex);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        fontSize: z.part,
        minHeight: z.row,
        lineHeight: 1.2,
        minWidth: 0,
      }}
    >
      <span
        style={{
          width: z.check,
          height: z.check,
          flexShrink: 0,
          boxSizing: "border-box",
          border: "1.5px solid #0f172a",
          borderRadius: 2,
          display: "inline-block",
        }}
      />
      <span
        style={{
          width: z.swatch,
          height: z.swatch,
          flexShrink: 0,
          boxSizing: "border-box",
          borderRadius: "50%",
          background: u.filament_hex,
          border: light ? "2px solid #64748b" : "1px solid #475569",
          display: "inline-block",
        }}
      />
      <KittingPartThumb unit={u} size={z.thumb} />
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
        <strong>{u.part_name}</strong> · {u.filament_name}
      </span>
    </div>
  );
};

/**
 * Waits until every picture on the kitting cards has loaded and decoded, so the native print
 * doesn't capture placeholders. A line composite that is still drawing shows the part
 * placeholder, so keep waiting while one is on a card (up to `timeoutMs`).
 */
async function waitForKittingPictures(root: HTMLElement | null, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const imgs = root ? Array.from(root.querySelectorAll("img")) : [];
    await Promise.all(
      imgs.map(async (img) => {
        if (!img.complete) {
          await new Promise<void>((resolve) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          });
        }
        await img.decode().catch(() => undefined);
      })
    );
    const drawing =
      imgs.some((img) => img.closest(".fp-kitting-line-picture") && img.getAttribute("src") === PART_PLACEHOLDER_SRC) ||
      !!root?.querySelector("[data-kitting-pending]");
    if (!drawing || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

/**
 * 1:1 port of `KittingCardPrint.swift` & `KittingCardFace.swift` (4×6 inch Kitting Card).
 */
export const KittingCardModal: React.FC<{
  orders: Order[];
  onClose: () => void;
}> = ({ orders, onClose }) => {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [printing, setPrinting] = useState(false);
  if (orders.length === 0) return null;
  return (
    <div className="fp-modal-backdrop" onClick={onClose}>
      <div
        className="fp-modal-window" role="dialog" aria-modal="true"
        style={{ width: "min(640px, 94vw)", maxHeight: "88vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fp-modal-header">
          <div>
            <div className="fp-modal-title">
              Kitting Card Preview ({orders.length}{" "}
              {orders.length === 1 ? "order" : "orders"})
            </div>
            <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>
              Prints one card per page, on the paper picked in the print dialog
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="fp-btn fp-btn-sm fp-btn-primary"
              disabled={printing}
              onClick={async () => {
                setPrinting(true);
                try {
                  await waitForKittingPictures(sheetRef.current);
                  await printCurrentWindow();
                } catch (e) {
                  notifyError("The kitting card didn't print", e);
                } finally {
                  setPrinting(false);
                }
              }}
            >
              {printing ? "Preparing…" : "🖨️ Print Kitting Card"}
            </button>
            <button type="button" className="fp-btn fp-btn-sm" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
        <div
          className="fp-modal-body"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            alignItems: "center",
          }}
        >
          <KittingCards orders={orders} sizes={KITTING_SIZES.screen} />
        </div>
      </div>
      {/* What the native print prints: a copy of the cards as a direct child of <body>, outside
          the app shell and this fixed overlay (see the @media print rules in index.css). */}
      {createPortal(
        <div className="fp-kitting-print-sheet" ref={sheetRef}>
          <KittingCards orders={orders} sizes={KITTING_SIZES.print} />
        </div>,
        document.body
      )}
    </div>
  );
};

/**
 * Kitting card sizes in CSS px (96 px = 1 in, 4 px = 3 pt). Print is sized for a Letter or A4
 * page: a 2.25-2.5 in product picture per line (composite or saved), 0.23 in check boxes, 0.55 in part pictures, 12 pt
 * part text in 0.7 in rows, 22.5 pt customer name. The on-screen preview is a smaller version.
 * `beside`: how many part rows sit next to the picture (one column); the rest go below it in
 * two columns across the whole line, so "Part · Color" stays on one line on Letter and A4.
 */
const KITTING_SIZES = {
  screen: { card: 560, picture: 150, check: 14, swatch: 11, thumb: 34, part: 12.5, title: 15, name: 22, meta: 12, notes: 12, footer: 11, row: 40, beside: 3 },
  print: { card: 384, picture: 240, check: 22, swatch: 15, thumb: 53, part: 16, title: 21, name: 30, meta: 16, notes: 15, footer: 13, row: 67, beside: 3 },
};
type KittingSizes = (typeof KITTING_SIZES)["print"];

/** The kitting card faces, one per order (the preview and the print sheet both draw these). */
const KittingCards: React.FC<{ orders: Order[]; sizes: KittingSizes }> = ({ orders, sizes: z }) => (
        <>
          {orders.map((ord) => {
            const trackedUnits = ord.lines
              .flatMap((l) => l.units)
              .filter((u) => !isThumbnailOnlyUnit(u));
            return (
              <div
                key={ord.id}
                className="fp-kitting-card"
                style={{
                  width: z.card,
                  minHeight: 520,
                  background: "#ffffff",
                  color: "#0f172a",
                  borderRadius: 12,
                  padding: "20px 22px",
                  boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
                }}
              >
                <div>
                  <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
                    <BrandLogo height={36} dark onlyCustom />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      borderBottom: "2px solid #0f172a",
                      paddingBottom: 10,
                      marginBottom: 12,
                    }}
                  >
                    <div>
                      <div className="fp-kitting-customer" style={{ fontSize: z.name, fontWeight: 900, lineHeight: 1.15 }}>
                        {ord.customer_name}
                      </div>
                      <div
                        style={{
                          fontSize: z.meta,
                          fontFamily: "ui-monospace, SFMono-Regular, monospace",
                          fontWeight: 700,
                          color: "#334155",
                          marginTop: 2,
                        }}
                      >
                        {ord.order_code}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {ord.is_rush && (
                        <div
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 4,
                            background: "#dc2626",
                            color: "#fff",
                            fontSize: z.meta,
                            fontWeight: 900,
                          }}
                        >
                          RUSH
                        </div>
                      )}
                      <div style={{ fontSize: z.meta, color: "#475569", marginTop: 4 }}>
                        {ord.lines.length} item{ord.lines.length === 1 ? "" : "s"} ·{" "}
                        {trackedUnits.length} parts
                      </div>
                    </div>
                  </div>

                  {ord.notes && (
                    <div
                      style={{
                        padding: "6px 10px",
                        borderRadius: 6,
                        background: "#f1f5f9",
                        border: "1px solid #cbd5e1",
                        fontSize: z.notes,
                        marginBottom: 12,
                      }}
                    >
                      <strong>Notes:</strong> {ord.notes}
                    </div>
                  )}

                  <div className="fp-kitting-lines" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {ord.lines.map((line, idx) => {
                      const units = line.units.filter(
                        (u) => !isThumbnailOnlyUnit(u)
                      );
                      return (
                        <div
                          key={line.id}
                          className="fp-kitting-line"
                          style={{
                            border: "1px solid #cbd5e1",
                            borderRadius: 8,
                            padding: "8px 10px",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                            {/* The product as ordered, left of the line title and its first parts. */}
                            <KittingLinePicture order={ord} line={line} size={z.picture} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  fontSize: z.title,
                                  fontWeight: 800,
                                  marginBottom: 4,
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  gap: 8,
                                }}
                              >
                                <span>
                                  #{idx + 1} · {line.quantity}× {line.product_name}
                                </span>
                                {line.custom_text && (
                                  <span style={{ color: "#0284c7" }}>
                                    “{line.custom_text}”
                                  </span>
                                )}
                              </div>
                              {units.slice(0, z.beside).map((u) => (
                                <KittingUnitRow key={u.id} unit={u} z={z} />
                              ))}
                            </div>
                          </div>
                          {units.length > z.beside && (
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                                columnGap: 12,
                                marginTop: 2,
                              }}
                            >
                              {units.slice(z.beside).map((u) => (
                                <KittingUnitRow key={u.id} unit={u} z={z} />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div
                  className="fp-kitting-footer"
                  style={{
                    borderTop: "1px solid #cbd5e1",
                    paddingTop: 8,
                    marginTop: 14,
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: z.footer,
                    color: "#64748b",
                  }}
                >
                  <span>FarmPrint Kitting Card</span>
                  <span>QC Checked: ______</span>
                </div>
              </div>
            );
          })}
        </>
);
