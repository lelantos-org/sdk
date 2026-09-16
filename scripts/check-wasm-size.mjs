// Fails if a wasm-pack `_bg.wasm` artifact grows past its budget. Raise a limit in the same PR that
// adds the growth, so the review surfaces the cost. Poseidon carries round constants for arity 5
// only (a build-time table, one width per exposed arity; see wasm/poseidon-params/src/lib.rs).

import { statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/package.mjs";

const BUDGETS = [
    { path: "wasm/jubjub/pkg/jubjub_wasm_bg.wasm", maxKiB: 200 },
    { path: "wasm/prover/pkg/prover_bg.wasm", maxKiB: 500 },
    { path: "wasm/poseidon/pkg/poseidon_wasm_bg.wasm", maxKiB: 120 },
];

let failed = false;
for (const { path, maxKiB } of BUDGETS) {
    const size = statSync(join(ROOT, path)).size / 1024;
    const ok = size <= maxKiB;
    failed ||= !ok;
    console.log(`[${ok ? "ok" : "FAIL"}] ${path}: ${size.toFixed(1)} KiB (limit ${maxKiB} KiB)`);
}

if (failed) {
    console.error(
        "\nWASM artifact exceeded budget. If intentional, raise the limit in scripts/check-wasm-size.mjs and call out the cost in the PR description.",
    );
    process.exit(1);
}
