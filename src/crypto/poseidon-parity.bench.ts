// Poseidon parity + timing: wasm vs poseidon-lite, at the Merkle arity.
//
// Modelled on `src/prover/prover-parity.bench.ts`. Doubles as the migration
// safety net for the vendored wasm permutation: it is the only place a digest
// produced by `wasm/poseidon` is compared against the JS backend at scale, and
// it fails loudly if `Poseidon.build()` silently fell back to JS — which would
// otherwise turn every parity test green while measuring nothing.
//
// Wired into CI via `npm run test:bench`.

import { poseidon5 } from "poseidon-lite/poseidon5";
import { describe, expect, it } from "vitest";
import { Poseidon } from "./poseidon.js";

const ITERS = 2_000;
/** Internal nodes in a full depth-10 arity-4 tree: (4^10 - 1) / 3. */
const FULL_TREE_NODES = 349_525;

function timeUs(fn: (i: number) => unknown, n: number): number {
    for (let i = 0; i < Math.min(n, 200); i++) fn(i);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) fn(i);
    return Number(process.hrtime.bigint() - t0) / 1000 / n;
}

describe("poseidon5 wasm vs js", () => {
    it("wasm backend is actually live", async () => {
        const P = await Poseidon.build();
        // `build()` falls back to JS when wasm cannot load. That is right for
        // production and wrong for this bench, so assert it did not happen.
        expect(P.backend).toBe("wasm");
    });

    it("agrees with poseidon-lite and reports the speedup", async () => {
        const P = await Poseidon.build();
        const inputs = Array.from({ length: ITERS }, (_, i) => [BigInt(i), 2n, 3n, 4n, 5n]);

        for (const xs of inputs.slice(0, 64)) expect(P.hash(xs)).toBe(poseidon5(xs));

        const wasmUs = timeUs((i) => P.hash(inputs[i] as bigint[]), ITERS);
        const jsUs = timeUs((i) => poseidon5(inputs[i] as bigint[]), ITERS);

        process.stdout.write(
            `\n  poseidon5  wasm ${wasmUs.toFixed(1)} us | js ${jsUs.toFixed(1)} us | ` +
                `${(jsUs / wasmUs).toFixed(2)}x\n` +
                `  full 2^20 tree (${FULL_TREE_NODES.toLocaleString()} nodes): ` +
                `${((wasmUs * FULL_TREE_NODES) / 1e6).toFixed(1)}s vs ` +
                `${((jsUs * FULL_TREE_NODES) / 1e6).toFixed(1)}s\n`,
        );

        // A regression that silently reverts to JS would land near 1.0.
        expect(jsUs / wasmUs).toBeGreaterThan(1.5);
    });
});
