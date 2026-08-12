// End-to-end shape check: prove a shipped golden witness with the matching
// proving key and verify it against the matching verification key.
//
// `vectors.test.ts` already checks that the SDK's `flatten` reproduces each
// vector's `y`. That pins the SDK to the vectors. This pins the vectors to the
// *compiled circuit*: the `y` a real proof emits as its public signal has to
// be the same value. Together they close the triangle, which is what makes a
// wider shape trustworthy — a 42-coefficient layout that the SDK and the
// vectors agree on is still wrong if the circuit numbers its slots otherwise.
//
// Skipped when a shape's artifacts are absent: the wasm and zkey come from the
// companion package, and an SDK-only checkout has neither.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type CircuitShape, shapeId, TRANSACT_2X2, TRANSACT_3X3 } from "../core/shape.js";
import { bundledProverArtifacts, resolveArtifacts } from "../prover/artifacts.js";
import { prove, verify } from "../prover/snarkjs.js";

interface Vector {
    name: string;
    witness: Record<string, unknown>;
    compression?: { y?: string };
}

/** The companion publishes `verification_key.json` per shape. */
function vkeyFor(shape: CircuitShape): unknown | null {
    const id = shapeId(shape);
    for (const spec of [`@lelantos-org/circuits/${id}/verification_key.json`]) {
        try {
            const resolved = (import.meta as { resolve?: (s: string) => string }).resolve?.(spec);
            if (resolved) return JSON.parse(readFileSync(fileURLToPath(resolved), "utf8"));
        } catch {
            // fall through to "unavailable"
        }
    }
    return null;
}

function vectorsFor(shape: CircuitShape): Vector[] {
    const spec = `@lelantos-org/circuits/vectors/transact-${shapeId(shape)}.json`;
    const resolved = (import.meta as { resolve?: (s: string) => string }).resolve?.(spec);
    if (!resolved) throw new Error(`cannot resolve ${spec}`);
    return JSON.parse(readFileSync(fileURLToPath(resolved), "utf8")).vectors as Vector[];
}

async function pathsFor(shape: CircuitShape) {
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

for (const shape of [TRANSACT_2X2, TRANSACT_3X3]) {
    const id = shapeId(shape);

    describe(`transact ${id}`, async () => {
        const paths = await pathsFor(shape);
        const vkey = vkeyFor(shape);

        it.skipIf(!paths || !vkey)(
            "proves a golden witness and emits the vector's compressed y",
            async () => {
                if (!paths || !vkey) return;
                const vector = vectorsFor(shape)[0];
                if (!vector) throw new Error(`no vectors for ${id}`);

                const { proof, publicSignals } = await prove(vector.witness, paths);
                expect(await verify(vkey as object, publicSignals, proof)).toBe(true);

                // Slot 0 of the public signals is the PolyEval-compressed `y`
                // that `PubInputs.compress` reproduces on chain.
                if (vector.compression?.y) {
                    expect(publicSignals[0]).toBe(vector.compression.y);
                }
            },
            120_000,
        );
    });
}
