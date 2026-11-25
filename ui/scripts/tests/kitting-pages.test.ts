// Printed kitting card: product blocks move whole to the next page, and a product longer
// than a page continues on the next pages in "(continued)" blocks, never cut mid-row.
import {
  continuedBlockHeight,
  firstBlockHeight,
  KITTING_LINE_GAP_PX,
  KITTING_PAGE_HEIGHT_PX,
  kittingBlocks,
} from "../../src/views/modals/kittingPages";
import { check, done } from "./check";

const z = { picture: 240, row: 67, title: 21, beside: 3 };
const P = KITTING_PAGE_HEIGHT_PX;
const header = 130;

// One small product: a single block, no page break (single-page cards look the same).
const one = kittingBlocks([{ units: 3 }], z, header);
check(one.length === 1 && !one[0].newPage && !one[0].continued && one[0].end === 3, "one product is one block on page 1");

// Several products that fit on a page stay together.
const few = kittingBlocks([{ units: 3 }, { units: 2 }], z, header);
check(few.every((b) => !b.newPage && !b.continued), "products that fit stay on page 1");

// A product that doesn't fit in what's left moves whole to the next page.
const many = kittingBlocks([{ units: 3 }, { units: 3 }, { units: 9 }, { units: 3 }], z, header);
check(many.filter((b) => b.continued).length === 0, "page-sized products are never split");
check(many.some((b) => b.newPage), "a product that doesn't fit starts the next page");
check(many.every((b) => b.start === 0 && b.end === [3, 3, 9, 3][b.line]), "each product keeps all its rows in one block");

// Simulate the pages: no block may run past the page bottom.
function pages(blocks: ReturnType<typeof kittingBlocks>, lines: { units: number }[]): number[][] {
  const out: number[][] = [[]];
  let y = header;
  for (const b of blocks) {
    const h = b.continued ? continuedBlockHeight(z, lines[b.line], b.end - b.start) : firstBlockHeight(z, lines[b.line], b.end - b.start);
    if (b.newPage) { out.push([]); y = 0; }
    check(y + h <= P, `block ${b.line}:${b.start}-${b.end} fits its page (${y + h} <= ${P})`);
    out[out.length - 1].push(h);
    y += h + KITTING_LINE_GAP_PX;
  }
  return out;
}
pages(many, [{ units: 3 }, { units: 3 }, { units: 9 }, { units: 3 }]);

// A product with 36 part rows is longer than a page: it starts where it is, then continues.
const longLines = [{ units: 3 }, { units: 6 }, { units: 36 }, { units: 3 }];
const long = kittingBlocks(longLines, z, header);
const parts = long.filter((b) => b.line === 2);
check(parts.length >= 2, "a product longer than a page is split");
check(!parts[0].continued && parts.slice(1).every((b) => b.continued && b.newPage), "later blocks are '(continued)' on a new page");
check(parts[0].start === 0 && parts[parts.length - 1].end === 36 && parts.every((b, i) => i === 0 || b.start === parts[i - 1].end), "every row is printed once, in order");
check(parts.every((b) => (b.continued ? (b.end - b.start) % 2 === 0 || b.end === 36 : true)), "continued blocks hold whole two-column rows");
check(long.reduce((n, b) => n + (b.end - b.start), 0) === 48, "no row is dropped");
const pg = pages(long, longLines);
check(pg.length >= 3, `the long order spans 3+ pages (${pg.length})`);

// A long product with almost no room left starts on a fresh page instead of a sliver.
const late = kittingBlocks([{ units: 9 }, { units: 40 }], z, header + 300);
const lateFirst = late.find((b) => b.line === 1)!;
check(lateFirst.newPage && !lateFirst.continued, "a long product with no room left starts the next page");

// Custom text can wrap: its title counts two lines.
check(firstBlockHeight(z, { units: 3, hasCustomText: true }, 3) >= firstBlockHeight(z, { units: 3 }, 3), "custom text never makes a block shorter");

done();
