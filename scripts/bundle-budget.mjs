#!/usr/bin/env node
// Per-entry eager-bundle budgets.
//
// `check-bundle-size.mjs` measures all of `dist/`, which says nothing about
// what an application actually downloads. This one bundles representative
// imports with esbuild and measures the *eager* graph: the entry chunk plus
// every chunk reachable from it by static import. Code behind a dynamic
// import lands in its own chunk and is reported separately.
//
// Budgets are minified bytes, not gzipped. Raise one deliberately, the same
// way as in `check-bundle-size.mjs`, and prefer to understand a regression
// first — the usual causes are a CommonJS dependency that cannot be
// tree-shaken and a static import of something that should be lazy.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * `source` is bundled as-is; `max` is the eager budget in bytes.
 *
 * The subpath entries are the ones to keep honest — they are what a
 * cost-sensitive consumer should import, and they shake down to almost
 * nothing. The root-barrel entries are deliberately generous: pulling any
 * symbol through `dist/index.js` currently retains viem's client stack
 * (~306 KB) even when nothing reachable uses it, and the cause is not yet
 * pinned down. Treat those two numbers as a ceiling to drive down, not as a
 * target that has been met.
 */
const ENTRIES = [
    {
        name: "root: connect",
        source: `export { connect } from "${ROOT}/dist/index.js";`,
        max: 640_000,
    },
    {
        name: "root: errors only",
        source: `export { isWalletError } from "${ROOT}/dist/index.js";`,
        max: 350_000,
    },
    {
        name: "subpath: errors",
        source: `export { isWalletError } from "${ROOT}/dist/core/errors.js";`,
        max: 4_000,
    },
    {
        name: "subpath: networks",
        source: `export { NETWORKS } from "${ROOT}/dist/chain/networks.js";`,
        max: 4_000,
    },
    {
        name: "keys: derive + address",
        source: `export { deriveKeysFromMnemonic, encodeAddress } from "${ROOT}/dist/keys/index.js";`,
        max: 220_000,
    },
    {
        name: "x402: pay",
        source: `export { x402 } from "${ROOT}/dist/x402/index.js";`,
        max: 100_000,
    },
    {
        name: "configure-wasm",
        source: `export { configureWasm } from "${ROOT}/dist/configure-wasm.js";`,
        max: 15_000,
    },
];

const tmp = mkdtempSync(join(tmpdir(), "lelantos-budget-"));
let failed = false;

try {
    for (const entry of ENTRIES) {
        const file = join(tmp, `${entry.name.replace(/\W+/g, "-")}.js`);
        writeFileSync(file, entry.source);

        const result = await build({
            entryPoints: [file],
            bundle: true,
            format: "esm",
            platform: "browser",
            minify: true,
            splitting: true,
            outdir: join(tmp, "out", entry.name.replace(/\W+/g, "-")),
            external: ["node:*"],
            metafile: true,
            logLevel: "error",
        });

        const outs = result.metafile.outputs;
        // esbuild reports `entryPoint` relative to cwd, and a dynamic import
        // gets its own `entryPoint` too — match our probe by basename.
        const probe = basename(file);
        const start = Object.keys(outs).find((k) => outs[k].entryPoint?.endsWith(probe));
        if (!start) throw new Error(`bundle-budget: no output chunk for ${probe}`);
        const eager = staticClosure(outs, start);
        const eagerBytes = [...eager].reduce((n, c) => n + outs[c].bytes, 0);
        const lazyBytes = Object.entries(outs)
            .filter(([k]) => !eager.has(k) && k.endsWith(".js"))
            .reduce((n, [, v]) => n + v.bytes, 0);

        const ok = eagerBytes <= entry.max;
        failed ||= !ok;
        console.log(
            `${ok ? "ok  " : "FAIL"}  ${entry.name.padEnd(24)} ` +
                `eager ${kb(eagerBytes).padStart(9)} / ${kb(entry.max).padStart(9)}` +
                `   lazy ${kb(lazyBytes)}`,
        );
    }
} finally {
    rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
    console.error(
        "\nbundle-budget: FAIL — an entry grew past its eager budget.\n" +
            "Find the cause with `--metafile` and esbuild's analyzer before raising a limit.",
    );
    process.exit(1);
}
console.log("bundle-budget: OK");

/** Chunks reachable from `start` by static import — what the browser fetches first. */
function staticClosure(outs, start) {
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
        const cur = stack.pop();
        if (!cur || seen.has(cur)) continue;
        seen.add(cur);
        for (const imp of outs[cur].imports ?? []) {
            if (imp.kind === "import-statement" && outs[imp.path]) stack.push(imp.path);
        }
    }
    return seen;
}

function kb(n) {
    return `${(n / 1024).toFixed(1)} KB`;
}
