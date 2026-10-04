// End-to-end shape check: prove each shape's golden witnesses with its proving key and verify
// them against its verification key.
//
// `vectors.test.ts` pins the SDK's `coeffs`, `coeffDigest` and `flatten` to each vector's `y`,
// `digest` and `z`. This test pins the vectors to the compiled circuit: the public signals a
// real proof emits, `[y, digest, z]`, must match. A coefficient layout the SDK and vectors agree
// on is still wrong if the circuit orders its slots differently.
//
// Skipped when a shape's artifacts are absent: the wasm and zkey come from the companion package.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type CircuitShape, shapeId, TRANSACT_SHAPES } from "../protocol/shape.js";
import { bundledProverArtifacts, resolveArtifacts } from "../prover/artifact-paths.js";
import { prove, verify } from "../prover/snarkjs.js";
import { circuitSignals, type TransactWitnessBundle } from "./input.js";

interface Vector {
    name: string;
    witness: TransactWitnessBundle;
    compression: { y: string; digest: string; z: string };
}

/**
 * Resolve a companion-package subpath to a filesystem path, or `null` when the package is absent
 * or does not export it.
 *
 * `import.meta.resolve` is cast as optional: the DOM lib does not declare it, and it is
 * synchronous only from Node 20.6.
 */
function resolvePackageFile(spec: string): string | null {
    try {
        const href = (import.meta as { resolve?: (s: string) => string }).resolve?.(spec);
        return href ? fileURLToPath(href) : null;
    } catch {
        return null;
    }
}

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, "utf8"));
}

/** The companion publishes one `verification_key.json` per shape. */
function vkeyFor(id: string): unknown | null {
    const path = resolvePackageFile(`@lelantos-org/circuits/${id}/verification_key.json`);
    return path ? readJson(path) : null;
}

/**
 * The shape's golden vectors. Unlike the artifacts these are required (`vectors.test.ts` fails
 * without them), so an unresolvable spec throws instead of skipping.
 */
function vectorsFor(id: string): Vector[] {
    const spec = `@lelantos-org/circuits/vectors/transact-${id}.json`;
    const path = resolvePackageFile(spec);
    if (!path) throw new Error(`cannot resolve ${spec}`);
    return (readJson(path) as { vectors: Vector[] }).vectors;
}

/** The shape's wasm/zkey pair, or `null` when either is not on disk. */
async function pathsFor(shape: CircuitShape) {
    try {
        const paths = resolveArtifacts(await bundledProverArtifacts({ runtime: "node", shape }));
        // `resolveArtifacts` yields `file://` hrefs for the companion package, which
        // `existsSync` does not accept.
        const onDisk = (p: string) => existsSync(p.startsWith("file:") ? fileURLToPath(p) : p);
        return onDisk(paths.wasmPath) && onDisk(paths.zkeyPath) ? paths : null;
    } catch {
        return null;
    }
}

for (const shape of TRANSACT_SHAPES) {
    const id = shapeId(shape);

    describe(`transact ${id}`, async () => {
        const paths = await pathsFor(shape);
        const vkey = vkeyFor(id);

        it.skipIf(!paths || !vkey)(
            "proves the golden witnesses and emits each vector's [y, digest, z]",
            async () => {
                if (!paths || !vkey) return;
                const vectors = vectorsFor(id);
                if (vectors.length === 0) throw new Error(`no vectors for ${id}`);

                for (const vector of vectors) {
                    // The vector's witness also carries the digest word and the
                    // challenge-only fields (addresses, clues, aux digest), which the
                    // witness calculator rejects.
                    const signals = { ...circuitSignals(vector.witness) };
                    const { proof, publicSignals } = await prove(signals, paths);
                    expect(await verify(vkey as object, publicSignals, proof), vector.name).toBe(
                        true,
                    );

                    // The verifier's `_pubSignals`, in `PubInputs.compress` order. `digest`
                    // is computed by the circuit, so this checks `transactDigest` against
                    // `CoeffDigest`.
                    const { y, digest, z } = vector.compression;
                    expect(publicSignals, vector.name).toEqual([y, digest, z]);
                    expect(vector.witness.digest, vector.name).toBe(digest);
                    expect(vector.witness.z, vector.name).toBe(z);

                    // A proof does not verify against another digest word.
                    const forged = [y, (BigInt(digest) ^ 1n).toString(), z];
                    expect(await verify(vkey as object, forged, proof), vector.name).toBe(false);
                }
            },
            300_000,
        );
    });
}
