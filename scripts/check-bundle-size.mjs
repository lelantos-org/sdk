#!/usr/bin/env node
// Fail if total `dist/` JS size (excluding `.d.ts`, `.map`, `.wasm`) exceeds
// the configured budget. Adjust `MAX_BYTES` deliberately when growth is intended.

import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");

// Initial budget: current size (~331 KB) + 10% headroom. Bump deliberately
// when growth is justified; treat unexpected jumps as a regression signal.
const MAX_BYTES = 365_000;

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
