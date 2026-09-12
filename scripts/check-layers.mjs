// Enforces the dependency ladder and barrel discipline in src/.
//
// Without this the structure re-rots on the first convenient import. The
// eight layering inversions this refactor removed were each individually
// reasonable at the time; nothing was watching the whole.
//
// Three rules:
//   1. No module may import from a HIGHER tier.
//   2. No `export *` in any barrel — package.json#exports has no wildcard,
//      so a barrel forwarding blindly is what makes @internal symbols
//      public API.
//   3. No leaf module below tier 3 may import a domain BARREL. Worker and
//      wasm bundles pull the whole barrel's graph; leaf imports keep them
//      small. (Root index.ts and each dir's own index.ts are exempt.)
//   5. `wallet/watch/` may not import the spend path, so a viewer does not
//      download the prover.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve as resolvePath, dirname } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

/**
 * First path segment -> tier.
 *
 * Every directory under `src/` must appear here. The tier-7 default exists for
 * new files inside a listed directory, not for whole modules: an unlisted
 * module is checked against nothing and can silently acquire any dependency it
 * likes, which is the failure this script exists to prevent. `check` below
 * fails on an unlisted directory rather than defaulting it.
 */
const TIERS = {
    core: 0,
    log: 0,
    worker: 0,
    wasm: 0,
    // Ambient `.d.ts` declarations for untyped dependencies. Tier 0: they
    // declare types and import nothing, so anything may reference them.
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
    presets: 7,
    x402: 7,
};

/** `wasm/loader.ts` is tier 0, but the rayon glue may reach for logging. */
const TIER_OF_FILE = (rel) => {
    const seg = rel.split("/")[0];
    if (rel === "index.ts") return 7;
    // Aggregates the crypto + prover wasm loaders; sits just under wallet.
    if (rel === "configure-wasm.ts") return 5;
    if (rel === "version.ts") return 0;
    return TIERS[seg] ?? 7;
};

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
    }
    return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s+"([^"]+)"/g;
const DYNAMIC_RE = /import\(\s*(?:\/\*[^*]*\*\/\s*)?"([^"]+)"\s*\)/g;
const EXPORT_STAR_RE = /^\s*export\s+\*\s+from\s+"/m;

/**
 * Modules `wallet/watch/` must not import.
 *
 * A watch wallet cannot sign, so none is reachable at runtime. `wallet.ts` is
 * listed because it statically reaches the per-tx modules and the prover.
 *
 * Direct imports only; `bundle-budget.mjs` measures the transitive graph.
 *
 * An entry ending in `/` forbids the whole directory, so splitting a listed
 * module into one does not silently unforbid its parts.
 */
const WATCH_FORBIDDEN = [
    "wallet/wallet.ts",
    "wallet/submitter.ts",
    "wallet/selection/",
    "wallet/tree-store.ts",
    "wallet/deposit.ts",
    "wallet/transfer.ts",
    "wallet/withdraw.ts",
    "wallet/swap.ts",
    "wallet/withdraw-preview.ts",
    "wallet/fee-quote.ts",
    "wallet/connect/index.ts",
    "wallet/defaults/prover.ts",
];

const problems = [];

// Rule 4: every directory under `src/` carries an explicit tier.
//
// Without this the tier-7 default silently adopts a whole new module — as it
// had for `x402`, 2.9k lines checked against nothing. Tier 7 happened to be
// right there, which is the point: nothing would have said otherwise.
for (const name of readdirSync(SRC)) {
    if (!statSync(join(SRC, name)).isDirectory()) continue;
    if (!(name in TIERS)) {
        problems.push(
            `src/${name}/ has no entry in TIERS — add one (see the table in this script)`,
        );
    }
}

for (const abs of walk(SRC)) {
    const rel = relative(SRC, abs);
    if (rel.endsWith(".test.ts") || rel.endsWith(".bench.ts") || rel.includes("test-utils")) {
        continue;
    }
    const src = readFileSync(abs, "utf8");
    const tier = TIER_OF_FILE(rel);
    const isBarrel = rel.endsWith("index.ts");

    if (isBarrel && EXPORT_STAR_RE.test(src)) {
        problems.push(`${rel}: uses \`export *\` — forward names explicitly`);
    }

    const specs = new Set();
    for (const m of src.matchAll(IMPORT_RE)) specs.add(m[1]);
    for (const m of src.matchAll(DYNAMIC_RE)) specs.add(m[1]);

    for (const spec of specs) {
        if (!spec.startsWith(".")) continue;
        const targetAbs = resolvePath(dirname(abs), spec).replace(/\.js$/, ".ts");
        const targetRel = relative(SRC, targetAbs);
        if (targetRel.startsWith("..")) continue;

        const targetTier = TIER_OF_FILE(targetRel);
        if (targetTier > tier) {
            problems.push(
                `${rel} (tier ${tier}) imports ${targetRel} (tier ${targetTier}) — upward dependency`,
            );
        }

        // Rule 5: the watch-only entry point must not reach the spend path.
        if (
            rel.startsWith("wallet/watch/") &&
            (WATCH_FORBIDDEN.some((f) => (f.endsWith("/") ? targetRel.startsWith(f) : f === targetRel)) ||
                targetRel.startsWith("prover/"))
        ) {
            problems.push(
                `${rel} imports ${targetRel} — \`wallet/watch/\` must not reach the spend path ` +
                    "(see WATCH_FORBIDDEN in this script)",
            );
        }

        // Rule 3: keep worker/wasm graphs small below the protocol tier.
        // Only cross-DOMAIN barrel imports count — reaching for a sibling
        // barrel inside your own domain pulls nothing extra.
        // `crypto/jubjub-wasm/index.ts` is one module's entry point, not a
        // domain barrel — importing it pulls exactly that module.
        const importsBarrel =
            targetRel.endsWith("/index.ts") && targetRel.split("/").length === 2;
        const crossDomain = targetRel.split("/")[0] !== rel.split("/")[0];
        if (importsBarrel && crossDomain && !isBarrel && tier <= 2 && targetTier <= 2) {
            problems.push(
                `${rel} imports the barrel ${targetRel} — use a leaf import to keep worker bundles small`,
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
console.log("check-layers: OK — tier ladder holds, no `export *`");
