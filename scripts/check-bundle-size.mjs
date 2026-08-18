#!/usr/bin/env node
// Fail if total `dist/` JS size (excluding `.d.ts`, `.map`, `.wasm`) exceeds
// the configured budget. Adjust `MAX_BYTES` deliberately when growth is intended.

import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");

// Budget: current size + ~10% headroom. Bump deliberately when growth is
// justified; treat unexpected jumps as a regression signal.
//
// The jump from 331 KB came with the nominal types in `core/brand.ts`: the
// types themselves are erased, but their validating constructors and the
// narrowing guards built on them are runtime code.
//
// 400 KB → 280 KB: `build:js` now passes `--removeComments`, so this measures
// code rather than documentation. It was 392 KB against a 400 KB ceiling, and
// 36% of that was comment bytes that no bundler ever ships. Declarations are
// emitted by a second pass (`build:types`) *without* the flag, because
// `removeComments` strips JSDoc from `.d.ts` too and consumers would lose
// every hover doc.
//
// 280 KB → 300 KB: raised to cover in-flight work that had already pushed
// `dist/` to 296 KB. Note the headroom here is ~1.4%, not the ~10% the
// earlier ceilings carried — so the next legitimate addition trips this, and
// the bump to make room should be a deliberate re-baseline rather than
// another few KB.
//
// Still a coarse "did something unexpected land in dist" tripwire —
// `bundle-budget.mjs` is the gate for what users actually download.
const MAX_BYTES = 307_200; // 300 KiB, as reported by `kb()` below.

let total = 0;
let count = 0;

function walk(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            walk(full);
        } else if (
            !entry.endsWith(".d.ts") &&
            !entry.endsWith(".map") &&
            !entry.endsWith(".wasm")
        ) {
            total += st.size;
            count++;
        }
    }
}

walk(DIST);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const pct = ((total / MAX_BYTES) * 100).toFixed(1);

console.log(`check-bundle-size: ${count} files, ${kb(total)} / ${kb(MAX_BYTES)} (${pct}%)`);

if (total > MAX_BYTES) {
    console.error(
        `check-bundle-size: FAIL — ${kb(total)} exceeds budget ${kb(MAX_BYTES)}.\n` +
            `If the growth is intentional, raise MAX_BYTES in scripts/check-bundle-size.mjs.`,
    );
    process.exit(1);
}
