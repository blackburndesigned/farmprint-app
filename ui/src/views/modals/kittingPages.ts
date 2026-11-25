/**
 * Page plan for the printed kitting card. The native print (WKWebView on macOS) slices the
 * document wherever the page ends, so the print copy is split into blocks that each fit on a
 * page: a product's block moves whole to the next page when it doesn't fit in what's left, and
 * a product too long for any page is cut between part rows into blocks that start a new page
 * with a "(continued)" header. Heights are CSS px from the card's print sizes (the rows have a
 * fixed height); each block also has `break-inside: avoid`, so an estimate that comes out a
 * little short moves the block rather than cutting it.
 */

/** Letter (the shortest common paper) minus the 0.5 in margins, in CSS px, with some slack. */
export const KITTING_PAGE_HEIGHT_PX = Math.floor((11 - 1) * 96 * 0.95);

export interface KittingBlockSizes {
  /** Product picture box (square). */
  picture: number;
  /** One part row. */
  row: number;
  /** Line title font size. */
  title: number;
  /** Part rows beside the picture (one column); the rest sit below it in two columns. */
  beside: number;
}

/** Print padding (10 px top and bottom), border and the gap between product blocks. */
export const KITTING_LINE_PAD_PX = 22;
export const KITTING_LINE_GAP_PX = 10;
/** Room for a two-column part grid's top margin. */
const GRID_TOP_PX = 2;

export interface KittingLineInfo {
  /** Part rows on the card for this line. */
  units: number;
  /** The title also shows custom text, which can wrap onto a second line. */
  hasCustomText?: boolean;
}

export interface KittingBlock {
  /** Index into the order's lines. */
  line: number;
  /** Part rows [start, end) of the line in this block. */
  start: number;
  end: number;
  /** Later block of a product longer than a page: no picture, "(continued)" header. */
  continued: boolean;
  /** Starts a new page. */
  newPage: boolean;
}

function titleHeight(z: KittingBlockSizes, info: KittingLineInfo): number {
  const line = Math.ceil(z.title * 1.25);
  return (info.hasCustomText ? line * 2 : line) + 4;
}

/** Height of a line's first block holding `n` part rows (picture, title, rows). */
export function firstBlockHeight(z: KittingBlockSizes, info: KittingLineInfo, n: number): number {
  const besideRows = Math.min(n, z.beside);
  const below = Math.max(0, n - z.beside);
  const head = Math.max(z.picture, titleHeight(z, info) + besideRows * z.row);
  return KITTING_LINE_PAD_PX + head + (below > 0 ? GRID_TOP_PX + Math.ceil(below / 2) * z.row : 0);
}

/** Height of a "(continued)" block holding `n` part rows (title, then two columns). */
export function continuedBlockHeight(z: KittingBlockSizes, info: KittingLineInfo, n: number): number {
  return KITTING_LINE_PAD_PX + titleHeight(z, info) + Math.ceil(n / 2) * z.row;
}

/** Most part rows a first block can hold in `space` px (0 when not even the picture fits). */
function firstBlockCapacity(z: KittingBlockSizes, info: KittingLineInfo, space: number): number {
  const head = Math.max(z.picture, titleHeight(z, info) + z.beside * z.row);
  const left = space - KITTING_LINE_PAD_PX - head;
  if (left < 0) return 0;
  return z.beside + 2 * Math.max(0, Math.floor((left - GRID_TOP_PX) / z.row));
}

function continuedCapacity(z: KittingBlockSizes, info: KittingLineInfo, space: number): number {
  return 2 * Math.max(0, Math.floor((space - KITTING_LINE_PAD_PX - titleHeight(z, info)) / z.row));
}

/**
 * Splits an order's lines into page blocks. `headerHeight` is what the card's top (logo,
 * customer, notes) takes on the first page; pages after the first start at the top.
 */
export function kittingBlocks(
  lines: KittingLineInfo[],
  z: KittingBlockSizes,
  headerHeight: number,
  pageHeight: number = KITTING_PAGE_HEIGHT_PX
): KittingBlock[] {
  const blocks: KittingBlock[] = [];
  let y = headerHeight;
  lines.forEach((info, line) => {
    const n = info.units;
    const whole = firstBlockHeight(z, info, n);
    if (whole <= pageHeight) {
      // Fits in what's left of this page, or moves whole to the next one.
      const moves = y + whole > pageHeight;
      blocks.push({ line, start: 0, end: n, continued: false, newPage: moves });
      y = (moves ? 0 : y) + whole + KITTING_LINE_GAP_PX;
      return;
    }
    // Longer than a page: fill this page from the top of the product (at least one row
    // below the picture, else start on a fresh page), then continue on the next pages.
    let newPage = false;
    let cap = firstBlockCapacity(z, info, pageHeight - y);
    if (cap < Math.min(n, z.beside + 2)) {
      newPage = y > 0;
      cap = firstBlockCapacity(z, info, pageHeight);
    }
    let start = Math.min(n, Math.max(cap, 1));
    blocks.push({ line, start: 0, end: start, continued: false, newPage });
    y = (newPage ? 0 : y) + firstBlockHeight(z, info, start) + KITTING_LINE_GAP_PX;
    const per = Math.max(2, continuedCapacity(z, info, pageHeight));
    while (start < n) {
      const end = Math.min(n, start + per);
      blocks.push({ line, start, end, continued: true, newPage: true });
      y = continuedBlockHeight(z, info, end - start) + KITTING_LINE_GAP_PX;
      start = end;
    }
  });
  return blocks;
}
