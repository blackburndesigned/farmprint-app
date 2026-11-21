// Shared confirmation stacking: the confirm must sit above every sheet/modal in the app,
// including ones portaled into <body> (Settings › Printers edit sheet), so it is never
// hidden behind the window that asked for it. Scans the UI source; no browser needed.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CONFIRM_Z_INDEX } from "../../src/layers";
import { check, done } from "./check";

const src = join(__dirname, "..", "..", "src");
// esbuild bundles this file, so __dirname is the temp output dir; fall back to cwd (ui/).
const root = (() => {
  try {
    statSync(join(src, "uiFeedback.tsx"));
    return src;
  } catch {
    return join(process.cwd(), "src");
  }
})();

const files: string[] = [];
const walk = (dir: string) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css)$/.test(f)) files.push(p);
  }
};
walk(root);

const feedback = readFileSync(join(root, "uiFeedback.tsx"), "utf8");
const host = feedback.slice(feedback.indexOf("export const ConfirmHost"), feedback.indexOf("export function isTypingTarget"));
check(/createPortal\(/.test(host) && /document\.body\s*\)/.test(host), "ConfirmHost portals into <body> (outside the shell's stacking context)");
check(/zIndex:\s*CONFIRM_Z_INDEX/.test(host), "ConfirmHost uses CONFIRM_Z_INDEX");
check(!/zIndex:\s*\d/.test(host), "ConfirmHost has no hard-coded z-index");
check(/stopImmediatePropagation/.test(host), "Esc on a confirmation does not also close the sheet behind it");

// Every other layer in the app stays below the confirmation.
let highest = { z: 0, where: "" };
for (const p of files) {
  const text = readFileSync(p, "utf8");
  for (const m of text.matchAll(/z-?index\s*:\s*(\d+)/gi)) {
    const z = Number(m[1]);
    if (z > highest.z) highest = { z, where: relative(root, p) };
    check(z < CONFIRM_Z_INDEX, `${relative(root, p)} z-index ${z} < confirm ${CONFIRM_Z_INDEX}`, true);
  }
}
check(highest.z < CONFIRM_Z_INDEX, `highest other layer (${highest.z} in ${highest.where}) is below the confirmation`);

// Every askConfirm caller goes through the one shared host (no private confirm overlays).
const callers = files.filter((p) => /\baskConfirm\(|confirmRemovePrinter\(|confirmDeleteFilament\(/.test(readFileSync(p, "utf8")));
check(callers.length >= 10, `askConfirm callers found: ${callers.map((p) => relative(root, p)).join(", ")}`);
check(!/window\.confirm\(/.test(files.map((p) => readFileSync(p, "utf8")).join("\n")), "no window.confirm (hidden/unsupported in the webview)");
done();
