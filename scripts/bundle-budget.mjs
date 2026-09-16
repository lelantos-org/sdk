#!/usr/bin/env node
// Size budgets for the built package.
//
// Two measures, both gated:
//
//   - dist total: every emitted JS file under `dist/` (no `.d.ts`, maps or wasm). A coarse "did
//     something unexpected land in dist" tripwire. `build` strips comments, so this is code.
//   - per-entry eager graph: esbuild bundles a representative import and measures the entry chunk
//     plus every chunk reachable from it by static import. Code behind a dynamic import lands in
//     its own chunk and is reported as lazy. `forbid` also walks the module graph itself.
//
// Budgets are minified bytes, not gzipped; figures print in KiB. Raise one deliberately, and
// understand a regression first — the usual causes are a CommonJS dependency that cannot be
// tree-shaken and a static import of something that should be lazy.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { DIST, loadTs, ROOT, walk } from "./lib/package.mjs";

const ts = loadTs();

/** Budget for all emitted JS under `dist/`. */
const DIST_MAX = 513_024; // 501 KiB

/**
 * Modules the spend path owns. An app entry must reach them only through a dynamic import, so a
 * caller who never spends never downloads them.
 */
const SPEND_PATH = [
    "bundle/spend.js",
    "wallet/tx/run-spend.js",
    "wallet/tx/steps.js",
    "wallet/ops/swap.js",
    "wallet/ops/quote-swap.js",
    // The wallet object's spend and quote methods, loaded on their first call.
    "wallet/surface/spend.js",
    // The deposit family: quote/deposit, cancel, Permit2 setup, and their surface.
    "wallet/surface/deposit.js",
    "wallet/ops/deposit.js",
    "wallet/ops/cancel-deposit.js",
    "wallet/ops/deposit-allowance.js",
    "bundle/deposit.js",
];

/**
 * Prover backends and their glue. The root and watch entries reach a prover only through
 * `connect`'s lazy handle (`wallet/defaults/prover.ts` → `await import(...)`), so these must stay
 * out of their static graphs too.
 */
const PROVER_PATH = ["prover/wasm-prover.js", "prover/snarkjs.js", "prover/worker-client.js"];

/**
 * `source` is bundled as-is; `max` is the eager budget in bytes. `forbid` lists `dist/`-relative
 * modules that must not appear in the static import graph of `module` (followed through
 * `import`/`export … from`, never `import()`), independent of how well esbuild shakes.
 *
 * The eager figure is an upper bound, not bytes a browser downloads. `splitting: true` is what
 * separates eager from lazy, but it also makes esbuild preserve symbols across chunk boundaries,
 * so an entry chunk can statically import shared chunks holding code only the lazy paths use.
 * `unsplit` (reported, never gated) is the same import bundled without splitting: the true static
 * cost for an entry that reaches no dynamic import, and an inflated one for an entry that does.
 * Keep the budgets as a ratchet against relative growth.
 */
const ENTRIES = [
    {
        name: "root: connect",
        source: `export { connect } from "${ROOT}/dist/entry/index.js";`,
        max: 255_000,
        module: "dist/entry/index.js",
        forbid: [...SPEND_PATH, ...PROVER_PATH],
    },
    {
        name: "root: errors only",
        source: `export { isWalletError } from "${ROOT}/dist/entry/index.js";`,
        max: 24_000,
        module: "dist/entry/index.js",
        forbid: [...SPEND_PATH, ...PROVER_PATH],
    },
    {
        // Formatting a balance must stay cheap: `wallet/assets/amount.ts` bundles no registry code.
        name: "root: amounts",
        source: `export { formatAmount, parseAmount } from "${ROOT}/dist/entry/index.js";`,
        max: 24_000,
    },
    {
        // The watch-only wallet. Must not reach the prover, the relayer submitter or the coin
        // selector; `check-layers.mjs` rule 5 covers direct imports. Its eager graph is the crypto
        // stack and the scan loop, so it tracks `primitives: keys`.
        name: "watch: connectWatch",
        source: `export { connectWatch } from "${ROOT}/dist/entry/watch.js";`,
        max: 148_000,
        module: "dist/entry/watch.js",
        forbid: [...SPEND_PATH, ...PROVER_PATH],
    },
    {
        // Key derivation and address encoding: the crypto stack's eager graph.
        name: "primitives: keys",
        source: `export { deriveKeysFromMnemonic, encodeAddress } from "${ROOT}/dist/entry/primitives.js";`,
        max: 150_000,
    },
    {
        // Pure arithmetic: none of the bundle builders `./protocol` also forwards.
        name: "protocol: fees",
        source: `export { depositTotals, withdrawNet } from "${ROOT}/dist/entry/protocol.js";`,
        max: 2_500,
    },
    {
        name: "services: relayer",
        source: `export { RelayerClient } from "${ROOT}/dist/entry/services.js";`,
        max: 10_500,
    },
    {
        // `createWallet` keeps the spend path lazy like `connect`; `./advanced` statically forwards
        // the viem adapter and the signers, which the split harness shares into the entry chunk.
        name: "advanced: createWallet",
        source: `export { createWallet } from "${ROOT}/dist/entry/advanced.js";`,
        max: 250_000,
        module: "dist/entry/advanced.js",
        forbid: SPEND_PATH,
    },
    {
        // The worker-backed prover a browser app imports; the wasm/snarkjs backends load lazily.
        name: "prover: WorkerProver",
        source: `export { WorkerProver } from "${ROOT}/dist/entry/prover.js";`,
        max: 18_000,
    },
    {
        name: "x402: pay",
        source: `export { x402 } from "${ROOT}/dist/entry/x402.js";`,
        max: 100_000,
    },
    {
        name: "configure-wasm",
        source: `export { configureWasm } from "${ROOT}/dist/configure-wasm.js";`,
        max: 15_000,
    },
];

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
let failed = false;

