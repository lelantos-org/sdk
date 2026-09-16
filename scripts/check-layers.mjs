// Enforces the dependency ladder and barrel discipline in src/.
//
// Without this the structure re-rots on the first convenient import: each layering inversion is
// individually reasonable at the time, and nothing else watches the whole.
//
// Rules:
//   1. No module may import from a HIGHER tier.
//   2. No `export *` in any barrel — package.json#exports has no wildcard, so a barrel forwarding
//      blindly is what makes @internal symbols public API.
//   3. No leaf module below tier 3 may import another domain's BARREL. Worker and wasm bundles pull
//      the whole barrel's graph; leaf imports keep them small.
//   4. Every directory under `src/` carries an explicit tier.
//   5. `wallet/watch/` may not import the spend path, so a viewer does not download the prover.
//   6. `errors/` imports only `core/` (and itself), so every layer — `core/` included — can throw a
//      typed error without an upward or domain dependency.
//   7. `wallet/ops/*` (one module per operation) never imports another operation, so an operation
//      composes others only through `WalletContext` hooks bound by the wallet shell. The one
//      exception is `swap.ts` → `swap-escrow.ts`, its own second leg. `wallet/tx/` (the pipeline
//      operations share) and `wallet/context.ts` import no operation at all, nor the shell.
//   8. `entry/*` (the published subpaths) holds only `export { … } from` statements naming modules
//      outside `entry/`, and nothing outside `entry/` imports an entry. The published surface is
//      then exactly the list in those files, each name forwarded once from where it is declared.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { SRC, shippedSources, ts } from "./lib/package.mjs";

/**
 * First path segment -> tier.
 *
 * Every directory under `src/` must appear here (rule 4). An unlisted module would be checked
 * against nothing and could silently acquire any dependency it likes, which is the failure this
 * script exists to prevent.
 */
const TIERS = {
    core: 0,
    // Split by domain; imports only `core/` (rule 6).
    errors: 0,
    log: 0,
    // Environment probes, worker RPC transport (`runtime/rpc/`) and wasm loaders (`runtime/wasm/`).
    runtime: 0,
    // Ambient `.d.ts` declarations for untyped dependencies: they import nothing.
    "types-ambient": 0,
    crypto: 1,
    fmd: 2,
    keys: 2,
    notes: 2,
    protocol: 3,
    circuit: 3,
    permit2: 4,
    chain: 4,
    prover: 4,
    services: 4,
    bundle: 5,
    sync: 5,
    wallet: 6,
    x402: 7,
    // The published subpaths (`.`, `./advanced`, `./protocol`, …), rule 8.
    entry: 7,
    // Shared test fixtures; never shipped, so never walked.
    "test-utils": 7,
};

/** Tier of a `src/`-relative path: its first segment, plus the root-level files. */
function tierOf(rel) {
    // Aggregates the crypto + prover wasm loaders; sits just under wallet.
    if (rel === "configure-wasm.ts") return 5;
    if (rel === "version.ts") return 0;
    return TIERS[rel.split("/")[0]];
}

const OPS = "wallet/ops/";
const OP_EXCEPTIONS = new Set(["wallet/ops/swap.ts -> wallet/ops/swap-escrow.ts"]);
/** Rule 7: what the pipeline and the context sit below. */
const ABOVE_TX = [OPS, "wallet/create.ts", "wallet/connect/"];

/**
 * Modules `wallet/watch/` must not import (rule 5), besides all of `prover/`.
 *
 * A watch wallet cannot sign, so none is reachable at runtime. `wallet/create.ts` is listed because
 * it statically reaches the per-tx modules and the prover. Direct imports only; `bundle-budget.mjs`
 * measures the transitive graph. An entry ending in `/` forbids the whole directory, so splitting a
 * listed module into one does not silently unforbid its parts.
 */
const WATCH_FORBIDDEN = [
    "prover/",
    "wallet/create.ts",
    "services/relayer/submitter.ts",
    "wallet/selection/",
    "sync/tree-store.ts",
    // Every operation and the shared spend steps.
    "wallet/ops/",
    "wallet/tx/",
    "wallet/connect/index.ts",
    "wallet/defaults/prover.ts",
];

const matches = (list, rel) => list.some((f) => (f.endsWith("/") ? rel.startsWith(f) : f === rel));

const problems = [];

