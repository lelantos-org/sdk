#!/usr/bin/env node
// Fail if shipped code under `src/` uses a Node-only facility a browser bundle cannot provide:
//
//   - a static `node:*` import (browser bundles must not pull in Node built-ins; Node-only paths live
//     behind dynamic imports or in `scripts/`);
//   - `process.env` (no `process` global in a browser; bundlers that shim it inline `undefined`);
//   - `Buffer` (not a browser global; use `Uint8Array` and `core/hex.ts` / `core/bytes.ts`).
//
// Comments are ignored. A file that legitimately touches `process.env` or `Buffer` must be listed in
// NODE_ONLY with the reason it is safe (a Node-only code path, or a `typeof process` guard).

import { readFileSync } from "node:fs";
import { shippedSources } from "./lib/package.mjs";

const NODE_IMPORT = [/\bfrom\s+["']node:[^"']+["']/, /\brequire\(\s*["']node:[^"']+["']\s*\)/];
const NODE_GLOBALS = [
    { pattern: /\bprocess\.env\b/, what: "process.env" },
    { pattern: /(?<![.\w$])Buffer\b/, what: "Buffer" },
];

/**
 * `src/`-relative files allowed to use `process.env` / `Buffer`, with why. Static `node:` imports are
 * never allowlisted.
 */
const NODE_ONLY = new Map([
    [
        "runtime/wasm/rayon/node-worker.ts",
        "Node rayon worker adapter; loaded only on the Node branch of the rayon pool",
    ],
    [
        "log/env.ts",
        "reads env knobs behind a `typeof process` guard; returns undefined in a browser",
    ],
    [
        "prover/artifact-paths.ts",
        'LELANTOS_PROVER_ARTIFACTS_DIR on the `runtime === "node"` branch, `typeof process` guarded',
    ],
]);

/** @type {Array<{file: string, line: number, text: string, what: string}>} */
const hits = [];
const usedAllowlist = new Set();

/** Source with comments blanked (line structure kept). Strings are left alone. */
function stripComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/(^|[^:"'`\\])\/\/.*$/gm, (_m, pre) => pre);
}

function scan(file, rel) {
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pat of NODE_IMPORT) {
            if (pat.test(line)) {
                hits.push({ file: rel, line: i + 1, text: line.trim(), what: "node: import" });
                break;
            }
        }
        for (const { pattern, what } of NODE_GLOBALS) {
            if (!pattern.test(line)) continue;
            if (NODE_ONLY.has(rel)) {
                usedAllowlist.add(rel);
                continue;
            }
            hits.push({ file: rel, line: i + 1, text: line.trim(), what });
        }
    }
}

for (const { abs, rel } of shippedSources()) scan(abs, rel);

const stale = [...NODE_ONLY.keys()].filter((f) => !usedAllowlist.has(f));

if (hits.length > 0 || stale.length > 0) {
    if (hits.length > 0) {
        console.error(`check-browser-safe: ${hits.length} Node-only use(s) in shipped src/:`);
        for (const h of hits) console.error(`  src/${h.file}:${h.line}  [${h.what}]  ${h.text}`);
        console.error(
            "\nMove Node-only code into scripts/, load it via dynamic import behind a runtime check," +
                " or (for a guarded Node-only path) add the file to NODE_ONLY with the reason.",
        );
    }
    if (stale.length > 0) {
        console.error(
            `check-browser-safe: NODE_ONLY lists files with no Node-only use: ${stale.join(", ")}`,
        );
    }
    process.exit(1);
}

console.log(
    `check-browser-safe: OK — no node: imports; process.env/Buffer only in ${NODE_ONLY.size} allowlisted Node-only files`,
);
