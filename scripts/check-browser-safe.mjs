#!/usr/bin/env node
// Fail if any file under `src/` (excluding `scripts/`) imports `node:*`.
// Browser bundles must not pull in Node built-ins; Node-only paths live behind
// dynamic imports or in `scripts/`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = join(ROOT, "src");

const PATTERNS = [
    /\bfrom\s+["']node:[^"']+["']/,
    /\brequire\(\s*["']node:[^"']+["']\s*\)/,
];

/** @type {Array<{file: string, line: number, text: string}>} */
const hits = [];

function walk(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            walk(full);
        } else if (
            entry.endsWith(".ts") &&
            !entry.endsWith(".test.ts") &&
            !entry.endsWith(".bench.ts") &&
            !entry.includes("test-utils")
        ) {
            // Mirror tsconfig.json exclude patterns: anything not shipped to
            // dist/ is allowed to use Node built-ins.
            scan(full);
        }
    }
}

function scan(file) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pat of PATTERNS) {
            if (pat.test(line)) {
                hits.push({ file: relative(ROOT, file), line: i + 1, text: line.trim() });
                break;
            }
        }
    }
}

walk(SRC);

if (hits.length > 0) {
    console.error(`check-browser-safe: ${hits.length} node: import(s) found under src/:`);
    for (const h of hits) {
        console.error(`  ${h.file}:${h.line}  ${h.text}`);
    }
    console.error("\nMove Node-only code into scripts/ or load it via dynamic import behind a runtime check.");
    process.exit(1);
}

console.log(`check-browser-safe: OK — no node: imports under src/`);