for (const name of readdirSync(SRC)) {
    if (statSync(join(SRC, name)).isDirectory() && !(name in TIERS)) {
        problems.push(
            `src/${name}/ has no entry in TIERS — add one (see the table in this script)`,
        );
    }
}

for (const { abs, rel } of shippedSources()) {
    const text = readFileSync(abs, "utf8");
    const tier = tierOf(rel) ?? 7;
    const isBarrel = rel.endsWith("index.ts");
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

    if (isBarrel && sf.statements.some((st) => ts.isExportDeclaration(st) && !st.exportClause)) {
        problems.push(`${rel}: uses \`export *\` — forward names explicitly`);
    }
    if (rel.startsWith("entry/")) checkEntry(rel, sf, text);

    for (const { fileName: spec } of ts.preProcessFile(text, true, true).importedFiles) {
        if (!spec.startsWith(".")) continue;
        const target = relative(SRC, resolve(dirname(abs), spec)).replace(/\.js$/, ".ts");
        if (target.startsWith("..")) continue;
        const targetTier = tierOf(target) ?? 7;

        if (targetTier > tier) {
            problems.push(
                `${rel} (tier ${tier}) imports ${target} (tier ${targetTier}) — upward dependency`,
            );
        }
        if (rel.startsWith("errors/") && !/^(errors|core)\//.test(target)) {
            problems.push(`${rel} imports ${target} — \`errors/\` may import only \`core/\``);
        }
        if (
            rel.startsWith(OPS) &&
            target.startsWith(OPS) &&
            !OP_EXCEPTIONS.has(`${rel} -> ${target}`)
        ) {
            problems.push(
                `${rel} imports ${target} — an operation may not import another; compose ` +
                    "through a `WalletContext` hook bound in `wallet/create.ts`",
            );
        }
        if (
            (rel.startsWith("wallet/tx/") || rel === "wallet/context.ts") &&
            matches(ABOVE_TX, target)
        ) {
            problems.push(
                `${rel} imports ${target} — \`wallet/tx/\` and \`wallet/context.ts\` sit below the operations`,
            );
        }
        if (rel.startsWith("wallet/watch/") && matches(WATCH_FORBIDDEN, target)) {
            problems.push(
                `${rel} imports ${target} — \`wallet/watch/\` must not reach the spend path ` +
                    "(see WATCH_FORBIDDEN in this script)",
            );
        }
        if (target.startsWith("entry/") && !rel.startsWith("entry/")) {
            problems.push(
                `${rel} imports ${target} — only package.json#exports may point at an entry`,
            );
        }
        // Rule 3: only a cross-domain `<dir>/index.ts` counts. `crypto/jubjub-wasm/index.ts` is
        // one module's entry point, not a domain barrel.
        const importsBarrel = target.endsWith("/index.ts") && target.split("/").length === 2;
        const crossDomain = target.split("/")[0] !== rel.split("/")[0];
        if (importsBarrel && crossDomain && !isBarrel && tier <= 2 && targetTier <= 2) {
            problems.push(
                `${rel} imports the barrel ${target} — use a leaf import to keep worker bundles small`,
            );
        }
    }
}

/** Rule 8: an entry is a list of `export { … } from "<module outside entry/>"`. */
function checkEntry(rel, sf, text) {
    for (const st of sf.statements) {
        const spec =
            ts.isExportDeclaration(st) &&
            st.exportClause &&
            st.moduleSpecifier &&
            ts.isStringLiteral(st.moduleSpecifier)
                ? st.moduleSpecifier.text
                : undefined;
        if (!spec) {
            const head = text.slice(st.getStart(sf)).split("\n")[0].slice(0, 60);
            problems.push(
                `${rel}: \`${head}\` — an entry holds only \`export { … } from\` statements`,
            );
            continue;
        }
        const target = relative(SRC, resolve(SRC, "entry", spec));
        if (target.startsWith("entry/") || target.startsWith("..")) {
            problems.push(
                `${rel} forwards from ${target} — an entry forwards from src/ modules outside entry/`,
            );
        }
    }
}

if (problems.length > 0) {
    console.error("check-layers: FAILED\n");
    for (const p of problems) console.error(`  ${p}`);
    console.error(`\n${problems.length} problem(s). See scripts/check-layers.mjs for the rules.`);
    process.exit(1);
}
console.log("check-layers: OK — tier ladder holds, no `export *`, entries only forward");
