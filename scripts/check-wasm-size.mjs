// Fails CI if the wasm-pack `_bg.wasm` artifacts grow past the budgets
// below. Bump the limit in the same PR that adds the regression so the
// review surfaces the cost. Sizes measured 2026-05-03:
//   jubjub_wasm_bg.wasm   149 KB
//   prover_bg.wasm        356 KB

import { statSync } from "node:fs";

const BUDGETS = [
    { path: "wasm/jubjub/pkg/jubjub_wasm_bg.wasm", maxKB: 200 },
    { path: "wasm/prover/pkg/prover_bg.wasm", maxKB: 500 },
];

let failed = false;
for (const { path, maxKB } of BUDGETS) {
    const sizeKB = statSync(path).size / 1024;
    const status = sizeKB > maxKB ? "FAIL" : "ok";
    const fmt = sizeKB.toFixed(1);
    console.log(`[${status}] ${path}: ${fmt} KB (limit ${maxKB} KB)`);
    if (sizeKB > maxKB) failed = true;
}

if (failed) {
    console.error(
        "\nWASM artifact exceeded budget. If intentional, raise the limit in scripts/check-wasm-size.mjs and call out the cost in the PR description.",
    );
    process.exit(1);
}
