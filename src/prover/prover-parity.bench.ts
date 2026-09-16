// Prover parity + timing bench: SnarkjsProver vs WasmProver, per shape.
//
// This is the only place a proof produced by `wasm/prover` is verified against
// the companion's verification key; changes to the arkworks stack must keep it
// passing for every shape. Runs in CI via `npm run test:bench`.
//
// Artifacts and witnesses come from the `@lelantos-org/circuits` devDependency.
// A hand-made `bench/public/input.<id>.json` takes precedence when present, so
// device runs stay comparable with `bench/results.json`.
//
// The debug sink below exposes the `witness` and `groth16` timing records
// emitted by `WasmProver.prove`. A `just prover-build-trace` build additionally
// prints `[prover-trace]` lines splitting `groth16` into the QAP witness map and
// the MSM block.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { circuitSignals, type TransactWitnessBundle } from "../circuit/index.js";
import { configureLogging } from "../log/logger.js";
import { type CircuitShape, shapeId, TRANSACT_SHAPES } from "../protocol/shape.js";
import { bundledProverArtifacts, resolveArtifacts } from "./artifact-paths.js";
import { SnarkjsProver, verify } from "./snarkjs.js";
import type { ProveResult, ProverArtifacts } from "./types.js";
import { WasmProver } from "./wasm-prover.js";

const WARM_ITERS = 3;

/** Resolve a JSON file exported by the companion package. */
function packaged<T>(spec: string): T | null {
    try {
        const resolved = (import.meta as { resolve?: (s: string) => string }).resolve?.(spec);
        return resolved ? (JSON.parse(readFileSync(fileURLToPath(resolved), "utf8")) as T) : null;
    } catch {
        return null;
    }
}

async function pathsFor(shape: CircuitShape): Promise<ProverArtifacts | null> {
    try {
        const artifacts = await bundledProverArtifacts({ runtime: "node", shape });
        const paths = resolveArtifacts(artifacts);
        // `resolveArtifacts` yields `file://` hrefs for the companion package,
        // which `existsSync` does not accept.
        const onDisk = (p: string) => existsSync(p.startsWith("file:") ? fileURLToPath(p) : p);
        return onDisk(paths.wasmPath) && onDisk(paths.zkeyPath) ? artifacts : null;
    } catch {
        return null;
    }
}

/**
 * Project a witness onto the circuit's declared signals.
 *
 * Packaged vectors also carry challenge-only fields (addresses, clue slots, aux
 * digest): logical public inputs hashed into `z` but not circuit signals. The
 * witness calculator rejects undeclared keys (`Signal recipient_address not
 * found`). `circuitSignals` is the same projection used in `bundle/common.ts`.
 *
 * A hand-made `bench/public/input.<id>.json` is already signal-only and is
 * passed through unchanged.
 */
function toSignals(raw: Record<string, unknown>): Record<string, unknown> {
    if (!("recipient_address" in raw)) return raw;
    return { ...circuitSignals(raw as unknown as TransactWitnessBundle) };
}

function inputFor(shape: CircuitShape): Record<string, unknown> | null {
    const id = shapeId(shape);
    const override = fileURLToPath(
        new URL(`../../../bench/public/input.${id}.json`, import.meta.url),
    );
    if (existsSync(override)) {
        // Logged because an override built for a different circuit fails with
        // a bare `Assert Failed ... in template Transact` that does not name
        // the file. CI has no override and proves the packaged vector.
        process.stdout.write(`[bench] ${id}: using override input ${override}\n`);
        return toSignals(JSON.parse(readFileSync(override, "utf8")) as Record<string, unknown>);
    }
    const corpus = packaged<{ vectors?: { witness: Record<string, unknown> }[] }>(
        `@lelantos-org/circuits/vectors/transact-${id}.json`,
    );
    const witness = corpus?.vectors?.[0]?.witness;
    return witness ? toSignals(witness) : null;
}

const CASES = await Promise.all(
    TRANSACT_SHAPES.map(async (shape) => {
        const id = shapeId(shape);
        return {
            id,
            paths: await pathsFor(shape),
            input: inputFor(shape),
            vkey: packaged<object>(`@lelantos-org/circuits/${id}/verification_key.json`),
        };
    }),
);

if (CASES.some((c) => c.paths && c.input)) {
    // Written to stdout rather than `consoleSink()`: vitest intercepts
    // `console.*` and drops the debug records.
    configureLogging({
        level: "debug",
        namespaces: "lelantos:prover:*",
        sink: (r) => process.stdout.write(`[bench]   ${r.msg}: ${fmt(Number(r.fields?.ms))}\n`),
    });
}

// Required for accurate measurement: idle rayon workers spin-wait, so a pool
// that outlives its run occupies every core and inflates later timings.
// `shutdown()` terminates all workers. A killed run can still orphan the pool;
// check for stray `node` processes before trusting an unexpected result.
afterAll(async () => {
    await WasmProver.shutdown();
});

function fmt(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    const out = await fn();
    process.stdout.write(`[bench] ${label}: ${fmt(performance.now() - t0)}\n`);
    return out;
}

for (const { id, paths, input, vkey } of CASES) {
    const ready = paths !== null && input !== null;

    describe.skipIf(!ready)(`prover parity + timing (${id})`, () => {
        // The `ready` guard above makes both non-null inside this suite.
        const p = paths as ProverArtifacts;
        const witness = input as Record<string, unknown>;

        async function proveAndCheck(
            label: string,
            prover: { prove(i: Record<string, unknown>): Promise<ProveResult> },
        ): Promise<ProveResult> {
            const cold = await timed(`${label} cold prove`, () => prover.prove(witness));
            for (let i = 0; i < WARM_ITERS; i++) {
                await timed(`${label} warm prove #${i + 1}`, () => prover.prove(witness));
            }
            if (vkey) {
                expect(await verify(vkey, cold.publicSignals, cold.proof)).toBe(true);
            }
            return cold;
        }

        it("snarkjs and wasm provers agree and verify", async () => {
            const snark = await timed(`${id} snarkjs construct`, async () => new SnarkjsProver(p));
            const snarkRes = await proveAndCheck(`${id} snarkjs`, snark);

            const wasm = await timed(`${id} wasm build (zkey parse + pool)`, () =>
                WasmProver.build(p),
            );
            const wasmRes = await proveAndCheck(`${id} wasm`, wasm);

            expect(wasmRes.publicSignals).toEqual(snarkRes.publicSignals);
        }, 600_000);
    });
}