if (!existsSync(DIST)) {
    console.error("bundle-budget: dist/ missing. Run `npm run build` first.");
    process.exit(1);
}

const emitted = walk(DIST).filter((f) => !/\.(d\.ts|map|wasm)$/.test(f));
const distBytes = emitted.reduce((n, f) => n + statSync(f).size, 0);
failed ||= distBytes > DIST_MAX;
console.log(
    `${distBytes <= DIST_MAX ? "ok  " : "FAIL"}  ${"dist total".padEnd(24)} ` +
        `${kib(distBytes).padStart(15)} / ${kib(DIST_MAX).padStart(10)}   ${emitted.length} files`,
);

const tmp = mkdtempSync(join(tmpdir(), "lelantos-budget-"));
try {
    for (const entry of ENTRIES) {
        const slug = entry.name.replace(/\W+/g, "-");
        const file = join(tmp, `${slug}.js`);
        writeFileSync(file, entry.source);

        const bundleOnce = (splitting, tag) =>
            build({
                entryPoints: [file],
                bundle: true,
                format: "esm",
                platform: "browser",
                minify: true,
                splitting,
                outdir: join(tmp, "out", `${slug}-${tag}`),
                external: ["node:*"],
                metafile: true,
                logLevel: "error",
            });

        const outs = (await bundleOnce(true, "split")).metafile.outputs;
        const flatBytes = Object.values((await bundleOnce(false, "flat")).metafile.outputs).reduce(
            (n, o) => n + o.bytes,
            0,
        );

        // esbuild reports `entryPoint` relative to cwd, and a dynamic import gets its own
        // `entryPoint` too — match our probe by basename.
        const probe = basename(file);
        const start = Object.keys(outs).find((k) => outs[k].entryPoint?.endsWith(probe));
        if (!start) throw new Error(`bundle-budget: no output chunk for ${probe}`);
        const eager = staticClosure(outs, start);
        const eagerBytes = [...eager].reduce((n, c) => n + outs[c].bytes, 0);
        const lazyBytes = Object.entries(outs)
            .filter(([k]) => !eager.has(k) && k.endsWith(".js"))
            .reduce((n, [, v]) => n + v.bytes, 0);

        const reached = entry.module
            ? forbiddenStaticImports(join(ROOT, entry.module), entry.forbid ?? [])
            : [];

        const ok = eagerBytes <= entry.max && reached.length === 0;
        failed ||= !ok;
        console.log(
            `${ok ? "ok  " : "FAIL"}  ${entry.name.padEnd(24)} ` +
                `eager ${kib(eagerBytes).padStart(9)} / ${kib(entry.max).padStart(10)}` +
                `   lazy ${kib(lazyBytes).padStart(10)}` +
                `   unsplit ${kib(flatBytes).padStart(10)}`,
        );
        for (const { module, via } of reached) {
            console.log(`      statically imports ${module}\n        via ${via.join(" <- ")}`);
        }
    }
} finally {
    rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
    console.error(
        "\nbundle-budget: FAIL — dist or an entry grew past its budget, or an entry statically imports the spend path.\n" +
            "Find the cause with `--metafile` and esbuild's analyzer before raising a limit; " +
            "reach a forbidden module through `await import(...)` instead.",
    );
    process.exit(1);
}
console.log("bundle-budget: OK");

/**
 * Forbidden modules reachable from `entry` through static imports, each with the import chain that
 * reaches it.
 *
 * Follows every relative `import`/`export … from` in the emitted JS; `import()` is not a statement,
 * so lazy edges are skipped by construction. Deliberately not esbuild's metafile, whose import
 * lists are already tree-shaken (the package declares `sideEffects`), so an unused re-export of the
 * spend path would not show up there.
 */
function forbiddenStaticImports(entry, forbid) {
    if (forbid.length === 0) return [];
    const parent = new Map([[entry, null]]);
    const stack = [entry];
    while (stack.length) {
        const cur = stack.pop();
        const sf = ts.createSourceFile(
            cur,
            readFileSync(cur, "utf8"),
            ts.ScriptTarget.Latest,
            false,
            ts.ScriptKind.JS,
        );
        for (const st of sf.statements) {
            if (!ts.isImportDeclaration(st) && !ts.isExportDeclaration(st)) continue;
            const spec = st.moduleSpecifier;
            if (!spec || !ts.isStringLiteral(spec) || !spec.text.startsWith(".")) continue;
            const next = resolve(dirname(cur), spec.text);
            if (parent.has(next) || !existsSync(next)) continue;
            parent.set(next, cur);
            stack.push(next);
        }
    }
    const out = [];
    for (const module of parent.keys()) {
        const hit = forbid.find((f) => module.endsWith(`/${f}`));
        if (!hit) continue;
        const via = [];
        for (let c = parent.get(module); c; c = parent.get(c)) via.push(relative(ROOT, c));
        out.push({ module: hit, via });
    }
    return out;
}

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
