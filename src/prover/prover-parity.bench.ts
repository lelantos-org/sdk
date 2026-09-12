// Prover parity + timing bench: SnarkjsProver vs WasmProver, per shape.
//
// Doubles as the migration safety net for the Rust prover: it is the only
// place a proof produced by `wasm/prover` is verified against the companion's
// verification key. Anything that changes the arkworks stack has to keep this
// green for every shape. Wired into CI via `npm run test:bench`.
//
// Artifacts and witnesses come from the `@lelantos-org/circuits` devDependency,
// so this runs anywhere `npm ci` has run. The sibling bench harness's
// hand-made `input.<id>.json` wins when present, keeping device runs
// comparable with the numbers already in `bench/results.json`.
//
// The debug sink below is load-bearing: `WasmProver.prove` splits its work
// into `witness` and `groth16` records, and this is the only place that split
// is observable. Without it the suite reports one opaque total. A
// `just prover-build-trace` build additionally prints `[prover-trace]` lines
// splitting `groth16` into the QAP witness map and the MSM block.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { circuitSignals, type TransactWitnessBundle } from "../circuit/index.js";
import { type CircuitShape, shapeId, TRANSACT_SHAPES } from "../core/shape.js";
import { configureLogging } from "../log/logger.js";
import { bundledProverArtifacts, resolveArtifacts } from "./artifacts.js";
import { SnarkjsProver, verify } from "./snarkjs.js";
import type { ProveResult, ProverPaths } from "./types.js";
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

async function pathsFor(shape: CircuitShape): Promise<ProverPaths | null> {
    try {
        const paths = resolveArtifacts(await bundledProverArtifacts({ runtime: "node", shape }));
        // `resolveArtifacts` yields `file://` hrefs for the companion package,
        // which `existsSync` does not understand — convert before probing.
        const onDisk = (p: string) => existsSync(p.startsWith("file:") ? fileURLToPath(p) : p);
        return onDisk(paths.wasmPath) && onDisk(paths.zkeyPath) ? paths : null;
    } catch {
        return null;
    }
}

/**
 * Project a witness onto the circuit's declared signals.
 *
 * The packaged vectors carry the challenge-only fields too — the addresses,
 * the clue slots and the aux digest — because those are logical public inputs
 * that hash into `z`. They are not circuit signals, and the witness calculator
 * rejects a key the circuit does not declare (`Signal recipient_address not
 * found`). `circuitSignals` is the same projection the SDK's own prove path
 * applies in `bundle/common.ts`.
 *
 * A hand-made `bench/public/input.<id>.json` is already signal-only, so it is
 * passed through untouched rather than picked at and left with `undefined`
 * holes.
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
        // Named, because an override built against an older circuit fails as a
        // bare `Assert Failed ... in template Transact` with nothing pointing
        // at the file that caused it. CI has no override and proves the
        // packaged vector.
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
    // Straight to stdout rather than `consoleSink()`: vitest intercepts
    // `console.*` and the debug records do not survive it, which is what hid
    // this split until now.
    configureLogging({
        level: "debug",
        namespaces: "lelantos:prover:*",
        sink: (r) => process.stdout.write(`[bench]   ${r.msg}: ${fmt(Number(r.fields?.ms))}\n`),
    });
}

// Load-bearing for measurement, not just hygiene. The rayon workers spin-wait
// while idle, so a pool that outlives its run burns every core and silently
// inflates whatever is timed next — early numbers in this file's history were
// wrong for exactly that reason. `shutdown()` terminates all of them (verified
// 16 -> 0). Note the pool can still be orphaned if a run is *killed* rather
// than allowed to finish: prefer letting the bench complete, and check for
// stray `node` processes before trusting a suspicious result.
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
        const p = paths as ProverPaths;
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
