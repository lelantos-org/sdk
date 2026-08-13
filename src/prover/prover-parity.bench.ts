// Prover parity + timing bench: SnarkjsProver vs WasmProver on the
// canonical 2x2 circuit. Skipped when artifacts are unavailable.
//
// Artifacts resolve via `bundledProverArtifacts()` (env
// LELANTOS_PROVER_ARTIFACTS_DIR or the @lelantos-org/circuits companion),
// falling back to the sibling bench harness checkout. Run with
// `npm run test:bench`.
//
// The debug sink below is load-bearing: `WasmProver.prove` splits its work
// into `witness` and `groth16` records, and this is the only place that split
// is observable. Without it the suite reports one opaque total.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shapeId, TRANSACT_2X2 } from "../core/shape.js";
import { configureLogging } from "../log/logger.js";
import { bundledProverArtifacts, resolveArtifacts } from "./artifacts.js";
import { SnarkjsProver, verify } from "./snarkjs.js";
import type { ProveResult, ProverPaths } from "./types.js";
import { WasmProver } from "./wasm-prover.js";

// This suite is 2x2 specific — it is paired with `input.2x2.json`, and the
// witness would not satisfy any other shape. `bundledProverArtifacts` defaults
// to `DEFAULT_SHAPE` (3x3), so the shape must be named explicitly.
const SHAPE = TRANSACT_2X2;
const ID = shapeId(SHAPE);

const BENCH_BUILD_DIR = fileURLToPath(
    new URL("../../../bench/node_modules/@lelantos-org/circuits/build", import.meta.url),
);
const BENCH_INPUT = fileURLToPath(
    new URL(`../../../bench/public/input.${ID}.json`, import.meta.url),
);

async function resolvePaths(): Promise<ProverPaths | null> {
    try {
        return resolveArtifacts(await bundledProverArtifacts({ runtime: "node", shape: SHAPE }));
    } catch {
        if (existsSync(`${BENCH_BUILD_DIR}/${ID}_final.zkey`)) {
            return {
                wasmPath: `${BENCH_BUILD_DIR}/${ID}.wasm`,
                zkeyPath: `${BENCH_BUILD_DIR}/${ID}_final.zkey`,
            };
        }
        return null;
    }
}

const paths = await resolvePaths();
const available = paths !== null && existsSync(BENCH_INPUT);

if (available) {
    // Straight to stdout rather than `consoleSink()`: vitest intercepts
    // `console.*` and the debug records do not survive it, which is what hid
    // this split until now.
    configureLogging({
        level: "debug",
        namespaces: "lelantos:prover:*",
        sink: (r) => process.stdout.write(`[bench]   ${r.msg}: ${fmt(Number(r.fields?.ms))}\n`),
    });
}

const WARM_ITERS = 3;

function fmt(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    const out = await fn();
    process.stdout.write(`[bench] ${label}: ${fmt(performance.now() - t0)}\n`);
    return out;
}

describe.skipIf(!available)("prover parity + timing (2x2)", () => {
    // `available` guard guarantees paths is non-null inside this suite.
    const p = paths as ProverPaths;
    const input = available
        ? (JSON.parse(readFileSync(BENCH_INPUT, "utf8")) as Record<string, unknown>)
        : {};
    const vkeyPath = `${p.zkeyPath.replace(/[^/]+$/, "")}verification_key.json`;
    const vkey = existsSync(vkeyPath)
        ? (JSON.parse(readFileSync(vkeyPath, "utf8")) as object)
        : null;

    async function proveAndCheck(
        label: string,
        prover: { prove(i: Record<string, unknown>): Promise<ProveResult> },
    ): Promise<ProveResult> {
        const cold = await timed(`${label} cold prove`, () => prover.prove(input));
        for (let i = 0; i < WARM_ITERS; i++) {
            await timed(`${label} warm prove #${i + 1}`, () => prover.prove(input));
        }
        if (vkey) {
            expect(await verify(vkey, cold.publicSignals, cold.proof)).toBe(true);
        }
        return cold;
    }

    it("snarkjs and wasm provers agree and verify", async () => {
        const snark = await timed("snarkjs construct", async () => new SnarkjsProver(p));
        const snarkRes = await proveAndCheck("snarkjs", snark);

        const wasm = await timed("wasm build (zkey parse + pool)", () => WasmProver.build(p));
        const wasmRes = await proveAndCheck("wasm", wasm);

        expect(wasmRes.publicSignals).toEqual(snarkRes.publicSignals);
    }, 600_000);
});
