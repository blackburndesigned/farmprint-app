// Runs the UI's plain TypeScript checks (no browser, no extra test framework): each file in
// scripts/tests/*.test.ts plus scripts/view-camera-roundtrip.ts is bundled with esbuild (already
// installed with Vite) and run in Node. A check fails by throwing or exiting non-zero.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const files = [
  ...readdirSync(join(here, "tests")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => join(here, "tests", f)),
  join(here, "view-camera-roundtrip.ts"),
];
const out = mkdtempSync(join(tmpdir(), "fp-ui-tests-"));
let failed = 0;
try {
  for (const file of files) {
    const outfile = join(out, file.replace(/[^a-z0-9]+/gi, "_") + ".cjs");
    await build({ entryPoints: [file], bundle: true, platform: "node", format: "cjs", logLevel: "error", outfile });
    const name = file.slice(here.length);
    try {
      execFileSync(process.execPath, [outfile], { stdio: "inherit" });
      console.log(`PASS ${name}`);
    } catch {
      failed++;
      console.error(`FAIL ${name}`);
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
if (failed) {
  console.error(`${failed} test file(s) failed`);
  process.exit(1);
}
console.log(`all ${files.length} test files passed`);
